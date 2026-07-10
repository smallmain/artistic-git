import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const checklistScript = path.join(
  repoRoot,
  "scripts",
  "release-rehearsal-checklist.mjs",
);

const platformIds = ["macos", "windows", "linux"];
const platformPrefixes = ["MACOS", "WINDOWS", "LINUX"];

test("dry-run checklist remains skipped and writes machine-readable evidence", async () => {
  const result = await runChecklist();

  assert.equal(result.status, 0);
  assert.equal(result.report.status, "skipped");
  assert.equal(result.report.taskCheckbox, "must-remain-unchecked");
  assert.equal(result.report.blockers[0].id, "formal-rehearsal-not-run");
  assert.match(result.stdout, /Status: skipped/);
});

test("dry-run checklist records GITHUB_SHA when workflow SHA is not provided", async () => {
  const githubSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const result = await runChecklist({
    GITHUB_SHA: githubSha,
  });

  assert.equal(result.status, 0);
  assert.equal(result.report.ciDryRunArtifact.workflowSha, githubSha);
});

test("operator-confirmed mode blocks when required evidence is missing", async () => {
  const result = await runChecklist({
    ARTISTIC_GIT_RELEASE_REHEARSAL_DRY_RUN: "0",
    TAURI_SIGNING_PRIVATE_KEY: "present",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "present",
    GH_TOKEN: "present",
    TAURI_UPDATER_PUBLIC_KEY: "present",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.report.status, "blocker");
  assert.ok(
    result.report.missingEvidence.includes(
      "ARTISTIC_GIT_RELEASE_REHEARSAL_OPERATOR_CONFIRMED",
    ),
  );
  assert.equal(result.report.taskCheckbox, "must-remain-unchecked");
});

test("operator-confirmed mode passes with all release and update markers", async () => {
  const result = await runChecklist(buildCompleteOperatorEnv());

  assert.equal(result.status, 0);
  assert.equal(result.report.status, "pass");
  assert.equal(result.report.taskCheckbox, "eligible-after-artifact-review");
  assert.deepEqual(result.report.missingSecrets, []);
  assert.deepEqual(result.report.missingEvidence, []);
  assert.deepEqual(
    result.report.operatorConfirmation.requiredMarkers.map(
      (marker) => marker.name,
    ),
    ["ARTISTIC_GIT_RELEASE_REHEARSAL_OPERATOR_CONFIRMED"],
  );
});

test("operator-confirmed mode rejects malformed update rehearsal records", async () => {
  const env = buildCompleteOperatorEnv();
  env.ARTISTIC_GIT_RELEASE_UPDATE_REHEARSAL_RECORD_JSON = JSON.stringify({
    schemaVersion: 1,
    fromVersion: "0.1.0",
    toVersion: "0.1.1",
    platformRecords: [
      {
        platform: "macos",
        installedVersionBefore: "0.1.0",
        discoveredVersion: "0.1.1",
        installedVersionAfter: "0.1.0",
        installSmokePassed: true,
        updateDownloaded: true,
        restartGateVerified: true,
        postUpdateSmokePassed: true,
        evidenceUrl: "https://github.com/smallmain/artistic-git/actions/runs/1",
        recordedAt: "2026-07-08T00:00:00.000Z",
        operator: "release-operator",
      },
    ],
  });

  const result = await runChecklist(env);

  assert.notEqual(result.status, 0);
  assert.equal(result.report.status, "blocker");
  assert.equal(result.report.updateRehearsal.record.status, "invalid");
  assert.ok(
    result.report.updateRehearsal.record.validationErrors.some((error) =>
      error.includes("installedVersionAfter"),
    ),
  );
});

test("operator-confirmed mode rejects GitHub evidence from another repository", async () => {
  const env = buildCompleteOperatorEnv();
  env.ARTISTIC_GIT_RELEASE_010_RUN_URL =
    "https://" +
    ["github.com", "other", "repo", "actions", "runs", "100"].join("/");

  const result = await runChecklist(env);

  assert.notEqual(result.status, 0);
  assert.equal(result.report.status, "blocker");
  assert.ok(
    result.report.blockers.some(
      (blocker) =>
        blocker.id === "invalid-github-url" &&
        blocker.message.includes("smallmain/artistic-git"),
    ),
  );
});

async function runChecklist(env = {}) {
  const reportDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-release-rehearsal-"),
  );

  try {
    const child = spawnSync(process.execPath, [checklistScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ARTISTIC_GIT_RELEASE_REHEARSAL_REPORT_DIR: reportDir,
        ...env,
      },
    });
    const report = JSON.parse(
      await readFile(
        path.join(reportDir, "release-rehearsal-checklist.json"),
        "utf8",
      ),
    );

    return {
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
      report,
    };
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

function buildCompleteOperatorEnv() {
  const env = {
    ARTISTIC_GIT_RELEASE_REHEARSAL_DRY_RUN: "0",
    TAURI_SIGNING_PRIVATE_KEY: "present",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "present",
    GH_TOKEN: "present",
    TAURI_UPDATER_PUBLIC_KEY: "present",
    ARTISTIC_GIT_RELEASE_REHEARSAL_OPERATOR_CONFIRMED: "1",
    ARTISTIC_GIT_RELEASE_010_RUN_URL:
      "https://github.com/smallmain/artistic-git/actions/runs/100",
    ARTISTIC_GIT_RELEASE_010_ARTIFACT_URL:
      "https://github.com/smallmain/artistic-git/releases/download/v0.1.0/Artistic-Git.dmg",
    ARTISTIC_GIT_RELEASE_010_RELEASE_URL:
      "https://github.com/smallmain/artistic-git/releases/tag/v0.1.0",
    ARTISTIC_GIT_RELEASE_011_RUN_URL:
      "https://github.com/smallmain/artistic-git/actions/runs/101",
    ARTISTIC_GIT_RELEASE_011_ARTIFACT_URL:
      "https://github.com/smallmain/artistic-git/releases/download/v0.1.1/Artistic-Git.dmg",
    ARTISTIC_GIT_RELEASE_011_RELEASE_URL:
      "https://github.com/smallmain/artistic-git/releases/tag/v0.1.1",
  };

  for (const prefix of platformPrefixes) {
    env[`ARTISTIC_GIT_RELEASE_${prefix}_INSTALL_OK`] = "1";
    env[`ARTISTIC_GIT_RELEASE_${prefix}_UPDATE_011_OK`] = "1";
  }

  env.ARTISTIC_GIT_RELEASE_UPDATE_REHEARSAL_RECORD_JSON = JSON.stringify({
    schemaVersion: 1,
    fromVersion: "0.1.0",
    toVersion: "0.1.1",
    platformRecords: platformIds.map((platform) => ({
      platform,
      installedVersionBefore: "0.1.0",
      discoveredVersion: "0.1.1",
      installedVersionAfter: "0.1.1",
      installSmokePassed: true,
      updateDownloaded: true,
      restartGateVerified: true,
      postUpdateSmokePassed: true,
      evidenceUrl: `https://github.com/smallmain/artistic-git/actions/runs/101/artifacts/${platform}`,
      recordedAt: "2026-07-08T00:00:00.000Z",
      operator: "release-operator",
    })),
  });

  return env;
}
