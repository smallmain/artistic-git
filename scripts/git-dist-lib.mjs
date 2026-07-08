/* global process */

import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const configPath = path.join(repoRoot, "git-dist.toml");

export const supportedTargets = [
  "windows-x86_64",
  "macos-universal",
  "linux-x86_64",
];

const zeroSha256 = "0".repeat(64);
const sha256Pattern = /^[a-f0-9]{64}$/i;

const hostTargetByPlatform = {
  win32: "windows-x86_64",
  darwin: "macos-universal",
  linux: "linux-x86_64",
};

const requiredVersionKeys = [
  "git",
  "git_for_windows",
  "git_lfs",
  "win32_openssh",
  "helper",
];

const requiredLayoutKeys = [
  "root",
  "manifest",
  "git",
  "git_executable",
  "git_executable_windows",
  "git_lfs",
  "git_lfs_executable",
  "git_lfs_executable_windows",
  "windows_openssh",
  "windows_ssh_executable",
  "helpers",
  "credential_helper",
  "credential_helper_windows",
  "ssh_askpass",
  "ssh_askpass_windows",
];

export class GitDistConfigError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "GitDistConfigError";
    this.details = details;
  }
}

export async function loadGitDistConfig(filePath = configPath) {
  const raw = await readFile(filePath, "utf8");
  return {
    filePath,
    raw,
    data: parseToml(raw),
  };
}

export function parseToml(text) {
  const root = {};
  let table = root;

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      table = ensureTable(root, splitDottedKey(header[1].trim()), index + 1);
      continue;
    }

    const equalsIndex = findUnquotedEquals(line);
    if (equalsIndex === -1) {
      throw new GitDistConfigError(
        `invalid TOML assignment on line ${index + 1}: ${rawLine}`,
      );
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = parseTomlValue(line.slice(equalsIndex + 1).trim(), index + 1);
    setDottedValue(table, splitDottedKey(key), value, index + 1);
  }

  return root;
}

export function validateGitDistConfig(config, options = {}) {
  const {
    realBuild = false,
    targetName,
    requireAllTargets = true,
    allowPlaceholders = !realBuild,
  } = options;
  const errors = [];
  const warnings = [];

  if (config.schema_version !== 1) {
    errors.push("schema_version must be 1");
  }

  for (const key of requiredVersionKeys) {
    const value = config.versions?.[key];
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`versions.${key} must be a non-empty string`);
    }
  }

  for (const key of requiredLayoutKeys) {
    const value = config.resources?.layout?.[key];
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`resources.layout.${key} must be a non-empty string`);
    }
  }

  const targets = config.targets ?? {};
  const targetNames = targetName ? [targetName] : Object.keys(targets);
  if (requireAllTargets) {
    for (const requiredTarget of supportedTargets) {
      if (!targets[requiredTarget]) {
        errors.push(`targets.${requiredTarget} is required`);
      }
    }
  }

  if (targetName && !targets[targetName]) {
    errors.push(
      `unknown git-dist target '${targetName}'. Supported targets: ${supportedTargets.join(", ")}`,
    );
  }

  const placeholders = [];
  for (const name of targetNames) {
    const target = targets[name];
    if (!target) {
      continue;
    }

    validateTarget(config, name, target, errors);
    for (const sourceRef of target.sources ?? []) {
      const source = getSourceByRef(config, sourceRef);
      if (!source) {
        errors.push(`targets.${name}.sources references missing ${sourceRef}`);
        continue;
      }

      validateSource(config, sourceRef, source, errors, warnings);
      placeholders.push(
        ...collectSourcePlaceholders(config, sourceRef, source),
      );
    }
  }

  if (!allowPlaceholders && placeholders.length > 0) {
    errors.push(
      `real build mode rejects placeholder pins: ${placeholders.join("; ")}`,
    );
  }

  if (errors.length > 0) {
    throw new GitDistConfigError("git-dist.toml validation failed", errors);
  }

  return { warnings, placeholders };
}

export function getHostTarget(platform = process.platform) {
  return hostTargetByPlatform[platform] ?? "linux-x86_64";
}

