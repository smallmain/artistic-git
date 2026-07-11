/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
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
  delete env.ARTISTIC_GIT_PHASE12_PERF_REPORT;
  delete env.ARTISTIC_GIT_PERF_HEAVY;
  return { ...env, ...overrides };
}

async function copyScriptToSandbox(root) {
  const sandboxScript = path.join(root, "scripts", path.basename(scriptPath));
  await mkdir(path.dirname(sandboxScript), { recursive: true });
  await cp(scriptPath, sandboxScript);
  return sandboxScript;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("writes blocker schema v2 evidence when the embedded distribution is missing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-perf-test-"));
  const reportPath = path.join(tmpDir, "phase12-perf-report.json");

  try {
    const sandboxScript = await copyScriptToSandbox(tmpDir);
    const result = spawnSync(
      process.execPath,
      [sandboxScript, `--report=${reportPath}`],
      {
        encoding: "utf8",
        env: cleanEnv(),
      },
    );

    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, "blocker");
    assert.equal(report.result, "blocker");
    assert.ok(
      report.gitDistDir.endsWith(
        path.join("src-tauri", "resources", "git-dist"),
      ),
    );
    assert.equal(report.thresholds.gitDist.rejectSystemGitFallback, true);
    assert.equal(report.taskReadiness.performanceItemCheckable, false);
    assert.ok(report.blockers.length > 0, "missing distribution is a blocker");
    assert.match(
      await readFile(path.join(tmpDir, "phase12-perf-report.md"), "utf8"),
      /Status: blocker/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("blocks unverifiable git-dist manifests without executable sha256 evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-perf-test-"));
  const distDir = path.join(tmpDir, "src-tauri", "resources", "git-dist");
  const reportPath = path.join(tmpDir, "phase12-perf-report.json");

  try {
    const sandboxScript = await copyScriptToSandbox(tmpDir);
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
          schemaVersion: 2,
          target: "macos-universal",
          toolchainRevision: "fixture-1",
          baseFingerprint: "base-fixture",
          helperFingerprint: "helper-fixture",
          distributionFingerprint: "distribution-fixture",
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
      [sandboxScript, `--report=${reportPath}`],
      {
        encoding: "utf8",
        env: cleanEnv(),
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
  const distDir = path.join(tmpDir, "src-tauri", "resources", "git-dist");
  const reportPath = path.join(tmpDir, "phase12-perf-report.json");
  const gitFixture = "not-executable git fixture\n";
  const gitLfsFixture = "not-executable git-lfs fixture\n";

  try {
    const sandboxScript = await copyScriptToSandbox(tmpDir);
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
          schemaVersion: 2,
          target: "linux-x86_64",
          toolchainRevision: "fixture-1",
          baseFingerprint: "base-fixture",
          helperFingerprint: "helper-fixture",
          distributionFingerprint: "distribution-fixture",
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
      [sandboxScript, `--report=${reportPath}`],
      {
        encoding: "utf8",
        env: cleanEnv(),
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

test("history perf fixture builds a linear commit chain before one final ref update", async () => {
  const source = await readFile(scriptPath, "utf8");
  const functionStart = source.indexOf("function verifyHistoryPagination() {");
  const functionEnd = source.indexOf(
    "function verifyLargeStatus() {",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "history fixture function is present");
  assert.notEqual(
    functionEnd,
    -1,
    "history fixture function has a stable boundary",
  );
  const historySource = source.slice(functionStart, functionEnd);
  const loopMatch = historySource.match(
    /for \(let index = 0; index < report\.profile\.commitCount; index \+= 1\) \{([\s\S]*?)\n {2}\}\n {2}runGit\(\["update-ref", "refs\/heads\/main", parent\], repo\);/,
  );

  assert.match(
    historySource,
    /fixtureStrategy: "commit-tree-linear-single-tree"/,
    "history evidence records the commit-tree fixture strategy",
  );
  assert.match(
    historySource,
    /"commit-tree", tree, "-m"/,
    "history fixture creates commits without rewriting a new file per commit",
  );
  assert.ok(
    loopMatch,
    "history fixture updates the branch only after the commit-tree loop",
  );
  const loopSource = loopMatch[1];
  assert.match(
    loopSource,
    /if \(parent\) \{\s+args\.push\("-p", parent\);\s+\}/,
    "each commit after the first links to the previously created commit",
  );
  assert.match(
    loopSource,
    /parent = runGit\(args, repo\)\.trim\(\);/,
    "the newly created commit becomes the next iteration's parent",
  );
  assert.doesNotMatch(
    loopSource,
    /update-ref/,
    "the commit loop must not repeatedly publish intermediate refs",
  );
  assert.equal(
    historySource.match(/"update-ref"/g)?.length,
    1,
    "history fixture publishes exactly one final branch ref",
  );
  assert.doesNotMatch(
    historySource,
    /runGit\(\["commit", "-m", `history/,
    "history fixture must not use porcelain commit for every perf commit",
  );
});

test("temporary fixture cleanup retries without failing passed evidence", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(
    source,
    /cleanupTempRoot\(root\)/,
    "fixture cleanup goes through the retrying cleanup helper",
  );
  assert.match(
    source,
    /maxRetries: 10/,
    "cleanup retries transient recursive removal failures",
  );
  assert.match(
    source,
    /retryDelay: 100/,
    "cleanup gives macOS filesystem state time to settle between retries",
  );
  assert.match(
    source,
    /WARN phase12 perf cleanup failed/,
    "cleanup failure is reported as a warning instead of replacing pass evidence",
  );
});
