#!/usr/bin/env node
/* global console, process */

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  GitDistConfigError,
  assertRelativeResourcePath,
  assertSha256,
  configPath,
  expectedManifestPaths,
  getHostTarget,
  getTarget,
  isPlaceholderChecksum,
  loadGitDistConfig,
  requiredExecutableKeysForTarget,
  sha256File,
  supportedTargets,
  validateGitDistConfig,
} from "./git-dist-lib.mjs";

const args = process.argv.slice(2);
const schemaOnly = args.includes("--schema-only");
const explain = args.includes("--explain");
const noExec = args.includes("--no-exec");
const realBuild = args.includes("--real-build");
const expectPlaceholderRejection = args.includes(
  "--expect-placeholder-rejection",
);
const help = args.includes("--help") || args.includes("-h");
const targetArg = args.find((arg) => arg.startsWith("--target="));
const targetName = normalizeTargetArg(
  targetArg?.slice("--target=".length) || getHostTarget(),
);

const usage = `Usage:
  node scripts/check-git-dist.mjs --schema-only
  node scripts/check-git-dist.mjs --schema-only --real-build [--expect-placeholder-rejection] [--target=${supportedTargets.join("|")}]
  ARTISTIC_GIT_DIST_DIR=/path/to/git-dist node scripts/check-git-dist.mjs [--no-exec] [--target=${supportedTargets.join("|")}]

This checker never searches PATH and never falls back to a system Git.`;

if (help) {
  console.log(usage);
  process.exit(0);
}

function fail(message) {
  console.error(`git-dist check failed: ${message}`);
  process.exit(1);
}

function failConfig(error) {
  if (error instanceof GitDistConfigError) {
    console.error(`git-dist check failed: ${error.message}`);
    for (const detail of error.details ?? []) {
      console.error(`  - ${detail}`);
    }
    process.exit(1);
  }
  throw error;
}

function info(message) {
  console.log(`git-dist: ${message}`);
}

async function assertPath(filePath, label, mode = constants.R_OK) {
  try {
    await access(filePath, mode);
  } catch {
    fail(`${label} is missing or not accessible: ${filePath}`);
  }
}

async function assertRegularFile(filePath, label) {
  await assertPath(filePath, label);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    fail(`${label} must be a file: ${filePath}`);
  }
}

async function checkConfigContract(config, options = {}) {
  if (expectPlaceholderRejection) {
    if (!schemaOnly || !realBuild) {
      fail(
        "--expect-placeholder-rejection must be used with --schema-only --real-build.",
      );
    }

    try {
      validateGitDistConfig(config, options);
    } catch (error) {
      if (
        error instanceof GitDistConfigError &&
        error.details?.some((detail) =>
          detail.startsWith("real build mode rejects placeholder pins:"),
        )
      ) {
        for (const detail of error.details) {
          info(detail);
        }
        info(
          "git-dist.toml real-build contract is blocked by documented placeholders as expected.",
        );
        return;
      }
      throw error;
    }

    fail(
      "expected real-build mode to reject placeholder pins, but the config is now release-ready. Remove --expect-placeholder-rejection from the caller.",
    );
  }

  const { warnings, placeholders } = validateGitDistConfig(config, options);
  for (const warning of warnings) {
    info(`warning: ${warning}`);
  }
  if (placeholders.length > 0) {
    info(
      `git-dist.toml contains placeholder source pins: ${placeholders.join("; ")}`,
    );
  }
  info(
    realBuild
      ? "git-dist.toml real-build contract passed."
      : "git-dist.toml schema contract passed.",
  );
}

function parseManifest(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`manifest.json is not valid JSON: ${error.message}`);
  }
}

function requireManifestString(manifest, key) {
  const value = manifest[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`manifest.${key} must be a non-empty string`);
  }
  return value;
}

