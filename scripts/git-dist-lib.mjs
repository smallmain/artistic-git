/* global process */

import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
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

// Git for Windows bundles Git Credential Manager even though Artistic Git
// always injects its own credential helper. This is the exact runtime payload
// from the pinned GCM 2.8.0 archive, plus Git for Windows' selector shim.
export const WINDOWS_MINGIT_GCM_RUNTIME_FILES = Object.freeze([
  "mingw64/bin/Atlassian.Bitbucket.dll",
  "mingw64/bin/Avalonia.Base.dll",
  "mingw64/bin/Avalonia.Controls.dll",
  "mingw64/bin/Avalonia.DesignerSupport.dll",
  "mingw64/bin/Avalonia.Dialogs.dll",
  "mingw64/bin/Avalonia.Markup.Xaml.dll",
  "mingw64/bin/Avalonia.Markup.dll",
  "mingw64/bin/Avalonia.Metal.dll",
  "mingw64/bin/Avalonia.MicroCom.dll",
  "mingw64/bin/Avalonia.OpenGL.dll",
  "mingw64/bin/Avalonia.Remote.Protocol.dll",
  "mingw64/bin/Avalonia.Skia.dll",
  "mingw64/bin/Avalonia.Themes.Fluent.dll",
  "mingw64/bin/Avalonia.Vulkan.dll",
  "mingw64/bin/Avalonia.Win32.dll",
  "mingw64/bin/Avalonia.dll",
  "mingw64/bin/GitHub.dll",
  "mingw64/bin/GitLab.dll",
  "mingw64/bin/HarfBuzzSharp.dll",
  "mingw64/bin/MicroCom.Runtime.dll",
  "mingw64/bin/Microsoft.AzureRepos.dll",
  "mingw64/bin/Microsoft.Bcl.AsyncInterfaces.dll",
  "mingw64/bin/Microsoft.Identity.Client.Broker.dll",
  "mingw64/bin/Microsoft.Identity.Client.Extensions.Msal.dll",
  "mingw64/bin/Microsoft.Identity.Client.NativeInterop.dll",
  "mingw64/bin/Microsoft.Identity.Client.dll",
  "mingw64/bin/Microsoft.IdentityModel.Abstractions.dll",
  "mingw64/bin/SkiaSharp.dll",
  "mingw64/bin/System.Buffers.dll",
  "mingw64/bin/System.CommandLine.dll",
  "mingw64/bin/System.ComponentModel.Annotations.dll",
  "mingw64/bin/System.Diagnostics.DiagnosticSource.dll",
  "mingw64/bin/System.IO.FileSystem.AccessControl.dll",
  "mingw64/bin/System.Memory.dll",
  "mingw64/bin/System.Numerics.Vectors.dll",
  "mingw64/bin/System.Runtime.CompilerServices.Unsafe.dll",
  "mingw64/bin/System.Security.AccessControl.dll",
  "mingw64/bin/System.Security.Cryptography.ProtectedData.dll",
  "mingw64/bin/System.Security.Principal.Windows.dll",
  "mingw64/bin/System.Text.Encodings.Web.dll",
  "mingw64/bin/System.Text.Json.dll",
  "mingw64/bin/System.Threading.Tasks.Extensions.dll",
  "mingw64/bin/System.ValueTuple.dll",
  "mingw64/bin/av_libglesv2.dll",
  "mingw64/bin/gcmcore.dll",
  "mingw64/bin/git-credential-helper-selector.exe",
  "mingw64/bin/git-credential-manager.exe",
  "mingw64/bin/git-credential-manager.exe.config",
  "mingw64/bin/libHarfBuzzSharp.dll",
  "mingw64/bin/libSkiaSharp.dll",
  "mingw64/bin/msalruntime.dll",
]);

