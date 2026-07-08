/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.join(import.meta.dirname, "e2e-real-git-report.mjs");

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.ARTISTIC_GIT_DIST_DIR;
  delete env.ARTISTIC_GIT_E2E_REAL_GIT;
  delete env.ARTISTIC_GIT_E2E_REPORT;
  delete env.ARTISTIC_GIT_PHASE12_GIT_DIST_ARTIFACT_NAME;
  delete env.ARTISTIC_GIT_PHASE12_GIT_DIST_DOWNLOAD_DIR;
  delete env.ARTISTIC_GIT_PHASE12_GIT_DIST_RUN_ID;
  delete env.ARTISTIC_GIT_PHASE12_GIT_DIST_RUN_URL;
  delete env.ARTISTIC_GIT_PHASE12_GIT_DIST_SOURCE;
  delete env.ARTISTIC_GIT_PHASE12_GIT_DIST_TARGET;
  return { ...env, ...overrides };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("writes skipped schema v2 report with artifact provenance when git-dist is missing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-e2e-real-git-"));
  const reportPath = path.join(tmpDir, "e2e-real-git-report.json");

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: cleanEnv({
        ARTISTIC_GIT_E2E_REPORT: reportPath,
        ARTISTIC_GIT_PHASE12_GIT_DIST_ARTIFACT_NAME:
          "artistic-git-dist-linux-x86_64",
        ARTISTIC_GIT_PHASE12_GIT_DIST_RUN_ID: "12345",
        ARTISTIC_GIT_PHASE12_GIT_DIST_SOURCE: "artifact-missing",
        ARTISTIC_GIT_PHASE12_GIT_DIST_TARGET: "linux-x86_64",
      }),
    });

    assert.equal(result.status, 0, result.stderr);
    const report = await readJson(reportPath);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, "skipped");
    assert.equal(report.gitDistSource.source, "artifact-missing");
    assert.equal(
      report.gitDistSource.artifactName,
      "artistic-git-dist-linux-x86_64",
    );
    assert.match(
      await readFile(path.join(tmpDir, "e2e-real-git-report.md"), "utf8"),
      /Status: skipped/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("explicit real-git request turns missing git-dist into failed evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-e2e-real-git-"));
  const reportPath = path.join(tmpDir, "e2e-real-git-report.json");

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: cleanEnv({
        ARTISTIC_GIT_E2E_REAL_GIT: "1",
        ARTISTIC_GIT_E2E_REPORT: reportPath,
      }),
    });

    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.status, "failed");
    assert.match(report.reason, /ARTISTIC_GIT_DIST_DIR is not set/);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("blocks unverifiable git-dist manifests without git-lfs sha256 evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-e2e-real-git-"));
  const distDir = path.join(tmpDir, "git-dist");
  const reportPath = path.join(tmpDir, "e2e-real-git-report.json");
  const gitContent = "git fixture\n";
  const gitLfsContent = "git-lfs fixture\n";

  try {
    await mkdir(path.join(distDir, "git", "bin"), { recursive: true });
    await mkdir(path.join(distDir, "git-lfs"), { recursive: true });
    await writeFile(path.join(distDir, "git", "bin", "git"), gitContent);
    await writeFile(path.join(distDir, "git-lfs", "git-lfs"), gitLfsContent);
    await writeFile(
      path.join(distDir, "manifest.json"),
      `${JSON.stringify(
        {
          gitLfsVersion: "3.7.1",
          gitVersion: "2.55.0",
          helperVersion: "fixture",
          paths: {
            gitExecutable: "git/bin/git",
            gitLfsExecutable: "git-lfs/git-lfs",
          },
          platform: "linux-x86_64",
          schemaVersion: 1,
          sha256: {
            "git/bin/git": sha256(gitContent),
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: cleanEnv({
        ARTISTIC_GIT_DIST_DIR: distDir,
        ARTISTIC_GIT_E2E_REPORT: reportPath,
      }),
    });

    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.status, "failed");
    assert.match(
      report.reason,
      /manifest\.sha256 must include git-lfs\/git-lfs/,
    );
    assert.equal(report.gitDist.manifest.sha256EntryCount, 1);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});