export function getTarget(config, targetName) {
  const target = config.targets?.[targetName];
  if (!target) {
    throw new GitDistConfigError(`unknown git-dist target: ${targetName}`);
  }
  return target;
}

export function getTargetSources(config, targetName) {
  const target = getTarget(config, targetName);
  return target.sources.map((sourceRef) => ({
    ref: sourceRef,
    source: getSourceByRef(config, sourceRef),
  }));
}

export function getSourceByRef(config, ref) {
  return ref.split(".").reduce((node, key) => node?.[key], config);
}

export function expectedManifestPaths(config, targetName) {
  const target = getTarget(config, targetName);
  const layout = config.resources.layout;
  const windows = target.platform === "windows";
  const paths = {
    gitExecutable: windows
      ? layout.git_executable_windows
      : layout.git_executable,
    gitLfsExecutable: windows
      ? layout.git_lfs_executable_windows
      : layout.git_lfs_executable,
    credentialHelper: windows
      ? layout.credential_helper_windows
      : layout.credential_helper,
    sshAskpass: windows ? layout.ssh_askpass_windows : layout.ssh_askpass,
  };

  if (windows) {
    paths.windowsSshExecutable = layout.windows_ssh_executable;
  }

  return paths;
}

export function requiredExecutableKeysForTarget(config, targetName) {
  return Object.keys(expectedManifestPaths(config, targetName));
}

export function assertRelativeResourcePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitDistConfigError(
      `manifest paths.${label} must be a non-empty relative path`,
    );
  }
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes("..")) {
    throw new GitDistConfigError(
      `manifest paths.${label} must stay inside ARTISTIC_GIT_DIST_DIR: ${value}`,
    );
  }
}

export function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new GitDistConfigError(`${label} must be a SHA-256 hex string`);
  }
}

export function isPlaceholderChecksum(value) {
  return value === zeroSha256;
}

export async function sha256File(filePath) {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export function sourceStagingDirectory(stagingDir, sourceRef) {
  return path.join(stagingDir, sourceRef.replaceAll(".", "__"));
}

export async function assembleGitDist({
  config,
  targetName,
  stagingDir,
  outputDir,
  helperDir,
  credentialHelperPath,
  sshAskpassPath,
  cargoTargetDir = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR)
    : path.join(repoRoot, "target"),
  helperProfile = "auto",
}) {
  const sources = getTargetSources(config, targetName);
  const resolvedOutputDir = path.resolve(outputDir);
  const tempOutputDir = path.join(
    path.dirname(resolvedOutputDir),
    `.${path.basename(resolvedOutputDir)}.assembly-${process.pid}-${Date.now()}`,
  );

  await rm(tempOutputDir, { recursive: true, force: true });
  await mkdir(tempOutputDir, { recursive: true });

  try {
    for (const { ref, source } of sources) {
      if (source.kind !== "archive" && source.kind !== "source-tarball") {
        throw new GitDistConfigError("git-dist assembly failed", [
          `${ref}.kind=${source.kind} is not supported by archive assembly`,
        ]);
      }
      await copyPreparedSource({
        config,
        targetName,
        stagingDir,
        tempOutputDir,
        ref,
        source,
      });
    }

    await finalizePreparedDist({ config, targetName, tempOutputDir });

    await copyGitDistHelpers({
      config,
      targetName,
      tempOutputDir,
      helperDir,
      credentialHelperPath,
      sshAskpassPath,
      cargoTargetDir,
      helperProfile,
    });

    const manifest = await createGitDistManifest({
      config,
      targetName,
      distRoot: tempOutputDir,
    });
    await writeGitDistManifest(config, tempOutputDir, manifest);
    await publishGitDistOutput(config, tempOutputDir, resolvedOutputDir);
    return manifest;
  } catch (error) {
    await rm(tempOutputDir, { recursive: true, force: true });
    throw error;
  }
}

