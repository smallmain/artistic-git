#!/usr/bin/env node
/* global AbortSignal, URL, console, fetch, process */

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GitDistConfigError,
  assembleGitDist,
  configPath as defaultConfigPath,
  getHostTarget,
  getTarget,
  getTargetSources,
  loadGitDistConfig,
  sha256File,
  sourceIsReleaseReady,
  sourceReadinessReason,
  supportedTargets,
  validateGitDistConfig,
} from "./git-dist-lib.mjs";

const args = parseArgs(process.argv.slice(2));
validateArgCombinations(args);
const targetName = normalizeTargetArg(args.target ?? getHostTarget());
const configFilePath = path.resolve(args.config ?? defaultConfigPath);
const devResourcesDir = path.join(
  path.dirname(configFilePath),
  "src-tauri",
  "resources",
  "git-dist",
);
const outputDir = path.resolve(
  args.devResources
    ? devResourcesDir
    : (args.output ??
        process.env.ARTISTIC_GIT_DIST_DIR ??
        path.join(os.tmpdir(), "artistic-git-dist", targetName)),
);
const cacheDir = path.resolve(
  args.cacheDir ?? path.join(os.tmpdir(), "artistic-git-dist-cache"),
);
const stagingDir = path.resolve(
  args.stagingDir ??
    path.join(os.tmpdir(), "artistic-git-dist-staging", targetName),
);
const sourceEvidenceDir = path.resolve(
  args.evidenceDir ??
    path.join(os.tmpdir(), "artistic-git-dist-source-evidence", targetName),
);

const usage = `Usage:
  node scripts/fetch-git-dist.mjs --schema-only [--target=${supportedTargets.join("|")}] [--config=/path/to/git-dist.toml]
  node scripts/fetch-git-dist.mjs --print-env [--target=${supportedTargets.join("|")}] [--output=/path/to/git-dist] [--config=/path/to/git-dist.toml]
  node scripts/fetch-git-dist.mjs --source-evidence-only --skip-blocked-sources [--target=${supportedTargets.join("|")}] [--components=git,git_lfs] [--cache-dir=/path] [--evidence-dir=/path] [--config=/path/to/git-dist.toml]
  node scripts/fetch-git-dist.mjs [--target=${supportedTargets.join("|")}] [--output=/path/to/git-dist] [--cache-dir=/path] [--download-only] [--no-extract] [--build-helpers] [--helper-dir=/path | --credential-helper=/path --ssh-askpass=/path] [--helper-profile=auto|release|debug]
  node scripts/fetch-git-dist.mjs --dev-resources [--target=${supportedTargets.join("|")}] [--helper-profile=auto|release|debug]

Default output is $ARTISTIC_GIT_DIST_DIR when set, otherwise a temp directory.
--dev-resources writes to src-tauri/resources/git-dist for local Tauri runs.
--dev-resources always assembles a runnable resource tree; do not combine it
with --output, --download-only, or --no-extract.
--source-evidence-only downloads and SHA-verifies selected release-ready source
archives for a target, records placeholder/unapproved sources as skipped when
--skip-blocked-sources is set, and never extracts or assembles a git-dist tree.
Archive assembly copies staged archives into the git-dist layout, copies helper
binaries from explicit paths or target/{release,debug}, and writes manifest.json
only after every required executable is present and hashed.
macOS and Linux source-tarball Git entries are built from the checked source
archive before assembly. Linux builds run inside ubuntu:20.04 via Docker unless
the script is already running on Ubuntu 20.04.
The fetch pipeline never searches PATH for git and never falls back to a system Git.`;

if (args.help) {
  console.log(usage);
  process.exit(0);
}

function info(message) {
  console.log(`git-dist fetch: ${message}`);
}

function fail(message) {
  console.error(`git-dist fetch failed: ${message}`);
  process.exit(1);
}

function failConfig(error) {
  if (error instanceof GitDistConfigError) {
    console.error(`git-dist fetch failed: ${error.message}`);
    for (const detail of error.details ?? []) {
      console.error(`  - ${detail}`);
    }
    process.exit(1);
  }
  throw error;
}

