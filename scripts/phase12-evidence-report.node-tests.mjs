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
const currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("E2E finalizer returns a blocker when availability failed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-e2e-"));
  const availabilityPath = path.join(tmpDir, "availability.json");
  const reportPath = path.join(tmpDir, "runtime.json");
  try {
    await writeJson(availabilityPath, {
      schemaVersion: 2,
      status: "failed",
      reason: "embedded distribution is missing",
      gitDistSource: { source: "workspace-resource", target: "windows-x86_64" },
      gitDist: { executableEvidence: [] },
    });
    const result = runFinalize(availabilityPath, reportPath, "windows");
    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.status, "blocker");
    assert.equal(report.taskReadiness.platformEvidenceCheckable, false);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("E2E finalizer rejects executable hash mismatches", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-e2e-sha-"));
  const availabilityPath = path.join(tmpDir, "availability.json");
  const reportPath = path.join(tmpDir, "runtime.json");
  try {
    const availability = readyAvailability("linux-x86_64");
    availability.gitDist.executableEvidence[0].sha256 = "mismatch";
    await writeJson(availabilityPath, availability);
    const result = runFinalize(availabilityPath, reportPath, "linux");
    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.status, "blocker");
    assert.match(
      report.taskReadiness.reasons.join("\n"),
      /gitExecutable sha256 does not match manifestSha256/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("E2E finalizer passes fixed embedded toolchain evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-e2e-pass-"));
  const availabilityPath = path.join(tmpDir, "availability.json");
  const reportPath = path.join(tmpDir, "runtime.json");
  try {
    await writeJson(availabilityPath, readyAvailability("linux-x86_64"));
    const result = runFinalize(availabilityPath, reportPath, "linux");
    assert.equal(result.status, 0, result.stderr);
    const report = await readJson(reportPath);
    assert.equal(report.status, "pass");
    assert.equal(report.wdio.embeddedToolchainReady, true);
    assert.equal(report.taskReadiness.platformEvidenceCheckable, true);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("evidence summary returns nonzero when a required target is missing", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-summary-missing-"),
  );
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");
  try {
    await writeJson(
      path.join(artifactsDir, "e2e-linux.json"),
      e2eReport("linux-x86_64"),
    );
    await writeJson(
      path.join(artifactsDir, "perf-linux.json"),
      perfReport("linux-x86_64"),
    );
    const result = runSummary(artifactsDir, reportDir);
    assert.notEqual(result.status, 0);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    assert.equal(summary.schemaVersion, 3);
    assert.equal(summary.status, "blocker");
    assert.equal(
      summary.tasks.e2eFullChain.targets["windows-x86_64"].status,
      "missing",
    );
    assert.equal(
      summary.tasks.performance.targets["macos-universal"].status,
      "missing",
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("evidence summary accepts runtime evidence without reusable artifact provenance", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-summary-pass-"),
  );
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");
  try {
    await writeJson(
      path.join(artifactsDir, "e2e.json"),
      e2eReport("linux-x86_64"),
    );
    await writeJson(
      path.join(artifactsDir, "perf.json"),
      perfReport("linux-x86_64"),
    );
    const result = runSummary(artifactsDir, reportDir, [
      "--e2e-required-targets=linux-x86_64",
      "--perf-required-targets=linux-x86_64",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    assert.equal(summary.status, "pass");
    assert.equal(summary.tasks.e2eFullChain.checkable, true);
    assert.equal(summary.tasks.performance.checkable, true);
    assert.equal(
      summary.tasks.performance.targets["linux-x86_64"].toolchain
        .toolchainRevision,
      "2026-07-10.1",
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("evidence summary blocks stale runtime and undersized performance evidence", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-summary-invalid-"),
  );
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");
  try {
    const e2e = e2eReport("linux-x86_64");
    e2e.ci.sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const perf = perfReport("linux-x86_64");
    perf.profile.commitCount = 100;
    await writeJson(path.join(artifactsDir, "e2e.json"), e2e);
    await writeJson(path.join(artifactsDir, "perf.json"), perf);
    const result = runSummary(artifactsDir, reportDir, [
      "--e2e-required-targets=linux-x86_64",
      "--perf-required-targets=linux-x86_64",
    ]);
    assert.notEqual(result.status, 0);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    assert.match(
      summary.tasks.e2eFullChain.blockers.join("\n"),
      /does not match current HEAD/,
    );
    assert.match(
      summary.tasks.performance.blockers.join("\n"),
      /profile\.commitCount/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

function runFinalize(availabilityPath, reportPath, platform) {
  return spawnSync(
    process.execPath,
    [
      finalizeScriptPath,
      `--availability-report=${availabilityPath}`,
      `--report=${reportPath}`,
      `--${platform}-outcome=success`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: currentHead,
        RUNNER_OS: platform === "windows" ? "Windows" : "Linux",
      },
    },
  );
}

function runSummary(artifactsDir, reportDir, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [
      summaryScriptPath,
      `--artifacts-dir=${artifactsDir}`,
      `--report-dir=${reportDir}`,
      `--current-head-sha=${currentHead}`,
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
}

function readyAvailability(target) {
  return {
    schemaVersion: 2,
    status: "ready",
    reason: "embedded Git is verified",
    gitDistSource: { source: "workspace-resource", target },
    gitDist: {
      manifest: toolchainManifest(target),
      executableEvidence: executableEvidence(),
      versions: {
        git: "git version fixture",
        gitLfsExecutable: "git-lfs fixture",
      },
    },
  };
}

function e2eReport(target) {
  return {
    schemaVersion: 1,
    kind: "phase12-e2e-full-chain-runtime",
    generatedAt: "2026-07-10T00:00:00.000Z",
    status: "pass",
    result: "pass",
    target,
    ci: { sha: currentHead },
    availabilityReport: { status: "ready" },
    gitDistSource: { source: "workspace-resource", target },
    gitDist: {
      manifest: toolchainManifest(target),
      executableEvidence: executableEvidence(),
    },
    wdio: { selectedOutcome: "success", embeddedToolchainReady: true },
    taskReadiness: { platformEvidenceCheckable: true },
  };
}

function perfReport(target) {
  return {
    schemaVersion: 2,
    kind: "phase12-perf",
    generatedAt: "2026-07-10T00:00:00.000Z",
    status: "pass",
    result: "pass",
    profileName: "heavy",
    heavy: true,
    profile: {
      binaryBytes: 128 * 1024 * 1024,
      commitCount: 10_000,
      fileCount: 50_000,
    },
    ci: { sha: currentHead },
    environment: { repository: { head: currentHead } },
    gitDistSource: { source: "workspace-resource", target },
    gitDist: {
      manifest: toolchainManifest(target),
      executableEvidence: executableEvidence(),
    },
    checks: ["historyPagination", "largeStatus", "largeBinaryLfs"].map(
      (name) => ({
        name,
        status: "pass",
      }),
    ),
    taskReadiness: { platformEvidenceCheckable: true },
  };
}

function toolchainManifest(target) {
  return {
    schemaVersion: 2,
    target,
    toolchainRevision: "2026-07-10.1",
    baseFingerprint: "base-fingerprint",
    helperFingerprint: "helper-fingerprint",
    distributionFingerprint: "distribution-fingerprint",
  };
}

function executableEvidence() {
  return ["gitExecutable", "gitLfsExecutable"].map((key) => ({
    key,
    resolvesInsideDistDir: true,
    sha256: `${key}-sha256`,
    manifestSha256: `${key}-sha256`,
  }));
}
