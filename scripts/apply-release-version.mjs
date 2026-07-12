#!/usr/bin/env node
/* global console, process */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const releaseVersionManifests = Object.freeze([
  {
    path: "package.json",
    kind: "json",
  },
  {
    path: "src-tauri/tauri.conf.json",
    kind: "json",
  },
  {
    path: "src-tauri/Cargo.toml",
    kind: "cargo",
  },
  {
    path: "crates/app/Cargo.toml",
    kind: "cargo",
  },
]);

export function validateReleaseVersion(version) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("release version is required");
  }

  const normalized = version.trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`invalid release version: ${version}`);
  }

  return normalized;
}

export function replaceJsonVersionField(raw, version, filePath = "package.json") {
  const packageVersion = /^([ \t]*"version"[ \t]*:[ \t]*")([^"]*)(")/m;
  if (!packageVersion.test(raw)) {
    throw new Error(`Missing package version in ${filePath}`);
  }

  // Keep the original formatting so release commits only touch the version.
  const next = raw.replace(packageVersion, `$1${version}$3`);
  const parsed = JSON.parse(next);
  if (parsed.version !== version) {
    throw new Error(`Failed to apply package version in ${filePath}`);
  }
  return next;
}

export function replaceCargoPackageVersion(
  raw,
  version,
  filePath = "Cargo.toml",
) {
  const packageVersion = /^version = "[^"]+"$/m;
  if (!packageVersion.test(raw)) {
    throw new Error(`Missing package version in ${filePath}`);
  }
  return raw.replace(packageVersion, `version = "${version}"`);
}

export async function applyReleaseVersion({
  version,
  cwd = repoRoot,
  manifests = releaseVersionManifests,
} = {}) {
  const normalizedVersion = validateReleaseVersion(version);
  const updated = [];

  for (const manifest of manifests) {
    const filePath = path.resolve(cwd, manifest.path);
    const previous = await readFile(filePath, "utf8");
    let next;

    if (manifest.kind === "json") {
      next = replaceJsonVersionField(previous, normalizedVersion, manifest.path);
    } else if (manifest.kind === "cargo") {
      next = replaceCargoPackageVersion(
        previous,
        normalizedVersion,
        manifest.path,
      );
    } else {
      throw new Error(`unknown manifest kind: ${manifest.kind}`);
    }

    if (next !== previous) {
      await writeFile(filePath, next);
    }
    updated.push(manifest.path);
  }

  return {
    version: normalizedVersion,
    files: updated,
  };
}

export function isDirectCliInvocation(metaUrl, argvPath) {
  if (!argvPath) {
    return false;
  }
  return path.resolve(fileURLToPath(metaUrl)) === path.resolve(argvPath);
}

function parseArgs(argv) {
  const options = {
    cwd: repoRoot,
    version: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      if (arg.includes("=")) {
        return arg.slice(arg.indexOf("=") + 1);
      }
      index += 1;
      if (!argv[index]) {
        throw new Error(`${name} requires a value`);
      }
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      options.version = readValue("--version");
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      options.cwd = path.resolve(readValue("--cwd"));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.version) {
    options.version = process.env.RELEASE_VERSION ?? null;
  }

  return options;
}

function usage() {
  return `Usage:
  node scripts/apply-release-version.mjs --version 0.2.2
  RELEASE_VERSION=0.2.2 node scripts/apply-release-version.mjs

Writes the release version into package.json, tauri.conf.json, and the Cargo
package manifests used for the displayed app version.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await applyReleaseVersion({
    version: options.version,
    cwd: options.cwd,
  });
  console.log(
    `applied release version ${result.version} to ${result.files.join(", ")}`,
  );
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(
      `apply release version failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  });
}
