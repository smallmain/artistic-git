/* global process */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildLatestJson,
  selectUpdaterAssets,
} from "./generate-tauri-latest-json.mjs";
import {
  checkTauriBundleResources,
  findBundledGitDistManifests,
  releaseLatestJsonEndpoint,
  requiredTargets,
} from "./check-tauri-bundle-resources.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const normalizeNewlines = (text) => text.replace(/\r\n/g, "\n");
const releaseWorkflow = normalizeNewlines(
  await readFile(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8",
  ),
);
const ciWorkflow = normalizeNewlines(
  await readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"),
);
const gitDistWorkflow = normalizeNewlines(
  await readFile(
    path.join(repoRoot, ".github", "workflows", "git-dist.yml"),
    "utf8",
  ),
);
const packageJson = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const tauriConfig = JSON.parse(
  await readFile(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
);
const tauriLinuxConfig = JSON.parse(
  await readFile(
    path.join(repoRoot, "src-tauri", "tauri.linux.conf.json"),
    "utf8",
  ),
);
const verifyGitDistBuildEvidenceScript = path.join(
  repoRoot,
  "scripts",
  "verify-git-dist-build-evidence.mjs",
);
const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

async function writeFixtureConfig(
  tmpDir,
  { writeManifest = true, writeIcon = true } = {},
) {
  const tauriDir = path.join(tmpDir, "src-tauri");
  const gitDistDir = path.join(tauriDir, "resources", "git-dist");
  await mkdir(gitDistDir, { recursive: true });
  if (writeManifest) {
    await writeFile(path.join(gitDistDir, "manifest.json"), "{}\n");
  }
  if (writeIcon) {
    await mkdir(path.join(tauriDir, "icons"), { recursive: true });
    await writeFile(path.join(tauriDir, "icons", "icon.png"), fixturePng);
  }

  const configPath = path.join(tauriDir, "tauri.conf.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        bundle: {
          active: true,
          targets: requiredTargets,
          icon: ["icons/icon.png"],
          createUpdaterArtifacts: true,
          resources: {
            "resources/git-dist/": "git-dist/",
          },
        },
        plugins: {
          updater: {
            pubkey: "generated-public-key",
            endpoints: [releaseLatestJsonEndpoint],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  return { configPath, gitDistDir };
}

async function writeFixtureGitDist(gitDistDir) {
  const files = new Map([
    ["git/bin/git", "git fixture\n"],
    ["git/bin/git-upload-pack", "git fixture\n"],
    ["git/libexec/git-core/git-add", "git fixture\n"],
    ["git-lfs/git-lfs", "git-lfs fixture\n"],
    ["helpers/artistic-git-credential-helper", "credential helper fixture\n"],
    ["helpers/artistic-git-ssh-askpass", "ssh askpass fixture\n"],
  ]);
  const sha256 = {};
  for (const [relativePath, contents] of files) {
    const filePath = path.join(gitDistDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
    sha256[relativePath] = createHash("sha256").update(contents).digest("hex");
  }
  await mkdir(gitDistDir, { recursive: true });
  await writeFile(
    path.join(gitDistDir, "manifest.json"),
    `${JSON.stringify(
      {
        paths: {
          gitExecutable: "git/bin/git",
          gitLfsExecutable: "git-lfs/git-lfs",
          credentialHelper: "helpers/artistic-git-credential-helper",
          sshAskpass: "helpers/artistic-git-ssh-askpass",
        },
        sha256,
      },
      null,
      2,
    )}\n`,
  );
}

test("builds latest.json with all signed Tauri updater platforms", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-latest-json-"));

  try {
    const assets = new Map([
      ["Artistic Git.app.tar.gz", ""],
      ["Artistic Git.app.tar.gz.sig", "macsig\n"],
      ["Artistic Git_1.2.3_x64-setup.exe.zip", ""],
      ["Artistic Git_1.2.3_x64-setup.exe.zip.sig", "winsig\n"],
      ["artistic-git_1.2.3_amd64.AppImage.tar.gz", ""],
      ["artistic-git_1.2.3_amd64.AppImage.tar.gz.sig", "linuxsig\n"],
      ["artistic-git_1.2.3_amd64.deb", ""],
    ]);
    await Promise.all(
      [...assets].map(([file, contents]) =>
        writeFile(path.join(tmpDir, file), contents),
      ),
    );

    assert.deepEqual(selectUpdaterAssets([...assets.keys()]), [
      "Artistic Git.app.tar.gz",
      "Artistic Git_1.2.3_x64-setup.exe.zip",
      "artistic-git_1.2.3_amd64.AppImage.tar.gz",
    ]);

    const latestJson = await buildLatestJson({
      assetsDir: tmpDir,
      version: "v1.2.3",
      notes: "Release notes",
      pubDate: "2026-07-08T00:00:00.000Z",
      repo: "smallmain/artistic-git",
      tag: "v1.2.3",
    });

    assert.deepEqual(Object.keys(latestJson.platforms), [
      "darwin-x86_64",
      "darwin-aarch64",
      "windows-x86_64",
      "linux-x86_64",
    ]);
    assert.equal(latestJson.version, "1.2.3");
    assert.equal(latestJson.notes, "Release notes");
    assert.equal(latestJson.pub_date, "2026-07-08T00:00:00.000Z");
    assert.equal(latestJson.platforms["darwin-x86_64"].signature, "macsig");
    assert.equal(latestJson.platforms["darwin-aarch64"].signature, "macsig");
    assert.equal(latestJson.platforms["windows-x86_64"].signature, "winsig");
    assert.equal(latestJson.platforms["linux-x86_64"].signature, "linuxsig");
    assert.equal(
      latestJson.platforms["windows-x86_64"].url,
      "https://github.com/smallmain/artistic-git/releases/download/v1.2.3/Artistic.Git_1.2.3_x64-setup.exe.zip",
    );
    assert.equal(
      latestJson.platforms["darwin-aarch64"].url,
      "https://github.com/smallmain/artistic-git/releases/download/v1.2.3/Artistic.Git.app.tar.gz",
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("latest.json generation fails when updater signatures are missing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-latest-json-"));

  try {
    await writeFile(path.join(tmpDir, "Artistic Git.app.tar.gz"), "");
    await writeFile(
      path.join(tmpDir, "Artistic Git_1.2.3_x64-setup.exe.zip"),
      "",
    );
    await writeFile(
      path.join(tmpDir, "artistic-git_1.2.3_amd64.AppImage.tar.gz"),
      "",
    );

    await assert.rejects(
      () =>
        buildLatestJson({
          assetsDir: tmpDir,
          version: "1.2.3",
          notes: "Release notes",
          pubDate: "2026-07-08T00:00:00.000Z",
          repo: "smallmain/artistic-git",
          tag: "v1.2.3",
        }),
      /missing updater signature/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("resource checker validates staged and packaged git-dist wiring", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-resources-"));

  try {
    const { configPath } = await writeFixtureConfig(tmpDir);
    const bundleOutput = path.join(
      tmpDir,
      "target",
      "x86_64-unknown-linux-gnu",
      "release",
    );
    const packagedGitDist = path.join(
      bundleOutput,
      "bundle",
      "appimage",
      "Artistic Git.AppDir",
      "usr",
      "lib",
      "artistic-git",
      "git-dist",
    );
    await writeFixtureGitDist(packagedGitDist);
    const packagedManifest = path.join(packagedGitDist, "manifest.json");

    assert.deepEqual(await findBundledGitDistManifests(bundleOutput), [
      packagedManifest,
    ]);

    const result = await checkTauriBundleResources({
      configPath,
      requireManifest: true,
      releaseMode: true,
      bundleOutput,
      requireBundledResource: true,
    });

    assert.equal(result.bundledManifestPaths.length, 1);
    assert.equal(result.bundledManifestPaths[0], packagedManifest);
    assert.equal(result.bundledManifestChecks[0].checked.length, 4);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("resource checker rejects packaged git-dist sha mismatches", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-resources-"));

  try {
    const { configPath } = await writeFixtureConfig(tmpDir);
    const bundleOutput = path.join(tmpDir, "target", "release");
    const packagedGitDist = path.join(
      bundleOutput,
      "bundle",
      "app",
      "git-dist",
    );
    await writeFixtureGitDist(packagedGitDist);
    await writeFile(
      path.join(packagedGitDist, "git", "bin", "git"),
      "tampered\n",
    );

    await assert.rejects(
      () =>
        checkTauriBundleResources({
          configPath,
          requireManifest: true,
          releaseMode: true,
          bundleOutput,
          requireBundledResource: true,
        }),
      /sha256 mismatch/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("resource checker rejects packaged git-dist files missing from manifest sha256", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-resources-extra-"));

  try {
    const { configPath } = await writeFixtureConfig(tmpDir);
    const bundleOutput = path.join(tmpDir, "target", "release");
    const packagedGitDist = path.join(
      bundleOutput,
      "bundle",
      "app",
      "git-dist",
    );
    await writeFixtureGitDist(packagedGitDist);
    await writeFile(
      path.join(packagedGitDist, "README.md"),
      "mount placeholder\n",
    );
    await mkdir(path.join(packagedGitDist, "git", "bin"), {
      recursive: true,
    });
    await writeFile(
      path.join(packagedGitDist, "git", "bin", "stray.txt"),
      "stray\n",
    );

    await assert.rejects(
      () =>
        checkTauriBundleResources({
          configPath,
          requireManifest: true,
          releaseMode: true,
          bundleOutput,
          requireBundledResource: true,
        }),
      (error) => {
        assert.match(
          error.message,
          /not covered by manifest\.sha256: git\/bin\/stray\.txt/,
        );
        assert.doesNotMatch(error.message, /git\/libexec\/git-core\/git-add/);
        return true;
      },
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("resource checker requires a square PNG icon for AppImage releases", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-resources-icon-"));

  try {
    const { configPath } = await writeFixtureConfig(tmpDir, {
      writeIcon: false,
    });

    await assert.rejects(
      () =>
        checkTauriBundleResources({
          configPath,
          requireManifest: true,
          releaseMode: true,
        }),
      /bundle\.icon PNG is missing or invalid/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("tauri config includes AppImage-compatible PNG icon sizes", () => {
  for (const icon of [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
  ]) {
    assert.ok(tauriConfig.bundle.icon.includes(icon), icon);
  }
});

test("linux bundles keep git-dist outside linuxdeploy's usr/lib ELF scan", () => {
  assert.equal(tauriLinuxConfig.bundle.resources, null);
  for (const target of ["appimage", "deb"]) {
    assert.equal(
      tauriLinuxConfig.bundle.linux[target].files[
        "usr/share/artistic-git/git-dist"
      ],
      "resources/git-dist",
      target,
    );
  }
});

test("resource checker fails when required release manifests are missing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-resources-"));

  try {
    const { configPath } = await writeFixtureConfig(tmpDir, {
      writeManifest: false,
    });

    await assert.rejects(
      () =>
        checkTauriBundleResources({
          configPath,
          requireManifest: true,
        }),
      /real release packaging requires staged/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("release workflow fails publishing when Tauri signing secrets are missing", () => {
  assert.ok(
    releaseWorkflow.includes(
      "if: needs.plan.outputs.publish_release == 'true'",
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      'if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then',
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      "TAURI_SIGNING_PRIVATE_KEY must be configured in GitHub Secrets before publishing updater artifacts.",
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      'if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then',
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be configured in GitHub Secrets before publishing updater artifacts.",
    ),
  );
});

test("release workflow uploads dry-run rehearsal evidence with CI context", () => {
  for (const token of [
    "Generate release rehearsal dry-run checklist",
    "ARTISTIC_GIT_RELEASE_REHEARSAL_REPORT_DIR: ${{ runner.temp }}/release-rehearsal",
    "ARTISTIC_GIT_RELEASE_REHEARSAL_ARTIFACT_NAME: release-rehearsal-${{ runner.os }}",
    "ARTISTIC_GIT_RELEASE_WORKFLOW_RUN_URL: https://github.com/${{github.repository}}/actions/runs/${{github.run_id}}",
    "ARTISTIC_GIT_RELEASE_PLAN_VERSION: ${{ needs.plan.outputs.version }}",
    "ARTISTIC_GIT_RELEASE_PLAN_TAG: ${{ needs.plan.outputs.tag }}",
    "ARTISTIC_GIT_RELEASE_MODE_REASON: ${{ needs.plan.outputs.mode_reason }}",
    "Upload release rehearsal dry-run checklist",
    "if: always()",
    "name: release-rehearsal-${{ runner.os }}",
  ]) {
    assert.ok(releaseWorkflow.includes(token), token);
  }
});

test("release workflow uploads all platform assets and generated latest.json", () => {
  for (const artifactName of [
    "artistic-git-macos",
    "artistic-git-windows",
    "artistic-git-linux",
  ]) {
    assert.ok(releaseWorkflow.includes(`artifactName: ${artifactName}`));
  }

  for (const assetPattern of [
    "-name '*.dmg'",
    "-name '*.app.tar.gz'",
    "-name '*.app.tar.gz.sig'",
    "-name '*.exe'",
    "-name '*.exe.zip'",
    "-name '*.exe.zip.sig'",
    "-name '*.AppImage'",
    "-name '*.AppImage.tar.gz'",
    "-name '*.AppImage.tar.gz.sig'",
    "-name '*.deb'",
  ]) {
    assert.ok(releaseWorkflow.includes(assetPattern), assetPattern);
  }

  assert.ok(
    releaseWorkflow.includes("node scripts/generate-tauri-latest-json.mjs \\"),
  );
  assert.ok(releaseWorkflow.includes("--output release-assets/latest.json"));
  assert.ok(
    releaseWorkflow.includes('gh release create "$TAG_NAME" release-assets/*'),
  );
});

test("release workflow installs pnpm before setting up Node in the publish job", () => {
  const publishStart = releaseWorkflow.indexOf("\n  publish:\n");
  assert.notEqual(publishStart, -1, "publish job block");
  const publishJob = releaseWorkflow.slice(publishStart);
  const pnpmSetup = publishJob.indexOf("- name: Set up pnpm");
  const nodeSetup = publishJob.indexOf("- name: Set up Node.js");

  assert.notEqual(pnpmSetup, -1, "publish job pnpm setup");
  assert.notEqual(nodeSetup, -1, "publish job Node setup");
  assert.ok(pnpmSetup < nodeSetup, "pnpm must be available to setup-node");
});

test("release workflow publishes only from main without environment approval", () => {
  assert.ok(!releaseWorkflow.includes("environment: release"));
  assert.equal(
    releaseWorkflow.match(/\[ "\$REF_NAME" = "main" \]/g)?.length,
    2,
    "push and manual publishing must both require main",
  );
});

test("release workflow applies the release version to displayed app versions", () => {
  for (const manifest of [
    '"package.json"',
    '"src-tauri/tauri.conf.json"',
    '"src-tauri/Cargo.toml"',
    '"crates/app/Cargo.toml"',
  ]) {
    assert.ok(releaseWorkflow.includes(manifest), manifest);
  }
  assert.ok(
    releaseWorkflow.includes("cargo metadata --format-version 1 --no-deps"),
  );
});

test("release workflow checks staged and packaged git-dist resources", () => {
  assert.ok(
    releaseWorkflow.includes(
      "name: artistic-git-dist-${{ matrix.gitDistTarget }}",
    ),
  );
  assert.ok(releaseWorkflow.includes("Activate staged embedded Git resources"));
  assert.ok(
    releaseWorkflow.includes("node scripts/activate-phase12-git-dist.mjs"),
  );
  assert.ok(
    releaseWorkflow.includes(
      "node scripts/check-tauri-bundle-resources.mjs --require-manifest --release",
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      'node scripts/check-git-dist.mjs --target="${{ matrix.gitDistTarget }}"',
    ),
  );
  assert.ok(
    !releaseWorkflow.includes(
      'node scripts/check-git-dist.mjs --no-exec --target="${{ matrix.gitDistTarget }}"',
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      "name: git-dist-build-evidence-${{ matrix.gitDistTarget }}",
    ),
  );
  assert.ok(
    releaseWorkflow.includes("node scripts/verify-git-dist-build-evidence.mjs"),
  );
  assert.ok(releaseWorkflow.includes("Verify packaged embedded Git resources"));
  assert.ok(
    releaseWorkflow.includes(
      '--bundle-output "${{ steps.packaged-resource-output.outputs.path }}"',
    ),
  );
  assert.ok(releaseWorkflow.includes("--require-bundled-resource"));
  assert.ok(
    releaseWorkflow.includes(
      "Install Windows bundle for resource verification",
    ),
  );
  assert.ok(
    releaseWorkflow.includes(
      'Test-Path (Join-Path $installDir "git-dist/manifest.json")',
    ),
  );
  assert.ok(releaseWorkflow.includes('"target/release/bundle"'));
  assert.ok(
    releaseWorkflow.includes('"target/${{ matrix.target }}/release/bundle"'),
  );
  assert.ok(!releaseWorkflow.includes("src-tauri/target/"));
});

test("release workflow configures Linux AppImage runtime prerequisites", () => {
  const packageStart = releaseWorkflow.indexOf("\n  package:\n");
  const publishStart = releaseWorkflow.indexOf("\n  publish:\n");
  assert.notEqual(packageStart, -1, "package job block");
  assert.notEqual(publishStart, -1, "publish job block");
  assert.ok(publishStart > packageStart, "publish job follows package job");
  const packageJob = releaseWorkflow.slice(packageStart, publishStart);
  assert.ok(
    packageJob.includes("Free Linux release packaging disk space"),
    "Linux packaging disk cleanup",
  );
  assert.ok(
    packageJob.includes("/usr/local/lib/android"),
    "Linux runner disk cleanup paths",
  );
  assert.ok(packageJob.includes("desktop-file-utils \\"), "desktop-file-utils");
  assert.ok(packageJob.includes("file \\"), "file");
  assert.ok(packageJob.includes("libfuse2 \\"), "libfuse2");
  assert.ok(packageJob.includes("squashfs-tools \\"), "squashfs-tools");
  assert.ok(packageJob.includes("zsync \\"), "zsync");
  assert.ok(
    packageJob.includes("command -v desktop-file-validate"),
    "desktop-file-validate validation",
  );
  assert.ok(packageJob.includes("command -v file"), "file check");
  assert.ok(packageJob.includes("command -v mksquashfs"), "mksquashfs check");
  assert.ok(packageJob.includes("command -v zsync"), "zsync check");
  assert.ok(
    packageJob.includes('APPIMAGE_EXTRACT_AND_RUN: "1"'),
    "APPIMAGE_EXTRACT_AND_RUN",
  );
  assert.ok(
    packageJob.includes("pnpm tauri build --ci --verbose"),
    "Linux Tauri verbose bundling",
  );
  assert.ok(
    packageJob.includes("du -sh src-tauri/resources/git-dist"),
    "Linux GitDist size diagnostic",
  );
  assert.ok(
    packageJob.includes("Prepare Linux Git dependency probe"),
    "Linux Git dependency probe",
  );
  assert.ok(
    packageJob.includes("ADDITIONAL_BIN_DIRS:"),
    "linuxdeploy additional binary probe",
  );
  assert.ok(
    packageJob.includes("Verify packaged Linux Git runtime"),
    "packaged Linux Git runtime smoke",
  );
  assert.ok(
    packageJob.includes('LD_LIBRARY_PATH="$app_lib"'),
    "packaged Linux library path",
  );
  for (const dependency of [
    "librtmp1",
    "libgnutls30 | libgnutls30t64",
    "libsasl2-2",
  ]) {
    assert.ok(tauriConfig.bundle.linux.deb.depends.includes(dependency));
  }
});

test("CI and git-dist workflows cover release and report contract checks", () => {
  assert.ok(ciWorkflow.includes("run: pnpm release:check"));
  assert.ok(ciWorkflow.includes("if: runner.os == 'Linux'"));
  assert.match(
    packageJson.scripts["release:check"],
    /pnpm phase12:evidence:test/,
  );
  for (const token of [
    "release_rehearsal_run_id:",
    "Resolve release rehearsal evidence artifacts",
    "DEFAULT_RELEASE_REHEARSAL_RUN_ID: ${{ vars.ARTISTIC_GIT_RELEASE_REHEARSAL_RUN_ID }}",
    "Download release rehearsal evidence",
    "if: steps.release-rehearsal-evidence.outputs.run_id != ''",
    "pattern: release-rehearsal-*",
    "path: ${{ runner.temp }}/phase12-evidence-input",
    "run-id: ${{ steps.release-rehearsal-evidence.outputs.run_id }}",
    "github-token: ${{ github.token }}",
    "Readiness summary will include release rehearsal evidence from Release run",
  ]) {
    assert.ok(ciWorkflow.includes(token), token);
  }
  assert.ok(
    ciWorkflow.indexOf("Download release rehearsal evidence") >
      ciWorkflow.indexOf("Generate phase 12 evidence summary"),
  );
  assert.ok(
    ciWorkflow.indexOf("Download release rehearsal evidence") <
      ciWorkflow.indexOf("Generate readiness summary"),
  );
  assert.ok(ciWorkflow.includes("node scripts/readiness-summary.mjs"));
  assert.ok(ciWorkflow.includes("name: readiness-summary"));
  assert.ok(gitDistWorkflow.includes('"scripts/git-dist-report.mjs"'));
});

test("git-dist build evidence verifier accepts only reusable artifacts from the expected run", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-evidence-"));
  const evidencePath = path.join(tmpDir, "git-dist-build-evidence.json");
  const blockedPath = path.join(tmpDir, "git-dist-blocked-evidence.json");

  try {
    await writeFile(
      evidencePath,
      `${JSON.stringify(gitDistBuildEvidence(), null, 2)}\n`,
    );
    const ok = spawnSync(
      process.execPath,
      [
        verifyGitDistBuildEvidenceScript,
        `--evidence=${evidencePath}`,
        "--target=linux-x86_64",
        "--run-id=12345",
      ],
      { encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);

    await writeFile(
      blockedPath,
      `${JSON.stringify(
        gitDistBuildEvidence({
          blocked: true,
          reusableArtifactProduced: false,
          status: "placeholder-blocked",
          targetStatus: "blocked",
        }),
        null,
        2,
      )}\n`,
    );
    const blocked = spawnSync(
      process.execPath,
      [
        verifyGitDistBuildEvidenceScript,
        `--evidence=${blockedPath}`,
        "--target=linux-x86_64",
        "--run-id=12345",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /not reusable|reusableArtifactProduced/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

function gitDistBuildEvidence({
  blocked = false,
  reusableArtifactProduced = true,
  status = "validated-fresh-build",
  targetStatus = "ready",
} = {}) {
  return {
    schemaVersion: 1,
    workflowBuild: {
      schemaVersion: 1,
      mode: "build",
      run: {
        runId: "12345",
      },
      target: {
        name: "linux-x86_64",
        artifactName: "artistic-git-dist-linux-x86_64",
        status: targetStatus,
        blocked,
      },
      artifactIndex: [
        {
          kind: "reusable-git-dist",
          name: "artistic-git-dist-linux-x86_64",
          produced: reusableArtifactProduced,
        },
      ],
      validationSummary: {
        status,
        reusableArtifactProduced,
        commands: [
          'node scripts/check-git-dist.mjs --schema-only --real-build --target="linux-x86_64"',
          "cargo build -p artistic-git-helpers --bins --release",
          'node scripts/fetch-git-dist.mjs --target="linux-x86_64" --output="$ARTISTIC_GIT_DIST_DIR" --cache-dir="$ARTISTIC_GIT_DIST_CACHE_DIR" --staging-dir="$ARTISTIC_GIT_DIST_STAGING_DIR"',
          'node scripts/check-git-dist.mjs --target="linux-x86_64"',
        ],
      },
    },
  };
}
