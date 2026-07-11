#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { regularFileResourcePaths } from "./git-dist-lib.mjs";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const defaultTauriConfigPath = path.join(
  repoRoot,
  "src-tauri",
  "tauri.conf.json",
);
export const requiredTargets = ["app", "dmg", "nsis", "appimage", "deb"];
export const releaseLatestJsonEndpoint =
  "https://github.com/smallmain/artistic-git/releases/latest/download/latest.json";

const ignoredBuildOutputDirectories = new Set([
  ".fingerprint",
  "build",
  "deps",
  "incremental",
]);

function fail(message) {
  throw new Error(message);
}

function info(message) {
  console.log(`tauri bundle resources: ${message}`);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeResourcePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
}

function requireObject(value, message) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail(message);
  }
  return value;
}

async function validateLinuxBundleResourceConfig(tauriDir) {
  const configPath = path.join(tauriDir, "tauri.linux.conf.json");
  if (!(await pathExists(configPath))) {
    return null;
  }

  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    fail(
      `Linux Tauri config is not valid JSON: ${configPath}: ${error.message}`,
    );
  }

  const bundle = requireObject(
    config.bundle,
    `Linux Tauri config must contain bundle settings: ${configPath}`,
  );
  if (bundle.resources !== null) {
    fail(
      "Linux Tauri config must set bundle.resources to null so linuxdeploy does not rewrite embedded Git executables.",
    );
  }

  const linux = requireObject(
    bundle.linux,
    `Linux Tauri config must contain bundle.linux settings: ${configPath}`,
  );
  for (const target of ["appimage", "deb"]) {
    const targetConfig = requireObject(
      linux[target],
      `Linux Tauri config must contain bundle.linux.${target}: ${configPath}`,
    );
    const files = requireObject(
      targetConfig.files,
      `Linux Tauri config must contain bundle.linux.${target}.files: ${configPath}`,
    );
    if (files["usr/share/artistic-git/git-dist"] !== "resources/git-dist") {
      fail(
        `Linux Tauri ${target} files must map usr/share/artistic-git/git-dist to resources/git-dist.`,
      );
    }
  }

  return configPath;
}

export async function findBundledGitDistManifests(buildOutput) {
  const root = path.resolve(buildOutput);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    return [];
  }

  const manifests = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (ignoredBuildOutputDirectories.has(entry.name)) {
        continue;
      }

      const child = path.join(directory, entry.name);
      if (entry.name === "git-dist") {
        const manifestPath = path.join(child, "manifest.json");
        if (await pathExists(manifestPath)) {
          manifests.push(manifestPath);
        }
        continue;
      }

      await walk(child);
    }
  }

  await walk(root);
  return manifests.sort();
}

