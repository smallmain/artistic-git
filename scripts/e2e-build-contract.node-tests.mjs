import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("E2E instrumentation is explicit and excluded from release builds", async () => {
  const [
    cargoToml,
    e2eConfigText,
    mainSource,
    shellSource,
    loggingSource,
    wdioConfig,
    releaseWorkflow,
  ] = await Promise.all([
    read("src-tauri/Cargo.toml"),
    read("src-tauri/tauri.e2e.conf.json"),
    read("src/main.tsx"),
    read("src-tauri/src/lib.rs"),
    read("crates/core/src/logging.rs"),
    read("wdio.tauri.conf.ts"),
    read(".github/workflows/release.yml"),
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
