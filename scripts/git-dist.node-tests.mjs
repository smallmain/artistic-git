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
const opensshReleaseCheckPath = path.join(
  repoRoot,
  "scripts",
  "check-git-dist-openssh-release.mjs",
);
const readinessReportPath = path.join(
  repoRoot,
  "scripts",
  "git-dist-report.mjs",
);
const fetchGitDistPath = path.join(repoRoot, "scripts", "fetch-git-dist.mjs");

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
      throw new Error(
        `unhandled fixture source component: ${source.component}`,
      );
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

async function writePosixHelpers(helperDir) {
  await writeExecutable(
    path.join(helperDir, "artistic-git-credential-helper"),
    "credential helper fixture\n",
  );
  await writeExecutable(
    path.join(helperDir, "artistic-git-ssh-askpass"),
    "ssh askpass fixture\n",
  );
}

async function stageMacosPreparedSources(config, stagingDir) {
  for (const { ref, source } of getTargetSources(config, "macos-universal")) {
    const root = sourceStagingDirectory(stagingDir, ref);
    if (source.kind === "source-tarball") {
      await writeExecutable(
        path.join(root, "install", "git", "bin", "git"),
        "git version 2.55.0\n",
      );
    } else if (source.component === "git_lfs") {
      const arch = source.resources_path.includes("arm64") ? "arm64" : "x86_64";
      await writeExecutable(
        path.join(root, `git-lfs-darwin-${arch}`, "git-lfs"),
        "git-lfs/3.7.1 universal fixture\n",
      );
    } else {
      throw new Error(
        `unhandled fixture source component: ${source.component}`,
      );
    }
  }
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
      ["scripts/check-git-dist.mjs", `--target=${windowsTarget}`, "--no-exec"],
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

test("assembles a prepared macOS source build and combines staged git-lfs binaries", async () => {
  const config = await loadConfig();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));

  try {
    const stagingDir = path.join(tmpDir, "staging");
    const outputDir = path.join(tmpDir, "git-dist");
    const helperDir = path.join(tmpDir, "helpers");
    await stageMacosPreparedSources(config, stagingDir);
    await writePosixHelpers(helperDir);

    const manifest = await assembleGitDist({
      config,
      targetName: "macos-universal",
      stagingDir,
      outputDir,
      helperDir,
    });

    assert.equal(manifest.platform, "macos-universal");
    assert.equal(
      await pathExists(path.join(outputDir, "git", "bin", "git")),
      true,
    );
    assert.equal(
      await pathExists(path.join(outputDir, "git-lfs", "git-lfs")),
      true,
    );
    assert.equal(
      await pathExists(path.join(outputDir, "git-lfs", "arm64")),
      false,
    );
    assert.equal(
      manifest.sha256[manifest.paths.gitExecutable],
      await sha256File(path.join(outputDir, manifest.paths.gitExecutable)),
    );
    assert.equal(
      manifest.sha256[manifest.paths.gitLfsExecutable],
      await sha256File(path.join(outputDir, manifest.paths.gitLfsExecutable)),
    );
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
    assert.equal(
      await pathExists(path.join(outputDir, "manifest.json")),
      false,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("source Git build flags disable optional Rust components", async () => {
  const config = await loadConfig();
  const fetchGitDist = await readFile(fetchGitDistPath, "utf8");
  assert.deepEqual(config.build.macos.git.configure_flags, ["--prefix=/git"]);
  assert.deepEqual(config.build.linux.git.configure_flags, ["--prefix=/git"]);
  assert.ok(
    config.build.macos.git.make_flags.includes("NO_RUST=YesPlease"),
    "macOS Git source build must not let Cargo discover the repo workspace",
  );
  assert.ok(
    config.build.linux.git.make_flags.includes("NO_RUST=YesPlease"),
    "Linux Ubuntu 20.04 build image should not require Cargo for optional Git Rust code",
  );
  assert.equal(
    config.build.linux.git.make_flags.includes("NO_PERL=YesPlease"),
    false,
    "Linux Git source build must keep Perl-backed porcelain commands such as git submodule",
  );
  for (const packageName of [
    "libnghttp2-dev",
    "libidn2-dev",
    "librtmp-dev",
    "libssh-dev",
    "libpsl-dev",
    "libkrb5-dev",
    "libldap2-dev",
    "libbrotli-dev",
    "libzstd-dev",
  ]) {
    assert.ok(
      config.build.linux.git.apt_packages.includes(packageName),
      `Linux static libcurl link requires ${packageName}`,
    );
  }
  assert.match(fetchGitDist, /static_link_flags="-Wl,-Bstatic/);
  assert.match(fetchGitDist, /static_required_libs/);
  assert.match(fetchGitDist, /dynamic_transitive_libs/);
  assert.match(fetchGitDist, /EXTLIBS="\$static_link_flags"/);
  assert.match(fetchGitDist, /OPENSSL_LIBSSL=/);
  assert.match(fetchGitDist, /-lcurl\|-lssl\|-lcrypto\|-lz/);
  assert.match(fetchGitDist, /find \$\{shellQuote\(installRoot\)\} -type f/);
  assert.match(fetchGitDist, /function gitInstallPrefix/);
  assert.match(fetchGitDist, /makePrefixFlag/);
  assert.doesNotMatch(fetchGitDist, /prefix=\/(?=["'\s]|$)/);
});

test("git-dist validation executes embedded Git runtime smoke checks", async () => {
  const checkGitDist = await readFile(
    path.join(repoRoot, "scripts", "check-git-dist.mjs"),
    "utf8",
  );
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(checkGitDist, /runGitRuntimeSmoke/);
  assert.match(checkGitDist, /"--exec-path"/);
  assert.match(checkGitDist, /"submodule", "status"/);
  assert.match(checkGitDist, /"init", "repo"/);
  assert.match(checkGitDist, /GIT_CONFIG_KEY_0: "init\.defaultBranch"/);
  assert.match(checkGitDist, /resourceOverrides: true/);
  assert.doesNotMatch(checkGitDist, /"init", "-b", "main", "repo"/);
  assert.match(
    workflow,
    /node scripts\/check-git-dist\.mjs --target="\$\{\{ matrix\.target \}\}"/,
  );
  assert.doesNotMatch(
    workflow,
    /Validate (?:restored assembled|assembled) distribution[\s\S]*?--no-exec/,
  );
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

test("Win32-OpenSSH release gate treats Preview tags as non-stable even when GitHub prerelease is false", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  try {
    const metadataPath = path.join(tmpDir, "openssh-releases.json");
    await writeFile(
      metadataPath,
      JSON.stringify([
        {
          tag_name: "10.0.0.0p2-Preview",
          name: "10.0.0.0p2-Preview",
          draft: false,
          prerelease: false,
          published_at: "2025-10-27T18:58:57Z",
          assets: [{ name: "OpenSSH-Win64.zip" }],
        },
      ]),
    );

    const result = spawnSync(
      process.execPath,
      [
        opensshReleaseCheckPath,
        "--expect-no-stable-release",
        `--metadata=${metadataPath}`,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /latest release remains non-stable/);
    assert.match(result.stdout, /preview label/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Win32-OpenSSH release gate fails when the latest release is stable", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  try {
    const metadataPath = path.join(tmpDir, "openssh-releases.json");
    await writeFile(
      metadataPath,
      JSON.stringify([
        {
          tag_name: "v10.1.0.0p1",
          name: "v10.1.0.0p1",
          draft: false,
          prerelease: false,
          published_at: "2026-07-08T00:00:00Z",
          assets: [{ name: "OpenSSH-Win64.zip" }],
        },
        {
          tag_name: "10.0.0.0p2-Preview",
          name: "10.0.0.0p2-Preview",
          draft: false,
          prerelease: false,
          published_at: "2025-10-27T18:58:57Z",
          assets: [{ name: "OpenSSH-Win64.zip" }],
        },
      ]),
    );

    const result = spawnSync(
      process.execPath,
      [
        opensshReleaseCheckPath,
        "--expect-no-stable-release",
        `--metadata=${metadataPath}`,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /latest Win32-OpenSSH release appears stable/);
    assert.match(result.stderr, /Update git-dist.toml/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("readiness report marks Windows blocked without blocking macOS and Linux", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  try {
    const metadataPath = path.join(tmpDir, "openssh-releases.json");
    const outputDir = path.join(tmpDir, "report");
    await writeFile(
      metadataPath,
      JSON.stringify([
        {
          tag_name: "10.0.0.0p2-Preview",
          name: "10.0.0.0p2-Preview",
          draft: false,
          prerelease: false,
          published_at: "2025-10-27T18:58:57Z",
          assets: [{ name: "OpenSSH-Win64.zip" }],
        },
      ]),
    );

    const result = spawnSync(
      process.execPath,
      [
        readinessReportPath,
        "--",
        `--metadata=${metadataPath}`,
        `--output-dir=${outputDir}`,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /windows-x86_64 \| blocked/);
    assert.match(result.stdout, /macos-universal \| ready/);
    assert.match(result.stdout, /linux-x86_64 \| ready/);

    const report = JSON.parse(
      await readFile(path.join(outputDir, "git-dist-readiness.json"), "utf8"),
    );
    assert.equal(
      report.targets.find((target) => target.target === "windows-x86_64")
        ?.status,
      "blocked",
    );
    assert.equal(
      report.targets.find((target) => target.target === "macos-universal")
        ?.status,
      "ready",
    );
    assert.equal(
      report.targets.find((target) => target.target === "linux-x86_64")?.status,
      "ready",
    );
    assert.equal(report.opensshRelease.status, "non-stable");
    assert.equal(report.opensshRelease.latest.hasRequiredAsset, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("workflow build evidence records cache validation and reusable artifact index", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  try {
    const outputDir = path.join(tmpDir, "report");
    const result = spawnSync(
      process.execPath,
      [
        readinessReportPath,
        "--workflow-build",
        "--target=macos-universal",
        "--mode=build",
        "--run-id=123",
        "--run-attempt=2",
        "--repository=smallmain/artistic-git",
        "--workflow=Git Distribution",
        "--event-name=workflow_dispatch",
        "--ref=refs/heads/main",
        "--ref-name=main",
        "--commit-sha=abcdef",
        "--runner-os=macOS",
        "--runner-arch=ARM64",
        "--job-os=macos-14",
        "--source-cache-hit=true",
        "--dist-cache-hit=true",
        "--source-cache-key=source-key",
        "--source-cache-restore-key=source-prefix-",
        "--dist-cache-key=dist-key",
        "--dist-cache-restore-key=dist-prefix-",
        "--source-cache-dir=.cache/git-dist",
        "--dist-dir=.artifacts/git-dist/macos-universal",
        `--output-dir=${outputDir}`,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Status: validated-cache-hit/);

    const report = JSON.parse(
      await readFile(
        path.join(outputDir, "git-dist-build-evidence.json"),
        "utf8",
      ),
    );
    assert.equal(report.workflowBuild.run.runId, "123");
    assert.equal(report.workflowBuild.target.name, "macos-universal");
    assert.equal(
      report.workflowBuild.validationSummary.status,
      "validated-cache-hit",
    );
    assert.equal(
      report.workflowBuild.cacheValidation.assembledDistributionCache.cacheHit,
      true,
    );
    assert.equal(
      report.workflowBuild.cacheValidation.assembledDistributionCache.validation
        .status,
      "passed",
    );
    assert.equal(
      report.workflowBuild.artifactIndex.find(
        (artifact) => artifact.kind === "reusable-git-dist",
      )?.produced,
      true,
    );
    assert.ok(
      report.workflowBuild.provenance.every(
        (source) => source.checksum?.algorithm === "sha256",
      ),
    );
    assert.equal(
      await pathExists(path.join(outputDir, "git-dist-blocker.json")),
      false,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("workflow build evidence writes blocker artifact for placeholder-blocked Windows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  try {
    const metadataPath = path.join(tmpDir, "openssh-releases.json");
    const outputDir = path.join(tmpDir, "report");
    await writeFile(
      metadataPath,
      JSON.stringify([
        {
          tag_name: "10.0.0.0p2-Preview",
          name: "10.0.0.0p2-Preview",
          draft: false,
          prerelease: false,
          published_at: "2025-10-27T18:58:57Z",
          assets: [{ name: "OpenSSH-Win64.zip" }],
        },
      ]),
    );

    const result = spawnSync(
      process.execPath,
      [
        readinessReportPath,
        "--",
        "--workflow-build",
        "--target=windows-x86_64",
        `--metadata=${metadataPath}`,
        "--mode=build",
        "--run-id=456",
        "--repository=smallmain/artistic-git",
        "--runner-os=Windows",
        "--runner-arch=X64",
        "--job-os=windows-2022",
        `--output-dir=${outputDir}`,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(
      await readFile(
        path.join(outputDir, "git-dist-build-evidence.json"),
        "utf8",
      ),
    );
    const blockerReport = JSON.parse(
      await readFile(path.join(outputDir, "git-dist-blocker.json"), "utf8"),
    );

    assert.equal(report.workflowBuild.target.blocked, true);
    assert.equal(
      report.workflowBuild.validationSummary.status,
      "placeholder-blocked",
    );
    assert.equal(
      report.workflowBuild.artifactIndex.find(
        (artifact) => artifact.kind === "reusable-git-dist",
      )?.produced,
      false,
    );
    assert.equal(
      report.workflowBuild.artifactIndex.find(
        (artifact) => artifact.kind === "blocker-evidence",
      )?.produced,
      true,
    );
    assert.equal(blockerReport.opensshRelease.status, "non-stable");
    assert.equal(blockerReport.workflowBuild.target.name, "windows-x86_64");
    assert.equal(
      await pathExists(path.join(outputDir, "git-dist-blocker.md")),
      true,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("workflow validates restored assembled cache hits before reuse", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /id: dist-cache/);
  assert.match(workflow, /Check Win32-OpenSSH release gate/);
  assert.match(workflow, /Write git-dist readiness report/);
  assert.match(workflow, /git-dist-readiness-contract/);
  assert.match(workflow, /Write target readiness and build evidence report/);
  assert.match(workflow, /git-dist-readiness-\$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /--workflow-build/);
  assert.match(workflow, /git-dist-build-evidence-\$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /git-dist-blocker-\$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /\$\{openssh_args\[@\]\+"\$\{openssh_args\[@\]\}"\}/);
  assert.match(
    workflow,
    /Upload target blocker evidence[\s\S]+if: matrix\.placeholderBlocked == true/,
  );
  assert.match(
    workflow,
    /Validate contract[\s\S]+Set up pnpm[\s\S]+pnpm\/action-setup@v4[\s\S]+Set up Node\.js/,
  );
  assert.match(
    workflow,
    /Prepare \$\{\{ matrix\.target \}\}[\s\S]+Set up pnpm[\s\S]+pnpm\/action-setup@v4[\s\S]+Set up Node\.js/,
  );
  assert.match(
    workflow,
    /node scripts\/check-git-dist-openssh-release\.mjs --expect-no-stable-release/,
  );
  assert.match(
    workflow,
    /Validate target real-build policy[\s\S]+node scripts\/check-git-dist\.mjs --schema-only --real-build --target="\$\{\{ matrix\.target \}\}"/,
  );
  assert.match(
    workflow,
    /Report placeholder-blocked target[\s\S]+--expect-placeholder-rejection/,
  );
  assert.match(
    workflow,
    /Validate restored assembled distribution[\s\S]+matrix\.placeholderBlocked != true && steps\.dist-cache\.outputs\.cache-hit == 'true'[\s\S]+node scripts\/check-git-dist\.mjs --target="\$\{\{ matrix\.target \}\}"/,
  );
});
