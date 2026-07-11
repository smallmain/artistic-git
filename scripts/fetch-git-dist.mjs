#!/usr/bin/env node
/* global AbortSignal, URL, clearInterval, console, fetch, process, setInterval, setTimeout */

import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assembleGitDistBase,
  getTarget,
  getTargetSources,
  sha256File,
  validateGitDistConfig,
} from "./git-dist-lib.mjs";
import { pathToFileURL } from "node:url";

let targetName;
let cacheDir;
let downloadLocksRoot;
let stagingDir;

function info(message) {
  console.log(`git-dist fetch: ${message}`);
}

function fail(message) {
  throw new Error(`git-dist build failed: ${message}`);
}

export async function buildGitToolchainBase({
  config,
  downloadsRoot,
  locksRoot,
  outputDir,
  target,
  workRoot,
}) {
  targetName = target;
  cacheDir = path.resolve(downloadsRoot);
  downloadLocksRoot = path.resolve(locksRoot);
  stagingDir = path.join(
    path.resolve(workRoot),
    `base-${process.pid}-${Date.now()}`,
    "staging",
  );
  validateGitDistConfig(config, {
    targetName,
    allowPlaceholders: false,
    realBuild: true,
  });

  const targetConfig = getTarget(config, targetName);
  const sources = getTargetSources(config, targetName);

  await mkdir(cacheDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  info(`target: ${targetName}`);

  for (const { ref, source } of sources) {
    const archivePath = await downloadSource(ref, source);
    await verifySource(ref, source, archivePath);
    await extractSource(ref, source, archivePath);
  }

  await buildSourceTarballs({ config, target: targetConfig, sources });
  await assembleGitDistBase({
    config,
    targetName,
    stagingDir,
    outputDir,
  });
  await rm(path.dirname(stagingDir), { recursive: true, force: true });
}

async function downloadSource(ref, source) {
  const expected = source.checksum.value.toLowerCase();
  return withDownloadLock(expected, () =>
    downloadSourceLocked({ expected, ref, source }),
  );
}

async function downloadSourceLocked({ expected, ref, source }) {
  const destination = path.join(cacheDir, expected, "asset");
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  for (const entry of await readdir(path.dirname(destination))) {
    if (entry.startsWith("asset.tmp-")) {
      await rm(path.join(path.dirname(destination), entry), { force: true });
    }
  }

  const existing = await stat(destination).catch(() => null);
  if (existing?.isFile()) {
    const actual = await sha256File(destination);
    if (actual === expected) {
      info(`reusing verified download for ${ref}`);
      return destination;
    }
    await rm(destination, { force: true });
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    info(`downloading ${ref}: ${source.url}`);
    try {
      const response = await fetch(source.url, {
        redirect: "follow",
        headers: {
          "User-Agent": "artistic-git-dist-fetch/phase-1a",
        },
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporary),
      );
      break;
    } catch (error) {
      await rm(temporary, { force: true });
      if (attempt === 3) {
        info(
          `built-in fetch failed for ${ref}; retrying the pinned URL with curl`,
        );
        const curl = spawnSync(
          "curl",
          [
            "--fail",
            "--location",
            "--retry",
            "3",
            "--retry-all-errors",
            "--output",
            temporary,
            source.url,
          ],
          { encoding: "utf8" },
        );
        if (curl.status !== 0) {
          fail(
            `download failed for ${ref}: ${curl.stderr || curl.stdout || error.message}`,
          );
        }
        break;
      }
      info(`retrying ${ref} after download failure: ${error.message}`);
    }
  }

  const actual = await sha256File(temporary);
  if (actual !== expected) {
    fail(
      `${ref} checksum mismatch after download: expected ${expected}, got ${actual}`,
    );
  }

  await renameOverExisting(temporary, destination);
  return destination;
}

async function withDownloadLock(checksum, callback) {
  await mkdir(downloadLocksRoot, { recursive: true });
  const lockPath = path.join(downloadLocksRoot, `download-${checksum}.lock`);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30 * 60 * 1000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for source download lock ${checksum}`,
          {
            cause: error,
          },
        );
      }
      await delay(250);
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => {});
  }, 10_000);
  heartbeat.unref();
  try {
    return await callback();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function verifySource(ref, source, archivePath) {
  const actual = await sha256File(archivePath);
  const expected = source.checksum.value.toLowerCase();
  if (actual !== expected) {
    fail(`${ref} checksum mismatch: expected ${expected}, got ${actual}`);
  }
  info(`verified ${ref}: sha256 ${actual}`);
  return actual;
}

async function extractSource(ref, source, archivePath) {
  const destination =
    source.kind === "source-tarball"
      ? path.join(stagedSourceDir(ref), "source")
      : stagedSourceDir(ref);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const archiveName =
    source.asset_name || path.basename(new URL(source.url).pathname);
  const command = extractionCommand(archivePath, destination, archiveName);
  if (!command) {
    fail(`no extractor is defined for ${archivePath}`);
  }

  info(`extracting ${ref} into ${destination}`);
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
    },
  });

  if (result.error) {
    fail(`extractor failed to start for ${ref}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `extractor failed for ${ref}: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
}

async function buildSourceTarballs({ config, target, sources }) {
  for (const { ref, source } of sources) {
    if (source.kind !== "source-tarball") {
      continue;
    }
    if (source.component !== "git") {
      fail(`${ref} source builds are only implemented for the git component`);
    }

    const stagedRoot = stagedSourceDir(ref);
    const sourceRoot = await findGitSourceRoot(path.join(stagedRoot, "source"));
    const installRoot = path.join(stagedRoot, "install");
    await rm(installRoot, { recursive: true, force: true });
    await mkdir(installRoot, { recursive: true });

    if (target.platform === "macos") {
      await buildMacosGit({ config, sourceRoot, installRoot });
    } else if (target.platform === "linux") {
      await buildLinuxGit({ config, sourceRoot, installRoot });
      await stripLinuxExecutables(installRoot);
    } else {
      fail(
        `${ref} has source-tarball kind but ${target.platform} has no source build recipe`,
      );
    }
    await ensureGitTransportBuiltinWrappers(installRoot);
    await normalizeGitExecutableCopies(installRoot);
    if (target.platform === "macos") {
      await stripMacosExecutables(installRoot);
    }
    await chmodTreeExecutables(installRoot);
  }
}

async function buildMacosGit({ config, sourceRoot, installRoot }) {
  if (process.platform !== "darwin") {
    fail("macOS Git source build must run on a macOS/Xcode runner.");
  }

  const recipe = config.build?.macos?.git;
  const arches = recipe?.arches ?? ["arm64", "x86_64"];
  const deploymentTarget = recipe?.deployment_target ?? "13.0";
  const makeFlags = recipe?.make_flags ?? [];
  const configureFlags = gitConfigureFlags(recipe);
  const makePrefixFlag = `prefix=${gitInstallPrefix(recipe)}`;
  const archInstalls = [];

  for (const arch of arches) {
    const buildRoot = path.join(path.dirname(installRoot), `build-${arch}`);
    const archInstallRoot = path.join(
      path.dirname(installRoot),
      `install-${arch}`,
    );
    await rm(buildRoot, { recursive: true, force: true });
    await rm(archInstallRoot, { recursive: true, force: true });
    await cp(sourceRoot, buildRoot, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await mkdir(archInstallRoot, { recursive: true });

    const archFlags = `-arch ${arch} -mmacosx-version-min=${deploymentTarget}`;
    const buildEnv = {
      ...process.env,
      CC: "clang",
      CFLAGS: archFlags,
      LDFLAGS: archFlags,
      MACOSX_DEPLOYMENT_TARGET: deploymentTarget,
    };

    await runCommand("./configure", configureFlags, {
      cwd: buildRoot,
      env: buildEnv,
      label: `configure git for ${arch}`,
    });
    await runCommand(
      "make",
      [`-j${parallelism()}`, ...makeFlags, makePrefixFlag, "all"],
      {
        cwd: buildRoot,
        env: buildEnv,
        label: `build git for ${arch}`,
      },
    );
    await runCommand(
      "make",
      [...makeFlags, makePrefixFlag, `DESTDIR=${archInstallRoot}`, "install"],
      {
        cwd: buildRoot,
        env: buildEnv,
        label: `install git for ${arch}`,
      },
    );
    archInstalls.push({ arch, path: archInstallRoot });
  }

  const base =
    archInstalls.find((entry) => entry.arch === "arm64") ?? archInstalls[0];
  await rm(installRoot, { recursive: true, force: true });
  await cp(base.path, installRoot, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  await lipoInstallTrees({
    destinationRoot: installRoot,
    baseRoot: base.path,
    otherRoots: archInstalls
      .filter((entry) => entry.path !== base.path)
      .map((entry) => entry.path),
  });
}

const gitTransportBuiltinWrappers = [
  ["git-receive-pack", "receive-pack"],
  ["git-upload-archive", "upload-archive"],
  ["git-upload-pack", "upload-pack"],
];

async function ensureGitTransportBuiltinWrappers(installRoot) {
  const gitExecPath = await firstExistingDirectory(installRoot, [
    "git/libexec/git-core",
    "git/mingw64/libexec/git-core",
    "git/usr/libexec/git-core",
  ]);
  if (!gitExecPath) {
    fail(
      `source-built git install is missing libexec/git-core under ${installRoot}`,
    );
  }

  const gitBinary = path.join(gitExecPath, "git");
  const gitStat = await stat(gitBinary).catch(() => null);
  if (!gitStat?.isFile()) {
    fail(
      `source-built git install is missing libexec git binary: ${gitBinary}`,
    );
  }
  const gitBinDir = await firstExistingDirectory(installRoot, ["git/bin"]);
  if (!gitBinDir) {
    fail(`source-built git install is missing git/bin under ${installRoot}`);
  }
  await chmod(gitBinDir, 0o755).catch(() => {});

  for (const [wrapperName, builtinName] of gitTransportBuiltinWrappers) {
    await ensureGitBuiltinWrapper({
      builtinName,
      gitBinary,
      wrapperPath: path.join(gitBinDir, wrapperName),
    });
    await ensureGitBuiltinWrapper({
      builtinName,
      gitBinary,
      wrapperPath: path.join(gitExecPath, wrapperName),
    });
  }
}

async function ensureGitBuiltinWrapper({
  builtinName,
  gitBinary,
  wrapperPath,
}) {
  const wrapperStat = await lstat(wrapperPath).catch(() => null);
  if (!wrapperStat) {
    await writeGitBuiltinWrapper({ builtinName, gitBinary, wrapperPath });
    return;
  }
  if (wrapperStat.isFile() && !wrapperStat.isSymbolicLink()) {
    await chmod(wrapperPath, 0o755).catch(() => {});
    return;
  }
  if (wrapperStat.isSymbolicLink()) {
    return;
  }
  await rm(wrapperPath, { force: true });
  await writeGitBuiltinWrapper({ builtinName, gitBinary, wrapperPath });
}

async function writeGitBuiltinWrapper({ builtinName, gitBinary, wrapperPath }) {
  const relativeGit = relativeExecutablePath(wrapperPath, gitBinary);
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec "$(dirname "$0")/${relativeGit}" ${builtinName} "$@"\n`,
  );
  await chmod(wrapperPath, 0o755);
}

