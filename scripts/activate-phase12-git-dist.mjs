#!/usr/bin/env node
/* global console, process */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

const executableResourcePaths = [
  "git/bin",
  "git/libexec/git-core",
  "git-lfs/git-lfs",
  "helpers",
];

const runId = process.env.RUN_ID ?? "";
const artifactName = process.env.ARTIFACT_NAME ?? "";
const distDir = process.env.DIST_DIR ?? "";
const fallbackDistDir = process.env.FALLBACK_DIST_DIR ?? "";
const githubEnvPath = process.env.GITHUB_ENV ?? "";
let sourceKind = "none";
let activeDistDir = "";

if (!githubEnvPath) {
  throw new Error(
    "GITHUB_ENV is required to activate phase 12 git-dist evidence.",
  );
}

if (runId && existsSync(path.join(distDir, "manifest.json"))) {
  sourceKind = "artifact";
  activeDistDir = distDir;
} else if (!runId && fallbackDistDir) {
  sourceKind = "repository-variable";
  activeDistDir = fallbackDistDir;
} else if (runId) {
  sourceKind = "artifact-missing";
}

const restoredExecutables = activeDistDir
  ? restoreExecutableBits(activeDistDir)
  : [];

const envLines = [
  ["ARTISTIC_GIT_PHASE12_GIT_DIST_SOURCE", sourceKind],
  ["ARTISTIC_GIT_PHASE12_GIT_DIST_ARTIFACT_NAME", artifactName],
  ["ARTISTIC_GIT_PHASE12_GIT_DIST_RUN_ID", runId],
  ["ARTISTIC_GIT_PHASE12_GIT_DIST_RUN_URL", process.env.RUN_URL ?? ""],
  ["ARTISTIC_GIT_PHASE12_GIT_DIST_TARGET", process.env.GIT_DIST_TARGET ?? ""],
  ["ARTISTIC_GIT_PHASE12_GIT_DIST_DOWNLOAD_DIR", distDir],
];
if (activeDistDir) {
  envLines.push(["ARTISTIC_GIT_DIST_DIR", activeDistDir]);
}

appendFileSync(
  githubEnvPath,
  envLines.map(([key, value]) => githubEnvLine(key, value)).join("\n") + "\n",
);

if (activeDistDir) {
  console.log(`Activated ${sourceKind} git-dist at ${activeDistDir}.`);
  if (restoredExecutables.length > 0) {
    console.log(
      `Restored executable bits for ${restoredExecutables.length} git-dist resource path(s).`,
    );
  }
} else {
  console.log(
    "No ARTISTIC_GIT_DIST_DIR was activated; Phase 12 evidence scripts will report skipped or blocker status.",
  );
}

function restoreExecutableBits(rootDir) {
  if (process.platform === "win32") {
    return [];
  }

  const manifestPath = path.join(rootDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return [];
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestPaths = manifest.paths ?? {};
  const rootRealPath = realpathSync(rootDir);
  const restored = [];
  const candidates = collectExecutableCandidates(rootDir, manifestPaths);

  for (const [label, relativePath] of candidates.values()) {
    const absolutePath = path.join(rootDir, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const realPath = realpathSync(absolutePath);
    if (!isPathInside(realPath, rootRealPath)) {
      throw new Error(
        `${label} resolves outside the activated git-dist (${realPath}).`,
      );
    }
    if (!statSync(realPath).isFile()) {
      continue;
    }
    chmodSync(
      lstatSync(absolutePath).isSymbolicLink() ? realPath : absolutePath,
      0o755,
    );
    restored.push(relativePath);
  }

  return restored;
}

function collectExecutableCandidates(rootDir, manifestPaths) {
  const candidates = new Map();
  for (const [key, relativePath] of Object.entries(manifestPaths)) {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      continue;
    }
    addCandidate(candidates, relativePath, `paths.${key}`);
  }

  for (const relativePath of executableResourcePaths) {
    addExecutableResource(candidates, rootDir, relativePath);
  }

  return candidates;
}

function addExecutableResource(candidates, rootDir, relativePath) {
  addCandidate(candidates, relativePath, `executable resource ${relativePath}`);
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isDirectory()) {
    return;
  }

  for (const nestedPath of listFiles(rootDir, relativePath)) {
    addCandidate(candidates, nestedPath, `executable resource ${relativePath}`);
  }
}

function addCandidate(candidates, relativePath, label) {
  assertRelativeManifestPath(relativePath, label);
  candidates.set(relativePath, [label, relativePath]);
}

function listFiles(rootDir, relativeDir) {
  const absoluteDir = path.join(rootDir, relativeDir);
  const files = [];
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(rootDir, relativePath);
    if (entry.isDirectory()) {
      files.push(...listFiles(rootDir, relativePath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relativePath);
    } else if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function assertRelativeManifestPath(value, label) {
  if (
    path.isAbsolute(value) ||
    value.split(/[\\/]/).includes("..") ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a relative path inside git-dist.`);
  }
}

function isPathInside(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function githubEnvLine(key, value) {
  if (!/^[A-Z0-9_]+$/.test(key)) {
    throw new Error(`Invalid GitHub env key: ${key}`);
  }
  const stringValue = String(value ?? "");
  if (stringValue.includes("\n") || stringValue.includes("\r")) {
    throw new Error(`Invalid newline in GitHub env value for ${key}.`);
  }
  return `${key}=${stringValue}`;
}