function assertManifestVersionNotPlaceholder(manifest, key) {
  const value = requireManifestString(manifest, key);
  if (/placeholder|TODO/i.test(value)) {
    fail(`manifest.${key} must not be a placeholder value: ${value}`);
  }
  return value;
}

async function checkDistRoot(config) {
  const target = getTarget(config, targetName);
  const distDir = process.env.ARTISTIC_GIT_DIST_DIR;
  if (!distDir || distDir.trim().length === 0) {
    fail(
      "ARTISTIC_GIT_DIST_DIR is not set. Refusing to search PATH or use a system Git.",
    );
  }

  const distRoot = path.resolve(distDir);
  let rootStat;
  try {
    rootStat = await stat(distRoot);
  } catch {
    fail(`ARTISTIC_GIT_DIST_DIR does not exist: ${distRoot}`);
  }
  if (!rootStat.isDirectory()) {
    fail(
      `ARTISTIC_GIT_DIST_DIR must point to a git-dist directory: ${distRoot}`,
    );
  }

  const manifestPath = path.join(distRoot, config.resources.layout.manifest);
  await assertRegularFile(manifestPath, "manifest.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));

  if (manifest.schemaVersion !== config.manifest.schema_version) {
    fail(`manifest.schemaVersion must be ${config.manifest.schema_version}`);
  }

  requireManifestString(manifest, "platform");
  assertManifestVersionNotPlaceholder(manifest, "gitVersion");
  assertManifestVersionNotPlaceholder(manifest, "gitLfsVersion");
  assertManifestVersionNotPlaceholder(manifest, "helperVersion");

  if (target.platform === "windows") {
    assertManifestVersionNotPlaceholder(manifest, "windowsOpenSshVersion");
  }

  if (manifest.platform !== target.manifest_platform) {
    fail(
      `manifest.platform must match targets.${targetName}.manifest_platform (${target.manifest_platform}), got ${manifest.platform}`,
    );
  }

  if (!manifest.paths || typeof manifest.paths !== "object") {
    fail("manifest.paths is required");
  }

  checkManifestPaths(config, manifest);
  await checkManifestExecutablesAndChecksums(config, manifest, distRoot);

  if (!noExec && targetName === getHostTarget()) {
    runVersionCheck(
      path.join(distRoot, manifest.paths.gitExecutable),
      ["--version"],
      "embedded git",
      expectedGitVersion(config, target),
    );
    runVersionCheck(
      path.join(distRoot, manifest.paths.gitLfsExecutable),
      ["version"],
      "embedded git-lfs",
      `git-lfs/${config.versions.git_lfs}`,
    );
  }

  info(`ARTISTIC_GIT_DIST_DIR is valid for ${manifest.platform}: ${distRoot}`);
}

function checkManifestPaths(config, manifest) {
  const expectedPaths = expectedManifestPaths(config, targetName);
  const requiredKeys = requiredExecutableKeysForTarget(config, targetName);

  for (const key of requiredKeys) {
    const actual = manifest.paths[key];
    const expected = expectedPaths[key];
    try {
      assertRelativeResourcePath(actual, key);
    } catch (error) {
      fail(error.message);
    }
    if (actual !== expected) {
      fail(
        `manifest.paths.${key} must match git-dist.toml resources layout (${expected}), got ${actual}`,
      );
    }
  }

  if (
    targetName !== "windows-x86_64" &&
    manifest.paths.windowsSshExecutable !== undefined
  ) {
    fail(
      "manifest.paths.windowsSshExecutable must be absent for non-Windows targets",
    );
  }
}

async function checkManifestExecutablesAndChecksums(
  config,
  manifest,
  distRoot,
) {
  if (
    !manifest.sha256 ||
    typeof manifest.sha256 !== "object" ||
    Object.keys(manifest.sha256).length === 0
  ) {
    fail("manifest.sha256 must contain checksums for distributed files");
  }

  const verifiedPaths = new Set();
  const requiredKeys = requiredExecutableKeysForTarget(config, targetName);
  for (const key of requiredKeys) {
    const relativePath = manifest.paths[key];
    const mode =
      targetName === getHostTarget() && process.platform !== "win32"
        ? constants.X_OK
        : constants.R_OK;
    const absolutePath = path.join(distRoot, relativePath);

    await assertRegularFile(absolutePath, `manifest paths.${key}`);
    await assertPath(absolutePath, `manifest paths.${key}`, mode);

    const checksum = manifest.sha256[relativePath];
    if (!checksum) {
      fail(
        `manifest.sha256 must include required executable path '${relativePath}' for ${key}`,
      );
    }
    try {
      assertSha256(checksum, `manifest.sha256["${relativePath}"]`);
    } catch (error) {
      fail(error.message);
    }
    if (isPlaceholderChecksum(checksum)) {
      fail(
        `manifest.sha256["${relativePath}"] must not be an all-zero placeholder`,
      );
    }

    const actual = await sha256File(absolutePath);
    if (actual !== checksum.toLowerCase()) {
      fail(
        `manifest.sha256["${relativePath}"] does not match file content: expected ${checksum}, got ${actual}`,
      );
    }
    verifiedPaths.add(relativePath);
  }

  for (const [relativePath, checksum] of Object.entries(manifest.sha256)) {
    try {
      assertRelativeResourcePath(relativePath, `sha256 key ${relativePath}`);
      assertSha256(checksum, `manifest.sha256["${relativePath}"]`);
    } catch (error) {
      fail(error.message);
    }
    if (!verifiedPaths.has(relativePath)) {
      const absolutePath = path.join(distRoot, relativePath);
      await assertRegularFile(
        absolutePath,
        `manifest.sha256 key ${relativePath}`,
      );
      const actual = await sha256File(absolutePath);
      if (actual !== checksum.toLowerCase()) {
        fail(
          `manifest.sha256["${relativePath}"] does not match file content: expected ${checksum}, got ${actual}`,
        );
      }
    }
  }
}

function runVersionCheck(executable, versionArgs, label, expectedVersion) {
  const result = spawnSync(executable, versionArgs, {
    encoding: "utf8",
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: path.dirname(executable),
      PATH: "",
    },
  });

  if (result.error) {
    fail(
      `${label} could not be executed at explicit path ${executable}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    fail(
      `${label} version check failed at explicit path ${executable}: ${result.stderr || result.stdout}`,
    );
  }

  const output = result.stdout.trim();
  if (!output.includes(expectedVersion)) {
    fail(`${label} expected version '${expectedVersion}', got '${output}'`);
  }
  info(`${label}: ${output}`);
}

function expectedGitVersion(config, target) {
  return target.platform === "windows"
    ? config.versions.git_for_windows
    : config.versions.git;
}

function normalizeTargetArg(value) {
  const aliases = {
    win32: "windows-x86_64",
    windows: "windows-x86_64",
    darwin: "macos-universal",
    macos: "macos-universal",
    linux: "linux-x86_64",
  };
  return aliases[value] ?? value;
}

if (explain) {
  console.log(usage);
  console.log("");
  console.log("Expected development layout:");
  console.log("  $ARTISTIC_GIT_DIST_DIR/manifest.json");
  console.log("  $ARTISTIC_GIT_DIST_DIR/git/bin/git(.exe)");
  console.log("  $ARTISTIC_GIT_DIST_DIR/git-lfs/git-lfs(.exe)");
  console.log(
    "  $ARTISTIC_GIT_DIST_DIR/openssh/ssh.exe       # Windows artifact only",
  );
  console.log("  $ARTISTIC_GIT_DIST_DIR/helpers/*");
  console.log("");
}

try {
  const { data: config } = await loadGitDistConfig(configPath);
  await checkConfigContract(config, {
    realBuild,
    targetName: targetArg ? targetName : undefined,
  });

  if (!schemaOnly) {
    await checkDistRoot(config);
  }
} catch (error) {
  failConfig(error);
}