const identicalGitExecutableGroups = [
  {
    canonical: "git/bin/git",
    aliases: ["git/libexec/git-core/git"],
  },
  {
    canonical: "git/bin/scalar",
    aliases: ["git/libexec/git-core/scalar"],
  },
  {
    canonical: "git/bin/git-shell",
    aliases: ["git/libexec/git-core/git-shell"],
  },
  {
    // The Perl runtime-prefix fallback derives share/perl5 from the libexec
    // location when GIT_EXEC_PATH is absent, so keep that copy canonical.
    canonical: "git/libexec/git-core/git-cvsserver",
    aliases: ["git/bin/git-cvsserver"],
  },
  {
    canonical: "git/libexec/git-core/git-remote-http",
    // remote-curl selects the transport from its URL argument, not argv[0].
    // Keep HTTP as the canonical binary and pass every alias argument unchanged.
    aliases: [
      "git/libexec/git-core/git-remote-ftp",
      "git/libexec/git-core/git-remote-ftps",
      "git/libexec/git-core/git-remote-https",
    ],
  },
];

export async function normalizeGitExecutableCopies(installRoot) {
  const resolvedRoot = path.resolve(installRoot);
  const builtinReplacements = await normalizeGitBuiltinCopies(resolvedRoot);
  const aliasReplacements = await normalizeIdenticalGitAliases(resolvedRoot);
  info(
    `normalized ${builtinReplacements} duplicate Git builtins and ${aliasReplacements} identical executable aliases`,
  );
  return { aliasReplacements, builtinReplacements };
}