export async function resolveGitDistHelperPaths({
  config,
  targetName,
  helperDir,
  credentialHelperPath,
  sshAskpassPath,
  cargoTargetDir = path.join(repoRoot, "target"),
  helperProfile = "auto",
}) {
  const paths = expectedManifestPaths(config, targetName);
  const helperBasenames = {
    credentialHelper: path.basename(paths.credentialHelper),
    sshAskpass: path.basename(paths.sshAskpass),
  };
  const explicitPaths = {
    credentialHelper: credentialHelperPath,
    sshAskpass: sshAskpassPath,
  };
  const profiles = helperProfiles(helperProfile);
  const resolved = {};
  const missing = [];

  for (const [key, basename] of Object.entries(helperBasenames)) {
    const candidates = helperCandidates({
      explicitPath: explicitPaths[key],
      helperDir,
      cargoTargetDir,
      profiles,
      basename,
    });
    const existing = await firstExistingFile(candidates);
    if (existing) {
      resolved[key] = existing;
    } else {
      missing.push(`${key} (${candidates.join(", ")})`);
    }
  }

  if (missing.length > 0) {
    throw new GitDistConfigError("git-dist helper binaries are required", [
      `missing: ${missing.join("; ")}`,
      "build them with `cargo build -p artistic-git-helpers --bins --release`, pass --helper-dir, or pass both --credential-helper and --ssh-askpass",
    ]);
  }

  return resolved;
}

async function copyPreparedSource({
  config,
  targetName,
  stagingDir,
  tempOutputDir,
  ref,
  source,
}) {
  const stagedSourceDir = sourceStagingDirectory(stagingDir, ref);
  const stagedStat = await stat(stagedSourceDir).catch(() => null);
  if (!stagedStat?.isDirectory()) {
    throw new GitDistConfigError("git-dist assembly failed", [
      `${ref} was not extracted under ${stagedSourceDir}`,
      "run without --no-extract or restore the staged archive contents before assembly",
    ]);
  }

  const expectedRelativePath = expectedComponentPathInSource(
    config,
    targetName,
    source,
  );
  const sourceRoot = await findArchiveContentRoot(
    stagedSourceDir,
    expectedRelativePath,
  );
  const destination = path.join(
    tempOutputDir,
    normalizeResourcePath(source.resources_path),
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(sourceRoot, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
}

async function finalizePreparedDist({ config, targetName, tempOutputDir }) {
  if (targetName !== "macos-universal") {
    return;
  }

  await finalizeMacosUniversalGitLfs({ config, tempOutputDir });
}

async function finalizeMacosUniversalGitLfs({ config, tempOutputDir }) {
  const layout = config.resources.layout;
  const gitLfsRoot = path.join(
    tempOutputDir,
    normalizeResourcePath(layout.git_lfs),
  );
  const destination = path.join(
    tempOutputDir,
    normalizeResourcePath(layout.git_lfs_executable),
  );

  if (await pathExists(destination)) {
    return;
  }

  const arm64Root = path.join(gitLfsRoot, "arm64");
  const x86Root = path.join(gitLfsRoot, "x86_64");
  const arm64Binary = await findExecutableByName(arm64Root, "git-lfs");
  const x86Binary = await findExecutableByName(x86Root, "git-lfs");
  if (!arm64Binary || !x86Binary) {
    throw new GitDistConfigError("git-dist assembly failed", [
      "macOS universal git-lfs requires both staged arm64 and x86_64 official binaries",
      `missing arm64 git-lfs under ${arm64Root}: ${arm64Binary ? "no" : "yes"}`,
      `missing x86_64 git-lfs under ${x86Root}: ${x86Binary ? "no" : "yes"}`,
    ]);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  if ((await sha256File(arm64Binary)) === (await sha256File(x86Binary))) {
    await cp(arm64Binary, destination, {
      force: true,
      preserveTimestamps: true,
    });
  } else if (process.platform === "darwin") {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      "lipo",
      ["-create", arm64Binary, x86Binary, "-output", destination],
      { encoding: "utf8" },
    );
    if (result.error) {
      throw new GitDistConfigError("git-dist assembly failed", [
        `lipo failed to start while creating universal git-lfs: ${result.error.message}`,
      ]);
    }
    if (result.status !== 0) {
      throw new GitDistConfigError("git-dist assembly failed", [
        `lipo failed while creating universal git-lfs: ${result.stderr || result.stdout || `exit ${result.status}`}`,
      ]);
    }
  } else {
    throw new GitDistConfigError("git-dist assembly failed", [
      "macOS universal git-lfs assembly requires lipo on macOS when architecture binaries differ",
      `arm64 binary: ${arm64Binary}`,
      `x86_64 binary: ${x86Binary}`,
    ]);
  }
  await chmod(destination, 0o755).catch(() => {});
  await rm(arm64Root, { recursive: true, force: true });
  await rm(x86Root, { recursive: true, force: true });
}

async function findExecutableByName(root, basename) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    return null;
  }

  const candidates = await directoryCandidates(root, 4);
  for (const directory of candidates) {
    const candidate = path.join(directory, basename);
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      return candidate;
    }
  }
  return null;
}

