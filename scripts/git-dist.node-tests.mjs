/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

import {
  assembleGitDist,
  configPath,
  expectedManifestPaths,
  getTargetSources,
  loadGitDistConfig,
  repoRoot,
  sha256File,
  sourceStagingDirectory,
  validateGitDistConfig,
} from "./git-dist-lib.mjs";

const windowsTarget = "windows-x86_64";
const workflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "git-dist.yml",
);

async function loadConfig() {
  const { data } = await loadGitDistConfig(configPath);
  return data;
}

async function writeExecutable(filePath, contents = "fixture executable\n") {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  await chmod(filePath, 0o755);
}

async function stageWindowsArchives(config, stagingDir) {
  for (const { ref, source } of getTargetSources(config, windowsTarget)) {
    const root = sourceStagingDirectory(stagingDir, ref);
    if (source.component === "git") {
      await writeExecutable(
        path.join(root, "mingit-fixture", "bin", "git.exe"),
        "git version 2.55.0.windows.2\n",
      );
    } else if (source.component === "git_lfs") {
      await writeExecutable(
        path.join(root, "git-lfs-fixture", "git-lfs.exe"),
        "git-lfs/3.7.1 fixture\n",
      );
    } else if (source.component === "win32_openssh") {
      await writeExecutable(
        path.join(root, "OpenSSH-Win64", "ssh.exe"),
        "OpenSSH_for_Windows_10.0 fixture\n",
      );
    } else {
      throw new Error(`unhandled fixture source component: ${source.component}`);
    }
  }
}

async function writeWindowsHelpers(helperDir) {
  await writeExecutable(
    path.join(helperDir, "artistic-git-credential-helper.exe"),
    "credential helper fixture\n",
  );
  await writeExecutable(
    path.join(helperDir, "artistic-git-ssh-askpass.exe"),
    "ssh askpass fixture\n",
  );
}

async function pathExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

test("assembles staged Windows archives into manifest layout and validates as a cache hit", async () => {
  const config = await loadConfig();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));

  try {
    const stagingDir = path.join(tmpDir, "staging");
    const outputDir = path.join(tmpDir, "git-dist");
    const helperDir = path.join(tmpDir, "helpers");
    await stageWindowsArchives(config, stagingDir);
    await writeWindowsHelpers(helperDir);

    const manifest = await assembleGitDist({
      config,
      targetName: windowsTarget,
      stagingDir,
      outputDir,
      helperDir,
    });

    const manifestPath = path.join(outputDir, "manifest.json");
    const manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));
    const expectedPaths = expectedManifestPaths(config, windowsTarget);
    assert.deepEqual(manifest.paths, expectedPaths);
    assert.deepEqual(manifestJson.paths, expectedPaths);
    assert.equal(manifestJson.platform, windowsTarget);
    assert.equal(manifestJson.schemaVersion, config.manifest.schema_version);

    for (const relativePath of [
      expectedPaths.gitExecutable,
      expectedPaths.gitLfsExecutable,
      expectedPaths.windowsSshExecutable,
      expectedPaths.credentialHelper,
      expectedPaths.sshAskpass,
    ]) {
      const actual = await sha256File(path.join(outputDir, relativePath));
      assert.equal(manifestJson.sha256[relativePath], actual);
    }

    assert.equal(
      await pathExists(path.join(outputDir, "git", "mingit-fixture")),
      false,
    );
    assert.equal(
      await pathExists(path.join(outputDir, "git-lfs", "git-lfs-fixture")),
      false,
    );

    const check = spawnSync(
      process.execPath,
      [
        "scripts/check-git-dist.mjs",
        `--target=${windowsTarget}`,
        "--no-exec",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ARTISTIC_GIT_DIST_DIR: outputDir,
        },
      },
    );
    assert.equal(check.status, 0, check.stderr || check.stdout);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("assembly resolves helper binaries from cargo target release output", async () => {
  const config = await loadConfig();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));

  try {
    const stagingDir = path.join(tmpDir, "staging");
    const outputDir = path.join(tmpDir, "git-dist");
    const cargoTargetDir = path.join(tmpDir, "target");
    await stageWindowsArchives(config, stagingDir);
    await writeWindowsHelpers(path.join(cargoTargetDir, "release"));

    const manifest = await assembleGitDist({
      config,
      targetName: windowsTarget,
      stagingDir,
      outputDir,
      cargoTargetDir,
      helperProfile: "release",
    });

    assert.equal(
      manifest.sha256[manifest.paths.credentialHelper],
      await sha256File(path.join(outputDir, manifest.paths.credentialHelper)),
    );
    assert.equal(
      manifest.sha256[manifest.paths.sshAskpass],
      await sha256File(path.join(outputDir, manifest.paths.sshAskpass)),
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("assembly fails without helper binaries and does not write an incomplete manifest", async () => {
  const config = await loadConfig();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));

  try {
    const stagingDir = path.join(tmpDir, "staging");
    const outputDir = path.join(tmpDir, "git-dist");
    await stageWindowsArchives(config, stagingDir);

    await assert.rejects(
      () =>
        assembleGitDist({
          config,
          targetName: windowsTarget,
          stagingDir,
          outputDir,
          cargoTargetDir: path.join(tmpDir, "missing-target"),
        }),
      /git-dist helper binaries are required/,
    );
    assert.equal(await pathExists(path.join(outputDir, "manifest.json")), false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("real Windows fetch still rejects the Win32-OpenSSH placeholder before download", async () => {
  const config = await loadConfig();
  assert.throws(
    () =>
      validateGitDistConfig(config, {
        targetName: windowsTarget,
        realBuild: true,
        allowPlaceholders: false,
      }),
    (error) =>
      error.details?.some((detail) =>
        detail.startsWith("real build mode rejects placeholder pins:"),
      ),
  );

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/fetch-git-dist.mjs",
        `--target=${windowsTarget}`,
        `--output=${path.join(tmpDir, "git-dist")}`,
        `--cache-dir=${path.join(tmpDir, "cache")}`,
        `--staging-dir=${path.join(tmpDir, "staging")}`,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /real build mode rejects placeholder pins/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /downloading/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("workflow validates restored assembled cache hits before reuse", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /id: dist-cache/);
  assert.match(
    workflow,
    /Validate target real-build policy[\s\S]+node scripts\/check-git-dist\.mjs --schema-only --real-build --target="\$\{\{ matrix\.target \}\}"/,
  );
  assert.match(
    workflow,
    /Validate restored assembled distribution[\s\S]+steps\.dist-cache\.outputs\.cache-hit == 'true'[\s\S]+node scripts\/check-git-dist\.mjs --target="\$\{\{ matrix\.target \}\}" --no-exec/,
  );
});
