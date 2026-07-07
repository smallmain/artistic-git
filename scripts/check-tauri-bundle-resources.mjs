#!/usr/bin/env node
/* global console, process */

import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tauriConfigPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
const requiredTargets = ["app", "dmg", "nsis", "appimage", "deb"];

const args = process.argv.slice(2);
const help = args.includes("--help") || args.includes("-h");
const requireManifest = args.includes("--require-manifest");

const usage = `Usage:
  node scripts/check-tauri-bundle-resources.mjs
  node scripts/check-tauri-bundle-resources.mjs --require-manifest

Checks that Tauri bundles the embedded git-dist resource tree at the packaged
resource path expected by release builds. --require-manifest is for real release
jobs after the git-dist artifact has been staged.`;

if (help) {
  console.log(usage);
  process.exit(0);
}

function fail(message) {
  console.error(`tauri bundle resource check failed: ${message}`);
  process.exit(1);
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

const raw = await readFile(tauriConfigPath, "utf8");
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

const resources = bundle.resources;
if (!resources || Array.isArray(resources) || typeof resources !== "object") {
  fail(
    "bundle.resources must map the git-dist directory to the packaged path.",
  );
}

const gitDistEntry = Object.entries(resources).find(([source, target]) => {
  const normalizedSource = source.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedTarget = target.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalizedSource === "resources/git-dist" && normalizedTarget === "git-dist"
  );
});

if (!gitDistEntry) {
  fail('bundle.resources must include "resources/git-dist/": "git-dist/".');
}

const [source] = gitDistEntry;
const sourcePath = path.join(repoRoot, "src-tauri", source);
const sourceStat = await stat(sourcePath).catch(() => null);
if (!sourceStat?.isDirectory()) {
  fail(`git-dist resource source must be a directory: ${sourcePath}`);
}

if (requireManifest) {
  const manifestPath = path.join(sourcePath, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    fail(`real release packaging requires staged ${manifestPath}`);
  }
}

info(
  requireManifest
    ? "git-dist resources and release manifest are wired."
    : "git-dist resources are wired; manifest staging is deferred to release jobs.",
);