export async function checkTauriBundleResources({
  configPath = defaultTauriConfigPath,
  requireManifest = false,
  releaseMode = false,
  bundleOutput = null,
  requireBundledResource = false,
} = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  const raw = await readFile(resolvedConfigPath, "utf8");
  const config = JSON.parse(raw);
  const bundle = config.bundle ?? {};

  if (bundle.active !== true) {
    fail("bundle.active must be true for release packaging.");
  }

  if (bundle.createUpdaterArtifacts !== true) {
    fail(
      "bundle.createUpdaterArtifacts must be true for signed updater artifacts.",
    );
  }

  const targets = bundle.targets === "all" ? requiredTargets : bundle.targets;
  if (!Array.isArray(targets)) {
    fail(
      "bundle.targets must be an explicit target array for release packaging.",
    );
  }

  const missingTargets = requiredTargets.filter(
    (target) => !targets.includes(target),
  );
  if (missingTargets.length > 0) {
    fail(`bundle.targets is missing: ${missingTargets.join(", ")}`);
  }

  await validateLinuxAppImageIcon({
    bundle,
    targets,
    tauriDir: path.dirname(resolvedConfigPath),
  });

  const resources = requireObject(
    bundle.resources,
    "bundle.resources must map the git-dist directory to the packaged path.",
  );
  const gitDistEntry = Object.entries(resources).find(([source, target]) => {
    return (
      normalizeResourcePath(source) === "resources/git-dist" &&
      normalizeResourcePath(target) === "git-dist"
    );
  });

  if (!gitDistEntry) {
    fail('bundle.resources must include "resources/git-dist/": "git-dist/".');
  }

  const [source] = gitDistEntry;
  const tauriDir = path.dirname(resolvedConfigPath);
  const linuxConfigPath = await validateLinuxBundleResourceConfig(tauriDir);
  const sourcePath = path.resolve(tauriDir, source);
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    if (!requireManifest) {
      info(
        `configured git-dist source will be created by git-toolchain:ensure: ${sourcePath}`,
      );
      return {
        config,
        configPath: resolvedConfigPath,
        linuxConfigPath,
        sourcePath,
      };
    }
    fail(`git-dist resource source must be a directory: ${sourcePath}`);
  }

  const manifestPath = path.join(sourcePath, "manifest.json");
  if (requireManifest && !(await pathExists(manifestPath))) {
    fail(`real release packaging requires staged ${manifestPath}`);
  }
  const stagedManifestCheck = requireManifest
    ? await validateBundledGitDistManifest(manifestPath)
    : null;

  if (releaseMode) {
    const pubkey = config.plugins?.updater?.pubkey;
    if (
      typeof pubkey !== "string" ||
      pubkey.length === 0 ||
      /REPLACE|TODO|PLACEHOLDER/i.test(pubkey)
    ) {
      fail(
        "release packaging requires plugins.updater.pubkey to be the generated Tauri updater public key, not a placeholder.",
      );
    }

    const endpoints = config.plugins?.updater?.endpoints;
    if (
      !Array.isArray(endpoints) ||
      !endpoints.includes(releaseLatestJsonEndpoint)
    ) {
      fail(
        "release packaging requires the GitHub Releases latest.json updater endpoint.",
      );
    }
  }

  const bundledManifestPaths = bundleOutput
    ? await findBundledGitDistManifests(bundleOutput)
    : [];
  if (requireBundledResource && bundledManifestPaths.length === 0) {
    fail(
      `packaged output must contain git-dist/manifest.json under ${path.resolve(
        bundleOutput ?? ".",
      )}`,
    );
  }
  const bundledManifestChecks =
    requireBundledResource || bundledManifestPaths.length > 0
      ? await Promise.all(
          bundledManifestPaths.map((currentManifestPath) =>
            validateBundledGitDistManifest(currentManifestPath),
          ),
        )
      : [];
  if (stagedManifestCheck) {
    for (const packaged of bundledManifestChecks) {
      for (const key of [
        "target",
        "toolchainRevision",
        "baseFingerprint",
        "helperFingerprint",
        "distributionFingerprint",
      ]) {
        if (packaged.manifest[key] !== stagedManifestCheck.manifest[key]) {
          fail(
            `packaged git-dist manifest.${key} does not match staged toolchain: ${packaged.manifestPath}`,
          );
        }
      }
    }
  }

  return {
    sourcePath,
    manifestPath,
    stagedManifestCheck,
    linuxConfigPath,
    bundledManifestPaths,
    bundledManifestChecks,
  };
}

async function validateLinuxAppImageIcon({ bundle, targets, tauriDir }) {
  if (!targets.includes("appimage")) {
    return;
  }

  const icons = bundle.icon;
  if (!Array.isArray(icons) || icons.length === 0) {
    fail("bundle.icon must include a square PNG icon for Linux AppImage.");
  }

  const pngIcons = icons.filter((icon) =>
    String(icon).toLowerCase().endsWith(".png"),
  );
  if (pngIcons.length === 0) {
    fail("bundle.icon must include a square PNG icon for Linux AppImage.");
  }

  const checked = [];
  for (const icon of pngIcons) {
    const normalized = normalizeResourcePath(icon);
    if (
      normalized.startsWith("/") ||
      normalized === "." ||
      normalized.split("/").some((part) => part === ".." || part === "")
    ) {
      fail(`bundle.icon path must stay inside src-tauri: ${icon}`);
    }
    const iconPath = path.join(tauriDir, normalized);
    const dimensions = await readPngDimensions(iconPath).catch(() => null);
    if (!dimensions) {
      fail(`bundle.icon PNG is missing or invalid: ${iconPath}`);
    }
    checked.push(`${normalized} (${dimensions.width}x${dimensions.height})`);
    if (dimensions.width === dimensions.height) {
      return;
    }
  }

  fail(
    `bundle.icon must include at least one square PNG icon for Linux AppImage; checked ${checked.join(", ")}`,
  );
}

