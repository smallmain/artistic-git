#!/usr/bin/env node
/* global console, process */

import { spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertRelativeResourcePath,
  assertSha256,
  expectedManifestPaths,
  getHostTarget,
  getTarget,
  isPlaceholderChecksum,
  regularFileResourcePaths,
  requiredExecutableKeysForTarget,
  sha256File,
  supportedTargets,
} from "./git-dist-lib.mjs";
import {
  activeToolchainRoot,
  computeToolchainState,
  normalizeTarget,
} from "./git-toolchain-state.mjs";

const usage = `Usage:
  node scripts/check-git-dist.mjs [--target=${supportedTargets.join("|")}]

The verifier always checks the repository's fixed embedded toolchain tree.`;

function fail(message) {
  throw new Error(message);
}

function info(message) {
  console.log(`git-dist: ${message}`);
}

async function assertPath(filePath, label, mode = constants.R_OK) {
  try {
    await access(filePath, mode);
  } catch {
    fail(`${label} is missing or not accessible: ${filePath}`);
  }
}

async function assertRegularFile(filePath, label) {
  await assertPath(filePath, label);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    fail(`${label} must be a file: ${filePath}`);
  }
}

function parseManifest(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`manifest.json is not valid JSON: ${error.message}`);
  }
}

function requireManifestString(manifest, key) {
  const value = manifest[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`manifest.${key} must be a non-empty string`);
  }
  return value;
}

function assertManifestVersionNotPlaceholder(manifest, key) {
  const value = requireManifestString(manifest, key);
  if (/placeholder|TODO/i.test(value)) {
    fail(`manifest.${key} must not be a placeholder value: ${value}`);
  }
  return value;
}

