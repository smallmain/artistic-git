#!/usr/bin/env node
/* global console, process */

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const configPath = path.join(repoRoot, "git-dist.toml");

const args = new Set(process.argv.slice(2));
const schemaOnly = args.has("--schema-only");
const explain = args.has("--explain");
const noExec = args.has("--no-exec");
const help = args.has("--help") || args.has("-h");
const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg?.slice("--target=".length) || process.platform;

const usage = `Usage:
  node scripts/check-git-dist.mjs --schema-only
  ARTISTIC_GIT_DIST_DIR=/path/to/git-dist node scripts/check-git-dist.mjs [--no-exec] [--target=win32|darwin|linux]

This checker never searches PATH and never falls back to a system Git.`;

if (help) {
  console.log(usage);
  process.exit(0);
}

function fail(message) {
  console.error(`git-dist check failed: ${message}`);
  process.exit(1);
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

function assertRelativeResourcePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`manifest paths.${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes("..")) {
    fail(
      `manifest paths.${label} must stay inside ARTISTIC_GIT_DIST_DIR: ${value}`,
    );
  }
}

async function checkConfigContract() {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    fail(`missing root git-dist.toml at ${configPath}`);
  }

  const requiredPatterns = [
    [/^schema_version\s*=\s*1$/m, "schema_version = 1"],
    [/^\[versions\]$/m, "[versions]"],
    [/^git\s*=/m, "versions.git"],
    [/^git_lfs\s*=/m, "versions.git_lfs"],
    [/^win32_openssh\s*=/m, "versions.win32_openssh"],
    [/^\[resources\.layout\]$/m, "[resources.layout]"],
    [/^git_executable\s*=/m, "resources.layout.git_executable"],
    [/^git_lfs_executable\s*=/m, "resources.layout.git_lfs_executable"],
    [/^windows_ssh_executable\s*=/m, "resources.layout.windows_ssh_executable"],
    [/^\[sources\.windows\.x86_64\.git\]$/m, "Windows MinGit source"],
    [/^\[sources\.windows\.x86_64\.git_lfs\]$/m, "Windows Git LFS source"],
    [/^\[sources\.windows\.x86_64\.win32_openssh\]$/m, "Win32-OpenSSH source"],
    [/^\[sources\.macos\.universal\.git\]$/m, "macOS Git source"],
    [/^\[sources\.linux\.x86_64\.git\]$/m, "Linux Git source"],
    [/^sha256\s*=/m, "source sha256 fields"],
  ];

  for (const [pattern, label] of requiredPatterns) {
    if (!pattern.test(text)) {
      fail(`git-dist.toml contract is missing ${label}`);
    }
  }

  if (/"0{64}"/.test(text) || /placeholder\s*=\s*true/.test(text)) {
    info(
      "git-dist.toml contains placeholder source pins; real build jobs must reject them.",
    );
  }

  info("git-dist.toml contract fields are present.");
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

async function checkDistRoot() {
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

  const manifestPath = path.join(distRoot, "manifest.json");
  await assertRegularFile(manifestPath, "manifest.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));

  if (manifest.schemaVersion !== 1) {
    fail("manifest.schemaVersion must be 1");
  }

  requireManifestString(manifest, "platform");
  requireManifestString(manifest, "gitVersion");
  requireManifestString(manifest, "gitLfsVersion");
  requireManifestString(manifest, "helperVersion");

  if (!manifest.paths || typeof manifest.paths !== "object") {
    fail("manifest.paths is required");
  }

  const requiredPathKeys = [
    "gitExecutable",
    "gitLfsExecutable",
    "credentialHelper",
    "sshAskpass",
  ];
  if (target === "win32") {
    requiredPathKeys.push("windowsSshExecutable");
  }

  for (const key of requiredPathKeys) {
    assertRelativeResourcePath(manifest.paths[key], key);
  }

  const executableKeys = [
    "gitExecutable",
    "gitLfsExecutable",
    "credentialHelper",
    "sshAskpass",
  ];
  if (manifest.paths.windowsSshExecutable) {
    assertRelativeResourcePath(
      manifest.paths.windowsSshExecutable,
      "windowsSshExecutable",
    );
    executableKeys.push("windowsSshExecutable");
  }

  for (const key of executableKeys) {
    const mode =
      target === process.platform && process.platform !== "win32"
        ? constants.X_OK
        : constants.R_OK;
    await assertRegularFile(
      path.join(distRoot, manifest.paths[key]),
      `manifest paths.${key}`,
    );
    await assertPath(
      path.join(distRoot, manifest.paths[key]),
      `manifest paths.${key}`,
      mode,
    );
  }

  if (
    !manifest.sha256 ||
    typeof manifest.sha256 !== "object" ||
    Object.keys(manifest.sha256).length === 0
  ) {
    fail("manifest.sha256 must contain checksums for distributed files");
  }

  if (!noExec && target === process.platform) {
    runVersionCheck(
      path.join(distRoot, manifest.paths.gitExecutable),
      ["--version"],
      "embedded git",
    );
    runVersionCheck(
      path.join(distRoot, manifest.paths.gitLfsExecutable),
      ["version"],
      "embedded git-lfs",
    );
  }

  info(`ARTISTIC_GIT_DIST_DIR is valid for ${manifest.platform}: ${distRoot}`);
}

function runVersionCheck(executable, versionArgs, label) {
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
  info(`${label}: ${result.stdout.trim()}`);
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

await checkConfigContract();

if (!schemaOnly) {
  await checkDistRoot();
}
