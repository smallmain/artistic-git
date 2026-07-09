/* global process */

import assert from "node:assert/strict";
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
const releaseWorkflow = await readFile(
  path.join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);
const ciWorkflow = await readFile(
  path.join(repoRoot, ".github", "workflows", "ci.yml"),
  "utf8",
);
const gitDistWorkflow = await readFile(
  path.join(repoRoot, ".github", "workflows", "git-dist.yml"),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const verifyGitDistBuildEvidenceScript = path.join(
  repoRoot,
  "scripts",
  "verify-git-dist-build-evidence.mjs",
);

async function writeFixtureConfig(tmpDir, { writeManifest = true } = {}) {
  const tauriDir = path.join(tmpDir, "src-tauri");
  const gitDistDir = path.join(tauriDir, "resources", "git-dist");
  await mkdir(gitDistDir, { recursive: true });
  if (writeManifest) {
    await writeFile(path.join(gitDistDir, "manifest.json"), "{}\n");
  }

  const configPath = path.join(tauriDir, "tauri.conf.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        bundle: {
          active: true,
          targets: requiredTargets,
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
      "https://github.com/smallmain/artistic-git/releases/download/v1.2.3/Artistic%20Git_1.2.3_x64-setup.exe.zip",
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

test("release workflow checks staged and packaged git-dist resources", () => {
  assert.ok(
    releaseWorkflow.includes(
      "name: artistic-git-dist-${{ matrix.gitDistTarget }}",
    ),
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
      '--bundle-output "src-tauri/target/${{ matrix.target }}/release"',
    ),
  );
  assert.ok(releaseWorkflow.includes("--require-bundled-resource"));
  assert.ok(releaseWorkflow.includes('"src-tauri/target/release/bundle"'));
  assert.ok(
    releaseWorkflow.includes(
      '"src-tauri/target/${{ matrix.target }}/release/bundle"',
    ),
  );
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
