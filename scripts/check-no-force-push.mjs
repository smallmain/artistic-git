#!/usr/bin/env node
/* global console, process */

import { readdir, readFile } from "node:fs/promises";
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
];

const skippedDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "target",
  "src-tauri/gen",
]);

const skippedFiles = new Set(["scripts/check-no-force-push.mjs"]);

const scannedExtensions = new Set([
  ".json",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

const unconditionalPatterns = [
  {
    label: "force push flag",
    pattern: /(^|[^A-Za-z0-9_])--force(?:-with-lease)?(?=$|[^A-Za-z0-9_])/,
  },
  {
    label: "force push refspec",
    pattern: /(["'`])\+[^"'`\s:]+:[^"'`\s]+\1/,
  },
];

const contextualPatterns = [
  {
    label: "short force push flag",
    pattern: /(["'`])-f\1/,
    context: /(^|[^A-Za-z0-9_])push($|[^A-Za-z0-9_])/,
  },
];

const findings = [];
let scannedFiles = 0;

for (const root of scanRoots) {
  await scanPath(path.join(repoRoot, root));
}

if (findings.length > 0) {
  console.error("no-force-push check failed:");
  for (const finding of findings) {
    console.error(
      `  - ${finding.file}:${finding.line}: ${finding.label}: ${finding.text.trim()}`,
    );
  }
  process.exit(1);
}

console.log(`no-force-push: checked ${scannedFiles} files; no force push args found.`);

async function scanPath(filePath) {
  const relative = path.relative(repoRoot, filePath);
  if (skippedDirectories.has(relative)) {
    return;
  }

  let entries;
  try {
    entries = await readdir(filePath, { withFileTypes: true });
  } catch {
    await scanFile(filePath);
    return;
  }

  for (const entry of entries) {
    const child = path.join(filePath, entry.name);
    const childRelative = path.relative(repoRoot, child);
    if (entry.isDirectory()) {
      if (!isSkippedDirectory(childRelative)) {
        await scanPath(child);
      }
    } else if (entry.isFile() && scannedExtensions.has(path.extname(entry.name))) {
      await scanFile(child);
    }
  }
}

function isSkippedDirectory(relativePath) {
  return Array.from(skippedDirectories).some(
    (skipped) => relativePath === skipped || relativePath.startsWith(`${skipped}${path.sep}`),
  );
}

async function scanFile(filePath) {
  const relative = path.relative(repoRoot, filePath);
  if (skippedFiles.has(relative)) {
    return;
  }

  const text = await readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  scannedFiles += 1;

  lines.forEach((line, index) => {
    for (const { label, pattern } of unconditionalPatterns) {
      if (pattern.test(line)) {
        findings.push({
          file: relative,
          line: index + 1,
          label,
          text: line,
        });
      }
    }

    for (const { label, pattern, context } of contextualPatterns) {
      if (!pattern.test(line)) {
        continue;
      }
      const start = Math.max(0, index - 3);
      const end = Math.min(lines.length, index + 4);
      const nearby = lines.slice(start, end).join("\n");
      if (context.test(nearby)) {
        findings.push({
          file: relative,
          line: index + 1,
          label,
          text: line,
        });
      }
    }
  });
}
