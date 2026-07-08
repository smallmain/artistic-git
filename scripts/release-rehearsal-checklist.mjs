#!/usr/bin/env node
/* global console, process */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const requiredSecrets = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "GITHUB_TOKEN",
];
const requiredEvidence = [
  ["ARTISTIC_GIT_RELEASE_010_ARTIFACT_URL", "0.1.0 release artifact URL"],
  ["ARTISTIC_GIT_RELEASE_MACOS_INSTALL_OK", "macOS install smoke passed"],
  ["ARTISTIC_GIT_RELEASE_WINDOWS_INSTALL_OK", "Windows install smoke passed"],
  ["ARTISTIC_GIT_RELEASE_LINUX_INSTALL_OK", "Linux install smoke passed"],
  [
    "ARTISTIC_GIT_RELEASE_MACOS_UPDATE_011_OK",
    "macOS 0.1.0 to 0.1.1 updater rehearsal passed",
  ],
  [
    "ARTISTIC_GIT_RELEASE_WINDOWS_UPDATE_011_OK",
    "Windows 0.1.0 to 0.1.1 updater rehearsal passed",
  ],
  [
    "ARTISTIC_GIT_RELEASE_LINUX_UPDATE_011_OK",
    "Linux 0.1.0 to 0.1.1 updater rehearsal passed",
  ],
];

const missingSecrets = requiredSecrets.filter((name) => !process.env[name]);
const missingEvidence = requiredEvidence
  .filter(([name]) => process.env[name] !== "1" && !process.env[name])
  .map(([name]) => name);
const dryRun = process.env.ARTISTIC_GIT_RELEASE_REHEARSAL_DRY_RUN !== "0";
const reportDir =
  process.env.ARTISTIC_GIT_RELEASE_REHEARSAL_REPORT_DIR ??
  (process.env.CI ? path.join("artifacts", "release-rehearsal") : null);
const status = dryRun
  ? "skipped"
  : missingSecrets.length > 0 || missingEvidence.length > 0
    ? "blocker"
    : "pass";
const rehearsal = {
  schemaVersion: 1,
  kind: "release-rehearsal-checklist",
  generatedAt: new Date().toISOString(),
  mode: dryRun ? "dry-run checklist" : "operator-confirmed rehearsal",
  dryRun,
  status,
  result: status,
  requiredSecrets: requiredSecrets.map((name) => ({
    name,
    present: Boolean(process.env[name]),
  })),
  missingSecrets,
  requiredEvidence: requiredEvidence.map(([name, description]) => ({
    name,
    description,
    present: Boolean(process.env[name]),
    value: process.env[name] ? "provided" : "missing",
  })),
  missingEvidence,
  skips: dryRun
    ? [
        {
          id: "dry-run",
          message:
            "Dry-run checklist artifact generated; signed release, installation, and updater rehearsal were not executed.",
        },
      ]
    : [],
  blockers:
    status === "blocker"
      ? [
          ...missingSecrets.map((name) => ({
            id: "missing-secret",
            name,
            message: `${name} is required for an operator-confirmed release rehearsal.`,
          })),
          ...missingEvidence.map((name) => ({
            id: "missing-evidence",
            name,
            message: `${name} must be recorded before the TASKS.md release rehearsal checkbox can be checked.`,
          })),
        ]
      : [],
  taskCheckbox:
    status === "pass"
      ? "eligible-after-artifact-review"
      : "must-remain-unchecked",
  cannotCheckTask:
    status !== "pass"
      ? "TASKS.md release rehearsal remains unchecked until signed artifacts are built, installed, and update-tested on macOS, Windows, and Linux."
      : null,
};

const markdown = `# Artistic Git 0.1.0 release rehearsal checklist

This script is a checklist entry point, not a local substitute for the formal
release rehearsal. The TASKS.md release item can only be checked after signed
artifacts are built, installed, and update-tested on all three target platforms.

Mode: ${rehearsal.mode}

Required external prerequisites:
- GitHub repository environments/variables enable main release publishing.
- macOS signing/notarization identity and Tauri updater private key are available.
- Windows signing material is available where the release workflow expects it.
- Linux package signing/upload credentials are available if enabled.
- Physical or VM coverage exists for macOS 13+, current Windows, and target Linux.

Commands to run:
- pnpm install --frozen-lockfile
- pnpm lint
- pnpm typecheck
- pnpm test
- pnpm cargo:fmt
- pnpm cargo:clippy
- pnpm cargo:test
- pnpm git-dist:check:real
- ARTISTIC_GIT_E2E_REAL_GIT=1 ARTISTIC_GIT_DIST_DIR=<real git-dist> pnpm e2e:tauri
- ARTISTIC_GIT_DIST_DIR=<real git-dist> pnpm phase12:perf
- pnpm release:check
- pnpm tauri build

0.1.0 rehearsal steps:
- Tag or dispatch the release workflow for 0.1.0 in a protected release environment.
- Confirm checksums, updater signatures, release notes, and uploaded assets.
- Install 0.1.0 on macOS, Windows, and Linux from the produced artifacts.
- Smoke test clone/open/commit/sync/revert on each installed app.
- Publish or stage 0.1.1 with a minimal changelog.
- On each platform, verify the updater discovers 0.1.1, downloads it, gates restart during active operations, installs, and relaunches into 0.1.1.
- Record artifact URLs, platform versions, install results, updater results, and rollback notes.

Secrets present in this shell:
${requiredSecrets.map((name) => `- ${name}: ${process.env[name] ? "present" : "missing"}`).join("\n")}

Evidence markers in this shell:
${requiredEvidence.map(([name, description]) => `- ${name}: ${process.env[name] ? "present" : "missing"} (${description})`).join("\n")}

Dry-run verifier result:
- Status: ${rehearsal.status}
- Result class: ${rehearsal.result}
- TASKS.md release item: ${rehearsal.cannotCheckTask ?? "operator prerequisites are present; still requires platform install/update evidence before checking."}
`;

console.log(markdown);
writeReports(markdown, rehearsal);

if (status === "blocker") {
  throw new Error(
    `Cannot mark operator-confirmed rehearsal: missing ${[...missingSecrets, ...missingEvidence].join(", ")}.`,
  );
}

function writeReports(markdownContent, jsonContent) {
  if (!reportDir) {
    return;
  }
  const absoluteReportDir = path.resolve(reportDir);
  mkdirSync(absoluteReportDir, { recursive: true });
  writeFileSync(
    path.join(absoluteReportDir, "release-rehearsal-checklist.md"),
    markdownContent,
  );
  writeFileSync(
    path.join(absoluteReportDir, "release-rehearsal-checklist.json"),
    `${JSON.stringify(jsonContent, null, 2)}\n`,
  );
  console.log(
    `Wrote release rehearsal checklist artifacts to ${absoluteReportDir}`,
  );
}
