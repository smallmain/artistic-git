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
const testCurrentHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const testStaleHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

test("E2E finalizer rejects executable hash mismatches before summary aggregation", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-e2e-sha-mismatch-"),
  );
  const availabilityPath = path.join(tmpDir, "availability.json");
  const reportPath = path.join(tmpDir, "runtime.json");

  try {
    await writeJson(availabilityPath, {
      schemaVersion: 2,
      status: "ready",
      reason: null,
      gitDistSource: {
        source: "artifact",
        artifactName: "artistic-git-dist-linux-x86_64",
        runId: "28915237870",
        target: "linux-x86_64",
      },
      gitDist: {
        executableEvidence: [
          executableEvidence("gitExecutable", {
            sha256: "actual-git-sha",
          }),
          executableEvidence("gitLfsExecutable"),
        ],
      },
    });

    const result = spawnSync(
      process.execPath,
      [
        finalizeScriptPath,
        `--availability-report=${availabilityPath}`,
        `--report=${reportPath}`,
        "--linux-outcome=success",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, RUNNER_OS: "Linux" },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = await readJson(reportPath);
    assert.equal(report.kind, "phase12-e2e-full-chain-runtime");
    assert.equal(report.status, "blocker");
    assert.equal(report.target, "linux-x86_64");
    assert.equal(report.wdio.selectedOutcome, "success");
    assert.equal(report.taskReadiness.platformEvidenceCheckable, false);
    assert.match(
      report.taskReadiness.reasons.join("\n"),
      /gitExecutable sha256 does not match manifestSha256/,
    );
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
    await writeJson(
      path.join(artifactsDir, "git-dist-linux", "git-dist-build-evidence.json"),
      gitDistBuildEvidence({ target: "linux-x86_64" }),
    );
    await writeJson(
      path.join(artifactsDir, "git-dist-macos", "git-dist-build-evidence.json"),
      gitDistBuildEvidence({ target: "macos-universal" }),
    );
    await writeJson(
      path.join(
        artifactsDir,
        "git-dist-windows",
        "git-dist-build-evidence.json",
      ),
      gitDistBuildEvidence({
        blocked: true,
        sourceArchiveValidation: windowsSourceArchiveValidation(),
        target: "windows-x86_64",
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        summaryScriptPath,
        `--artifacts-dir=${artifactsDir}`,
        `--report-dir=${reportDir}`,
        `--current-head-sha=${testCurrentHeadSha}`,
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
    assert.equal(summary.schemaVersion, 2);
    assert.equal(
      summary.gitDistribution.targets["linux-x86_64"].reusableArtifactCheckable,
      true,
    );
    assert.equal(
      summary.gitDistribution.targets["macos-universal"].status,
      "reusable-ready",
    );
    assert.equal(
      summary.gitDistribution.targets["windows-x86_64"].status,
      "source-partial",
    );
    assert.equal(
      summary.gitDistribution.targets["windows-x86_64"].sourceArchiveCheckable,
      true,
    );
    assert.deepEqual(
      summary.gitDistribution.targets["windows-x86_64"].sourceArchive
        .checkedComponents,
      ["git", "git_lfs"],
    );
    assert.deepEqual(
      summary.gitDistribution.targets["windows-x86_64"].sourceArchive
        .blockedComponents,
      ["win32_openssh"],
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
        `--current-head-sha=${testCurrentHeadSha}`,
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

test("summary rejects artifact-backed reports with executable hash mismatches", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-sha-"));
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");

  try {
    await writeJson(
      path.join(artifactsDir, "e2e-linux", "runtime.json"),
      e2eReport({
        executableOverrides: {
          gitExecutable: { sha256: "actual-git-sha" },
        },
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "perf-linux", "report.json"),
      perfReport({
        executableOverrides: {
          gitLfsExecutable: { manifestSha256: "manifest-lfs-sha" },
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
        `--current-head-sha=${testCurrentHeadSha}`,
        "--e2e-required-targets=linux-x86_64",
        "--perf-required-targets=linux-x86_64",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    const e2eTarget = summary.tasks.e2eFullChain.targets["linux-x86_64"];
    const perfTarget = summary.tasks.performance.targets["linux-x86_64"];
    assert.equal(e2eTarget.checkable, false);
    assert.equal(perfTarget.checkable, false);
    assert.match(
      e2eTarget.reasons.join("\n"),
      /gitExecutable sha256 does not match manifestSha256/,
    );
    assert.match(
      perfTarget.reasons.join("\n"),
      /gitLfsExecutable sha256 does not match manifestSha256/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("summary rejects artifact-backed reports without matching git-dist build evidence", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-missing-git-dist-evidence-"),
  );
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
        `--current-head-sha=${testCurrentHeadSha}`,
        "--e2e-required-targets=linux-x86_64",
        "--perf-required-targets=linux-x86_64",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    const e2eTarget = summary.tasks.e2eFullChain.targets["linux-x86_64"];
    const perfTarget = summary.tasks.performance.targets["linux-x86_64"];
    assert.equal(e2eTarget.checkable, false);
    assert.equal(perfTarget.checkable, false);
    assert.match(
      e2eTarget.reasons.join("\n"),
      /git-dist linux-x86_64 build evidence is missing for artifact-backed report/,
    );
    assert.match(
      perfTarget.reasons.join("\n"),
      /git-dist linux-x86_64 build evidence is missing for artifact-backed report/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("summary rejects artifact-backed reports whose run id differs from git-dist build evidence", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-git-dist-run-mismatch-"),
  );
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");

  try {
    await writeJson(
      path.join(artifactsDir, "e2e-linux", "runtime.json"),
      e2eReport({
        runId: "runtime-run",
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "perf-linux", "report.json"),
      perfReport({
        runId: "runtime-run",
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "git-dist-linux", "git-dist-build-evidence.json"),
      gitDistBuildEvidence({
        runId: "build-run",
        target: "linux-x86_64",
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        summaryScriptPath,
        `--artifacts-dir=${artifactsDir}`,
        `--report-dir=${reportDir}`,
        `--current-head-sha=${testCurrentHeadSha}`,
        "--e2e-required-targets=linux-x86_64",
        "--perf-required-targets=linux-x86_64",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    const e2eTarget = summary.tasks.e2eFullChain.targets["linux-x86_64"];
    const perfTarget = summary.tasks.performance.targets["linux-x86_64"];
    assert.equal(e2eTarget.checkable, false);
    assert.equal(perfTarget.checkable, false);
    assert.match(
      e2eTarget.reasons.join("\n"),
      /gitDistSource\.runId runtime-run does not match git-dist build evidence runId build-run/,
    );
    assert.match(
      perfTarget.reasons.join("\n"),
      /gitDistSource\.runId runtime-run does not match git-dist build evidence runId build-run/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("summary rejects runtime evidence from a stale commit", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-stale-runtime-"),
  );
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");

  try {
    await writeJson(
      path.join(artifactsDir, "e2e-linux", "runtime.json"),
      e2eReport({
        sha: testStaleHeadSha,
        status: "pass",
        target: "linux-x86_64",
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
      path.join(artifactsDir, "git-dist-linux", "git-dist-build-evidence.json"),
      gitDistBuildEvidence({ target: "linux-x86_64" }),
    );

    const result = spawnSync(
      process.execPath,
      [
        summaryScriptPath,
        `--artifacts-dir=${artifactsDir}`,
        `--report-dir=${reportDir}`,
        `--current-head-sha=${testCurrentHeadSha}`,
        "--e2e-required-targets=linux-x86_64",
        "--perf-required-targets=linux-x86_64",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    const e2eTarget = summary.tasks.e2eFullChain.targets["linux-x86_64"];
    const perfTarget = summary.tasks.performance.targets["linux-x86_64"];
    assert.equal(e2eTarget.checkable, false);
    assert.equal(perfTarget.checkable, true);
    assert.match(
      e2eTarget.reasons.join("\n"),
      /E2E linux-x86_64 runtime evidence commit b{40} does not match current HEAD a{40}/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("summary rejects git-dist build evidence from a stale commit", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-stale-git-dist-build-"),
  );
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
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "git-dist-linux", "git-dist-build-evidence.json"),
      gitDistBuildEvidence({
        runCommitSha: testStaleHeadSha,
        target: "linux-x86_64",
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        summaryScriptPath,
        `--artifacts-dir=${artifactsDir}`,
        `--report-dir=${reportDir}`,
        `--current-head-sha=${testCurrentHeadSha}`,
        "--e2e-required-targets=linux-x86_64",
        "--perf-required-targets=linux-x86_64",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );
    const e2eTarget = summary.tasks.e2eFullChain.targets["linux-x86_64"];
    const perfTarget = summary.tasks.performance.targets["linux-x86_64"];
    const gitDistTarget = summary.gitDistribution.targets["linux-x86_64"];
    assert.equal(e2eTarget.checkable, false);
    assert.equal(perfTarget.checkable, false);
    assert.equal(gitDistTarget.reusableArtifactCheckable, false);
    assert.match(
      e2eTarget.reasons.join("\n"),
      /git-dist linux-x86_64 reusable build evidence is not checkable/,
    );
    assert.match(
      perfTarget.reasons.join("\n"),
      /git-dist linux-x86_64 reusable build evidence is not checkable/,
    );
    assert.match(
      gitDistTarget.blockers.join("\n"),
      /git-dist linux-x86_64 build evidence commit b{40} does not match current HEAD a{40}/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("summary selects the newest equal-score evidence candidate per target", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "ag-phase12-newest-candidate-"),
  );
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");

  try {
    await writeJson(
      path.join(artifactsDir, "e2e-linux-old", "runtime.json"),
      e2eReport({
        generatedAt: "2026-07-09T00:00:00.000Z",
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "e2e-linux-new", "runtime.json"),
      e2eReport({
        generatedAt: "2026-07-09T00:05:00.000Z",
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "perf-linux-old", "report.json"),
      perfReport({
        generatedAt: "2026-07-09T00:00:00.000Z",
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(artifactsDir, "perf-linux-new", "report.json"),
      perfReport({
        generatedAt: "2026-07-09T00:05:00.000Z",
        status: "pass",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(
        artifactsDir,
        "git-dist-linux-old",
        "git-dist-build-evidence.json",
      ),
      gitDistBuildEvidence({
        generatedAt: "2026-07-09T00:00:00.000Z",
        target: "linux-x86_64",
      }),
    );
    await writeJson(
      path.join(
        artifactsDir,
        "git-dist-linux-new",
        "git-dist-build-evidence.json",
      ),
      gitDistBuildEvidence({
        generatedAt: "2026-07-09T00:05:00.000Z",
        target: "linux-x86_64",
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        summaryScriptPath,
        `--artifacts-dir=${artifactsDir}`,
        `--report-dir=${reportDir}`,
        `--current-head-sha=${testCurrentHeadSha}`,
        "--e2e-required-targets=linux-x86_64",
        "--perf-required-targets=linux-x86_64",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = await readJson(
      path.join(reportDir, "phase12-evidence-summary.json"),
    );

    assert.match(
      summary.tasks.e2eFullChain.targets["linux-x86_64"].reportPath,
      /e2e-linux-new/,
    );
    assert.match(
      summary.tasks.performance.targets["linux-x86_64"].reportPath,
      /perf-linux-new/,
    );
    assert.match(
      summary.gitDistribution.targets["linux-x86_64"].buildEvidencePath,
      /git-dist-linux-new/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

function perfReport({
  executableOverrides = {},
  generatedAt = "2026-07-09T00:00:00.000Z",
  profile = {
    binaryBytes: 128 * 1024 * 1024,
    commitCount: 10_000,
    fileCount: 50_000,
  },
  repositoryHead = testCurrentHeadSha,
  runId = "28915237870",
  sha = testCurrentHeadSha,
  source = "artifact",
  status,
  target,
}) {
  const pass = status === "pass";
  return {
    schemaVersion: 2,
    kind: "phase12-perf",
    generatedAt,
    status,
    result: status,
    ci: sha ? { sha } : {},
    environment: {
      repository: {
        head: repositoryHead,
      },
    },
    profileName: "heavy",
    heavy: true,
    profile,
    gitDistSource: gitDistSource({ runId, source, target }),
    gitDist: gitDistEvidence(pass, executableOverrides),
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

function e2eReport({
  executableOverrides = {},
  generatedAt = "2026-07-09T00:00:00.000Z",
  runId = "28915237870",
  sha = testCurrentHeadSha,
  source = "artifact",
  status,
  target,
}) {
  const pass = status === "pass";
  return {
    schemaVersion: 1,
    kind: "phase12-e2e-full-chain-runtime",
    generatedAt,
    status,
    result: status,
    target,
    ci: sha ? { sha } : {},
    availabilityReport: {
      status: pass ? "ready" : status,
    },
    gitDistSource: gitDistSource({ runId, source, target }),
    gitDist: gitDistEvidence(pass, executableOverrides),
    wdio: {
      selectedOutcome: pass ? "success" : "skipped",
    },
    taskReadiness: {
      platformEvidenceCheckable: pass,
    },
  };
}

function gitDistSource({ runId = "28915237870", source, target }) {
  return {
    source,
    artifactName: `artistic-git-dist-${target}`,
    runId,
    target,
  };
}

function gitDistEvidence(pass, overrides = {}) {
  return {
    executableEvidence: pass
      ? [
          executableEvidence("gitExecutable", overrides.gitExecutable),
          executableEvidence("gitLfsExecutable", overrides.gitLfsExecutable),
        ]
      : [],
  };
}

function executableEvidence(key, overrides = {}) {
  return {
    key,
    resolvesInsideDistDir: true,
    sha256: `${key}-sha256`,
    manifestSha256: `${key}-sha256`,
    ...overrides,
  };
}

function gitDistBuildEvidence({
  blocked = false,
  generatedAt = "2026-07-09T00:00:00.000Z",
  runCommitSha = testCurrentHeadSha,
  runId = "28915237870",
  sourceArchiveValidation = null,
  target,
}) {
  return {
    generatedAt,
    workflowBuild: {
      schemaVersion: 1,
      mode: "build",
      run: {
        commitSha: runCommitSha,
        runId,
      },
      target: {
        name: target,
        platform: target.startsWith("windows")
          ? "windows"
          : target.startsWith("macos")
            ? "darwin"
            : "linux",
        manifestPlatform: target,
        artifactName: `artistic-git-dist-${target}`,
        status: blocked ? "blocked" : "ready",
        blocked,
        blockers: blocked
          ? [
              {
                ref: "windows-x86_64",
                component: "win32_openssh",
                reason: "latest Win32-OpenSSH release is non-stable",
              },
            ]
          : [],
      },
      artifactIndex: [
        {
          name: `artistic-git-dist-${target}`,
          kind: "reusable-git-dist",
          produced: !blocked,
        },
      ],
      sourceArchiveValidation:
        sourceArchiveValidation ??
        (blocked
          ? {
              status: "skipped-blocked-target",
              produced: false,
              summary: {
                checked: 0,
                skippedBlocked: 0,
                skippedUnselected: 0,
              },
              sources: [],
            }
          : {
              status: "covered-by-fetch",
              produced: false,
              summary: {
                checked: 0,
                skippedBlocked: 0,
                skippedUnselected: 0,
              },
              sources: [],
            }),
      validationSummary: {
        reusableArtifactProduced: !blocked,
        status: blocked ? "blocked" : "validated-fresh-build",
        commands: blocked
          ? [
              'node scripts/fetch-git-dist.mjs --target="windows-x86_64" --source-evidence-only --skip-blocked-sources --components=git,git_lfs --cache-dir="$ARTISTIC_GIT_DIST_CACHE_DIR" --evidence-dir="<evidence-dir>"',
            ]
          : [`node scripts/check-git-dist.mjs --target="${target}"`],
      },
    },
  };
}

function windowsSourceArchiveValidation() {
  return {
    status: "partial",
    produced: true,
    summary: {
      checked: 2,
      skippedBlocked: 1,
      skippedUnselected: 0,
    },
    sources: [
      sourceArchiveEntry({ component: "git", sha256: "a".repeat(64) }),
      sourceArchiveEntry({ component: "git_lfs", sha256: "b".repeat(64) }),
      {
        ref: "sources.windows.x86_64.win32_openssh",
        component: "win32_openssh",
        status: "skipped-blocked",
        stable: false,
        placeholder: true,
        reason: "latest release is preview",
        expectedSha256: "c".repeat(64),
        actualSha256: null,
      },
    ],
  };
}

function sourceArchiveEntry({ component, sha256 }) {
  return {
    ref: `sources.windows.x86_64.${component}`,
    component,
    status: "checked",
    stable: true,
    placeholder: false,
    reason: "downloaded archive matched configured SHA-256",
    expectedSha256: sha256,
    actualSha256: sha256,
  };
}
