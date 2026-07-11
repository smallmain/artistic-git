import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  configPath,
  expectedManifestPaths,
  getHostTarget,
  getTarget,
  getTargetSources,
  loadGitDistConfig,
  repoRoot,
  supportedTargets,
  validateGitDistConfig,
} from "./git-dist-lib.mjs";

export const toolchainLockPath = path.join(repoRoot, "git-toolchain.lock.json");
export const activeToolchainRoot = path.join(
  repoRoot,
  "src-tauri",
  "resources",
  "git-dist",
);
export const toolchainCacheRoot = path.join(
  repoRoot,
  ".cache",
  "artistic-git",
  "git-toolchain",
);

const helperSourceRoots = [
  path.join(repoRoot, "crates", "helpers"),
  path.join(repoRoot, "crates", "contracts"),
];
const helperInputFiles = [
  path.join(repoRoot, "Cargo.toml"),
  path.join(repoRoot, "Cargo.lock"),
];
const baseBuilderFiles = [
  path.join(repoRoot, "scripts", "fetch-git-dist.mjs"),
  path.join(repoRoot, "scripts", "git-dist-lib.mjs"),
];
const helperBuilderFiles = [
  path.join(repoRoot, "scripts", "build-git-toolchain-helpers.mjs"),
];

export function normalizeTarget(value = getHostTarget()) {
  const aliases = {
    darwin: "macos-universal",
    linux: "linux-x86_64",
    macos: "macos-universal",
    win32: "windows-x86_64",
    windows: "windows-x86_64",
  };
  const target = aliases[value] ?? value;
  if (!supportedTargets.includes(target)) {
    throw new Error(
      `unsupported embedded toolchain target '${value}'; expected ${supportedTargets.join(", ")}`,
    );
  }
  return target;
}

export async function loadToolchainDefinition({ requireLock = true } = {}) {
  const { data: config } = await loadGitDistConfig(configPath);
  validateGitDistConfig(config, {
    allowPlaceholders: false,
    realBuild: true,
  });

  const revision = requireNonEmptyString(
    config.meta?.toolchain_revision,
    "meta.toolchain_revision",
  );
  const helperRustToolchain = requireNonEmptyString(
    config.helpers?.rust_toolchain,
    "helpers.rust_toolchain",
  );
  const helperVersion = await readCargoPackageVersion(
    path.join(repoRoot, "crates", "helpers", "Cargo.toml"),
  );
  const targetDefinitions = {};
  for (const targetName of supportedTargets) {
    targetDefinitions[targetName] = await computeBaseDefinition({
      config,
      targetName,
    });
  }

  let lock = null;
  if (requireLock) {
    lock = await readToolchainLock();
    assertToolchainLock({ lock, revision, targetDefinitions });
  }

  return {
    config,
    helperRustToolchain,
    helperVersion,
    lock,
    revision,
    targetDefinitions,
  };
}

export async function createToolchainLock(revision) {
  const { data: config } = await loadGitDistConfig(configPath);
  validateGitDistConfig(config, {
    allowPlaceholders: false,
    realBuild: true,
  });
  if (config.meta?.toolchain_revision !== revision) {
    throw new Error(
      `git-dist.toml meta.toolchain_revision must be '${revision}' before updating the lock`,
    );
  }

  const current = await readToolchainLock();
  if (current?.toolchainRevision === revision) {
    throw new Error(
      `toolchain revision '${revision}' is already locked; choose a new revision`,
    );
  }

  const targets = {};
  for (const targetName of supportedTargets) {
    const definition = await computeBaseDefinition({ config, targetName });
    targets[targetName] = {
      definitionFingerprint: definition.fingerprint,
      sourceChecksums: definition.sourceChecksums,
    };
  }

  return {
    schemaVersion: 1,
    toolchainRevision: revision,
    targets,
  };
}