async function run() {
  const { data: config } = await loadGitDistConfig(configFilePath);

  if (args.schemaOnly) {
    validateGitDistConfig(config, {
      targetName,
      allowPlaceholders: true,
      realBuild: false,
    });
    info(`schema is valid for ${targetName}`);
    return;
  }

  if (args.printEnv) {
    validateGitDistConfig(config, {
      targetName,
      allowPlaceholders: true,
      realBuild: false,
    });
    printEnv(outputDir);
    return;
  }

  if (args.sourceEvidenceOnly) {
    await writeSourceEvidence(config);
    return;
  }

  validateGitDistConfig(config, {
    targetName,
    allowPlaceholders: false,
    realBuild: true,
  });

  const target = getTarget(config, targetName);
  const sources = getTargetSources(config, targetName);

  await mkdir(cacheDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  info(`target: ${targetName}`);
  info(`cache: ${cacheDir}`);
  info(`staging: ${stagingDir}`);
  info(`output: ${outputDir}`);
  printEnv(outputDir);

  for (const { ref, source } of sources) {
    const archivePath = await downloadSource(ref, source);
    await verifySource(ref, source, archivePath);
    if (!args.noExtract) {
      await extractSource(ref, source, archivePath);
    }
  }

  if (args.downloadOnly || args.noExtract) {
    info("download/verify stage completed; assembly was skipped by flag.");
    return;
  }

  await buildSourceTarballs({ config, target, sources });
  if (args.buildHelpers || args.devResources) {
    buildHelpers();
  }

  const manifest = await assembleGitDist({
    config,
    targetName,
    stagingDir,
    outputDir,
    helperDir: args.helperDir,
    credentialHelperPath: args.credentialHelper,
    sshAskpassPath: args.sshAskpass,
    cargoTargetDir: args.cargoTargetDir,
    helperProfile: args.helperProfile,
  });
  info(
    `assembled ${target.manifest_platform}: ${Object.keys(manifest.sha256).length} files hashed`,
  );
  info(`manifest: ${path.join(outputDir, config.resources.layout.manifest)}`);
}

async function writeSourceEvidence(config) {
  validateGitDistConfig(config, {
    targetName,
    allowPlaceholders: true,
    realBuild: false,
  });

  const target = getTarget(config, targetName);
  const selectedComponents = args.components ? new Set(args.components) : null;
  const sources = getTargetSources(config, targetName);
  const evidenceSources = [];

  await mkdir(cacheDir, { recursive: true });
  await mkdir(sourceEvidenceDir, { recursive: true });

  info(`target: ${targetName}`);
  info(`cache: ${cacheDir}`);
  info(`source evidence: ${sourceEvidenceDir}`);

  for (const { ref, source } of sources) {
    const entry = sourceEvidenceBaseEntry({ config, ref, source });
    const blocked = !sourceIsReleaseReady(source);
    if (blocked) {
      if (!args.skipBlockedSources) {
        fail(
          `${ref} is blocked by placeholder/unapproved source; pass --skip-blocked-sources to record it without downloading`,
        );
      }
      evidenceSources.push({
        ...entry,
        status: "skipped-blocked",
        reason: sourceReadinessReason(source),
      });
      info(`skipped blocked source ${ref}: ${sourceReadinessReason(source)}`);
      continue;
    }

    if (selectedComponents && !selectedComponents.has(source.component)) {
      evidenceSources.push({
        ...entry,
        status: "skipped-unselected",
        reason: `component ${source.component} was not selected`,
      });
      info(`skipped unselected source ${ref}`);
      continue;
    }

    const archivePath = await downloadSource(ref, source);
    const actualSha256 = await verifySource(ref, source, archivePath);
    evidenceSources.push({
      ...entry,
      status: "checked",
      reason: "downloaded archive matched configured SHA-256",
      actualSha256,
      cachePath: path.relative(process.cwd(), archivePath),
    });
  }

  const checked = evidenceSources.filter(
    (source) => source.status === "checked",
  );
  if (checked.length === 0) {
    fail("source evidence mode did not check any source archives");
  }

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "source-evidence-only",
    target: {
      name: targetName,
      platform: target.platform,
      manifestPlatform: target.manifest_platform,
      artifactName: target.artifact_name,
    },
    config: {
      path: path.relative(process.cwd(), configFilePath),
    },
    cacheDir: path.relative(process.cwd(), cacheDir),
    components: args.components ?? null,
    skipBlockedSources: args.skipBlockedSources,
    status: evidenceSources.some(
      (source) => source.status === "skipped-blocked",
    )
      ? "partial"
      : "passed",
    summary: {
      checked: checked.length,
      skippedBlocked: evidenceSources.filter(
        (source) => source.status === "skipped-blocked",
      ).length,
      skippedUnselected: evidenceSources.filter(
        (source) => source.status === "skipped-unselected",
      ).length,
    },
    sources: evidenceSources,
  };

  await writeFile(
    path.join(sourceEvidenceDir, "git-dist-source-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await writeFile(
    path.join(sourceEvidenceDir, "git-dist-source-evidence.md"),
    renderSourceEvidenceMarkdown(evidence),
  );
  info(
    `source evidence wrote ${checked.length} checked source(s) to ${sourceEvidenceDir}`,
  );
}

function sourceEvidenceBaseEntry({ config, ref, source }) {
  const versionKey = source.version_key;
  return {
    ref,
    component: source.component,
    kind: source.kind,
    vendor: source.vendor,
    version: versionKey ? config.versions?.[versionKey] : null,
    stable: source.stable === true,
    placeholder: source.placeholder === true,
    placeholderReason: source.placeholder_reason ?? null,
    channel: source.channel ?? null,
    fallbackWhenNoStable: source.fallback_when_no_stable === true,
    fallbackReason: source.fallback_reason ?? null,
    releaseReady: sourceIsReleaseReady(source),
    releaseUrl: source.release_url ?? null,
    assetName: source.asset_name ?? null,
    url: source.url,
    checksum: {
      algorithm: source.checksum?.algorithm ?? null,
      expectedSha256: source.checksum?.value?.toLowerCase() ?? null,
      source: source.checksum?.source ?? null,
      url: source.checksum?.url ?? null,
    },
    resourcesPath: source.resources_path ?? null,
  };
}

function renderSourceEvidenceMarkdown(evidence) {
  const lines = [
    "# Git Distribution Source Evidence",
    "",
    `Generated: ${evidence.generatedAt}`,
    "",
    `Target: ${evidence.target.name}`,
    "",
    `Status: ${evidence.status}`,
    "",
    "| Component | Source | Status | SHA-256 | Reason |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const source of evidence.sources) {
    lines.push(
      `| ${source.component} | ${source.ref} | ${source.status} | ${
        source.actualSha256 ?? source.checksum.expectedSha256 ?? "unknown"
      } | ${source.reason} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function downloadSource(ref, source) {
  const fileName =
    source.asset_name || path.basename(new URL(source.url).pathname);
  const destination = path.join(cacheDir, fileName);
  const temporary = `${destination}.tmp`;

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
        fail(`download failed for ${ref}: ${error.message}`);
      }
      info(`retrying ${ref} after download failure: ${error.message}`);
    }
  }

  const actual = await sha256File(temporary);
  if (actual !== source.checksum.value.toLowerCase()) {
    fail(
      `${ref} checksum mismatch after download: expected ${source.checksum.value}, got ${actual}`,
    );
  }

  await renameOverExisting(temporary, destination);
  return destination;
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

  const command = extractionCommand(archivePath, destination);
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
    } else {
      fail(
        `${ref} has source-tarball kind but ${target.platform} has no source build recipe`,
      );
    }
    await ensureGitTransportBuiltinWrappers(installRoot);
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
    });
    await mkdir(archInstallRoot, { recursive: true });

    const archFlags = `-arch ${arch} -mmacosx-version-min=${deploymentTarget}`;
    const buildEnv = {
      ...process.env,
      CC: "clang",
      CFLAGS: [process.env.CFLAGS, archFlags].filter(Boolean).join(" "),
      LDFLAGS: [process.env.LDFLAGS, archFlags].filter(Boolean).join(" "),
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
      [
        ...makeFlags,
        makePrefixFlag,
        `DESTDIR=${archInstallRoot}`,
        "NO_INSTALL_HARDLINKS=YesPlease",
        "install",
      ],
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

  for (const [wrapperName, builtinName] of gitTransportBuiltinWrappers) {
    const wrapperPath = path.join(gitExecPath, wrapperName);
    const wrapperStat = await lstat(wrapperPath).catch(() => null);
    if (wrapperStat?.isFile() && !wrapperStat.isSymbolicLink()) {
      continue;
    }
    if (wrapperStat) {
      await rm(wrapperPath, { force: true });
    }
    await writeFile(
      wrapperPath,
      `#!/bin/sh\nexec "$(dirname "$0")/git" ${builtinName} "$@"\n`,
    );
    await chmod(wrapperPath, 0o755);
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

async function lipoInstallTrees({ destinationRoot, baseRoot, otherRoots }) {
  for (const relativePath of await regularFiles(baseRoot)) {
    const sourcePaths = [path.join(baseRoot, relativePath)];
    for (const otherRoot of otherRoots) {
      sourcePaths.push(path.join(otherRoot, relativePath));
    }
    const destination = path.join(destinationRoot, relativePath);
    const allMachO = sourcePaths.every((filePath) => isMachO(filePath));
    if (!allMachO) {
      continue;
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
  const script = linuxBuildShellScript(recipe, "/src", "/install");
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
    ["-lc", linuxBuildShellScript(recipe, sourceRoot, installRoot)],
    {
      label: "build linux git on Ubuntu 20.04",
    },
  );
}

function linuxBuildShellScript(recipe, sourceRoot, installRoot) {
  const packages = [...(recipe?.apt_packages ?? []), "pkg-config"];
  const makeFlags = shellWords(recipe?.make_flags ?? []);
  const configureFlags = shellWords(gitConfigureFlags(recipe));
  const makePrefixFlag = `prefix=${shellQuote(gitInstallPrefix(recipe))}`;
  return `
set -euo pipefail
apt-get update
apt-get install -y --no-install-recommends ${shellWords(packages)}
cd ${shellQuote(sourceRoot)}
./configure ${configureFlags}
pkg_config_static_libs="$(pkg-config --static --libs libcurl openssl zlib libpcre2-8 expat)"
static_required_libs=""
dynamic_transitive_libs=""
for token in $pkg_config_static_libs; do
  case "$token" in
    -lcurl|-lssl|-lcrypto|-lz|-lpcre2-8|-lexpat|-lssh)
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
static_link_flags="-Wl,-Bstatic $static_required_libs -Wl,-Bdynamic $dynamic_transitive_libs"
make -j"$(nproc)" ${makeFlags} ${makePrefixFlag} CURL_LDFLAGS="$static_link_flags" EXPAT_LIBEXPAT="$static_link_flags" OPENSSL_LINK= OPENSSL_LIBSSL= LIB_4_CRYPTO="$static_link_flags" EXTLIBS="$static_link_flags" all
make ${makeFlags} ${makePrefixFlag} DESTDIR=${shellQuote(installRoot)} NO_INSTALL_HARDLINKS=YesPlease CURL_LDFLAGS="$static_link_flags" EXPAT_LIBEXPAT="$static_link_flags" OPENSSL_LINK= OPENSSL_LIBSSL= LIB_4_CRYPTO="$static_link_flags" EXTLIBS="$static_link_flags" install
if find ${shellQuote(installRoot)} -type f -perm /111 -print0 | xargs -0 -r ldd 2>/dev/null | grep -E 'lib(curl|ssl|crypto|z|pcre2|expat)'; then
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

function buildHelpers() {
  info("building helper binaries with cargo --release");
  const result = spawnSync(
    "cargo",
    ["build", "-p", "artistic-git-helpers", "--bins", "--release"],
    {
      cwd: path.dirname(configFilePath),
      encoding: "utf8",
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error) {
    fail(`helper build failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`helper build failed with exit ${result.status}`);
  }
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
  if (process.env.ARTISTIC_GIT_DIST_FORCE_DOCKER === "1") {
    return false;
  }
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

function extractionCommand(archivePath, destination) {
  if (/\.zip$/i.test(archivePath)) {
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

  if (/\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2)$/i.test(archivePath)) {
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

function parseArgs(argv) {
  const parsed = {
    help: false,
    schemaOnly: false,
    printEnv: false,
    downloadOnly: false,
    noExtract: false,
    sourceEvidenceOnly: false,
    skipBlockedSources: false,
    components: undefined,
    buildHelpers: false,
    devResources: false,
    config: undefined,
    target: undefined,
    output: undefined,
    cacheDir: undefined,
    stagingDir: undefined,
    evidenceDir: undefined,
    helperDir: undefined,
    credentialHelper: undefined,
    sshAskpass: undefined,
    cargoTargetDir: undefined,
    helperProfile: "auto",
  };

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--schema-only") {
      parsed.schemaOnly = true;
    } else if (arg === "--print-env") {
      parsed.printEnv = true;
    } else if (arg === "--download-only") {
      parsed.downloadOnly = true;
    } else if (arg === "--no-extract") {
      parsed.noExtract = true;
    } else if (arg === "--source-evidence-only") {
      parsed.sourceEvidenceOnly = true;
    } else if (arg === "--skip-blocked-sources") {
      parsed.skipBlockedSources = true;
    } else if (arg === "--build-helpers") {
      parsed.buildHelpers = true;
    } else if (arg === "--dev-resources") {
      parsed.devResources = true;
    } else if (arg.startsWith("--config=")) {
      parsed.config = arg.slice("--config=".length);
    } else if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else if (arg.startsWith("--components=")) {
      parsed.components = arg
        .slice("--components=".length)
        .split(",")
        .map((component) => component.trim())
        .filter(Boolean);
      if (parsed.components.length === 0) {
        fail("--components must include at least one component");
      }
    } else if (arg.startsWith("--output=")) {
      parsed.output = arg.slice("--output=".length);
    } else if (arg.startsWith("--cache-dir=")) {
      parsed.cacheDir = arg.slice("--cache-dir=".length);
    } else if (arg.startsWith("--staging-dir=")) {
      parsed.stagingDir = arg.slice("--staging-dir=".length);
    } else if (arg.startsWith("--evidence-dir=")) {
      parsed.evidenceDir = arg.slice("--evidence-dir=".length);
    } else if (arg.startsWith("--helper-dir=")) {
      parsed.helperDir = arg.slice("--helper-dir=".length);
    } else if (arg.startsWith("--credential-helper=")) {
      parsed.credentialHelper = arg.slice("--credential-helper=".length);
    } else if (arg.startsWith("--ssh-askpass=")) {
      parsed.sshAskpass = arg.slice("--ssh-askpass=".length);
    } else if (arg.startsWith("--cargo-target-dir=")) {
      parsed.cargoTargetDir = arg.slice("--cargo-target-dir=".length);
    } else if (arg.startsWith("--helper-profile=")) {
      parsed.helperProfile = arg.slice("--helper-profile=".length);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function validateArgCombinations(parsed) {
  if (parsed.help) {
    return;
  }
  const conflicts = [];
  if (parsed.devResources) {
    if (parsed.output) {
      conflicts.push("--output");
    }
    if (parsed.downloadOnly) {
      conflicts.push("--download-only");
    }
    if (parsed.noExtract) {
      conflicts.push("--no-extract");
    }
    if (conflicts.length > 0) {
      fail(
        `--dev-resources writes the runnable Tauri resource tree and cannot be combined with ${conflicts.join(", ")}`,
      );
    }
  }
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

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellWords(values) {
  return values.map((value) => shellQuote(String(value))).join(" ");
}

function printEnv(dir) {
  console.log(`# ARTISTIC_GIT_DIST_DIR for this target`);
  console.log(`export ARTISTIC_GIT_DIST_DIR=${shellQuote(dir)}`);
}

try {
  await run();
} catch (error) {
  failConfig(error);
}