async function findArchiveContentRoot(stagedSourceDir, expectedRelativePath) {
  if (!expectedRelativePath) {
    return stagedSourceDir;
  }

  const candidates = await directoryCandidates(stagedSourceDir, 3);
  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, expectedRelativePath))) {
      return candidate;
    }
  }

  throw new GitDistConfigError("git-dist assembly failed", [
    `staged archive ${stagedSourceDir} does not contain expected ${expectedRelativePath}`,
  ]);
}

async function directoryCandidates(root, maxDepth) {
  const candidates = [root];

  async function walk(directory, depth) {
    if (depth >= maxDepth) {
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(directory, entry.name);
      candidates.push(child);
      await walk(child, depth + 1);
    }
  }

  await walk(root, 0);
  return candidates;
}

async function copyGitDistHelpers({
  config,
  targetName,
  tempOutputDir,
  helperDir,
  credentialHelperPath,
  sshAskpassPath,
  cargoTargetDir,
  helperProfile,
}) {
  const helperPaths = await resolveGitDistHelperPaths({
    config,
    targetName,
    helperDir,
    credentialHelperPath,
    sshAskpassPath,
    cargoTargetDir,
    helperProfile,
  });
  const manifestPaths = expectedManifestPaths(config, targetName);
  for (const [key, sourcePath] of Object.entries(helperPaths)) {
    await copyFileIntoDist(
      sourcePath,
      path.join(tempOutputDir, manifestPaths[key]),
    );
  }
}

async function copyFileIntoDist(sourcePath, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(sourcePath, destination, { force: true, preserveTimestamps: true });
  await chmod(destination, 0o755).catch(() => {});
}

async function createGitDistManifest({ config, targetName, distRoot }) {
  const target = getTarget(config, targetName);
  const paths = expectedManifestPaths(config, targetName);
  await assertRequiredDistFiles(config, targetName, distRoot, paths);

  const manifestPath = normalizeResourcePath(config.resources.layout.manifest);
  const sha256 = {};
  for (const relativePath of await regularFileResourcePaths(distRoot)) {
    if (relativePath === manifestPath) {
      continue;
    }
    sha256[relativePath] = await sha256File(path.join(distRoot, relativePath));
  }

  return {
    schemaVersion: config.manifest.schema_version,
    platform: target.manifest_platform,
    gitVersion:
      target.platform === "windows"
        ? config.versions.git_for_windows
        : config.versions.git,
    gitLfsVersion: config.versions.git_lfs,
    windowsOpenSshVersion:
      target.platform === "windows" ? config.versions.win32_openssh : null,
    helperVersion: config.versions.helper,
    paths,
    sha256,
  };
}

async function assertRequiredDistFiles(config, targetName, distRoot, paths) {
  const missing = [];
  for (const key of requiredExecutableKeysForTarget(config, targetName)) {
    const filePath = path.join(distRoot, paths[key]);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      missing.push(`${key}: ${paths[key]}`);
      continue;
    }
    await chmod(filePath, 0o755).catch(() => {});
  }

  if (missing.length > 0) {
    throw new GitDistConfigError("git-dist assembly failed", [
      `missing required executable files: ${missing.join(", ")}`,
      "no manifest was written",
    ]);
  }
}

async function regularFileResourcePaths(root) {
  const files = [];

  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(root, "");
  return files;
}

