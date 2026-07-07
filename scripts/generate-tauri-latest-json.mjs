#!/usr/bin/env node
/* global console, process */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const platformOrder = [
  "darwin-x86_64",
  "darwin-aarch64",
  "windows-x86_64",
  "linux-x86_64",
];

function fail(message) {
  throw new Error(message);
}

function normalizeVersion(version) {
  const normalized = String(version ?? "")
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    fail(`invalid version: ${version}`);
  }
  return normalized;
}

function normalizeTag(tag, version) {
  const normalized = String(tag ?? "").trim();
  if (normalized) {
    return normalized;
  }
  return `v${normalizeVersion(version)}`;
}

function encodeReleaseAssetUrl({ repo, tag, filename }) {
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    fail(`invalid GitHub repo: ${repo}`);
  }
  const encodedTag = encodeURIComponent(tag);
  const encodedFile = filename
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://github.com/${repo}/releases/download/${encodedTag}/${encodedFile}`;
}

function isUpdateCandidate(file) {
  return (
    file.endsWith(".app.tar.gz") ||
    file.endsWith(".AppImage.tar.gz") ||
    file.endsWith(".AppImage") ||
    file.endsWith(".exe.zip") ||
    file.endsWith(".exe")
  );
}

function classifyUpdaterAsset(file) {
  if (file.endsWith(".app.tar.gz")) {
    return ["darwin-x86_64", "darwin-aarch64"];
  }
  if (file.endsWith(".exe.zip") || file.endsWith(".exe")) {
    return ["windows-x86_64"];
  }
  if (file.endsWith(".AppImage.tar.gz") || file.endsWith(".AppImage")) {
    return ["linux-x86_64"];
  }
  return [];
}

function choosePreferredAsset(files, predicates, description) {
  for (const predicate of predicates) {
    const matches = files.filter(predicate).sort();
    if (matches.length > 1) {
      fail(`multiple ${description} updater assets: ${matches.join(", ")}`);
    }
    if (matches.length === 1) {
      return matches[0];
    }
  }
  fail(`missing ${description} updater asset`);
}

export function selectUpdaterAssets(files) {
  const candidates = files.filter(isUpdateCandidate);
  return [
    choosePreferredAsset(
      candidates,
      [(file) => file.endsWith(".app.tar.gz")],
      "macOS .app.tar.gz",
    ),
    choosePreferredAsset(
      candidates,
      [(file) => file.endsWith(".exe.zip"), (file) => file.endsWith(".exe")],
      "Windows NSIS updater .exe.zip or .exe",
    ),
    choosePreferredAsset(
      candidates,
      [
        (file) => file.endsWith(".AppImage.tar.gz"),
        (file) => file.endsWith(".AppImage"),
      ],
      "Linux AppImage updater .tar.gz or .AppImage",
    ),
  ];
}

export async function buildLatestJson({
  assetsDir,
  version,
  notes,
  pubDate,
  repo,
  tag,
}) {
  const entries = await readdir(assetsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const selectedAssets = selectUpdaterAssets(files);
  const platforms = {};

  for (const asset of selectedAssets) {
    const sigFile = `${asset}.sig`;
    if (!files.includes(sigFile)) {
      fail(`missing updater signature for ${asset}: expected ${sigFile}`);
    }

    const signature = (
      await readFile(path.join(assetsDir, sigFile), "utf8")
    ).trim();
    if (!signature) {
      fail(`empty updater signature: ${sigFile}`);
    }

    const url = encodeReleaseAssetUrl({ repo, tag, filename: asset });
    for (const platform of classifyUpdaterAsset(asset)) {
      platforms[platform] = { signature, url };
    }
  }

  const missingPlatforms = platformOrder.filter(
    (platform) => !platforms[platform],
  );
  if (missingPlatforms.length > 0) {
    fail(`missing latest.json platforms: ${missingPlatforms.join(", ")}`);
  }

  return {
    version: normalizeVersion(version),
    notes,
    pub_date: pubDate,
    platforms: Object.fromEntries(
      platformOrder.map((platform) => [platform, platforms[platform]]),
    ),
  };
}

function parseArgs(argv) {
  const options = {};

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
    } else if (arg === "--assets-dir" || arg.startsWith("--assets-dir=")) {
      options.assetsDir = readValue("--assets-dir");
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      options.version = readValue("--version");
    } else if (arg === "--notes-file" || arg.startsWith("--notes-file=")) {
      options.notesFile = readValue("--notes-file");
    } else if (arg === "--pub-date" || arg.startsWith("--pub-date=")) {
      options.pubDate = readValue("--pub-date");
    } else if (arg === "--repo" || arg.startsWith("--repo=")) {
      options.repo = readValue("--repo");
    } else if (arg === "--tag" || arg.startsWith("--tag=")) {
      options.tag = readValue("--tag");
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      options.output = readValue("--output");
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return `Usage:
  node scripts/generate-tauri-latest-json.mjs --assets-dir release-assets --version 0.1.0 --tag v0.1.0 --repo owner/repo --notes-file RELEASE_NOTES.md --output release-assets/latest.json

Generates Tauri updater latest.json from signed release artifacts. The assets
directory must contain exactly one macOS .app.tar.gz updater asset, one Windows
.exe.zip updater asset or .exe fallback, and one Linux .AppImage.tar.gz updater
asset or .AppImage fallback, each with a matching .sig file.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  for (const name of ["assetsDir", "version", "notesFile", "repo", "output"]) {
    if (!options[name]) {
      fail(
        `missing required --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
    }
  }

  const notes = await readFile(options.notesFile, "utf8");
  const pubDate = options.pubDate || new Date().toISOString();
  const tag = normalizeTag(options.tag, options.version);
  const latestJson = await buildLatestJson({
    assetsDir: options.assetsDir,
    version: options.version,
    notes,
    pubDate,
    repo: options.repo,
    tag,
  });

  await writeFile(options.output, `${JSON.stringify(latestJson, null, 2)}\n`);
  console.log(`wrote ${options.output}`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(`generate latest.json failed: ${error.message}`);
    process.exit(1);
  });
}