export async function writeToolchainLock(lock) {
  await writeFile(toolchainLockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

export async function computeToolchainState(targetName) {
  const target = normalizeTarget(targetName);
  const definition = await loadToolchainDefinition();
  const baseFingerprint = definition.lock.targets[target].definitionFingerprint;
  const helperFingerprint = await computeHelperFingerprint({
    config: definition.config,
    helperRustToolchain: definition.helperRustToolchain,
    targetName: target,
  });
  const distributionFingerprint = sha256Canonical({
    baseFingerprint,
    helperFingerprint,
    manifestSchemaVersion: definition.config.manifest.schema_version,
    resourcePaths: expectedManifestPaths(definition.config, target),
    target,
    toolchainRevision: definition.revision,
  });

  return {
    ...definition,
    baseFingerprint,
    helperFingerprint,
    distributionFingerprint,
    target,
    targetConfig: getTarget(definition.config, target),
  };
}

export function cachePaths(state) {
  return {
    baseRoot: path.join(
      toolchainCacheRoot,
      "bases",
      state.target,
      state.baseFingerprint,
      "tree",
    ),
    downloadsRoot: path.join(toolchainCacheRoot, "downloads"),
    helperRoot: path.join(
      toolchainCacheRoot,
      "helpers",
      state.target,
      state.helperFingerprint,
      "bin",
    ),
    locksRoot: path.join(toolchainCacheRoot, "locks"),
    workRoot: path.join(toolchainCacheRoot, "work", state.target),
  };
}

export async function ensureCacheDirectories(state) {
  const paths = cachePaths(state);
  await Promise.all(
    [paths.downloadsRoot, paths.locksRoot, paths.workRoot].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  return paths;
}

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sha256Canonical(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export async function computeBaseDefinition({ config, targetName }) {
  const target = getTarget(config, targetName);
  const sources = getTargetSources(config, targetName).map(
    ({ ref, source }) => ({
      ref,
      source,
    }),
  );
  const builderFiles = {};
  for (const filePath of baseBuilderFiles) {
    builderFiles[fingerprintRelativePath(filePath)] =
      await sha256Path(filePath);
  }
  const recipes = {
    gitLfs: config.build?.git_lfs ?? null,
    platform: config.build?.[target.platform] ?? null,
    win32OpenSsh:
      target.platform === "windows"
        ? (config.build?.win32_openssh ?? null)
        : null,
  };
  const versionKeys = new Set();
  for (const { source } of sources) {
    for (const key of [source.version_key, source.package_version_key]) {
      if (key) versionKeys.add(key);
    }
  }
  const versions = Object.fromEntries(
    [...versionKeys].sort().map((key) => [key, config.versions?.[key]]),
  );
  const expectedPaths = expectedManifestPaths(config, targetName);
  const resourcePaths = Object.fromEntries(
    ["gitExecutable", "gitLfsExecutable", "windowsSshExecutable"]
      .filter((key) => expectedPaths[key])
      .map((key) => [key, expectedPaths[key]]),
  );
  const input = {
    builderFiles,
    buildRecipeRevision: config.meta?.build_recipe_revision,
    recipes,
    resourcePaths,
    sources,
    target,
    targetName,
    versions,
  };
  return {
    fingerprint: sha256Canonical(input),
    input,
    sourceChecksums: Object.fromEntries(
      sources.map(({ ref, source }) => [
        ref,
        source.checksum.value.toLowerCase(),
      ]),
    ),
  };
}

async function computeHelperFingerprint({
  config,
  helperRustToolchain,
  targetName,
}) {
  const inputs = {
    builderFiles: {},
    files: {},
    profile: config.helpers.profile,
    rustToolchain: helperRustToolchain,
    target: targetName,
    targetTriples:
      targetName === "macos-universal"
        ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
        : [targetTriple(targetName)],
  };
  for (const filePath of helperBuilderFiles) {
    inputs.builderFiles[fingerprintRelativePath(filePath)] =
      await sha256Path(filePath);
  }
  for (const root of helperSourceRoots) {
    for (const filePath of await regularFiles(root)) {
      inputs.files[fingerprintRelativePath(filePath)] =
        await sha256Path(filePath);
    }
  }
  for (const filePath of helperInputFiles) {
    inputs.files[fingerprintRelativePath(filePath)] =
      await sha256Path(filePath);
  }
  return sha256Canonical(inputs);
}

function assertToolchainLock({ lock, revision, targetDefinitions }) {
  if (lock.schemaVersion !== 1) {
    throw new Error("git-toolchain.lock.json schemaVersion must be 1");
  }
  if (lock.toolchainRevision !== revision) {
    throw new Error(
      `toolchain lock revision '${lock.toolchainRevision}' does not match git-dist.toml '${revision}'; run pnpm git-toolchain:update with a new revision`,
    );
  }
  for (const targetName of supportedTargets) {
    const expected = targetDefinitions[targetName].fingerprint;
    const actual = lock.targets?.[targetName]?.definitionFingerprint;
    if (actual !== expected) {
      throw new Error(
        `third-party toolchain definition changed for ${targetName} without a manual revision update`,
      );
    }
  }
}

async function readToolchainLock() {
  return JSON.parse(await readFile(toolchainLockPath, "utf8"));
}

async function readCargoPackageVersion(manifestPath) {
  const raw = await readFile(manifestPath, "utf8");
  const version = raw.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  return requireNonEmptyString(version, `${manifestPath} package.version`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function targetTriple(targetName) {
  const triples = {
    "linux-x86_64": "x86_64-unknown-linux-gnu",
    "windows-x86_64": "x86_64-pc-windows-msvc",
  };
  return triples[targetName] ?? targetName;
}

async function regularFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  await walk(root);
  return files;
}

async function sha256Path(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`fingerprint input must be a regular file: ${filePath}`);
  }
  return sha256FingerprintText(await readFile(filePath, "utf8"));
}

function fingerprintRelativePath(filePath) {
  return normalizeFingerprintPath(path.relative(repoRoot, filePath));
}

export function normalizeFingerprintPath(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

export function sha256FingerprintText(content) {
  return createHash("sha256")
    .update(content.replaceAll("\r\n", "\n"))
    .digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
