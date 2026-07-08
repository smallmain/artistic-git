#!/usr/bin/env node
/* global console, process */

const requiredSecrets = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "GITHUB_TOKEN",
];

const missingSecrets = requiredSecrets.filter((name) => !process.env[name]);
const dryRun = process.env.ARTISTIC_GIT_RELEASE_REHEARSAL_DRY_RUN !== "0";

console.log(`# Artistic Git 0.1.0 release rehearsal checklist

This script is a checklist entry point, not a local substitute for the formal
release rehearsal. The TASKS.md release item can only be checked after signed
artifacts are built, installed, and update-tested on all three target platforms.

Mode: ${dryRun ? "dry-run checklist" : "operator-confirmed rehearsal"}

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
`);

if (!dryRun && missingSecrets.length > 0) {
  throw new Error(
    `Cannot mark operator-confirmed rehearsal: missing ${missingSecrets.join(", ")}.`,
  );
}
