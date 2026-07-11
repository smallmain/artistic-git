import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("manual CI platform scope prunes runner matrices without weakening push CI", async () => {
  const ciWorkflow = await read(".github/workflows/ci.yml");

  assert.match(
    ciWorkflow,
    /platform_scope:\n\s+description:[\s\S]+?default: all\n\s+type: choice\n\s+options:\n\s+- all\n\s+- windows\n\s+- linux\n\s+- macos/,
  );
  assert.equal(
    ciWorkflow.match(/github\.event_name != 'workflow_dispatch'/g)?.length,
    4,
    "test, E2E matrix, E2E macOS guard, and evidence summary must default non-manual events to the full contract",
  );
  assert.equal(
    ciWorkflow.match(/inputs\.platform_scope == 'all'/g)?.length,
    3,
    "both matrices and the evidence summary require all scope",
  );
  for (const scopedMatrix of [
    "inputs.platform_scope == 'windows' &&",
    "inputs.platform_scope == 'linux' &&",
  ]) {
    assert.equal(
      ciWorkflow.split(scopedMatrix).length - 1,
      2,
      `${scopedMatrix} must select both test and E2E matrices`,
    );
  }
  assert.deepEqual(
    matrixPlatformOptions(workflowJob(ciWorkflow, "test", "e2e")),
    [
      ["ubuntu-22.04", "macos-latest", "windows-latest"],
      ["windows-latest"],
      ["ubuntu-22.04"],
      ["macos-latest"],
    ],
  );
  assert.deepEqual(
    matrixPlatformOptions(
      workflowJob(ciWorkflow, "e2e", "phase12-evidence-summary"),
    ),
    [["ubuntu-22.04", "windows-latest"], ["windows-latest"], ["ubuntu-22.04"]],
  );
  assert.match(
    ciWorkflow,
    /e2e:\n[\s\S]+?if: github\.event_name != 'workflow_dispatch' \|\| inputs\.platform_scope != 'macos'[\s\S]+?matrix:\n\s+include: >-\n\s+\$\{\{ fromJSON\(/,
  );
  assert.match(
    ciWorkflow,
    /phase12-evidence-summary:[\s\S]+?if: >-\n\s+\$\{\{ always\(\) &&\n\s+\(github\.event_name != 'workflow_dispatch' \|\| inputs\.platform_scope == 'all'\)/,
  );
  assert.doesNotMatch(
    ciWorkflow,
    /if: .*matrix\.os.*platform_scope|if: .*platform_scope.*matrix\.os/,
    "platform filtering must happen before matrix jobs are expanded",
  );
});

function workflowJob(workflow, jobName, nextJobName) {
  const start = workflow.indexOf(`\n  ${jobName}:\n`);
  const end = workflow.indexOf(`\n  ${nextJobName}:\n`, start + 1);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  assert.notEqual(end, -1, `missing ${nextJobName} job`);
  return workflow.slice(start, end);
}

function matrixPlatformOptions(jobSource) {
  return [...jobSource.matchAll(/'(\[\{[^\n]+\}\])'/g)].map((match) =>
    JSON.parse(match[1]).map((entry) => entry.os),
  );
}

test("E2E instrumentation is explicit and excluded from release builds", async () => {
  const [
    cargoToml,
    e2eConfigText,
    mainSource,
    shellSource,
    loggingSource,
    wdioConfig,
    releaseWorkflow,
    ciWorkflow,
    fullChainSource,
  ] = await Promise.all([
    read("src-tauri/Cargo.toml"),
    read("src-tauri/tauri.e2e.conf.json"),
    read("src/main.tsx"),
    read("src-tauri/src/lib.rs"),
    read("crates/core/src/logging.rs"),
    read("wdio.tauri.conf.ts"),
    read(".github/workflows/release.yml"),
    read(".github/workflows/ci.yml"),
    read("e2e/tauri/full-chain-real-git.e2e.ts"),
  ]);
  const e2eConfig = JSON.parse(e2eConfigText);
  const packageJson = JSON.parse(await read("package.json"));

  assert.equal(packageJson.devDependencies["@wdio/tauri-plugin"], "1.2.0");
  assert.match(packageJson.scripts["build:e2e"], /vite build --mode e2e/);
  assert.match(cargoToml, /wdio-e2e = \["dep:tauri-plugin-wdio"\]/);
  assert.match(
    cargoToml,
    /tauri-plugin-wdio = \{ version = "=1\.2\.0", optional = true \}/,
  );
  assert.match(shellSource, /feature = "wdio-e2e", not\(debug_assertions\)/);
  assert.match(shellSource, /builder\.plugin\(tauri_plugin_wdio::init\(\)\)/);
  assert.match(shellSource, /initialize_logging_with_existing_log_logger/);
  assert.match(loggingSource, /set_global_default\(subscriber\.finish\(\)\)/);
  assert.match(mainSource, /import\.meta\.env\.MODE === "e2e"/);
  assert.match(mainSource, /import\("@wdio\/tauri-plugin"\)/);
  assert.equal(e2eConfig.build.beforeBuildCommand, "pnpm build:e2e");
  assert.equal(e2eConfig.app.withGlobalTauri, true);
  assert.ok(
    e2eConfig.app.security.capabilities.some(
      (capability) =>
        typeof capability === "object" &&
        capability.permissions.includes("wdio:default"),
    ),
  );
  for (const required of [
    '"--features"',
    '"wdio-e2e"',
    '"src-tauri/tauri.e2e.conf.json"',
    "installDebugGitDist(gitDistDir, appBinaryPath)",
  ]) {
    assert.ok(wdioConfig.includes(required), required);
  }
  assert.doesNotMatch(releaseWorkflow, /wdio-e2e|tauri\.e2e\.conf\.json/);
  assert.match(fullChainSource, /e2eTemporaryRoot\(process\.env, tmpdir\(\)\)/);
  assert.match(fullChainSource, /clone UI reported:/);
  assert.match(fullChainSource, /e2e-real-git-clone-diagnostic-/);
  for (const required of [
    "ARTISTIC_GIT_E2E_LOG_DIR:",
    "ARTISTIC_GIT_E2E_PROFILE_DIR:",
    "artifacts/e2e-real-git-clone-diagnostic-*",
    "${{ runner.temp }}/tauri-e2e-profile/",
  ]) {
    assert.ok(ciWorkflow.includes(required), required);
  }

  const defaultTree = spawnSync(
    "cargo",
    ["tree", "--locked", "-p", "artistic-git-shell", "-e", "normal"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(defaultTree.status, 0, defaultTree.stderr);
  assert.doesNotMatch(defaultTree.stdout, /tauri-plugin-wdio/);

  const e2eTree = spawnSync(
    "cargo",
    [
      "tree",
      "--locked",
      "-p",
      "artistic-git-shell",
      "-e",
      "normal",
      "--features",
      "wdio-e2e",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(e2eTree.status, 0, e2eTree.stderr);
  assert.match(e2eTree.stdout, /tauri-plugin-wdio v1\.2\.0/);
});