export const WINDOWS_MINGIT_REQUIRED_FILES = Object.freeze([
  "LICENSE.txt",
  "mingw64/bin/git-askpass.exe",
  "mingw64/bin/git-remote-https.exe",
  "mingw64/bin/git.exe",
  "mingw64/doc/git-credential-manager/LICENSE",
  "mingw64/doc/git-credential-manager/NOTICE",
  "mingw64/doc/git-credential-manager/README.md",
  "usr/bin/ssh-add.exe",
  "usr/bin/ssh-agent.exe",
  "usr/bin/ssh.exe",
  "usr/lib/ssh/ssh-pkcs11-helper.exe",
  "usr/lib/ssh/ssh-sk-helper.exe",
  "usr/share/licenses/openssh/LICENCE",
]);

// Win32-OpenSSH is retained as a complete client. Only server executables,
// host configuration, and service installation support are removed.
export const WINDOWS_OPENSSH_SERVER_FILES = Object.freeze([
  "FixHostFilePermissions.ps1",
  "install-sshd.ps1",
  "moduli",
  "openssh-events.man",
  "sftp-server.exe",
  "ssh-shellhost.exe",
  "sshd-auth.exe",
  "sshd-session.exe",
  "sshd.exe",
  "sshd_config_default",
  "uninstall-sshd.ps1",
]);

export const WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES = Object.freeze([
  "FixUserFilePermissions.ps1",
  "LICENSE.txt",
  "NOTICE.txt",
  "OpenSSHUtils.psd1",
  "OpenSSHUtils.psm1",
  "_manifest/spdx_2.2/ESRPClientLogs1022194139642.json",
  "_manifest/spdx_2.2/bsi.cose",
  "_manifest/spdx_2.2/bsi.json",
  "_manifest/spdx_2.2/manifest.cat",
  "_manifest/spdx_2.2/manifest.spdx.cose",
  "_manifest/spdx_2.2/manifest.spdx.json",
  "_manifest/spdx_2.2/manifest.spdx.json.sha256",
  "libcrypto.dll",
  "scp.exe",
  "sftp.exe",
  "ssh-add.exe",
  "ssh-agent.exe",
  "ssh-keygen.exe",
  "ssh-keyscan.exe",
  "ssh-pkcs11-helper.exe",
  "ssh-sk-helper.exe",
  "ssh.exe",
]);

