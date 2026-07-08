#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fullChainPath = path.join(
  repoRoot,
  "e2e",
  "tauri",
  "full-chain-real-git.e2e.ts",
);
const startScreenHelperPath = path.join(
  repoRoot,
  "e2e",
  "tauri",
  "start-screen.ts",
);
const source = [
  readFileSync(fullChainPath, "utf8"),
  readFileSync(startScreenHelperPath, "utf8"),
].join("\n");

const forbiddenPatterns = [
  {
    pattern: /__TAURI_INTERNALS__/,
    reason: "direct Tauri internals access bypasses the UI",
  },
  {
    pattern: /\bappInvoke\b/,
    reason: "appInvoke reintroduces backend command probing",
  },
  {
    pattern: /\.invoke\s*(?:<|\()/,
    reason: "Tauri invoke calls are not allowed in the real UI full-chain E2E",
  },
  {
    pattern: /\brepository_summary\b/,
    reason: "repository readiness must be observed through UI state",
  },
];

const requiredUiTokens = [
  '[data-testid="start-screen"]',
  '[data-testid="clone-submit"]',
  '"repository-shell"',
  '[data-testid="repository-tab-local-changes"]',
  '"local-change-row"',
  '[data-testid="commit-dialog-submit"]',
  '[data-testid="repository-sync-all"]',
  '[data-testid="conflict-resolution-overlay"]',
  "assertCloseGuardBlocksWindowShortcutDuringConflict",
  "Close window?",
  '"history-commit-row"',
  "data-commit-id",
];

const failures = [];

for (const rule of forbiddenPatterns) {
  if (rule.pattern.test(source)) {
    failures.push(rule.reason);
  }
}

for (const token of requiredUiTokens) {
  if (!source.includes(token)) {
    failures.push(
      `full-chain real-git E2E no longer references required UI token ${token}`,
    );
  }
}

if (failures.length > 0) {
  console.error("E2E real UI check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  "E2E real UI check passed: full-chain test uses UI selectors and no Tauri backend invoke.",
);
