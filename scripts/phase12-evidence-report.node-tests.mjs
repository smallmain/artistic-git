/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const finalizeScriptPath = path.join(
  import.meta.dirname,
  "phase12-e2e-finalize.mjs",
);
const summaryScriptPath = path.join(
  import.meta.dirname,
  "phase12-evidence-summary.mjs",
);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("E2E finalizer keeps missing Windows git-dist as skipped evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-e2e-"));
  const availabilityPath = path.join(tmpDir, "availability.json");
  const reportPath = path.join(tmpDir, "runtime.json");

  try {
    await writeJson(availabilityPath, {
      schemaVersion: 2,
      status: "skipped",
      reason: "ARTISTIC_GIT_DIST_DIR is not set",
      gitDistSource: {
        source: "artifact-missing",
        artifactName: "artistic-git-dist-windows-x86_64",
        runId: "28915237870",
        target: "windows-x86_64",
      },
      gitDist: {
        executableEvidence: [],
      },
    });

    const result = spawnSync(
      process.execPath,
      [
        finalizeScriptPath,
        `--availability-report=${availabilityPath}`,
        `--report=${reportPath}`,
        "--windows-outcome=success",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, RUNNER_OS: "Windows" },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = await readJson(reportPath);
    assert.equal(report.kind, "phase12-e2e-full-chain-runtime");
    assert.equal(report.status, "skipped");
    assert.equal(report.target, "windows-x86_64");
    assert.equal(report.wdio.selectedOutcome, "success");
    assert.equal(report.taskReadiness.platformEvidenceCheckable, false);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("summary separates Linux/Windows E2E from three-platform perf evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-summary-"));
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");

  try {
    await writeJson(
      path.join(artifactsDir, "e2e-linux", "runtime.json"),
      e2eReport({
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "e2e-windows", "runtime.json"),
      e2eReport({
        source: "artifact-missing",
        status: "skipped",
        target: "windows-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "perf-linux", "report.json"),
      perfReport({
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "perf-macos", "report.json"),
      perfReport({
        status: "pass",
        target: "macos-universal",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "perf-windows", "report.json"),
      perfReport({
        source: "artifact-missing",
        status: "skipped",
        target: "windows-x86_64",
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        summaryScriptPath,
        `--artifacts-dir=${artifactsDir}`,
        `--report-dir=${reportDir}`,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );

    assert.deepEqual(summary.requiredTargets.e2eFullChain, [
      "linux-x86_64",
      "windows-x86_64",
    ]);
    assert.deepEqual(summary.requiredTargets.performance, [
      "linux-x86_64",
      "macos-universal",
      "windows-x86_64",
    ]);
    assert.equal(
      summary.tasks.e2eFullChain.targets["linux-x86_64"].checkable,
      true,
    );
    assert.equal(
      summary.tasks.e2eFullChain.targets["windows-x86_64"].status,
      "skipped",
    );
    assert.equal(
      summary.tasks.performance.targets["macos-universal"].checkable,
      true,
    );
    assert.equal(
      summary.tasks.performance.targets["windows-x86_64"].status,
      "skipped",
    );
    assert.equal(summary.tasks.e2eFullChain.checkable, false);
    assert.equal(summary.tasks.performance.checkable, false);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("summary rejects heavy perf reports whose scale was overridden smaller", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-scale-"));
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");

  try {
    await writeJson(
      path.join(artifactsDir, "e2e-linux", "runtime.json"),
      e2eReport({
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "perf-linux", "report.json"),
      perfReport({
        profile: {
          binaryBytes: 5 * 1024 * 1024,
          commitCount: 300,
          fileCount: 2_000,
        },
        status: "pass",
        target: "linux-x86_64",
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        summaryScriptPath,
        `--artifacts-dir=${artifactsDir}`,
        `--report-dir=${reportDir}`,
        "--e2e-required-targets=linux-x86_64",
        "--perf-required-targets=linux-x86_64",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    const perfTarget = summary.tasks.performance.targets["linux-x86_64"];
    assert.equal(perfTarget.checkable, false);
    assert.match(perfTarget.reasons.join("\n"), /profile\.commitCount/);
    assert.equal(summary.tasks.performance.checkable, false);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

function e2eReport({ source = "artifact", status, target }) {
  const pass = status === "pass";
  return {
    schemaVersion: 1,
    kind: "phase12-e2e-full-chain-runtime",
    status,
    result: status,
    target,
    availabilityReport: {
      status: pass ? "ready" : status,
    },
    gitDistSource: gitDistSource({ source, target }),
    gitDist: gitDistEvidence(pass),
    wdio: {
      selectedOutcome: pass ? "success" : "skipped",
    },
    taskReadiness: {
      platformEvidenceCheckable: pass,
    },
  };
}

function perfReport({
  profile = {
    binaryBytes: 128 * 1024 * 1024,
    commitCount: 10_000,
    fileCount: 50_000,
  },
  source = "artifact",
  status,
  target,
}) {
  const pass = status === "pass";
  return {
    schemaVersion: 2,
    kind: "phase12-perf",
    status,
    result: status,
    profileName: "heavy",
    heavy: true,
    profile,
    gitDistSource: gitDistSource({ source, target }),
    gitDist: gitDistEvidence(pass),
    checks: pass
      ? [
          { name: "historyPagination", status: "pass" },
          { name: "largeStatus", status: "pass" },
          { name: "largeBinaryLfs", status: "pass" },
        ]
      : [],
    taskReadiness: {
      platformEvidenceCheckable: pass,
    },
  };
}

function gitDistSource({ source, target }) {
  return {
    source,
    artifactName: `artistic-git-dist-${target}`,
    runId: "28915237870",
    target,
  };
}

function gitDistEvidence(pass) {
  return {
    executableEvidence: pass
      ? [
          executableEvidence("gitExecutable"),
          executableEvidence("gitLfsExecutable"),
        ]
      : [],
  };
}

function executableEvidence(key) {
  return {
    key,
    resolvesInsideDistDir: true,
    sha256: `${key}-sha256`,
    manifestSha256: `${key}-sha256`,
  };
}