async function normalizeGitBuiltinCopies(installRoot) {
  const gitBinary = await firstExistingFile(installRoot, [
    "git/bin/git",
    "git/libexec/git-core/git",
  ]);
  if (!gitBinary) {
    fail(
      `source-built Git is missing its canonical executable under ${installRoot}`,
    );
  }
  const canonicalSha = await sha256File(gitBinary);
  let replacements = 0;
  for (const relativePath of await regularFiles(installRoot)) {
    const candidate = path.join(installRoot, relativePath);
    const basename = path.basename(candidate);
    if (!basename.startsWith("git-") || candidate === gitBinary) {
      continue;
    }
    const candidateStat = await stat(candidate);
    if (
      (candidateStat.mode & 0o111) === 0 ||
      (await sha256File(candidate)) !== canonicalSha
    ) {
      continue;
    }

    const builtinName = basename.slice("git-".length);
    await rm(candidate, { force: true });
    await writeGitBuiltinWrapper({
      builtinName,
      gitBinary,
      wrapperPath: candidate,
    });
    replacements += 1;
  }
  return replacements;
}

async function normalizeIdenticalGitAliases(installRoot) {
  let replacements = 0;
  for (const group of identicalGitExecutableGroups) {
    const canonical = path.join(installRoot, group.canonical);
    const canonicalStat = await lstat(canonical).catch(() => null);
    if (!canonicalStat?.isFile() || canonicalStat.isSymbolicLink()) {
      continue;
    }
    const canonicalSha = await sha256File(canonical);
    for (const aliasRelativePath of group.aliases) {
      const alias = path.join(installRoot, aliasRelativePath);
      const aliasStat = await lstat(alias).catch(() => null);
      if (!aliasStat) {
        continue;
      }
      if (aliasStat.isSymbolicLink()) {
        fail(`source-built Git alias must not be a symbolic link: ${alias}`);
      }
      if (
        !aliasStat.isFile() ||
        (aliasStat.mode & 0o111) === 0 ||
        (await sha256File(alias)) !== canonicalSha
      ) {
        continue;
      }
      await writeGitExecutableAliasWrapper({
        aliasPath: alias,
        canonicalPath: canonical,
        installRoot,
      });
      replacements += 1;
    }
  }
  return replacements;
}

