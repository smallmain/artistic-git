#!/usr/bin/env node
/* global AbortSignal, URL, console, fetch, process */

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GitDistConfigError,
  assembleGitDist,
  configPath,
  getHostTarget,
  getTarget,
  getTargetSources,
  loadGitDistConfig,
  sha256File,
  supportedTargets,
  validateGitDistConfig,
} from "./git-dist-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const targetName = normalizeTargetArg(args.target ?? getHostTarget());
const devResourcesDir = path.join(
  path.dirname(configPath),
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

const usage = `Usage:
  node scripts/fetch-git-dist.mjs --schema-only [--target=${supportedTargets.join("|")}]
  node scripts/fetch-git-dist.mjs --print-env [--target=${supportedTargets.join("|")}] [--output=/path/to/git-dist]
  node scripts/fetch-git-dist.mjs [--target=${supportedTargets.join("|")}] [--output=/path/to/git-dist] [--cache-dir=/path] [--download-only] [--no-extract] [--helper-dir=/path | --credential-helper=/path --ssh-askpass=/path] [--helper-profile=auto|release|debug]
  node scripts/fetch-git-dist.mjs --dev-resources [--target=${supportedTargets.join("|")}] [--download-only]

Default output is $ARTISTIC_GIT_DIST_DIR when set, otherwise a temp directory.
--dev-resources writes to src-tauri/resources/git-dist for local Tauri runs.
Archive assembly copies staged archives into the git-dist layout, copies helper
binaries from explicit paths or target/{release,debug}, and writes manifest.json
only after every required executable is present and hashed.
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
  const { data: config } = await loadGitDistConfig(configPath);

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

async function downloadSource(ref, source) {
  const fileName =
    source.asset_name || path.basename(new URL(source.url).pathname);
  const destination = path.join(cacheDir, fileName);
  const temporary = `${destination}.tmp`;

  info(`downloading ${ref}: ${source.url}`);
  const response = await fetch(source.url, {
    redirect: "follow",
    headers: {
      "User-Agent": "artistic-git-dist-fetch/phase-1a",
    },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  if (!response.ok || !response.body) {
    fail(
      `download failed for ${ref}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
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
}

async function extractSource(ref, source, archivePath) {
  const destination = path.join(stagingDir, ref.replaceAll(".", "__"));
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
    devResources: false,
    target: undefined,
    output: undefined,
    cacheDir: undefined,
    stagingDir: undefined,
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
    } else if (arg === "--dev-resources") {
      parsed.devResources = true;
    } else if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else if (arg.startsWith("--output=")) {
      parsed.output = arg.slice("--output=".length);
    } else if (arg.startsWith("--cache-dir=")) {
      parsed.cacheDir = arg.slice("--cache-dir=".length);
    } else if (arg.startsWith("--staging-dir=")) {
      parsed.stagingDir = arg.slice("--staging-dir=".length);
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

function printEnv(dir) {
  console.log(`# ARTISTIC_GIT_DIST_DIR for this target`);
  console.log(`export ARTISTIC_GIT_DIST_DIR=${shellQuote(dir)}`);
}

try {
  await run();
} catch (error) {
  failConfig(error);
}
