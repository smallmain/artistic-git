/* global Buffer, URL, process */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
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

async function startFixtureServer(files) {
  const loopbackProtocol = "http";
  const loopbackHost = "127.0.0.1";
  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      `${loopbackProtocol}://${loopbackHost}`,
    );
    const key = decodeURIComponent(requestUrl.pathname.replace(/^\//, ""));
    const body = files[key];
    if (!body) {
      response.statusCode = 404;
      response.end("missing fixture");
      return;
    }
    response.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, loopbackHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    baseUrl: `${loopbackProtocol}://${loopbackHost}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function writeSourceEvidenceFixtureConfig({
  tmpDir,
  baseUrl,
  gitContent,
  gitLfsContent,
  gitLfsChecksum,
}) {
  const config = await loadConfig();
  const gitSource = getTargetSources(config, windowsTarget).find(
    ({ source }) => source.component === "git",
  ).source;
  const gitLfsSource = getTargetSources(config, windowsTarget).find(
    ({ source }) => source.component === "git_lfs",
  ).source;
  const gitSha = await writeFixtureHash(
    tmpDir,
    "mingit-fixture.zip",
    gitContent,
  );
  const gitLfsSha =
    gitLfsChecksum ??
    (await writeFixtureHash(tmpDir, "git-lfs-fixture.zip", gitLfsContent));

  let raw = await readFile(configPath, "utf8");
  raw = raw
    .replace(`url = "${gitSource.url}"`, `url = "${baseUrl}/mingit.zip"`)
    .replace(
      `checksum.value = "${gitSource.checksum.value}"`,
      `checksum.value = "${gitSha}"`,
    )
    .replace(`url = "${gitLfsSource.url}"`, `url = "${baseUrl}/git-lfs.zip"`)
    .replace(
      `checksum.value = "${gitLfsSource.checksum.value}"`,
      `checksum.value = "${gitLfsSha}"`,
    );

  const fixtureConfigPath = path.join(tmpDir, "git-dist.toml");
  await writeFile(fixtureConfigPath, raw);
  return fixtureConfigPath;
}

async function writeFixtureHash(tmpDir, fileName, content) {
  const filePath = path.join(tmpDir, fileName);
  await writeFile(filePath, content);
  return sha256File(filePath);
}

async function spawnNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += error.message;
      resolve({ status: 1, stdout, stderr });
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
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
  assert.match(fetchGitDist, /ensureGitTransportBuiltinWrappers/);
  assert.match(fetchGitDist, /git-receive-pack/);
  assert.match(fetchGitDist, /git-upload-pack/);
  assert.match(fetchGitDist, /git-upload-archive/);
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
  assert.match(checkGitDist, /"init", "--bare", "-b", "main", remote/);
  assert.match(checkGitDist, /"push", "-u", "origin", "main"/);
  assert.match(checkGitDist, /"clone", remote, "clone"/);
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

test("source evidence mode checks available Windows archives while skipping OpenSSH", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  const gitContent = Buffer.from("mingit fixture archive\n");
  const gitLfsContent = Buffer.from("git-lfs fixture archive\n");
  const server = await startFixtureServer({
    "mingit.zip": gitContent,
    "git-lfs.zip": gitLfsContent,
  });

  try {
    const fixtureConfigPath = await writeSourceEvidenceFixtureConfig({
      tmpDir,
      baseUrl: server.baseUrl,
      gitContent,
      gitLfsContent,
    });
    const evidenceDir = path.join(tmpDir, "evidence");
    const outputDir = path.join(tmpDir, "git-dist");

    const result = await spawnNode([
      fetchGitDistPath,
      "--source-evidence-only",
      "--skip-blocked-sources",
      "--components=git,git_lfs",
      `--target=${windowsTarget}`,
      `--config=${fixtureConfigPath}`,
      `--cache-dir=${path.join(tmpDir, "cache")}`,
      `--evidence-dir=${evidenceDir}`,
      `--output=${outputDir}`,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /source evidence wrote 2 checked source/);
    assert.equal(
      await pathExists(path.join(outputDir, "manifest.json")),
      false,
    );

    const evidence = JSON.parse(
      await readFile(
        path.join(evidenceDir, "git-dist-source-evidence.json"),
        "utf8",
      ),
    );
    assert.equal(evidence.target.name, windowsTarget);
    assert.equal(evidence.status, "partial");
    assert.equal(evidence.summary.checked, 2);
    assert.equal(evidence.summary.skippedBlocked, 1);
    assert.deepEqual(
      evidence.sources
        .filter((source) => source.status === "checked")
        .map((source) => source.component)
        .sort(),
      ["git", "git_lfs"],
    );
    assert.equal(
      evidence.sources.find((source) => source.component === "win32_openssh")
        ?.status,
      "skipped-blocked",
    );
    for (const source of evidence.sources.filter(
      (entry) => entry.status === "checked",
    )) {
      assert.equal(source.actualSha256, source.checksum.expectedSha256);
      assert.ok(source.cachePath);
    }
  } finally {
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("source evidence mode fails when an available archive checksum mismatches", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  const gitContent = Buffer.from("mingit fixture archive\n");
  const gitLfsContent = Buffer.from("git-lfs fixture archive\n");
  const server = await startFixtureServer({
    "mingit.zip": gitContent,
    "git-lfs.zip": gitLfsContent,
  });

  try {
    const fixtureConfigPath = await writeSourceEvidenceFixtureConfig({
      tmpDir,
      baseUrl: server.baseUrl,
      gitContent,
      gitLfsContent,
      gitLfsChecksum: "f".repeat(64),
    });

    const result = await spawnNode([
      fetchGitDistPath,
      "--source-evidence-only",
      "--skip-blocked-sources",
      "--components=git,git_lfs",
      `--target=${windowsTarget}`,
      `--config=${fixtureConfigPath}`,
      `--cache-dir=${path.join(tmpDir, "cache")}`,
      `--evidence-dir=${path.join(tmpDir, "evidence")}`,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch after download/);
  } finally {
    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("dev resources print-env points at the Tauri git-dist resource mount", () => {
  const result = spawnSync(
    process.execPath,
    [
      fetchGitDistPath,
      "--print-env",
      "--dev-resources",
      "--target=macos-universal",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ARTISTIC_GIT_DIST_DIR/);
  assert.match(result.stdout, /src-tauri\/resources\/git-dist/);
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

test("Win32-OpenSSH release gate treats non-production release notes as non-stable", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  try {
    const metadataPath = path.join(tmpDir, "openssh-releases.json");
    await writeFile(
      metadataPath,
      JSON.stringify([
        {
          tag_name: "v10.0.0.0p2",
          name: "v10.0.0.0p2",
          body: "This is a preview-release (non-production ready).",
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
    assert.match(result.stdout, /preview release notes/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Win32-OpenSSH release gate scans all non-draft releases for stable Win64 assets", async () => {
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
          published_at: "2026-07-08T00:00:00Z",
          assets: [{ name: "OpenSSH-Win64.zip" }],
        },
        {
          tag_name: "v9.9.0.0p1",
          name: "v9.9.0.0p1",
          draft: false,
          prerelease: false,
          published_at: "2025-01-01T00:00:00Z",
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
    assert.match(result.stderr, /found stable Win32-OpenSSH release/);
    assert.match(result.stderr, /v9\.9\.0\.0p1/);
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
    assert.match(result.stderr, /found stable Win32-OpenSSH release/);
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
    assert.equal(report.opensshRelease.scan.checkedReleaseCount, 1);
    assert.equal(report.opensshRelease.scan.stableWithRequiredAssetCount, 0);
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

test("workflow build evidence records partial source checks for blocked Windows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-"));
  try {
    const metadataPath = path.join(tmpDir, "openssh-releases.json");
    const sourceEvidencePath = path.join(
      tmpDir,
      "git-dist-source-evidence.json",
    );
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
    await writeFile(
      sourceEvidencePath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-07-09T00:00:00.000Z",
        mode: "source-evidence-only",
        target: {
          name: windowsTarget,
          platform: "windows",
          manifestPlatform: windowsTarget,
          artifactName: `artistic-git-dist-${windowsTarget}`,
        },
        status: "partial",
        summary: {
          checked: 2,
          skippedBlocked: 1,
          skippedUnselected: 0,
        },
        sources: [
          {
            ref: "sources.windows.x86_64.git",
            component: "git",
            status: "checked",
            stable: true,
            placeholder: false,
            reason: "downloaded archive matched configured SHA-256",
            checksum: { expectedSha256: "a".repeat(64) },
            actualSha256: "a".repeat(64),
            cachePath: ".cache/git-dist/MinGit.zip",
            url: "https://example.test/MinGit.zip",
            assetName: "MinGit.zip",
          },
          {
            ref: "sources.windows.x86_64.git_lfs",
            component: "git_lfs",
            status: "checked",
            stable: true,
            placeholder: false,
            reason: "downloaded archive matched configured SHA-256",
            checksum: { expectedSha256: "b".repeat(64) },
            actualSha256: "b".repeat(64),
            cachePath: ".cache/git-dist/git-lfs.zip",
            url: "https://example.test/git-lfs.zip",
            assetName: "git-lfs.zip",
          },
          {
            ref: "sources.windows.x86_64.win32_openssh",
            component: "win32_openssh",
            status: "skipped-blocked",
            stable: false,
            placeholder: true,
            reason: "preview release",
            checksum: { expectedSha256: "c".repeat(64) },
            url: "https://example.test/OpenSSH-Win64.zip",
            assetName: "OpenSSH-Win64.zip",
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        readinessReportPath,
        "--workflow-build",
        "--target=windows-x86_64",
        `--metadata=${metadataPath}`,
        "--mode=build",
        "--run-id=789",
        "--repository=smallmain/artistic-git",
        "--runner-os=Windows",
        "--runner-arch=X64",
        "--job-os=windows-2022",
        `--source-evidence=${sourceEvidencePath}`,
        "--source-evidence-artifact-name=git-dist-source-evidence-windows-x86_64",
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
    assert.equal(report.workflowBuild.target.blocked, true);
    assert.equal(
      report.workflowBuild.validationSummary.reusableArtifactProduced,
      false,
    );
    assert.equal(
      report.workflowBuild.sourceArchiveValidation.status,
      "partial",
    );
    assert.equal(
      report.workflowBuild.sourceArchiveValidation.summary.checked,
      2,
    );
    assert.equal(
      report.workflowBuild.sourceArchiveValidation.sources.find(
        (source) => source.component === "win32_openssh",
      )?.status,
      "skipped-blocked",
    );
    assert.equal(
      report.workflowBuild.artifactIndex.find(
        (artifact) => artifact.kind === "source-check-evidence",
      )?.name,
      "git-dist-source-evidence-windows-x86_64",
    );
    assert.ok(
      report.workflowBuild.validationSummary.commands.some((command) =>
        command.includes("--source-evidence-only"),
      ),
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
    /Check available source archives for placeholder-blocked target[\s\S]+--source-evidence-only[\s\S]+--skip-blocked-sources[\s\S]+--components=git,git_lfs/,
  );
  assert.match(workflow, /source_evidence_args=\(\)/);
  assert.match(
    workflow,
    /--source-evidence="artifacts\/git-dist-readiness-\$\{\{ matrix\.target \}\}\/git-dist-source-evidence\.json"/,
  );
  assert.match(
    workflow,
    /Upload target source evidence[\s\S]+git-dist-source-evidence-\$\{\{ matrix\.target \}\}/,
  );
  assert.match(
    workflow,
    /Validate restored assembled distribution[\s\S]+matrix\.placeholderBlocked != true && steps\.dist-cache\.outputs\.cache-hit == 'true'[\s\S]+node scripts\/check-git-dist\.mjs --target="\$\{\{ matrix\.target \}\}"/,
  );
});
