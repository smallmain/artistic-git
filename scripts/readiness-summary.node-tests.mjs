/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const readinessScript = path.join(import.meta.dirname, "readiness-summary.mjs");
const currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const staleHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("readiness returns nonzero and records every blocker", async () => {
  const fixture = await createFixture("blocked");
  try {
    await writeJson(
      path.join(fixture.artifactsDir, "phase12.json"),
      phase12Summary({ e2e: false, perf: false }),
    );
    const result = runReadiness(fixture);
    assert.notEqual(result.status, 0);
    const summary = await fixture.readSummary();
    assert.equal(summary.schemaVersion, 3);
    assert.equal(summary.overallStatus, "blocked");
    assert.equal(summary.items.length, 3);
    assert.ok(
      summary.remainingBlockers.some(
        (entry) => entry.itemId === "phase12-e2e-full-chain",
      ),
    );
    assert.ok(
      summary.remainingBlockers.some(
        (entry) => entry.itemId === "phase12-performance",
      ),
    );
    assert.ok(
      summary.remainingBlockers.some(
        (entry) => entry.itemId === "release-rehearsal",
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("readiness reports ready only for current passing evidence", async () => {
  const fixture = await createFixture("ready");
  try {
    await writeJson(
      path.join(fixture.artifactsDir, "phase12.json"),
      phase12Summary({ e2e: true, perf: true }),
    );
    await writeJson(
      path.join(fixture.artifactsDir, "release.json"),
      releaseReport({ status: "pass" }),
    );
    const result = runReadiness(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = await fixture.readSummary();
    assert.equal(summary.overallStatus, "ready");
    assert.deepEqual(summary.remainingBlockers, []);
    assert.ok(summary.items.every((item) => item.checkable));
  } finally {
    await fixture.cleanup();
  }
});

test("soft operator blockers keep dry-run readiness non-fatal when Phase 12 is ready", async () => {
  const fixture = await createFixture("soft-operator-blockers");
  try {
    await writeJson(
      path.join(fixture.artifactsDir, "phase12.json"),
      phase12Summary({ e2e: true, perf: true }),
    );
    await writeJson(
      path.join(fixture.artifactsDir, "release.json"),
      releaseReport({ status: "skipped" }),
    );
    const hard = runReadiness(fixture);
    assert.notEqual(hard.status, 0);
    const soft = runReadiness(fixture, {
      ARTISTIC_GIT_READINESS_SOFT_OPERATOR_BLOCKERS: "1",
    });
    assert.equal(soft.status, 0, soft.stderr);
    const summary = await fixture.readSummary();
    assert.equal(summary.overallStatus, "blocked");
    assert.ok(
      summary.remainingBlockers.every(
        (entry) => entry.category === "operator-evidence",
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("soft operator blockers still fail when Phase 12 evidence is blocked", async () => {
  const fixture = await createFixture("soft-operator-still-hard-phase12");
  try {
    await writeJson(
      path.join(fixture.artifactsDir, "phase12.json"),
      phase12Summary({ e2e: true, perf: false }),
    );
    await writeJson(
      path.join(fixture.artifactsDir, "release.json"),
      releaseReport({ status: "skipped" }),
    );
    const result = runReadiness(fixture, {
      ARTISTIC_GIT_READINESS_SOFT_OPERATOR_BLOCKERS: "1",
    });
    assert.notEqual(result.status, 0);
    const summary = await fixture.readSummary();
    assert.ok(
      summary.remainingBlockers.some(
        (entry) => entry.itemId === "phase12-performance",
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("readiness evaluates passing Phase 12 tasks independently", async () => {
  const fixture = await createFixture("independent-phase12-tasks");
  try {
    await writeJson(
      path.join(fixture.artifactsDir, "phase12.json"),
      phase12Summary({ e2e: true, perf: false }),
    );
    await writeJson(
      path.join(fixture.artifactsDir, "release.json"),
      releaseReport({ status: "pass" }),
    );

    const result = runReadiness(fixture);
    assert.notEqual(result.status, 0);
    const summary = await fixture.readSummary();
    const e2eItem = summary.items.find(
      (item) => item.id === "phase12-e2e-full-chain",
    );
    const performanceItem = summary.items.find(
      (item) => item.id === "phase12-performance",
    );

    assert.equal(summary.overallStatus, "blocked");
    assert.equal(e2eItem.status, "ready");
    assert.equal(e2eItem.checkable, true);
    assert.deepEqual(e2eItem.blockers, []);
    assert.equal(performanceItem.status, "blocked");
    assert.equal(performanceItem.checkable, false);
    assert.ok(
      summary.remainingBlockers.every(
        (entry) => entry.itemId !== "phase12-e2e-full-chain",
      ),
    );
    assert.ok(
      summary.remainingBlockers.some(
        (entry) => entry.itemId === "phase12-performance",
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("readiness blocks contradictory Phase 12 task status", async () => {
  const fixture = await createFixture("contradictory-phase12-task");
  try {
    const phase12 = phase12Summary({ e2e: true, perf: true });
    phase12.tasks.e2eFullChain.status = "blocker";
    await writeJson(path.join(fixture.artifactsDir, "phase12.json"), phase12);
    await writeJson(
      path.join(fixture.artifactsDir, "release.json"),
      releaseReport({ status: "pass" }),
    );

    const result = runReadiness(fixture);
    assert.notEqual(result.status, 0);
    const summary = await fixture.readSummary();
    const e2eItem = summary.items.find(
      (item) => item.id === "phase12-e2e-full-chain",
    );
    const performanceItem = summary.items.find(
      (item) => item.id === "phase12-performance",
    );

    assert.equal(summary.overallStatus, "blocked");
    assert.equal(e2eItem.status, "blocked");
    assert.equal(e2eItem.checkable, false);
    assert.equal(performanceItem.status, "ready");
    assert.equal(performanceItem.checkable, true);
    assert.ok(
      summary.remainingBlockers.some(
        (entry) => entry.itemId === "phase12-e2e-full-chain",
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("readiness blocks stale Phase 12 evidence", async () => {
  const fixture = await createFixture("stale-phase12");
  try {
    await writeJson(
      path.join(fixture.artifactsDir, "phase12.json"),
      phase12Summary({ e2e: true, perf: true, sha: staleHead }),
    );
    await writeJson(
      path.join(fixture.artifactsDir, "release.json"),
      releaseReport({ status: "pass" }),
    );
    const result = runReadiness(fixture);
    assert.notEqual(result.status, 0);
    const summary = await fixture.readSummary();
    assert.equal(
      summary.source.selectedPhase12Summary.freshness.status,
      "stale",
    );
    assert.ok(
      summary.remainingBlockers.some(
        (entry) =>
          entry.category === "stale-evidence" &&
          entry.message.includes(staleHead),
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("readiness selects the newest current release candidate and blocks stale releases", async () => {
  const fixture = await createFixture("release-candidates");
  try {
    await writeJson(
      path.join(fixture.artifactsDir, "phase12.json"),
      phase12Summary({ e2e: true, perf: true }),
    );
    await writeJson(
      path.join(fixture.artifactsDir, "release-old.json"),
      releaseReport({
        generatedAt: "2026-07-09T00:00:00.000Z",
        status: "pass",
      }),
    );
    await writeJson(
      path.join(fixture.artifactsDir, "release-new-stale.json"),
      releaseReport({
        artifactName: "release-new-stale",
        generatedAt: "2026-07-09T00:05:00.000Z",
        sha: staleHead,
        status: "pass",
      }),
    );
    const result = runReadiness(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = await fixture.readSummary();
    assert.equal(summary.source.releaseRehearsalCandidateCount, 2);
    assert.equal(
      summary.source.selectedReleaseRehearsal.artifactName,
      "release-current",
    );
    assert.equal(
      summary.source.selectedReleaseRehearsal.freshness.status,
      "current",
    );
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `ag-readiness-${name}-`));
  const artifactsDir = path.join(root, "artifacts");
  const reportDir = path.join(root, "summary");
  return {
    root,
    artifactsDir,
    reportDir,
    readSummary: () => readJson(path.join(reportDir, "readiness-summary.json")),
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

function runReadiness(fixture, env = {}) {
  return spawnSync(
    process.execPath,
    [
      readinessScript,
      `--artifacts-dir=${fixture.artifactsDir}`,
      `--report-dir=${fixture.reportDir}`,
      `--expected-head-sha=${currentHead}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
      },
    },
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function phase12Summary({ e2e, perf, sha = currentHead }) {
  return {
    schemaVersion: 3,
    kind: "phase12-evidence-summary",
    generatedAt: "2026-07-09T00:00:00.000Z",
    status: e2e && perf ? "pass" : "blocker",
    source: { currentHeadSha: sha },
    tasks: {
      e2eFullChain: task(e2e, "E2E evidence is blocked"),
      performance: task(perf, "Performance evidence is blocked"),
    },
  };
}

function task(checkable, blocker) {
  return {
    checkable,
    status: checkable ? "pass" : "blocker",
    blockers: checkable ? [] : [blocker],
    targets: {},
  };
}

function releaseReport({
  artifactName = "release-current",
  generatedAt = "2026-07-09T00:01:00.000Z",
  sha = currentHead,
  status,
}) {
  const pass = status === "pass";
  return {
    schemaVersion: 2,
    kind: "release-rehearsal-checklist",
    generatedAt,
    status,
    result: status,
    blockers: pass ? [] : [{ message: "operator confirmation missing" }],
    ciDryRunArtifact: {
      expectedArtifactName: artifactName,
      workflowRunUrl: "https://example.test/actions/runs/1",
      workflowRunUrlValid: true,
      workflowSha: sha,
    },
  };
}