async function readPngDimensions(filePath) {
  const buffer = await readFile(filePath);
  const pngSignature = "89504e470d0a1a0a";
  if (
    buffer.length < 24 ||
    buffer.subarray(0, 8).toString("hex") !== pngSignature ||
    buffer.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error(`invalid PNG: ${filePath}`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function validateBundledGitDistManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(
      `packaged git-dist manifest is not valid JSON: ${manifestPath}: ${error.message}`,
    );
  }
  const root = path.dirname(manifestPath);
  const paths = requireObject(
    manifest.paths,
    `packaged git-dist manifest must contain paths: ${manifestPath}`,
  );
  const sha256 = requireObject(
    manifest.sha256,
    `packaged git-dist manifest must contain sha256: ${manifestPath}`,
  );
  if (
    !Array.isArray(manifest.executablePaths) ||
    manifest.executablePaths.length === 0
  ) {
    fail(
      `packaged git-dist manifest must contain executablePaths: ${manifestPath}`,
    );
  }
  const checked = [];
  const checkedPaths = new Set();
  for (const [key, relativePath] of Object.entries(paths)) {
    const normalized = assertRelativeManifestPath(
      relativePath,
      key,
      manifestPath,
    );
    const filePath = path.join(root, normalized);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      fail(`packaged git-dist executable is missing for ${key}: ${filePath}`);
    }
    const expectedSha = sha256[normalized];
    if (typeof expectedSha !== "string" || expectedSha.trim() === "") {
      fail(`packaged git-dist manifest.sha256 is missing ${normalized}`);
    }
    const actualSha = await sha256File(filePath);
    if (actualSha !== expectedSha.toLowerCase()) {
      fail(
        `packaged git-dist sha256 mismatch for ${normalized}: expected ${expectedSha}, got ${actualSha}`,
      );
    }
    checkedPaths.add(normalized);
    checked.push({ key, path: normalized, sha256: actualSha });
  }
  for (const [relativePath, expectedSha] of Object.entries(sha256)) {
    const normalized = assertRelativeManifestPath(
      relativePath,
      `sha256 key ${relativePath}`,
      manifestPath,
    );
    const filePath = path.join(root, normalized);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      fail(`packaged git-dist manifest.sha256 file is missing: ${filePath}`);
    }
    const actualSha = await sha256File(filePath);
    if (actualSha !== String(expectedSha).toLowerCase()) {
      fail(
        `packaged git-dist sha256 mismatch for ${normalized}: expected ${expectedSha}, got ${actualSha}`,
      );
    }
    checkedPaths.add(normalized);
  }
  for (const relativePath of manifest.executablePaths) {
    const normalized = assertRelativeManifestPath(
      relativePath,
      "executablePaths entry",
      manifestPath,
    );
    if (!sha256[normalized]) {
      fail(`packaged git-dist executable is not hashed: ${normalized}`);
    }
    if (process.platform !== "win32") {
      const mode = (await stat(path.join(root, normalized))).mode;
      if ((mode & 0o111) === 0) {
        fail(`packaged git-dist executable is not executable: ${normalized}`);
      }
    }
  }
  const allowedUnmanifestedPaths = new Set(["manifest.json"]);
  const unmanifested = [];
  for (const relativePath of await regularFileResourcePaths(root)) {
    if (
      allowedUnmanifestedPaths.has(relativePath) ||
      checkedPaths.has(relativePath)
    ) {
      continue;
    }
    unmanifested.push(relativePath);
  }
  if (unmanifested.length > 0) {
    fail(
      `packaged git-dist contains regular files not covered by manifest.sha256: ${unmanifested.join(", ")}`,
    );
  }
  return { manifest, manifestPath, checked };
}

function assertRelativeManifestPath(value, key, manifestPath) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(
      `packaged git-dist manifest path ${key} must be a non-empty string: ${manifestPath}`,
    );
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized === "." ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    fail(
      `packaged git-dist manifest path ${key} must stay inside git-dist: ${value}`,
    );
  }
  return normalized;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function parseArgs(argv) {
  const options = {
    configPath: defaultTauriConfigPath,
    requireManifest: false,
    releaseMode: false,
    bundleOutput: null,
    requireBundledResource: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      if (arg.includes("=")) {
        return arg.slice(arg.indexOf("=") + 1);
      }
      index += 1;
      if (!argv[index]) {
        fail(`${name} requires a value`);
      }
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--config" || arg.startsWith("--config=")) {
      options.configPath = readValue("--config");
    } else if (arg === "--require-manifest") {
      options.requireManifest = true;
    } else if (arg === "--release") {
      options.releaseMode = true;
    } else if (
      arg === "--bundle-output" ||
      arg.startsWith("--bundle-output=")
    ) {
      options.bundleOutput = readValue("--bundle-output");
    } else if (arg === "--require-bundled-resource") {
      options.requireBundledResource = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return `Usage:
  node scripts/check-tauri-bundle-resources.mjs
  node scripts/check-tauri-bundle-resources.mjs --require-manifest
  node scripts/check-tauri-bundle-resources.mjs --require-manifest --release
  node scripts/check-tauri-bundle-resources.mjs --require-manifest --release --bundle-output target/<triple>/release --require-bundled-resource

Checks that Tauri bundles the embedded git-dist resource tree at the packaged
resource path expected by release builds. --require-manifest is for real release
jobs after the git-dist artifact has been staged. --release also requires the
public updater configuration to be ready for publishing. --require-bundled-resource
checks built output directories for git-dist/manifest.json and verifies every
manifest-declared executable checksum.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await checkTauriBundleResources(options);
  const status = [
    options.requireManifest
      ? "git-dist resources and release manifest are wired"
      : "git-dist resources are wired; manifest staging is deferred to release jobs",
  ];
  if (options.releaseMode) {
    status.push("updater release config is publish-ready");
  }
  if (options.requireBundledResource) {
    status.push(
      `packaged git-dist manifests checked: ${result.bundledManifestChecks.length}`,
    );
  }
  info(`${status.join("; ")}.`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(`tauri bundle resource check failed: ${error.message}`);
    process.exit(1);
  });
}
