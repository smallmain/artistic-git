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
  runVersionCheck,
  selectEmbeddedGitHostEnv,
  selectRuntimeLibraryEnv,
  WINDOWS_EMBEDDED_RUNTIME_ENV_KEYS,
} from "./check-git-dist.mjs";

import {
  assembleGitDistFromBase,
  configPath,
  expectedManifestPaths,
  loadGitDistConfig,
  regularFileResourcePaths,
  repoRoot,
  supportedTargets,
  validateGitDistConfig,
} from "./git-dist-lib.mjs";
import {
  computeBaseDefinition,
  computeToolchainState,
  loadToolchainDefinition,
  toolchainLockPath,
} from "./git-toolchain-state.mjs";
import { validateAndActivateCandidate } from "./ensure-git-toolchain.mjs";

async function writeExecutable(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

test("embedded runtime host environment only preserves the Windows allowlist", () => {
  const sourceEnv = {
    ProgramData: "C:\\ProgramData",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows-from-case-insensitive-source",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: "C:\\Temp",
    TMP: "C:\\Tmp",
    USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
    HOME: "C:\\system-git-home",
    PATH: "C:\\system-git-bin",
    GIT_EXEC_PATH: "C:\\system-git-libexec",
    GIT_SSH: "C:\\system-ssh.exe",
    SSH_ASKPASS: "C:\\system-askpass.exe",
    UNKNOWN_SECRET: "must-not-leak",
  };

  const selected = selectEmbeddedGitHostEnv(sourceEnv, "win32");

  assert.deepEqual(Object.keys(selected), [
    ...WINDOWS_EMBEDDED_RUNTIME_ENV_KEYS,
  ]);
  assert.equal(selected.WINDIR, "C:\\Windows-from-case-insensitive-source");
  assert.equal(selected.PATH, undefined);
  assert.equal(selected.HOME, undefined);
  assert.equal(selected.GIT_EXEC_PATH, undefined);
  assert.equal(selected.GIT_SSH, undefined);
  assert.equal(selected.SSH_ASKPASS, undefined);
  assert.equal(selected.UNKNOWN_SECRET, undefined);
});

test("embedded runtime host environment is empty outside Windows", () => {
  assert.deepEqual(
    selectEmbeddedGitHostEnv(
      {
        ProgramData: "/system-data",
        SystemRoot: "/system-root",
        TEMP: "/tmp",
      },
      "linux",
    ),
    {},
  );
  assert.deepEqual(
    selectEmbeddedGitHostEnv({ ProgramData: "/system-data" }, "darwin"),
    {},
  );
});

test("packaged runtime library paths are explicit and platform-specific", () => {
  assert.deepEqual(selectRuntimeLibraryEnv("/app/usr/lib", "linux"), {
    LD_LIBRARY_PATH: "/app/usr/lib",
  });
  assert.deepEqual(selectRuntimeLibraryEnv("/app/Frameworks", "darwin"), {
    DYLD_LIBRARY_PATH: "/app/Frameworks",
  });
  assert.deepEqual(selectRuntimeLibraryEnv("C:\\app\\lib", "win32"), {});
  assert.deepEqual(selectRuntimeLibraryEnv(null, "linux"), {});
});

test("version check failures report exit status and signal", () => {
  assert.throws(
    () =>
      runVersionCheck(
        process.execPath,
        ["-e", "process.exit(17)"],
        "fixture executable",
        "unused",
        {},
      ),
    /exit status 17, signal none/,
  );
});

test("pinned configuration and committed lock cover every target", async () => {
  const definition = await loadToolchainDefinition();
  assert.equal(definition.config.manifest.schema_version, 2);
  assert.equal(definition.lock.schemaVersion, 1);
  assert.equal(definition.lock.toolchainRevision, definition.revision);
  assert.deepEqual(
    Object.keys(definition.lock.targets).sort(),
    [...supportedTargets].sort(),
  );
  validateGitDistConfig(definition.config, {
    allowPlaceholders: false,
    realBuild: true,
  });
});

test("toolchain fingerprints are deterministic and target-specific", async () => {
  const first = await computeToolchainState("macos-universal");
  const second = await computeToolchainState("macos-universal");
  const linux = await computeToolchainState("linux-x86_64");
  assert.equal(first.baseFingerprint, second.baseFingerprint);
  assert.equal(first.helperFingerprint, second.helperFingerprint);
  assert.equal(first.distributionFingerprint, second.distributionFingerprint);
  assert.notEqual(first.baseFingerprint, linux.baseFingerprint);
  assert.notEqual(first.helperFingerprint, linux.helperFingerprint);
});

test("Windows-only definitions do not invalidate macOS or Linux bases", async () => {
  const { data: original } = await loadGitDistConfig(configPath);
  const changed = JSON.parse(JSON.stringify(original));
  changed.versions.git_for_windows = "99.0.windows.1";
  changed.versions.git_for_windows_package = "99.0.1";
  changed.versions.win32_openssh = "99.0-preview";
  changed.resources.layout.windows_ssh_executable = "openssh-next/ssh.exe";

  for (const targetName of ["macos-universal", "linux-x86_64"]) {
    const before = await computeBaseDefinition({
      config: original,
      targetName,
    });
    const after = await computeBaseDefinition({
      config: changed,
      targetName,
    });
    assert.equal(after.fingerprint, before.fingerprint, targetName);
  }
  const windowsBefore = await computeBaseDefinition({
    config: original,
    targetName: "windows-x86_64",
  });
  const windowsAfter = await computeBaseDefinition({
    config: changed,
    targetName: "windows-x86_64",
  });
  assert.notEqual(windowsAfter.fingerprint, windowsBefore.fingerprint);
});

test("assembly writes the complete schema v2 manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-toolchain-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseDir = path.join(root, "base");
  const helperDir = path.join(root, "helpers");
  const outputDir = path.join(root, "active");
  const { data: config } = await loadGitDistConfig(configPath);
  const target = "windows-x86_64";
  const paths = expectedManifestPaths(config, target);
  await writeExecutable(
    path.join(baseDir, paths.gitExecutable),
    "git version fixture\n",
  );
  await writeExecutable(
    path.join(baseDir, paths.gitLfsExecutable),
    "git-lfs fixture\n",
  );
  await writeExecutable(
    path.join(baseDir, paths.windowsSshExecutable),
    "openssh fixture\n",
  );
  await writeExecutable(
    path.join(helperDir, path.basename(paths.credentialHelper)),
    "credential helper fixture\n",
  );
  await writeExecutable(
    path.join(helperDir, path.basename(paths.sshAskpass)),
    "askpass helper fixture\n",
  );

  const manifest = await assembleGitDistFromBase({
    baseDir,
    baseFingerprint: "a".repeat(64),
    config,
    distributionFingerprint: "c".repeat(64),
    helperDir,
    helperFingerprint: "b".repeat(64),
    helperVersion: "0.1.0",
    outputDir,
    targetName: target,
    toolchainRevision: "test-r1",
  });

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.target, target);
  assert.equal(manifest.toolchainRevision, "test-r1");
  assert.equal(manifest.baseFingerprint, "a".repeat(64));
  assert.equal(manifest.helperFingerprint, "b".repeat(64));
  assert.equal(manifest.distributionFingerprint, "c".repeat(64));
  assert.deepEqual(manifest.paths, paths);
  const files = await regularFileResourcePaths(outputDir);
  assert.ok(files.includes("manifest.json"));
  assert.equal(Object.keys(manifest.sha256).length, files.length - 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")),
    manifest,
  );
});

