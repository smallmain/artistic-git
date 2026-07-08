/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.join(import.meta.dirname, "phase12-perf-verify.mjs");

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.ARTISTIC_GIT_DIST_DIR;
  delete env.ARTISTIC_GIT_PHASE12_PERF_REPORT;
  delete env.ARTISTIC_GIT_PHASE12_PERF_REQUIRE_REAL_GIT_DIST;
  delete env.ARTISTIC_GIT_PERF_HEAVY;
  return { ...env, ...overrides };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("writes skipped schema v2 evidence when git-dist is missing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-perf-test-"));
  const reportPath = path.join(tmpDir, "phase12-perf-report.json");

  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, `--report=${reportPath}`],
      {
        encoding: "utf8",
        env: cleanEnv(),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = await readJson(reportPath);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, "skipped");
    assert.equal(report.result, "skipped");
    assert.equal(report.gitDistDir, null);
    assert.equal(report.thresholds.gitDist.rejectSystemGitFallback, true);
    assert.equal(report.taskReadiness.performanceItemCheckable, false);
    assert.ok(
      report.skips.some((skip) => skip.id === "missing-git-dist"),
      "missing git-dist skip is machine-readable",
    );
    assert.match(
      await readFile(path.join(tmpDir, "phase12-perf-report.md"), "utf8"),
      /Status: skipped/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("require-real-git-dist turns missing git-dist into a blocker", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-perf-test-"));
  const reportPath = path.join(tmpDir, "phase12-perf-report.json");

  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--require-real-git-dist", `--report=${reportPath}`],
      {
        encoding: "utf8",
        env: cleanEnv(),
      },
    );

    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.status, "blocker");
    assert.ok(
      report.blockers.some(
        (blocker) => blocker.id === "missing-git-dist-required",
      ),
      "required real git-dist blocker is machine-readable",
    );
    assert.equal(report.taskReadiness.status, "blocked");
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("blocks unverifiable git-dist manifests without executable sha256 evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-perf-test-"));
  const distDir = path.join(tmpDir, "git-dist");
  const reportPath = path.join(tmpDir, "phase12-perf-report.json");

  try {
    await mkdir(path.join(distDir, "git", "bin"), { recursive: true });
    await mkdir(path.join(distDir, "git-lfs"), { recursive: true });
    await writeFile(path.join(distDir, "git", "bin", "git"), "git\n");
    await writeFile(path.join(distDir, "git-lfs", "git-lfs"), "git-lfs\n");
    await chmod(path.join(distDir, "git", "bin", "git"), 0o755);
    await chmod(path.join(distDir, "git-lfs", "git-lfs"), 0o755);
    await writeFile(
      path.join(distDir, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          platform: "macos",
          gitVersion: "git version fixture",
          gitLfsVersion: "git-lfs fixture",
          helperVersion: "fixture",
          paths: {
            gitExecutable: "git/bin/git",
            gitLfsExecutable: "git-lfs/git-lfs",
          },
          sha256: {},
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [scriptPath, `--report=${reportPath}`],
      {
        encoding: "utf8",
        env: cleanEnv({ ARTISTIC_GIT_DIST_DIR: distDir }),
      },
    );

    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.status, "blocker");
    assert.match(report.error, /manifest sha256 is missing/);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("reports spawn error details when git-dist executable cannot start", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix executable-bit failure mode is not portable to Windows.");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-perf-test-"));
  const distDir = path.join(tmpDir, "git-dist");
  const reportPath = path.join(tmpDir, "phase12-perf-report.json");
  const gitFixture = "not-executable git fixture\n";
  const gitLfsFixture = "not-executable git-lfs fixture\n";

  try {
    await mkdir(path.join(distDir, "git", "bin"), { recursive: true });
    await mkdir(path.join(distDir, "git-lfs"), { recursive: true });
    await writeFile(path.join(distDir, "git", "bin", "git"), gitFixture);
    await writeFile(path.join(distDir, "git-lfs", "git-lfs"), gitLfsFixture);
    await chmod(path.join(distDir, "git", "bin", "git"), 0o644);
    await chmod(path.join(distDir, "git-lfs", "git-lfs"), 0o644);
    await writeFile(
      path.join(distDir, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          platform: "linux",
          gitVersion: "git version fixture",
          gitLfsVersion: "git-lfs fixture",
          helperVersion: "fixture",
          paths: {
            gitExecutable: "git/bin/git",
            gitLfsExecutable: "git-lfs/git-lfs",
          },
          sha256: {
            "git/bin/git": sha256(gitFixture),
            "git-lfs/git-lfs": sha256(gitLfsFixture),
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [scriptPath, `--report=${reportPath}`],
      {
        encoding: "utf8",
        env: cleanEnv({ ARTISTIC_GIT_DIST_DIR: distDir }),
      },
    );

    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.status, "blocker");
    assert.match(report.error, /spawn error:/);
    assert.match(report.error, /code=EACCES/);
    assert.doesNotMatch(report.error, /stdout:\nundefined/);
    assert.doesNotMatch(report.error, /stderr:\nundefined/);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});
