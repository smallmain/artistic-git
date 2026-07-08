#!/usr/bin/env node
/* global console, process */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const scanRoots = [
  ".github/workflows",
  "crates",
  "scripts",
  "src",
  "src-tauri",
  "git-dist.toml",
  "package.json",
  "README.md",
  "README_zh-CN.md",
  "docs",
];

const ignoredPathParts = new Set([
  ".git",
  "dist",
  "node_modules",
  "target",
  ".artifacts",
  ".cache",
  ".staging",
]);

const ignoredRelativePrefixes = ["src-tauri/gen/"];

const textExtensions = new Set([
  ".cjs",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".toml",
  ".tsx",
  ".ts",
  ".yml",
  ".yaml",
]);

const allowedUrlPatterns = [
  /^https:\/\/github\.com\/smallmain\/artistic-git(?:[/?#].*)?$/,
  /^https:\/\/github\.com\/smallmain\/artistic-git\/releases(?:[/?#].*)?$/,
  /^https:\/\/github\.com\/smallmain\/artistic-git\/releases\/latest\/download\/latest\.json$/,
  /^https:\/\/github\.com\/smallmain\/artistic-git\/releases\/download\/[^/]+\/[^"'`\s)]+$/,
  /^https:\/\/github\.com\/\$\{repo\}\/releases\/download\/\$\{encodedTag\}\/\$\{encodedFile\}$/,
  /^https:\/\/github\.com\/git-for-windows\/git\/releases\/tag\/[^/]+$/,
  /^https:\/\/github\.com\/git-for-windows\/git\/releases\/download\/[^/]+\/[^"'`\s)]+$/,
  /^https:\/\/github\.com\/git\/git\/releases\/tag\/[^/]+$/,
  /^https:\/\/github\.com\/git-lfs\/git-lfs\/releases\/tag\/[^/]+$/,
  /^https:\/\/github\.com\/git-lfs\/git-lfs\/releases\/download\/[^/]+\/[^"'`\s)]+$/,
  /^https:\/\/github\.com\/PowerShell\/Win32-OpenSSH\/releases\/tag\/[^/]+$/,
  /^https:\/\/github\.com\/PowerShell\/Win32-OpenSSH\/releases\/download\/[^/]+\/[^"'`\s)]+$/,
  /^https:\/\/api\.github\.com\/repos\/\$\{args\.repo\}\/releases$/,
  /^https:\/\/github\.com\/studio\/[^"'`\s)]+$/,
  /^git@github\.com:studio\/[^"'`\s)]+$/,
  /^https:\/\/www\.kernel\.org\/pub\/software\/scm\/git\/[^"'`\s)]+$/,
  /^https:\/\/www\.gravatar\.com\/avatar\/(?:\$\{.*)?$/,
  /^https:\/\/git-lfs\.github\.com\/spec\/v1$/,
  /^https:\/\/schema\.tauri\.app\/config\/2$/,
  /^https:\/\/example\.test\/[^"'`\s)]+$/,
  /^http:\/\/127\.0\.0\.1(?::(?:\d+|\{\}))?(?:\/[^"'`\s)]*)?$/,
];

const runtimeNetworkApis = [
  /\bXMLHttpRequest\b/,
  /\bnavigator\.sendBeacon\b/,
  /\bnew\s+WebSocket\b/,
  /\bEventSource\b/,
];

const analyticsTerms = [
  "amplitude",
  "datadog",
  "fullstory",
  "google-analytics",
  "mixpanel",
  "posthog",
  "sentry",
];

const allowedFetchFiles = new Set([
  "scripts/fetch-git-dist.mjs",
  "scripts/check-git-dist-openssh-release.mjs",
  "scripts/git-dist-report.mjs",
]);

const urlPattern = /\b(?:https?:\/\/|git@github\.com:)[^"'`\s<>)]+/g;

const failures = [];
let scannedFiles = 0;
let checkedUrls = 0;

for (const root of scanRoots) {
  await scanPath(path.join(repoRoot, root));
}

if (failures.length > 0) {
  console.error("privacy network audit failed:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `privacy network audit: scanned ${scannedFiles} files; checked ${checkedUrls} URLs and runtime network APIs.`,
);

async function scanPath(filePath) {
  const relative = normalizeRelative(filePath);
  if (shouldIgnore(relative)) {
    return;
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat) {
    return;
  }
  if (fileStat.isDirectory()) {
    for (const entry of await readdir(filePath)) {
      await scanPath(path.join(filePath, entry));
    }
    return;
  }
  if (!fileStat.isFile() || !isTextFile(filePath)) {
    return;
  }

  const content = await readFile(filePath, "utf8");
  scannedFiles += 1;
  checkUrls(relative, content);
  checkRuntimeNetworkApis(relative, content);
  checkAnalyticsTerms(relative, content);
}

function checkUrls(relative, content) {
  for (const match of content.matchAll(urlPattern)) {
    const url = trimTrailingPunctuation(match[0]);
    checkedUrls += 1;
    if (!allowedUrlPatterns.some((pattern) => pattern.test(url))) {
      failures.push(`${relative}: unapproved URL literal ${url}`);
    }
  }
}

function checkRuntimeNetworkApis(relative, content) {
  if (relative === "scripts/check-privacy-network.mjs") {
    return;
  }
  if (/\bfetch\s*\(/.test(content) && !allowedFetchFiles.has(relative)) {
    failures.push(`${relative}: runtime fetch() is not privacy-approved`);
  }
  for (const pattern of runtimeNetworkApis) {
    if (pattern.test(content)) {
      failures.push(
        `${relative}: runtime network API ${pattern.source} is not privacy-approved`,
      );
    }
  }
}

function checkAnalyticsTerms(relative, content) {
  if (relative === "scripts/check-privacy-network.mjs") {
    return;
  }
  const lowered = content.toLowerCase();
  for (const term of analyticsTerms) {
    if (lowered.includes(term)) {
      failures.push(`${relative}: analytics/telemetry term found: ${term}`);
    }
  }
}

function shouldIgnore(relative) {
  const parts = relative.split("/");
  if (parts.some((part) => ignoredPathParts.has(part))) {
    return true;
  }
  return ignoredRelativePrefixes.some((prefix) => relative.startsWith(prefix));
}

function isTextFile(filePath) {
  return textExtensions.has(path.extname(filePath));
}

function normalizeRelative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function trimTrailingPunctuation(value) {
  return value.replace(/\\[nr].*$/u, "").replace(/[\\.,;:]+$/u, "");
}
