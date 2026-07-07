#!/usr/bin/env node
/* global console, process */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const findings = [];
const counters = {
  files: 0,
  lfsChecks: 0,
  mergeCommandSites: 0,
};

await auditLfsLockReservedSurface();
await auditArbitraryMergeEntrypoints();

if (findings.length > 0) {
  console.error("v1 safety audit failed:");
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
  process.exit(1);
}

console.log(
  [
    "v1-safety-audit:",
    `checked ${counters.lfsChecks} LFS lock/attribute hooks`,
    `${counters.mergeCommandSites} merge command sites`,
    `across ${counters.files} files`,
    "with no findings.",
  ].join(" "),
);

async function auditLfsLockReservedSurface() {
  const requiredSnippets = [
    {
      file: "crates/contracts/src/lib.rs",
      label: "DiffPayload carries LFS lock status",
      snippet: "pub lfs_lock: Option<LfsLockStatus>",
    },
    {
      file: "crates/contracts/src/lib.rs",
      label: "LFS lock status contract type",
      snippet: "pub struct LfsLockStatus",
    },
    {
      file: "src/lib/ipc/generated.ts",
      label: "generated TS LFS lock type",
      snippet: "export type LfsLockStatus",
    },
    {
      file: "src/features/diff/types.ts",
      label: "Diff list item preserves LFS lock status",
      snippet: "lfsLock?: LfsLockStatus | null",
    },
    {
      file: "src/features/diff/DiffViewer.tsx",
      label: "Diff viewer renders LFS lock state",
      snippet: "payload.lfsLock?.locked",
    },
    {
      file: "src/features/local-changes/fixtures.ts",
      label: "local changes fixture covers locked LFS file",
      snippet: "lfsLock: {",
    },
    {
      file: "crates/app/src/commit.rs",
      label: "commit decision can track large files with LFS",
      snippet: "LargeFileDecision::TrackWithLfs",
    },
    {
      file: "crates/app/src/commit.rs",
      label: "commit path stages generated .gitattributes",
      snippet: 'add_paths.push(".gitattributes".to_owned())',
    },
    {
      file: "crates/app/src/commit.rs",
      label: "LFS tracking writes merge/diff/filter attributes",
      snippet: "filter=lfs diff=lfs merge=lfs -text",
    },
    {
      file: "crates/app/src/commit.rs",
      label: "large file LFS tracking has an integration test",
      snippet: 'expect("track large file with lfs")',
    },
  ];

  for (const check of requiredSnippets) {
    const content = await readRelative(check.file);
    counters.lfsChecks += 1;
    if (!content.includes(check.snippet)) {
      findings.push(
        `${check.file}: missing ${check.label} (${JSON.stringify(check.snippet)})`,
      );
    }
  }
}

async function auditArbitraryMergeEntrypoints() {
  const files = await collectFiles(repoRoot, new Set([".rs", ".ts", ".tsx"]));

  for (const filePath of files) {
    const relative = normalizeRelative(filePath);
    if (shouldSkip(relative)) {
      continue;
    }

    counters.files += 1;
    const content = await readFile(filePath, "utf8");
    auditMergeCommandArrays(relative, content);
    auditMergeEntrypointNames(relative, content);
  }
}

function auditMergeCommandArrays(relative, content) {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!looksLikeGitMergeCommand(line)) {
      continue;
    }

    counters.mergeCommandSites += 1;
    if (isAllowedMergeCommandSite(relative, line)) {
      continue;
    }

    findings.push(
      `${relative}:${index + 1}: product code must not expose arbitrary git merge; use ff-only sync or conflict continuation only.`,
    );
  }
}

function auditMergeEntrypointNames(relative, content) {
  const forbidden = [
    /\bmerge_branch\b/i,
    /\bmergeBranch\b/,
    /\bMergeBranch\b/,
    /\bmerge\s+branch\b/i,
  ];

  for (const pattern of forbidden) {
    if (pattern.test(content) && !isAllowedTextFixture(relative)) {
      findings.push(
        `${relative}: possible arbitrary branch merge entrypoint matched ${pattern}.`,
      );
    }
  }
}

function looksLikeGitMergeCommand(line) {
  return (
    /\[\s*["']merge["']/.test(line) ||
    /OsString::from\(["']merge["']\)/.test(line)
  );
}

function isAllowedMergeCommandSite(relative, line) {
  if (
    line.includes('"merge-base"') ||
    line.includes("'merge-base'") ||
    line.includes("--ff-only") ||
    line.includes("--abort") ||
    line.includes("--continue")
  ) {
    return true;
  }

  const testFixturePatterns = [
    /git_output_result\(\["merge", "other"\]\)/,
    /repo\.git\(\["merge", "--no-ff"/,
  ];
  return (
    isRustTestFile(relative) &&
    testFixturePatterns.some((pattern) => pattern.test(line))
  );
}

function isRustTestFile(relative) {
  return relative.endsWith(".rs");
}

function isAllowedTextFixture(relative) {
  return (
    relative.endsWith(".test.tsx") ||
    relative.endsWith(".test.ts") ||
    relative.includes("/fixtures.")
  );
}

async function collectFiles(root, extensions) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    const relative = normalizeRelative(filePath);
    if (shouldSkip(relative)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(filePath, extensions)));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(filePath);
    }
  }
  return files;
}

function shouldSkip(relative) {
  return (
    relative === "." ||
    relative.startsWith(".git/") ||
    relative.startsWith("dist/") ||
    relative.startsWith("node_modules/") ||
    relative.startsWith("target/") ||
    relative.startsWith("src-tauri/gen/")
  );
}

async function readRelative(relative) {
  return readFile(path.join(repoRoot, relative), "utf8");
}

function normalizeRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