async function writeGitDistManifest(config, distRoot, manifest) {
  const manifestPath = path.join(distRoot, config.resources.layout.manifest);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function publishGitDistOutput(config, tempOutputDir, outputDir) {
  await mkdir(outputDir, { recursive: true });
  const manifestPath = normalizeResourcePath(config.resources.layout.manifest);
  const entries = [
    config.resources.layout.git,
    config.resources.layout.git_lfs,
    config.resources.layout.windows_openssh,
    config.resources.layout.helpers,
  ]
    .map(normalizeResourcePath)
    .filter(Boolean);

  for (const relativePath of entries) {
    const source = path.join(tempOutputDir, relativePath);
    const destination = path.join(outputDir, relativePath);
    await rm(destination, { recursive: true, force: true });
    if (await pathExists(source)) {
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
    }
  }

  await rm(path.join(outputDir, manifestPath), { force: true });
  await rename(
    path.join(tempOutputDir, manifestPath),
    path.join(outputDir, manifestPath),
  );
  await rm(tempOutputDir, { recursive: true, force: true });
}

function expectedComponentPathInSource(config, targetName, source) {
  const expectedPaths = expectedManifestPaths(config, targetName);
  const manifestKeyByComponent = {
    git: "gitExecutable",
    git_lfs: "gitLfsExecutable",
    win32_openssh: "windowsSshExecutable",
  };
  const manifestKey = manifestKeyByComponent[source.component];
  if (!manifestKey || !expectedPaths[manifestKey]) {
    return null;
  }

  const resourcePath = resourcePathWithTrailingSlash(source.resources_path);
  const expectedPath = normalizeResourcePath(expectedPaths[manifestKey]);
  if (!expectedPath.startsWith(resourcePath)) {
    return null;
  }
  return expectedPath.slice(resourcePath.length);
}

function helperProfiles(profile) {
  if (profile === "auto") {
    return ["release", "debug"];
  }
  if (profile === "release" || profile === "debug") {
    return [profile];
  }
  throw new GitDistConfigError("git-dist helper profile is invalid", [
    `--helper-profile must be auto, release, or debug; got ${profile}`,
  ]);
}

function helperCandidates({
  explicitPath,
  helperDir,
  cargoTargetDir,
  profiles,
  basename,
}) {
  if (explicitPath) {
    return [path.resolve(explicitPath)];
  }
  if (helperDir) {
    return [path.join(path.resolve(helperDir), basename)];
  }
  return profiles.map((profile) =>
    path.join(path.resolve(cargoTargetDir), profile, basename),
  );
}

async function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      return candidate;
    }
  }
  return null;
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
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function resourcePathWithTrailingSlash(value) {
  const normalized = normalizeResourcePath(value);
  return normalized ? `${normalized}/` : "";
}

function validateTarget(config, name, target, errors) {
  for (const key of [
    "platform",
    "arch",
    "artifact_name",
    "manifest_platform",
  ]) {
    if (typeof target[key] !== "string" || target[key].length === 0) {
      errors.push(`targets.${name}.${key} must be a non-empty string`);
    }
  }

  if (!Array.isArray(target.sources) || target.sources.length === 0) {
    errors.push(`targets.${name}.sources must list source refs`);
  }

  const expectedPaths = expectedManifestPaths(config, name);
  for (const [manifestKey, relativePath] of Object.entries(expectedPaths)) {
    try {
      assertRelativeResourcePath(relativePath, manifestKey);
    } catch (error) {
      errors.push(error.message);
    }
  }
}

