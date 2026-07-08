/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.join(
  import.meta.dirname,
  "activate-phase12-git-dist.mjs",
);

async function createGitDist(root, manifestPaths = {}) {
  const paths = {
    gitExecutable: "git/bin/git",
    gitLfsExecutable: "git-lfs/git-lfs",
    credentialHelper: "helpers/artistic-git-credential-helper",
    ...manifestPaths,
  };
  const expectedExecutablePaths = new Set([
    ...Object.values(paths),
    "git/libexec/git-core/git-merge",
    "git/libexec/git-core/git-remote-http",
    "helpers/artistic-git-ssh-askpass",
  ]);

  for (const relativePath of expectedExecutablePaths) {
    if (typeof relativePath !== "string" || relativePath.includes("..")) {
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${relativePath}\n`);
    await chmod(absolutePath, 0o644);
  }

  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, paths }, null, 2)}\n`,
  );

  return { expectedExecutablePaths, paths };
}

async function readGithubEnv(filePath) {
  const env = new Map();
  for (const line of (await readFile(filePath, "utf8")).trim().split("\n")) {
    const separator = line.indexOf("=");
    env.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return env;
}

test("activates a downloaded artifact and restores Unix executable bits", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-activate-"));
  const distDir = path.join(tmpDir, "dist");
  const githubEnvPath = path.join(tmpDir, "github-env");

  try {
    const { expectedExecutablePaths } = await createGitDist(distDir);
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUN_ID: "28915237870",
        ARTIFACT_NAME: "artistic-git-dist-linux-x86_64",
        DIST_DIR: distDir,
        GIT_DIST_TARGET: "linux-x86_64",
        GITHUB_ENV: githubEnvPath,
        RUN_URL: "https://example.test/runs/28915237870",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const githubEnv = await readGithubEnv(githubEnvPath);
    assert.equal(
      githubEnv.get("ARTISTIC_GIT_PHASE12_GIT_DIST_SOURCE"),
      "artifact",
    );
    assert.equal(githubEnv.get("ARTISTIC_GIT_DIST_DIR"), distDir);

    if (process.platform !== "win32") {
      for (const relativePath of expectedExecutablePaths) {
        const mode = (await stat(path.join(distDir, relativePath))).mode;
        assert.notEqual(mode & 0o111, 0, `${relativePath} is executable`);
      }
      assert.match(result.stdout, /Restored executable bits for 6/);
    }
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("activates repository variable fallback when no artifact run is configured", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-activate-"));
  const fallbackDistDir = path.join(tmpDir, "fallback-dist");
  const githubEnvPath = path.join(tmpDir, "github-env");

  try {
    await createGitDist(fallbackDistDir);
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUN_ID: "",
        ARTIFACT_NAME: "artistic-git-dist-macos-universal",
        DIST_DIR: path.join(tmpDir, "download"),
        GIT_DIST_TARGET: "macos-universal",
        FALLBACK_DIST_DIR: fallbackDistDir,
        GITHUB_ENV: githubEnvPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const githubEnv = await readGithubEnv(githubEnvPath);
    assert.equal(
      githubEnv.get("ARTISTIC_GIT_PHASE12_GIT_DIST_SOURCE"),
      "repository-variable",
    );
    assert.equal(githubEnv.get("ARTISTIC_GIT_DIST_DIR"), fallbackDistDir);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("records artifact-missing without activating ARTISTIC_GIT_DIST_DIR", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-activate-"));
  const githubEnvPath = path.join(tmpDir, "github-env");

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUN_ID: "28915237870",
        ARTIFACT_NAME: "artistic-git-dist-windows-x86_64",
        DIST_DIR: path.join(tmpDir, "missing"),
        GIT_DIST_TARGET: "windows-x86_64",
        GITHUB_ENV: githubEnvPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const githubEnv = await readGithubEnv(githubEnvPath);
    assert.equal(
      githubEnv.get("ARTISTIC_GIT_PHASE12_GIT_DIST_SOURCE"),
      "artifact-missing",
    );
    assert.equal(githubEnv.has("ARTISTIC_GIT_DIST_DIR"), false);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

test("rejects manifest paths outside the activated dist", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-phase12-activate-"));
  const distDir = path.join(tmpDir, "dist");
  const githubEnvPath = path.join(tmpDir, "github-env");

  try {
    await mkdir(distDir, { recursive: true });
    await writeFile(
      path.join(distDir, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          paths: {
            gitExecutable: "../outside/git",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUN_ID: "28915237870",
        ARTIFACT_NAME: "artistic-git-dist-linux-x86_64",
        DIST_DIR: distDir,
        GITHUB_ENV: githubEnvPath,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be a relative path inside git-dist/);
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
});