const requiredVersionKeys = [
  "git",
  "git_for_windows",
  "git_lfs",
  "win32_openssh",
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
  if (
    typeof config.meta?.toolchain_revision !== "string" ||
    config.meta.toolchain_revision.length === 0
  ) {
    errors.push("meta.toolchain_revision must be a non-empty string");
  }
  if (
    typeof config.meta?.build_recipe_revision !== "string" ||
    config.meta.build_recipe_revision.length === 0
  ) {
    errors.push("meta.build_recipe_revision must be a non-empty string");
  }
  if (
    typeof config.helpers?.rust_toolchain !== "string" ||
    config.helpers.rust_toolchain.length === 0
  ) {
    errors.push("helpers.rust_toolchain must be a non-empty string");
  }
  if (config.helpers?.profile !== "git-toolchain-helper") {
    errors.push('helpers.profile must be "git-toolchain-helper"');
  }
  if (config.manifest?.schema_version !== 2) {
    errors.push("manifest.schema_version must be 2");
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

export function sourceAllowsPreviewFallback(source) {
  return (
    source?.placeholder === false &&
    source?.stable === false &&
    String(source?.channel ?? "").toLowerCase() === "preview" &&
    source?.fallback_when_no_stable === true
  );
}

export function sourceIsReleaseReady(source) {
  return (
    source?.placeholder === false &&
    (source?.stable === true || sourceAllowsPreviewFallback(source))
  );
}

export function sourceReadinessReason(source) {
  if (source?.placeholder === true) {
    return source.placeholder_reason ?? "source is marked as a placeholder";
  }
  if (sourceAllowsPreviewFallback(source)) {
    return (
      source.fallback_reason ??
      "preview source accepted because no stable release is available"
    );
  }
  if (source?.stable === false) {
    return "source is not stable and has no approved preview fallback";
  }
  return "source is release-ready";
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
      `manifest paths.${label} must stay inside the embedded toolchain root: ${value}`,
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

export async function assembleGitDistBase({
  config,
  targetName,
  stagingDir,
  outputDir,
}) {
  const resolvedOutputDir = path.resolve(outputDir);
  const tempOutputDir = path.join(
    path.dirname(resolvedOutputDir),
    `.${path.basename(resolvedOutputDir)}.base-${process.pid}-${Date.now()}`,
  );
  await rm(tempOutputDir, { recursive: true, force: true });
  await mkdir(tempOutputDir, { recursive: true });
  try {
    for (const { ref, source } of getTargetSources(config, targetName)) {
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
    await publishGitDistOutput(config, tempOutputDir, resolvedOutputDir);
  } catch (error) {
    await rm(tempOutputDir, { recursive: true, force: true });
    throw error;
  }
}

export async function assembleGitDistFromBase({
  baseDir,
  baseFingerprint,
  config,
  distributionFingerprint,
  helperDir,
  helperFingerprint,
  helperVersion,
  outputDir,
  targetName,
  toolchainRevision,
}) {
  const resolvedOutputDir = path.resolve(outputDir);
  const tempOutputDir = path.join(
    path.dirname(resolvedOutputDir),
    `.${path.basename(resolvedOutputDir)}.assembly-${process.pid}-${Date.now()}`,
  );
  await rm(tempOutputDir, { recursive: true, force: true });
  await mkdir(tempOutputDir, { recursive: true });
  try {
    await cp(baseDir, tempOutputDir, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await copyGitDistHelpers({
      config,
      targetName,
      tempOutputDir,
      helperDir,
    });
    const manifest = await createGitDistManifest({
      baseFingerprint,
      config,
      distributionFingerprint,
      distRoot: tempOutputDir,
      helperFingerprint,
      helperVersion,
      targetName,
      toolchainRevision,
    });
    await writeGitDistManifest(config, tempOutputDir, manifest);
    await publishGitDistOutput(config, tempOutputDir, resolvedOutputDir);
    return manifest;
  } catch (error) {
    await rm(tempOutputDir, { recursive: true, force: true });
    throw error;
  }
}

async function resolveGitDistHelperPaths({ config, targetName, helperDir }) {
  const paths = expectedManifestPaths(config, targetName);
  const helperBasenames = {
    credentialHelper: path.basename(paths.credentialHelper),
    sshAskpass: path.basename(paths.sshAskpass),
  };
  const resolved = {};
  const missing = [];

  for (const [key, basename] of Object.entries(helperBasenames)) {
    const candidates = [path.join(path.resolve(helperDir), basename)];
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
      "the internal helper cache must contain both required release binaries",
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
      "the internal base builder must extract every pinned source before assembly",
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
    verbatimSymlinks: true,
  });
}

async function finalizePreparedDist({ config, targetName, tempOutputDir }) {
  if (targetName === "windows-x86_64") {
    await pruneWindowsGitDist({ config, distRoot: tempOutputDir });
    return;
  }
  if (targetName !== "macos-universal") {
    return;
  }

  await finalizeMacosUniversalGitLfs({ config, tempOutputDir });
}

export async function pruneWindowsGitDist({ config, distRoot }) {
  const layout = config.resources.layout;
  const minGitRoot = path.join(distRoot, normalizeResourcePath(layout.git));
  const openSshRoot = path.join(
    distRoot,
    normalizeResourcePath(layout.windows_openssh),
  );

  await assertPinnedFilesRetained({
    label: "pinned MinGit client and license payload",
    paths: WINDOWS_MINGIT_REQUIRED_FILES,
    root: minGitRoot,
  });
  await assertPinnedFilesRetained({
    label: "pinned Win32-OpenSSH client, license, and SPDX payload",
    paths: WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES,
    root: openSshRoot,
  });

  // Preflight both sources before deleting either one. A partially extracted
  // pinned archive must never publish a partially pruned base cache.
  const gcmState = await inspectPinnedRemovalSet({
    label: "pinned MinGit GCM 2.8.0 runtime",
    paths: WINDOWS_MINGIT_GCM_RUNTIME_FILES,
    root: minGitRoot,
  });
  const openSshState = await inspectPinnedOpenSshInventory(openSshRoot);

  await removePinnedFiles(minGitRoot, gcmState.presentPaths);
  await removePinnedFiles(openSshRoot, openSshState.presentPaths);

  await inspectPinnedRemovalSet({
    label: "pinned MinGit GCM 2.8.0 runtime",
    paths: WINDOWS_MINGIT_GCM_RUNTIME_FILES,
    root: minGitRoot,
  });
  await inspectPinnedOpenSshInventory(openSshRoot);
  await assertPinnedFilesRetained({
    label: "pinned MinGit client and license payload",
    paths: WINDOWS_MINGIT_REQUIRED_FILES,
    root: minGitRoot,
  });
  await assertPinnedFilesRetained({
    label: "pinned Win32-OpenSSH client, license, and SPDX payload",
    paths: WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES,
    root: openSshRoot,
  });

  return {
    minGitGcm: {
      alreadyPruned: gcmState.alreadyPruned,
      removedFiles: gcmState.presentPaths.length,
    },
    openSshServer: {
      alreadyPruned: openSshState.alreadyPruned,
      removedFiles: openSshState.presentPaths.length,
    },
  };
}

async function assertPinnedFilesRetained({ label, paths, root }) {
  const invalid = [];
  for (const relativePath of paths) {
    const kind = await explicitFileKind(path.join(root, relativePath));
    if (kind !== "file") {
      invalid.push(`${relativePath} (${kind})`);
    }
  }
  if (invalid.length > 0) {
    throw new GitDistConfigError(`${label} is incomplete`, [
      `expected regular files: ${invalid.join(", ")}`,
    ]);
  }
}

async function inspectPinnedRemovalSet({ label, paths, root }) {
  const states = [];
  for (const relativePath of paths) {
    states.push({
      kind: await explicitFileKind(path.join(root, relativePath)),
      relativePath,
    });
  }
  const presentPaths = states
    .filter(({ kind }) => kind === "file")
    .map(({ relativePath }) => relativePath);
  const invalid = states.filter(
    ({ kind }) => kind !== "file" && kind !== "missing",
  );
  if (
    invalid.length > 0 ||
    (presentPaths.length > 0 && presentPaths.length !== paths.length)
  ) {
    const missing = states
      .filter(({ kind }) => kind === "missing")
      .map(({ relativePath }) => relativePath);
    throw new GitDistConfigError(`${label} is partially present`, [
      `expected either all ${paths.length} regular files or none`,
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(invalid.length > 0
        ? [
            `wrong type: ${invalid
              .map(({ kind, relativePath }) => `${relativePath} (${kind})`)
              .join(", ")}`,
          ]
        : []),
    ]);
  }
  return {
    alreadyPruned: presentPaths.length === 0,
    presentPaths,
  };
}

async function inspectPinnedOpenSshInventory(root) {
  const observed = (await regularFileResourcePaths(root)).sort();
  const retained = [...WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES].sort();
  const complete = [
    ...WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES,
    ...WINDOWS_OPENSSH_SERVER_FILES,
  ].sort();
  if (samePaths(observed, complete)) {
    return {
      alreadyPruned: false,
      presentPaths: [...WINDOWS_OPENSSH_SERVER_FILES],
    };
  }
  if (samePaths(observed, retained)) {
    return { alreadyPruned: true, presentPaths: [] };
  }

  const expected = new Set(complete);
  const actual = new Set(observed);
  const missing = complete.filter((relativePath) => !actual.has(relativePath));
  const unexpected = observed.filter(
    (relativePath) => !expected.has(relativePath),
  );
  throw new GitDistConfigError(
    "pinned Win32-OpenSSH archive inventory is not recognized",
    [
      `expected either ${complete.length} complete files or ${retained.length} client-only files`,
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0
        ? [`unexpected: ${unexpected.join(", ")}`]
        : []),
    ],
  );
}

async function explicitFileKind(filePath) {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  if (fileStat.isFile()) {
    return "file";
  }
  if (fileStat.isDirectory()) {
    return "directory";
  }
  if (fileStat.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

async function removePinnedFiles(root, relativePaths) {
  for (const relativePath of relativePaths) {
    await rm(path.join(root, relativePath));
  }
}

function samePaths(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
}) {
  const helperPaths = await resolveGitDistHelperPaths({
    config,
    targetName,
    helperDir,
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

export async function createGitDistManifest({
  baseFingerprint,
  config,
  distributionFingerprint,
  distRoot,
  helperFingerprint,
  helperVersion,
  targetName,
  toolchainRevision,
}) {
  const target = getTarget(config, targetName);
  const paths = expectedManifestPaths(config, targetName);
  await assertRequiredDistFiles(config, targetName, distRoot, paths);

  const manifestPath = normalizeResourcePath(config.resources.layout.manifest);
  const sha256 = {};
  const executablePaths = [];
  const resourcePaths = await regularFileResourcePaths(distRoot);
  for (const relativePath of resourcePaths) {
    if (relativePath === manifestPath) {
      continue;
    }
    const absolutePath = path.join(distRoot, relativePath);
    sha256[relativePath] = await sha256File(absolutePath);
    if (
      target.platform !== "windows" &&
      ((await stat(absolutePath)).mode & 0o111) !== 0
    ) {
      executablePaths.push(relativePath);
    }
  }
  if (target.platform === "windows") {
    for (const key of requiredExecutableKeysForTarget(config, targetName)) {
      executablePaths.push(paths[key]);
    }
  }

  return {
    schemaVersion: config.manifest.schema_version,
    target: targetName,
    platform: target.manifest_platform,
    toolchainRevision,
    baseFingerprint,
    helperFingerprint,
    distributionFingerprint,
    gitVersion:
      target.platform === "windows"
        ? config.versions.git_for_windows
        : config.versions.git,
    gitLfsVersion: config.versions.git_lfs,
    windowsOpenSshVersion:
      target.platform === "windows" ? config.versions.win32_openssh : null,
    helperVersion,
    paths,
    executablePaths: [...new Set(executablePaths)].sort(),
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

export async function regularFileResourcePaths(root) {
  const files = [];
  const rootRealPath = await realpath(root);

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
      } else if (entry.isSymbolicLink()) {
        const fileStat = await stat(absolutePath).catch(() => null);
        if (!fileStat?.isFile()) {
          continue;
        }
        const realFilePath = await realpath(absolutePath);
        if (!isPathInside(realFilePath, rootRealPath)) {
          throw new GitDistConfigError(
            "git-dist manifest path resolves outside resource root",
            [`${relativePath} -> ${realFilePath}`],
          );
        }
        files.push(relativePath);
      }
    }
  }

  await walk(root, "");
  return files;
}

export async function writeGitDistManifest(config, distRoot, manifest) {
  const manifestPath = path.join(distRoot, config.resources.layout.manifest);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function publishGitDistOutput(_config, tempOutputDir, outputDir) {
  await mkdir(path.dirname(outputDir), { recursive: true });
  const backup = `${outputDir}.backup-${process.pid}-${Date.now()}`;
  const hadOutput = await pathExists(outputDir);
  if (hadOutput) {
    await rename(outputDir, backup);
  }
  try {
    await rename(tempOutputDir, outputDir);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    if (hadOutput && (await pathExists(backup))) {
      await rename(backup, outputDir);
    }
    throw error;
  }
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

function isPathInside(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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

  if (source.channel !== undefined && typeof source.channel !== "string") {
    errors.push(`${ref}.channel must be a string when present`);
  }

  if (
    source.fallback_when_no_stable !== undefined &&
    typeof source.fallback_when_no_stable !== "boolean"
  ) {
    errors.push(`${ref}.fallback_when_no_stable must be true or false`);
  }

  if (source.fallback_when_no_stable === true) {
    if (source.placeholder !== false || source.stable !== false) {
      errors.push(
        `${ref}.fallback_when_no_stable is only valid for non-placeholder non-stable sources`,
      );
    }
    if (String(source.channel ?? "").toLowerCase() !== "preview") {
      errors.push(
        `${ref}.fallback_when_no_stable requires channel = "preview"`,
      );
    }
    if (
      typeof source.fallback_reason !== "string" ||
      source.fallback_reason.length === 0
    ) {
      errors.push(
        `${ref}.fallback_reason must explain the approved preview fallback`,
      );
    }
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
  if (source.stable === false && !sourceAllowsPreviewFallback(source)) {
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