export async function writeGitExecutableAliasWrapper({
  aliasPath,
  canonicalPath,
  installRoot,
}) {
  assertPathInside(installRoot, aliasPath, "Git executable alias");
  assertPathInside(installRoot, canonicalPath, "canonical Git executable");
  const relativeExecutable = relativeExecutablePath(aliasPath, canonicalPath);
  await rm(aliasPath, { force: true });
  await writeFile(
    aliasPath,
    `#!/bin/sh\nexec "$(dirname "$0")/${relativeExecutable}" "$@"\n`,
  );
  await chmod(aliasPath, 0o755);
}

function relativeExecutablePath(wrapperPath, executablePath) {
  return path
    .relative(path.dirname(wrapperPath), executablePath)
    .split(path.sep)
    .join("/");
}

function assertPathInside(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    fail(
      `${label} must stay inside the source-built Git install: ${candidate}`,
    );
  }
}

async function firstExistingDirectory(root, relativePaths) {
  for (const relativePath of relativePaths) {
    const candidate = path.join(root, relativePath);
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isDirectory()) {
      return candidate;
    }
  }
  return null;
}

async function firstExistingFile(root, relativePaths) {
  for (const relativePath of relativePaths) {
    const candidate = path.join(root, relativePath);
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      return candidate;
    }
  }
  return null;
}

async function lipoInstallTrees({ destinationRoot, baseRoot, otherRoots }) {
  for (const relativePath of await regularFiles(baseRoot)) {
    const sourcePaths = [path.join(baseRoot, relativePath)];
    for (const otherRoot of otherRoots) {
      sourcePaths.push(path.join(otherRoot, relativePath));
    }
    const destination = path.join(destinationRoot, relativePath);
    if (!isMachO(sourcePaths[0])) {
      continue;
    }
    const invalidSlice = sourcePaths.find((filePath) => !isMachO(filePath));
    if (invalidSlice) {
      fail(
        `macOS universal merge is missing a Mach-O slice for ${relativePath}: ${invalidSlice}`,
      );
    }
    await runCommand(
      "lipo",
      ["-create", ...sourcePaths, "-output", destination],
      {
        label: `lipo ${relativePath}`,
      },
    );
    await chmod(destination, 0o755).catch(() => {});
  }
}

export async function stripMacosExecutables(
  installRoot,
  { commandRunner = runCommand } = {},
) {
  return stripInstallExecutables({
    commandRunner,
    installRoot,
    isBinary: isMachO,
    stripArgs: (filePath) => ["-S", "-x", filePath],
  });
}

export async function stripMacosBinary(
  filePath,
  { commandRunner = runCommand } = {},
) {
  await commandRunner("strip", ["-S", "-x", filePath], {
    label: `strip ${filePath}`,
  });
}