test("candidate validation failure preserves the active toolchain", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-activation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activeRoot = path.join(root, "active");
  const candidateRoot = path.join(root, "candidate");
  await mkdir(activeRoot);
  await mkdir(candidateRoot);
  await writeFile(path.join(activeRoot, "marker"), "active\n");
  await writeFile(path.join(candidateRoot, "marker"), "candidate\n");

  await assert.rejects(
    validateAndActivateCandidate({
      activeRoot,
      candidateRoot,
      state: {},
      validateCandidate: async () => {
        throw new Error("candidate verification failed");
      },
    }),
    /candidate verification failed/,
  );

  assert.equal(
    await readFile(path.join(activeRoot, "marker"), "utf8"),
    "active\n",
  );
  assert.equal(
    await readFile(path.join(candidateRoot, "marker"), "utf8"),
    "candidate\n",
  );
});

test("legacy partial builder modes are not exposed", async () => {
  const fetchSource = await readFile(
    path.join(repoRoot, "scripts", "fetch-git-dist.mjs"),
    "utf8",
  );
  for (const token of [
    "schema-only",
    "print-env",
    "download-only",
    "no-extract",
    "source-evidence-only",
    "dev-resources",
  ]) {
    assert.equal(fetchSource.includes(token), false, token);
  }
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "fetch-git-dist.mjs")],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /internal builder/);
});

test("manual update refuses to reuse the locked revision", async () => {
  const lock = JSON.parse(await readFile(toolchainLockPath, "utf8"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "update-git-toolchain.mjs"),
      `--revision=${lock.toolchainRevision}`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already locked/);
});