export async function checkDistRoot(state, distRoot = activeToolchainRoot) {
  const { config } = state;
  const targetName = state.target;
  const target = getTarget(config, targetName);
  let rootStat;
  try {
    rootStat = await stat(distRoot);
  } catch {
    fail(`embedded toolchain directory does not exist: ${distRoot}`);
  }
  if (!rootStat.isDirectory()) {
    fail(`embedded toolchain path must be a directory: ${distRoot}`);
  }

  const manifestPath = path.join(distRoot, config.resources.layout.manifest);
  await assertRegularFile(manifestPath, "manifest.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));

  if (manifest.schemaVersion !== config.manifest.schema_version) {
    fail(`manifest.schemaVersion must be ${config.manifest.schema_version}`);
  }

  requireManifestString(manifest, "platform");
  if (manifest.target !== targetName) {
    fail(`manifest.target must be ${targetName}, got ${manifest.target}`);
  }
  for (const [key, expected] of [
    ["toolchainRevision", state.revision],
    ["baseFingerprint", state.baseFingerprint],
    ["helperFingerprint", state.helperFingerprint],
    ["distributionFingerprint", state.distributionFingerprint],
  ]) {
    if (requireManifestString(manifest, key) !== expected) {
      fail(`manifest.${key} does not match the locked toolchain state`);
    }
  }
  const expectedVersions = {
    gitVersion: expectedGitVersion(config, target),
    gitLfsVersion: config.versions.git_lfs,
    helperVersion: state.helperVersion,
  };
  for (const [key, expected] of Object.entries(expectedVersions)) {
    const actual = assertManifestVersionNotPlaceholder(manifest, key);
    if (actual !== expected) {
      fail(`manifest.${key} must be ${expected}, got ${actual}`);
    }
  }

  if (target.platform === "windows") {
    const actual = assertManifestVersionNotPlaceholder(
      manifest,
      "windowsOpenSshVersion",
    );
    if (actual !== config.versions.win32_openssh) {
      fail(
        `manifest.windowsOpenSshVersion must be ${config.versions.win32_openssh}, got ${actual}`,
      );
    }
  } else if (manifest.windowsOpenSshVersion !== null) {
    fail("manifest.windowsOpenSshVersion must be null outside Windows");
  }

  if (manifest.platform !== target.manifest_platform) {
    fail(
      `manifest.platform must match targets.${targetName}.manifest_platform (${target.manifest_platform}), got ${manifest.platform}`,
    );
  }

  if (!manifest.paths || typeof manifest.paths !== "object") {
    fail("manifest.paths is required");
  }

  checkManifestPaths(config, manifest, targetName);
  await checkManifestExecutablesAndChecksums(
    config,
    manifest,
    distRoot,
    targetName,
  );
  await checkExecutablePermissions(config, manifest, distRoot, targetName);
  await checkTargetArchitectures(targetName, manifest, distRoot);
  await checkLinuxExecutableDependencies(target, distRoot);

  if (targetName === getHostTarget()) {
    const gitExecutable = path.join(distRoot, manifest.paths.gitExecutable);
    const runtimeRoot = await mkdtemp(
      path.join(os.tmpdir(), "ag-git-dist-runtime-"),
    );
    const runtimeEnv = await embeddedGitRuntimeEnv({
      distRoot,
      manifest,
      home: path.join(runtimeRoot, "home"),
      resourceOverrides: true,
    });
    try {
      runVersionCheck(
        gitExecutable,
        ["--version"],
        "embedded git",
        expectedGitVersion(config, target),
        runtimeEnv,
      );
      runVersionCheck(
        path.join(distRoot, manifest.paths.gitLfsExecutable),
        ["version"],
        "embedded git-lfs",
        `git-lfs/${config.versions.git_lfs}`,
        runtimeEnv,
      );
      runExpectedFailure(
        path.join(distRoot, manifest.paths.credentialHelper),
        [],
        "embedded credential helper",
        "missing credential operation argument",
        runtimeEnv,
      );
      runExpectedFailure(
        path.join(distRoot, manifest.paths.sshAskpass),
        [],
        "embedded ssh askpass",
        "missing askpass prompt argument",
        runtimeEnv,
      );
      if (target.platform === "windows") {
        runVersionCheck(
          path.join(distRoot, manifest.paths.windowsSshExecutable),
          ["-V"],
          "embedded Windows OpenSSH",
          "OpenSSH",
          runtimeEnv,
        );
      }
      await runGitRuntimeSmoke({ gitExecutable, distRoot, runtimeEnv });
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }

  info(`embedded toolchain is valid for ${manifest.platform}: ${distRoot}`);
}

function checkManifestPaths(config, manifest, targetName) {
  const expectedPaths = expectedManifestPaths(config, targetName);
  const requiredKeys = requiredExecutableKeysForTarget(config, targetName);

  for (const key of requiredKeys) {
    const actual = manifest.paths[key];
    const expected = expectedPaths[key];
    try {
      assertRelativeResourcePath(actual, key);
    } catch (error) {
      fail(error.message);
    }
    if (actual !== expected) {
      fail(
        `manifest.paths.${key} must match git-dist.toml resources layout (${expected}), got ${actual}`,
      );
    }
  }

  if (
    targetName !== "windows-x86_64" &&
    manifest.paths.windowsSshExecutable !== undefined
  ) {
    fail(
      "manifest.paths.windowsSshExecutable must be absent for non-Windows targets",
    );
  }
}

async function checkManifestExecutablesAndChecksums(
  config,
  manifest,
  distRoot,
  targetName,
) {
  if (
    !manifest.sha256 ||
    typeof manifest.sha256 !== "object" ||
    Object.keys(manifest.sha256).length === 0
  ) {
    fail("manifest.sha256 must contain checksums for distributed files");
  }

  const verifiedPaths = new Set();
  const requiredKeys = requiredExecutableKeysForTarget(config, targetName);
  for (const key of requiredKeys) {
    const relativePath = manifest.paths[key];
    const mode =
      targetName === getHostTarget() && process.platform !== "win32"
        ? constants.X_OK
        : constants.R_OK;
    const absolutePath = path.join(distRoot, relativePath);

    await assertRegularFile(absolutePath, `manifest paths.${key}`);
    await assertPath(absolutePath, `manifest paths.${key}`, mode);

    const checksum = manifest.sha256[relativePath];
    if (!checksum) {
      fail(
        `manifest.sha256 must include required executable path '${relativePath}' for ${key}`,
      );
    }
    try {
      assertSha256(checksum, `manifest.sha256["${relativePath}"]`);
    } catch (error) {
      fail(error.message);
    }
    if (isPlaceholderChecksum(checksum)) {
      fail(
        `manifest.sha256["${relativePath}"] must not be an all-zero placeholder`,
      );
    }

    const actual = await sha256File(absolutePath);
    if (actual !== checksum.toLowerCase()) {
      fail(
        `manifest.sha256["${relativePath}"] does not match file content: expected ${checksum}, got ${actual}`,
      );
    }
    verifiedPaths.add(relativePath);
  }

  for (const [relativePath, checksum] of Object.entries(manifest.sha256)) {
    try {
      assertRelativeResourcePath(relativePath, `sha256 key ${relativePath}`);
      assertSha256(checksum, `manifest.sha256["${relativePath}"]`);
    } catch (error) {
      fail(error.message);
    }
    if (!verifiedPaths.has(relativePath)) {
      const absolutePath = path.join(distRoot, relativePath);
      await assertRegularFile(
        absolutePath,
        `manifest.sha256 key ${relativePath}`,
      );
      const actual = await sha256File(absolutePath);
      if (actual !== checksum.toLowerCase()) {
        fail(
          `manifest.sha256["${relativePath}"] does not match file content: expected ${checksum}, got ${actual}`,
        );
      }
    }
  }

  await checkNoUnmanifestedFiles(config, manifest, distRoot);
}

async function checkNoUnmanifestedFiles(config, manifest, distRoot) {
  const allowedUnmanifestedPaths = new Set([config.resources.layout.manifest]);
  const manifestShaPaths = new Set(Object.keys(manifest.sha256 ?? {}));
  const unmanifested = [];
  for (const relativePath of await regularFileResourcePaths(distRoot)) {
    if (
      allowedUnmanifestedPaths.has(relativePath) ||
      manifestShaPaths.has(relativePath)
    ) {
      continue;
    }
    unmanifested.push(relativePath);
  }
  if (unmanifested.length > 0) {
    fail(
      `git-dist contains regular files not covered by manifest.sha256: ${unmanifested.join(", ")}`,
    );
  }
}

async function checkExecutablePermissions(
  config,
  manifest,
  distRoot,
  targetName,
) {
  if (
    !Array.isArray(manifest.executablePaths) ||
    manifest.executablePaths.length === 0
  ) {
    fail("manifest.executablePaths must contain executable file paths");
  }
  const expected = new Set();
  for (const relativePath of manifest.executablePaths) {
    try {
      assertRelativeResourcePath(relativePath, "executablePaths entry");
    } catch (error) {
      fail(error.message);
    }
    if (!manifest.sha256[relativePath]) {
      fail(`manifest.executablePaths entry is not hashed: ${relativePath}`);
    }
    const absolutePath = path.join(distRoot, relativePath);
    await assertRegularFile(absolutePath, `executable ${relativePath}`);
    await assertPath(
      absolutePath,
      `executable ${relativePath}`,
      targetName === "windows-x86_64" ? constants.R_OK : constants.X_OK,
    );
    expected.add(relativePath);
  }
  for (const key of requiredExecutableKeysForTarget(config, targetName)) {
    if (!expected.has(manifest.paths[key])) {
      fail(`manifest.executablePaths must include paths.${key}`);
    }
  }
  if (targetName !== "windows-x86_64") {
    const actual = [];
    for (const relativePath of await regularFileResourcePaths(distRoot)) {
      if (relativePath === config.resources.layout.manifest) continue;
      const mode = (await stat(path.join(distRoot, relativePath))).mode;
      if ((mode & 0o111) !== 0) actual.push(relativePath);
    }
    const expectedPaths = [...expected].sort();
    actual.sort();
    if (JSON.stringify(actual) !== JSON.stringify(expectedPaths)) {
      fail("manifest.executablePaths does not match executable file modes");
    }
  }
}

async function checkTargetArchitectures(targetName, manifest, distRoot) {
  const executableKeys = [
    "gitExecutable",
    "gitLfsExecutable",
    "credentialHelper",
    "sshAskpass",
  ];
  if (targetName === "windows-x86_64") {
    executableKeys.push("windowsSshExecutable");
    for (const key of executableKeys) {
      const executable = path.join(distRoot, manifest.paths[key]);
      const buffer = await readFile(executable);
      if (buffer.length < 64 || buffer.subarray(0, 2).toString() !== "MZ") {
        fail(`manifest paths.${key} must be a Windows PE executable`);
      }
      const peOffset = buffer.readUInt32LE(0x3c);
      if (
        peOffset + 6 > buffer.length ||
        buffer.subarray(peOffset, peOffset + 4).toString("hex") !==
          "50450000" ||
        buffer.readUInt16LE(peOffset + 4) !== 0x8664
      ) {
        fail(`manifest paths.${key} must be a Windows x86_64 PE executable`);
      }
    }
    info("Windows Git, Git LFS, OpenSSH, and helpers are x86_64 PE files");
    return;
  }
  if (targetName === "linux-x86_64") {
    for (const key of executableKeys) {
      const executable = path.join(distRoot, manifest.paths[key]);
      const buffer = await readFile(executable);
      if (
        buffer.length < 20 ||
        buffer.subarray(0, 4).toString("hex") !== "7f454c46" ||
        buffer[4] !== 2 ||
        buffer[5] !== 1 ||
        buffer.readUInt16LE(18) !== 62
      ) {
        fail(`manifest paths.${key} must be a Linux x86_64 ELF executable`);
      }
    }
    info("Linux Git, Git LFS, and helpers are x86_64 ELF files");
    return;
  }
  if (targetName !== "macos-universal") return;
  if (process.platform !== "darwin") {
    fail("macOS universal toolchains must be verified on macOS");
  }
  for (const key of executableKeys) {
    const executable = path.join(distRoot, manifest.paths[key]);
    const result = spawnSync("lipo", ["-archs", executable], {
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      fail(
        `manifest paths.${key} architecture check failed: ${result.error?.message || result.stderr || result.stdout}`,
      );
    }
    const architectures = new Set(result.stdout.trim().split(/\s+/));
    for (const required of ["arm64", "x86_64"]) {
      if (!architectures.has(required)) {
        fail(
          `manifest paths.${key} must contain arm64 and x86_64, got ${result.stdout.trim()}`,
        );
      }
    }
  }
  info("macOS Git, Git LFS, credential helper, and askpass are universal");
}

async function checkLinuxExecutableDependencies(target, distRoot) {
  if (target.platform !== "linux" || process.platform !== "linux") {
    return;
  }

  const executablePaths = [];
  for (const relativePath of await regularFileResourcePaths(distRoot)) {
    const absolutePath = path.join(distRoot, relativePath);
    try {
      await access(absolutePath, constants.X_OK);
    } catch {
      continue;
    }
    executablePaths.push(absolutePath);
  }

  if (executablePaths.length === 0) {
    fail("linux git-dist must contain executable files for dependency audit");
  }

  const result = spawnSync("ldd", executablePaths, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) {
    fail(
      `linux git-dist dependency audit could not run ldd: ${result.error.message}`,
    );
  }

  const blockedLines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bnot found\b|lib(ldap|lber)\S*\s*=>/.test(line));
  if (blockedLines.length > 0) {
    fail(
      `linux git-dist executable dependencies include dynamic LDAP libraries or missing libraries:\n${blockedLines.join("\n")}`,
    );
  }

  info(
    `linux git-dist executable dependency audit passed for ${executablePaths.length} files.`,
  );
}

function runVersionCheck(executable, versionArgs, label, expectedVersion, env) {
  const result = spawnSync(executable, versionArgs, {
    encoding: "utf8",
    env,
  });

  if (result.error) {
    fail(
      `${label} could not be executed at explicit path ${executable}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    fail(
      `${label} version check failed at explicit path ${executable}: ${result.stderr || result.stdout}`,
    );
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (!output.includes(expectedVersion)) {
    fail(`${label} expected version '${expectedVersion}', got '${output}'`);
  }
  info(`${label}: ${output}`);
}

function runExpectedFailure(executable, args, label, expectedMessage, env) {
  const result = spawnSync(executable, args, { encoding: "utf8", env });
  if (result.error) {
    fail(`${label} could not be executed: ${result.error.message}`);
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0 || !output.includes(expectedMessage)) {
    fail(
      `${label} protocol smoke expected '${expectedMessage}', got exit ${result.status}: ${output}`,
    );
  }
  info(`${label} protocol startup smoke passed`);
}

async function embeddedGitRuntimeEnv({
  distRoot,
  manifest,
  home,
  resourceOverrides,
}) {
  await mkdir(home, { recursive: true });

  const gitExecutable = path.join(distRoot, manifest.paths.gitExecutable);
  const gitLfsExecutable = path.join(distRoot, manifest.paths.gitLfsExecutable);
  const gitExecPath = firstExistingDirectory(distRoot, [
    "git/libexec/git-core",
    "git/mingw64/libexec/git-core",
    "git/usr/libexec/git-core",
  ]);
  const templateDir = firstExistingDirectory(distRoot, [
    "git/share/git-core/templates",
    "git/mingw64/share/git-core/templates",
  ]);
  const perlDirs = existingDirectories(distRoot, [
    "git/share/perl5",
    "git/mingw64/share/perl5",
  ]);
  const pathEntries = uniquePaths([
    path.dirname(gitExecutable),
    gitExecPath,
    path.dirname(gitLfsExecutable),
    path.join(distRoot, "git", "cmd"),
    path.join(distRoot, "git", "mingw64", "bin"),
    path.join(distRoot, "git", "usr", "bin"),
    ...platformToolPathEntries(),
  ]);

  const env = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "init.defaultBranch",
    GIT_CONFIG_VALUE_0: "main",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    PATH: pathEntries.join(path.delimiter),
  };

  if (resourceOverrides) {
    if (gitExecPath) {
      env.GIT_EXEC_PATH = gitExecPath;
    }
    if (templateDir) {
      env.GIT_TEMPLATE_DIR = templateDir;
    }
    if (perlDirs.length > 0) {
      env.GITPERLLIB = perlDirs.join(path.delimiter);
    }
  }

  return env;
}

async function runGitRuntimeSmoke({ gitExecutable, distRoot, runtimeEnv }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-smoke-"));
  try {
    const expectedExecPath = firstExistingDirectory(distRoot, [
      "git/libexec/git-core",
      "git/mingw64/libexec/git-core",
      "git/usr/libexec/git-core",
    ]);
    if (!expectedExecPath) {
      fail("embedded git smoke could not find git libexec/git-core in dist");
    }
    if (process.platform !== "win32") {
      for (const helper of [
        "git-receive-pack",
        "git-upload-archive",
        "git-upload-pack",
      ]) {
        const helperPath = await firstExistingFile(distRoot, [
          path.join("git", "bin", helper),
          path.join("git", "libexec", "git-core", helper),
          path.join("git", "usr", "bin", helper),
          path.join("git", "usr", "libexec", "git-core", helper),
        ]);
        if (!helperPath) {
          fail(`embedded git smoke is missing transport helper ${helper}`);
        }
      }
    }
    const observedExecPath = runGitSmokeCommand(
      gitExecutable,
      ["--exec-path"],
      root,
      runtimeEnv,
    ).stdout.trim();
    if (!samePath(observedExecPath, expectedExecPath)) {
      fail(
        `embedded git --exec-path must resolve to artifact resource env: expected ${expectedExecPath}, got ${observedExecPath}`,
      );
    }

    runGitSmokeCommand(gitExecutable, ["init", "repo"], root, runtimeEnv);
    const repo = path.join(root, "repo");
    const branch = runGitSmokeCommand(
      gitExecutable,
      ["symbolic-ref", "--short", "HEAD"],
      repo,
      runtimeEnv,
    ).stdout.trim();
    if (branch !== "main") {
      fail(`embedded git init default branch must be main, got ${branch}`);
    }
    const sampleHook = path.join(repo, ".git", "hooks", "pre-commit.sample");
    if (!existsSync(sampleHook)) {
      fail(`embedded git init must copy hook templates; missing ${sampleHook}`);
    }
    runGitSmokeCommand(
      gitExecutable,
      ["submodule", "status"],
      repo,
      runtimeEnv,
    );
    runGitSmokeCommand(
      gitExecutable,
      ["lfs", "install", "--local"],
      repo,
      runtimeEnv,
    );
    runGitSmokeCommand(
      gitExecutable,
      ["lfs", "track", "*.bin"],
      repo,
      runtimeEnv,
    );

    const remote = path.join(root, "remote.git");
    runGitSmokeCommand(
      gitExecutable,
      ["init", "--bare", "-b", "main", remote],
      root,
      runtimeEnv,
    );
    runGitSmokeCommand(
      gitExecutable,
      ["config", "user.name", "Artistic Git Smoke"],
      repo,
      runtimeEnv,
    );
    runGitSmokeCommand(
      gitExecutable,
      ["config", "user.email", "smoke@example.test"],
      repo,
      runtimeEnv,
    );
    await writeFile(path.join(repo, "transport.txt"), "transport\n");
    const lfsPayload = "embedded lfs payload\n".repeat(256);
    await writeFile(path.join(repo, "payload.bin"), lfsPayload);
    runGitSmokeCommand(
      gitExecutable,
      ["add", ".gitattributes", "transport.txt", "payload.bin"],
      repo,
      runtimeEnv,
    );
    runGitSmokeCommand(
      gitExecutable,
      ["commit", "-m", "transport smoke"],
      repo,
      runtimeEnv,
    );
    const lfsPointer = runGitSmokeCommand(
      gitExecutable,
      ["show", "HEAD:payload.bin"],
      repo,
      runtimeEnv,
    ).stdout;
    if (!lfsPointer.startsWith("version https://git-lfs.github.com/spec/v1")) {
      fail("embedded git-lfs clean filter did not create an LFS pointer");
    }
    runGitSmokeCommand(gitExecutable, ["lfs", "ls-files"], repo, runtimeEnv);
    runGitSmokeCommand(gitExecutable, ["lfs", "fsck"], repo, runtimeEnv);
    runGitSmokeCommand(
      gitExecutable,
      ["remote", "add", "origin", remote],
      repo,
      runtimeEnv,
    );
    runGitSmokeCommand(
      gitExecutable,
      ["push", "-u", "origin", "main"],
      repo,
      runtimeEnv,
    );
    runGitSmokeCommand(gitExecutable, ["clone", remote, "clone"], root, {
      ...runtimeEnv,
      GIT_LFS_SKIP_SMUDGE: "1",
    });
    if (!existsSync(path.join(root, "clone", "transport.txt"))) {
      fail("embedded git clone smoke did not materialize pushed file");
    }
    if (
      !(
        await readFile(path.join(root, "clone", "payload.bin"), "utf8")
      ).startsWith("version https://git-lfs.github.com/spec/v1")
    ) {
      fail("embedded git-lfs clone smoke did not preserve the LFS pointer");
    }
    runGitSmokeCommand(
      gitExecutable,
      ["lfs", "ls-files"],
      path.join(root, "clone"),
      runtimeEnv,
    );
    runGitSmokeCommand(
      gitExecutable,
      ["archive", "--remote", remote, "HEAD", "transport.txt"],
      root,
      runtimeEnv,
    );

    await writeFile(path.join(repo, "fetched.txt"), "fetch smoke\n");
    runGitSmokeCommand(gitExecutable, ["add", "fetched.txt"], repo, runtimeEnv);
    runGitSmokeCommand(
      gitExecutable,
      ["commit", "-m", "fetch smoke"],
      repo,
      runtimeEnv,
    );
    runGitSmokeCommand(
      gitExecutable,
      ["push", "origin", "main"],
      repo,
      runtimeEnv,
    );
    const clone = path.join(root, "clone");
    runGitSmokeCommand(gitExecutable, ["fetch", "origin"], clone, runtimeEnv);
    const fetched = runGitSmokeCommand(
      gitExecutable,
      ["show", "origin/main:fetched.txt"],
      clone,
      runtimeEnv,
    ).stdout;
    if (fetched !== "fetch smoke\n") {
      fail("embedded git fetch smoke did not update origin/main");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  info(
    "embedded git runtime smoke: exec-path, templates, builtins, LFS, push, clone, archive, and fetch passed",
  );
}

function runGitSmokeCommand(gitExecutable, args, cwd, env) {
  const result = spawnSync(gitExecutable, args, {
    cwd,
    encoding: "utf8",
    env,
  });
  if (result.error) {
    fail(
      `embedded git smoke command '${args.join(" ")}' failed to start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    fail(
      `embedded git smoke command '${args.join(" ")}' failed: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function firstExistingDirectory(distRoot, relativePaths) {
  return existingDirectories(distRoot, relativePaths)[0] ?? null;
}

async function firstExistingFile(distRoot, relativePaths) {
  for (const relativePath of relativePaths) {
    const candidate = path.join(distRoot, relativePath);
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      return candidate;
    }
  }
  return null;
}

function existingDirectories(distRoot, relativePaths) {
  return relativePaths
    .map((relativePath) => path.join(distRoot, relativePath))
    .filter((candidate) => existsSync(candidate));
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const item of paths) {
    if (!item || !existsSync(item)) {
      continue;
    }
    const normalized = normalizeComparablePath(item);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(item);
  }
  return result;
}

function platformToolPathEntries() {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    return systemRoot ? [path.join(systemRoot, "System32")] : [];
  }
  return ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
}

function samePath(left, right) {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function normalizeComparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function expectedGitVersion(config, target) {
  return target.platform === "windows"
    ? config.versions.git_for_windows
    : config.versions.git;
}

export async function verifyGitDistRoot({
  distRoot = activeToolchainRoot,
  targetName = getHostTarget(),
} = {}) {
  const state = await computeToolchainState(normalizeTarget(targetName));
  await checkDistRoot(state, distRoot);
  return state;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const help = args.includes("--help") || args.includes("-h");
  const targetArg = args.find((arg) => arg.startsWith("--target="));
  const unknownArgs = args.filter(
    (arg) => arg !== "--help" && arg !== "-h" && !arg.startsWith("--target="),
  );
  if (unknownArgs.length > 0) {
    throw new Error(`unknown git-toolchain verify argument: ${unknownArgs[0]}`);
  }
  if (help) {
    console.log(usage);
    return;
  }
  await verifyGitDistRoot({
    targetName: targetArg?.slice("--target=".length) || getHostTarget(),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(`git-dist check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
