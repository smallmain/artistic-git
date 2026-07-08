import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const readinessScript = path.join(repoRoot, "scripts", "readiness-summary.mjs");

test("readiness summary aggregates remaining Windows and release blockers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-readiness-"));
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");

  try {
    await writeJson(
      path.join(artifactsDir, "phase12", "phase12-evidence-summary.json"),
      phase12Summary({
        e2eCheckable: false,
        perfCheckable: false,
        windowsReusable: false,
      }),
    );
    await writeJson(
      path.join(artifactsDir, "git-dist", "git-dist-blocker.json"),
      opensshBlocker(),
    );
    await writeJson(
      path.join(artifactsDir, "release", "release-rehearsal-checklist.json"),
      releaseRehearsal({ status: "skipped" }),
    );

    const result = runReadiness(artifactsDir, reportDir);
    assert.equal(result.status, 0, result.stderr);

    const summary = await readJson(
      path.join(reportDir, "readiness-summary.json"),
    );
    assert.equal(summary.kind, "readiness-summary");
    assert.equal(summary.overallStatus, "blocked");
    assert.equal(summary.items.length, 7);
    assert.ok(
      summary.remainingBlockers.some(
        (blocker) =>
          blocker.itemId === "win32-openssh-gate" &&
          blocker.category === "external-upstream",
      ),
    );
    assert.ok(
      summary.remainingBlockers.some(
        (blocker) =>
          blocker.itemId === "windows-git-dist" &&
          blocker.message.includes("Partial source evidence is checkable"),
      ),
    );
    assert.ok(
      summary.remainingBlockers.some(
        (blocker) =>
          blocker.itemId === "release-rehearsal" &&
          blocker.category === "operator-evidence",
      ),
    );
    assert.match(result.stdout, /Readiness summary: blocked/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("readiness summary reports ready when all consumed evidence is checkable", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-readiness-ready-"));
  const artifactsDir = path.join(tmpDir, "artifacts");
  const reportDir = path.join(tmpDir, "summary");

  try {
    await writeJson(
      path.join(artifactsDir, "phase12", "phase12-evidence-summary.json"),
      phase12Summary({
        e2eCheckable: true,
        perfCheckable: true,
        windowsReusable: true,
      }),
    );
    await writeJson(
      path.join(artifactsDir, "release", "release-rehearsal-checklist.json"),
      releaseRehearsal({ status: "pass" }),
    );

    const result = runReadiness(artifactsDir, reportDir);
    assert.equal(result.status, 0, result.stderr);

    const summary = await readJson(
      path.join(reportDir, "readiness-summary.json"),
    );
    assert.equal(summary.overallStatus, "ready");
    assert.deepEqual(summary.remainingBlockers, []);
    assert.ok(summary.items.every((item) => item.checkable === true));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

function runReadiness(artifactsDir, reportDir) {
  return spawnSync(
    process.execPath,
    [
      readinessScript,
      `--artifacts-dir=${artifactsDir}`,
      `--report-dir=${reportDir}`,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
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

function phase12Summary({ e2eCheckable, perfCheckable, windowsReusable }) {
  const windowsGitDist = windowsReusable
    ? gitDistTarget({
        reusableArtifactCheckable: true,
        sourceArchiveCheckable: true,
        status: "reusable-ready",
        target: "windows-x86_64",
      })
    : gitDistTarget({
        reusableArtifactCheckable: false,
        sourceArchiveCheckable: true,
        status: "source-partial",
        target: "windows-x86_64",
      });
  return {
    schemaVersion: 2,
    kind: "phase12-evidence-summary",
    generatedAt: "2026-07-09T00:00:00.000Z",
    gitDistribution: {
      requiredTargets: ["linux-x86_64", "macos-universal", "windows-x86_64"],
      targets: {
        "linux-x86_64": gitDistTarget({
          reusableArtifactCheckable: true,
          sourceArchiveCheckable: true,
          status: "reusable-ready",
          target: "linux-x86_64",
        }),
        "macos-universal": gitDistTarget({
          reusableArtifactCheckable: true,
          sourceArchiveCheckable: true,
          status: "reusable-ready",
          target: "macos-universal",
        }),
        "windows-x86_64": windowsGitDist,
      },
      blockers: windowsReusable
        ? []
        : ["git-dist windows-x86_64: reusableArtifactProduced is not true"],
    },
    tasks: {
      e2eFullChain: phase12Task({
        checkable: e2eCheckable,
        status: e2eCheckable ? "checkable" : "blocked",
        blocker:
          "E2E full-chain windows-x86_64: status/result is skipped/artifact-missing",
      }),
      performance: phase12Task({
        checkable: perfCheckable,
        status: perfCheckable ? "checkable" : "blocked",
        blocker:
          "Performance windows-x86_64: status/result is skipped/artifact-missing",
      }),
    },
  };
}

function phase12Task({ blocker, checkable, status }) {
  return {
    checkable,
    status,
    blockers: checkable ? [] : [blocker],
    targets: {},
  };
}

function gitDistTarget({
  reusableArtifactCheckable,
  sourceArchiveCheckable,
  status,
  target,
}) {
  return {
    status,
    reusableArtifactCheckable,
    sourceArchiveCheckable,
    buildEvidencePath: `artifacts/git-dist-build-evidence-${target}/git-dist-build-evidence.json`,
    sourceEvidencePath: null,
    blockerEvidencePath: reusableArtifactCheckable
      ? null
      : `artifacts/git-dist-blocker-${target}/git-dist-blocker.json`,
    runId: "123456",
    artifactName: `artistic-git-dist-${target}`,
    blockers: reusableArtifactCheckable
      ? []
      : ["reusableArtifactProduced is not true"],
  };
}

function opensshBlocker() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-09T00:01:00.000Z",
    opensshRelease: {
      repo: "PowerShell/Win32-OpenSSH",
      requiredAsset: "OpenSSH-Win64.zip",
      status: "non-stable",
      latest: {
        tagName: "10.0.0.0p2-Preview",
        name: "10.0.0.0p2-Preview",
        publishedAt: "2025-10-27T18:58:57Z",
        prerelease: false,
        draft: false,
        hasRequiredAsset: true,
      },
      scan: {
        checkedReleaseCount: 54,
        stableWithRequiredAssetCount: 0,
        stableWithRequiredAsset: [],
      },
      reason: "preview label",
    },
  };
}

function releaseRehearsal({ status }) {
  const pass = status === "pass";
  return {
    schemaVersion: 2,
    kind: "release-rehearsal-checklist",
    generatedAt: "2026-07-09T00:02:00.000Z",
    dryRun: !pass,
    status,
    result: status,
    release: {
      fromVersion: "0.1.0",
      toVersion: "0.1.1",
    },
    missingEvidence: pass
      ? []
      : ["ARTISTIC_GIT_RELEASE_REHEARSAL_OPERATOR_CONFIRMED"],
    missingSecrets: [],
    blockers: pass
      ? []
      : [
          {
            id: "formal-rehearsal-not-run",
            message:
              "This run is not operator-confirmed evidence and cannot check the TASKS.md release rehearsal item.",
          },
        ],
    taskCheckbox: pass
      ? "eligible-after-artifact-review"
      : "must-remain-unchecked",
  };
}
