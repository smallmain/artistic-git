/* global process */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
