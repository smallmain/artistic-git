/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.join(import.meta.dirname, "e2e-real-git-report.mjs");

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.ARTISTIC_GIT_E2E_REPORT;
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

test("fails with schema v2 evidence when the embedded distribution is missing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-e2e-real-git-"));
  const reportPath = path.join(tmpDir, "e2e-real-git-report.json");

  try {
    const sandboxScript = await copyScriptToSandbox(tmpDir);
    const result = spawnSync(process.execPath, [sandboxScript], {
      encoding: "utf8",
      env: cleanEnv({
        ARTISTIC_GIT_E2E_REPORT: reportPath,
      }),
    });

    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, "failed");
    assert.equal(report.gitDistSource.source, "workspace-resource");
    assert.match(report.reason, /resource directory does not exist/);
    assert.match(
      await readFile(path.join(tmpDir, "e2e-real-git-report.md"), "utf8"),
      /Status: failed/,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("fails when the fixed embedded distribution manifest is malformed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-e2e-real-git-"));
  const reportPath = path.join(tmpDir, "e2e-real-git-report.json");

  try {
    const sandboxScript = await copyScriptToSandbox(tmpDir);
    const distDir = path.join(tmpDir, "src-tauri", "resources", "git-dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, "manifest.json"), "not json\n");
    const result = spawnSync(process.execPath, [sandboxScript], {
      encoding: "utf8",
      env: cleanEnv({
        ARTISTIC_GIT_E2E_REPORT: reportPath,
      }),
    });

    assert.notEqual(result.status, 0);
    const report = await readJson(reportPath);
    assert.equal(report.status, "failed");
    assert.match(report.reason, /Could not parse git-dist manifest/);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("blocks unverifiable git-dist manifests without git-lfs sha256 evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-e2e-real-git-"));
  const distDir = path.join(tmpDir, "src-tauri", "resources", "git-dist");
  const reportPath = path.join(tmpDir, "e2e-real-git-report.json");
  const gitContent = "git fixture\n";
  const gitLfsContent = "git-lfs fixture\n";

  try {
    const sandboxScript = await copyScriptToSandbox(tmpDir);
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
          schemaVersion: 2,
          target: "linux-x86_64",
          toolchainRevision: "fixture-1",
          baseFingerprint: "base-fixture",
          helperFingerprint: "helper-fixture",
          distributionFingerprint: "distribution-fixture",
          sha256: {
            "git/bin/git": sha256(gitContent),
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(process.execPath, [sandboxScript], {
      encoding: "utf8",
      env: cleanEnv({
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