function validateSource(config, ref, source, errors, warnings) {
  for (const key of ["component", "kind", "vendor", "url", "resources_path"]) {
    if (typeof source[key] !== "string" || source[key].length === 0) {
      errors.push(`${ref}.${key} must be a non-empty string`);
    }
  }

  if (typeof source.placeholder !== "boolean") {
    errors.push(`${ref}.placeholder must be true or false`);
  }

  if (typeof source.stable !== "boolean") {
    errors.push(`${ref}.stable must be true or false`);
  }

  try {
    assertRelativeResourcePath(source.resources_path, `${ref}.resources_path`);
  } catch (error) {
    errors.push(error.message);
  }

  if (!source.resources_path.endsWith("/")) {
    errors.push(`${ref}.resources_path must end with "/"`);
  }

  const versionKey = source.version_key;
  if (typeof versionKey !== "string" || !config.versions?.[versionKey]) {
    errors.push(`${ref}.version_key must point at a versions.* entry`);
  }

  const checksum = source.checksum;
  if (!checksum || typeof checksum !== "object") {
    errors.push(`${ref}.checksum table is required`);
  } else {
    if (checksum.algorithm !== "sha256") {
      errors.push(`${ref}.checksum.algorithm must be "sha256"`);
    }
    try {
      assertSha256(checksum.value, `${ref}.checksum.value`);
    } catch (error) {
      errors.push(error.message);
    }
    if (isPlaceholderChecksum(checksum.value)) {
      warnings.push(`${ref} still uses an all-zero placeholder checksum`);
    }
    if (typeof checksum.source !== "string" || checksum.source.length === 0) {
      errors.push(`${ref}.checksum.source must be a non-empty string`);
    }
  }
}

function collectSourcePlaceholders(config, ref, source) {
  const placeholders = [];
  const version = config.versions?.[source.version_key];
  const checksum = source.checksum?.value;

  if (source.placeholder) {
    placeholders.push(`${ref}.placeholder=true`);
  }
  if (source.stable === false) {
    placeholders.push(`${ref}.stable=false`);
  }
  if (typeof source.url === "string" && source.url.startsWith("TODO:")) {
    placeholders.push(`${ref}.url`);
  }
  if (typeof version === "string" && /placeholder|TODO/i.test(version)) {
    placeholders.push(`versions.${source.version_key}`);
  }
  if (checksum && isPlaceholderChecksum(checksum)) {
    placeholders.push(`${ref}.checksum.value`);
  }

  return placeholders;
}

function splitDottedKey(key) {
  return key.split(".").map((part) => part.trim());
}

function ensureTable(root, parts, lineNumber) {
  let node = root;
  for (const part of parts) {
    if (!part) {
      throw new GitDistConfigError(
        `empty TOML table segment on line ${lineNumber}`,
      );
    }
    if (node[part] === undefined) {
      node[part] = {};
    }
    if (!isPlainObject(node[part])) {
      throw new GitDistConfigError(
        `TOML table ${parts.join(".")} conflicts with an existing value on line ${lineNumber}`,
      );
    }
    node = node[part];
  }
  return node;
}

function setDottedValue(table, parts, value, lineNumber) {
  let node = table;
  for (const part of parts.slice(0, -1)) {
    if (!part) {
      throw new GitDistConfigError(
        `empty TOML key segment on line ${lineNumber}`,
      );
    }
    if (node[part] === undefined) {
      node[part] = {};
    }
    if (!isPlainObject(node[part])) {
      throw new GitDistConfigError(
        `TOML key ${parts.join(".")} conflicts with an existing value on line ${lineNumber}`,
      );
    }
    node = node[part];
  }

  const leaf = parts.at(-1);
  if (!leaf) {
    throw new GitDistConfigError(`empty TOML key on line ${lineNumber}`);
  }
  node[leaf] = value;
}

function parseTomlValue(value, lineNumber) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new GitDistConfigError(
        `invalid TOML string on line ${lineNumber}: ${error.message}`,
      );
    }
  }

  if (value.startsWith("[")) {
    if (!value.endsWith("]")) {
      throw new GitDistConfigError(
        `unterminated TOML array on line ${lineNumber}`,
      );
    }
    const body = value.slice(1, -1).trim();
    if (!body) {
      return [];
    }
    return splitArrayItems(body).map((item) =>
      parseTomlValue(item, lineNumber),
    );
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }

  throw new GitDistConfigError(
    `unsupported TOML value on line ${lineNumber}: ${value}`,
  );
}

function splitArrayItems(body) {
  const items = [];
  let current = "";
  let quote = false;
  let escaped = false;

  for (const char of body) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = false;
      }
      continue;
    }

    if (char === '"') {
      quote = true;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

function stripTomlComment(line) {
  let quote = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = false;
      }
      continue;
    }

    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function findUnquotedEquals(line) {
  let quote = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = false;
      }
      continue;
    }

    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === "=") {
      return index;
    }
  }

  return -1;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