export async function stripLinuxExecutables(
  installRoot,
  { commandRunner = runCommand } = {},
) {
  return stripInstallExecutables({
    commandRunner,
    installRoot,
    isBinary: isElf,
    stripArgs: (filePath) => ["--strip-unneeded", filePath],
  });
}

async function stripInstallExecutables({
  commandRunner,
  installRoot,
  isBinary,
  stripArgs,
}) {
  let stripped = 0;
  for (const relativePath of await regularFiles(installRoot)) {
    const filePath = path.join(installRoot, relativePath);
    const fileStat = await stat(filePath);
    if ((fileStat.mode & 0o111) === 0 || !(await isBinary(filePath))) {
      continue;
    }
    await commandRunner("strip", stripArgs(filePath), {
      label: `strip ${filePath}`,
    });
    stripped += 1;
  }
  info(`stripped ${stripped} source-built Git executables`);
  return stripped;
}

async function buildLinuxGit({ config, sourceRoot, installRoot }) {
  const recipe = config.build?.linux?.git;
  if (process.platform !== "linux") {
    fail(
      "Linux Git source build must run on Linux or a Linux runner with Docker.",
    );
  }

  if (await isUbuntu2004()) {
    await buildLinuxGitNative({ recipe, sourceRoot, installRoot });
    return;
  }

  const docker = spawnSync("docker", ["--version"], { encoding: "utf8" });
  if (docker.status !== 0) {
    fail(
      "Linux Git source build requires Ubuntu 20.04. Run on Ubuntu 20.04 or install Docker so the script can use ubuntu:20.04.",
    );
  }

  await buildLinuxGitInDocker({ recipe, sourceRoot, installRoot });
}

async function buildLinuxGitInDocker({ recipe, sourceRoot, installRoot }) {
  await mkdir(installRoot, { recursive: true });
  const image = recipe?.container_image ?? "ubuntu:20.04";
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const script = `
trap 'chown -R ${uid}:${gid} /src /install' EXIT
${linuxBuildShellScript(recipe, "/src", "/install")}`;
  await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${sourceRoot}:/src`,
      "-v",
      `${installRoot}:/install`,
      "-e",
      "DEBIAN_FRONTEND=noninteractive",
      image,
      "bash",
      "-lc",
      script,
    ],
    { label: "build linux git in ubuntu:20.04 container" },
  );
}

async function buildLinuxGitNative({ recipe, sourceRoot, installRoot }) {
  await runCommand(
    "bash",
    [
      "-lc",
      linuxBuildShellScript(recipe, sourceRoot, installRoot, {
        useSudo: true,
      }),
    ],
    {
      label: "build linux git on Ubuntu 20.04",
    },
  );
}

function linuxBuildShellScript(
  recipe,
  sourceRoot,
  installRoot,
  { useSudo = false } = {},
) {
  const packages = [...(recipe?.apt_packages ?? []), "pkg-config"];
  const makeFlags = shellWords(recipe?.make_flags ?? []);
  const configureFlags = shellWords(gitConfigureFlags(recipe));
  const makePrefixFlag = `prefix=${shellQuote(gitInstallPrefix(recipe))}`;
  return `
set -euo pipefail
${useSudo ? "sudo " : ""}apt-get update
${useSudo ? "sudo " : ""}apt-get install -y --no-install-recommends ${shellWords(packages)}
cd ${shellQuote(sourceRoot)}
./configure ${configureFlags}
pkg_config_static_libs="$(pkg-config --static --libs libcurl openssl zlib libpcre2-8 expat)"
static_required_libs=""
dynamic_transitive_libs=""
for token in $pkg_config_static_libs; do
  case "$token" in
    -lcurl|-lssl|-lcrypto|-lz|-lpcre2-8|-lexpat|-lssh|-lldap|-llber)
      static_required_libs="$static_required_libs $token"
      ;;
    -L*|-Wl,*)
      static_required_libs="$static_required_libs $token"
      dynamic_transitive_libs="$dynamic_transitive_libs $token"
      ;;
    *)
      dynamic_transitive_libs="$dynamic_transitive_libs $token"
      ;;
  esac
done
dynamic_transitive_libs="$dynamic_transitive_libs -lgnutls -lsasl2"
static_link_flags="-Wl,-Bstatic $static_required_libs -Wl,-Bdynamic $dynamic_transitive_libs"
make -j"$(nproc)" ${makeFlags} ${makePrefixFlag} CURL_LDFLAGS="$static_link_flags" EXPAT_LIBEXPAT="$static_link_flags" OPENSSL_LINK= OPENSSL_LIBSSL= LIB_4_CRYPTO="$static_link_flags" EXTLIBS="$static_link_flags" all
make ${makeFlags} ${makePrefixFlag} DESTDIR=${shellQuote(installRoot)} CURL_LDFLAGS="$static_link_flags" EXPAT_LIBEXPAT="$static_link_flags" OPENSSL_LINK= OPENSSL_LIBSSL= LIB_4_CRYPTO="$static_link_flags" EXTLIBS="$static_link_flags" install
if find ${shellQuote(installRoot)} -type f -perm /111 -print0 | xargs -0 -r ldd 2>/dev/null | grep -E 'lib(curl|ssl|crypto|z|pcre2|expat|ldap|lber)'; then
  echo "git distribution still links dynamic required libraries" >&2
  exit 1
fi
	`;
}

function gitConfigureFlags(recipe) {
  return recipe?.configure_flags ?? [`--prefix=${gitInstallPrefix(recipe)}`];
}

function gitInstallPrefix(recipe) {
  const flags = recipe?.configure_flags ?? [];
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--prefix" && flags[index + 1]) {
      return flags[index + 1];
    }
    if (flag.startsWith("--prefix=")) {
      return flag.slice("--prefix=".length);
    }
  }
  return "/git";
}

async function findGitSourceRoot(root) {
  const candidates = await directoryCandidates(root, 3);
  for (const candidate of candidates) {
    const makefile = await stat(path.join(candidate, "Makefile")).catch(
      () => null,
    );
    const gitC = await stat(path.join(candidate, "git.c")).catch(() => null);
    if (makefile?.isFile() && gitC?.isFile()) {
      return candidate;
    }
  }
  fail(
    `extracted Git source tree under ${root} does not contain Makefile and git.c`,
  );
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

async function regularFiles(root) {
  const files = [];
  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  await walk(root, "");
  return files;
}

function isMachO(filePath) {
  const result = spawnSync("file", ["-b", filePath], { encoding: "utf8" });
  return result.status === 0 && /\bMach-O\b/.test(result.stdout);
}

async function isElf(filePath) {
  const prefix = Buffer.alloc(4);
  const handle = await open(filePath, "r");
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return (
      bytesRead === prefix.length &&
      prefix.equals(Buffer.from("7f454c46", "hex"))
    );
  } finally {
    await handle.close();
  }
}

async function chmodTreeExecutables(root) {
  for (const relativePath of await regularFiles(root)) {
    const filePath = path.join(root, relativePath);
    const mode = await stat(filePath).then((fileStat) => fileStat.mode);
    if ((mode & 0o111) !== 0) {
      await chmod(filePath, 0o755).catch(() => {});
    }
  }
}

async function isUbuntu2004() {
  const osRelease = await readFile("/etc/os-release", "utf8").catch(() => "");
  return /ID=ubuntu/.test(osRelease) && /VERSION_ID="?20\.04"?/.test(osRelease);
}

async function runCommand(executable, commandArgs, options = {}) {
  const result = spawnSync(executable, commandArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    fail(
      `${options.label ?? executable} failed to start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    fail(
      `${options.label ?? executable} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
}

function stagedSourceDir(ref) {
  return path.join(stagingDir, ref.replaceAll(".", "__"));
}

function parallelism() {
  return Math.max(1, os.availableParallelism?.() ?? os.cpus().length ?? 1);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function extractionCommand(
  archivePath,
  destination,
  archiveName = archivePath,
) {
  if (/\.zip$/i.test(archiveName)) {
    if (process.platform === "win32") {
      return {
        executable: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-Command",
          "Expand-Archive",
          "-LiteralPath",
          archivePath,
          "-DestinationPath",
          destination,
          "-Force",
        ],
      };
    }
    return {
      executable: "unzip",
      args: ["-q", "-o", archivePath, "-d", destination],
    };
  }

  if (/\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2)$/i.test(archiveName)) {
    return {
      executable: "tar",
      args: ["-xf", archivePath, "-C", destination],
    };
  }

  return null;
}

async function renameOverExisting(from, to) {
  const { rename, rm } = await import("node:fs/promises");
  await rm(to, { force: true });
  await rename(from, to);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellWords(values) {
  return values.map((value) => shellQuote(String(value))).join(" ");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.error(
    "fetch-git-dist.mjs is an internal builder; use pnpm git-toolchain:ensure",
  );
  process.exitCode = 1;
}
