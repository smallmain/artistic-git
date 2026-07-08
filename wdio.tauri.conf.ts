import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const driverHost = process.env.TAURI_DRIVER_HOST ?? "127.0.0.1";
const driverPort = Number.parseInt(process.env.TAURI_DRIVER_PORT ?? "4444", 10);
const appBinaryPath =
  process.env.ARTISTIC_GIT_E2E_APP ?? defaultTauriBinaryPath();
const tauriDriverPath = process.env.TAURI_DRIVER ?? defaultTauriDriverPath();
const gitDistFixturePath =
  process.env.ARTISTIC_GIT_DIST_DIR ?? defaultGitDistFixturePath();

process.env.ARTISTIC_GIT_DIST_DIR = gitDistFixturePath;

export const config = {
  runner: "local",
  specs: ["./e2e/tauri/**/*.e2e.ts"],
  maxInstances: 1,
  hostname: driverHost,
  port: driverPort,
  path: "/",
  logLevel: process.env.CI ? "warn" : "info",
  bail: 1,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        autoDownloadEdgeDriver: true,
        autoInstallTauriDriver: false,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        driverProvider: "external",
        env: {
          ARTISTIC_GIT_DIST_DIR: gitDistFixturePath,
        },
        logLevel: process.env.CI ? "warn" : "info",
        tauriDriverPath,
        tauriDriverPort: driverPort,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinaryPath,
      },
      "wdio:tauriServiceOptions": {
        appBinaryPath,
        driverProvider: "external",
        env: {
          ARTISTIC_GIT_DIST_DIR: gitDistFixturePath,
        },
      },
    },
  ],
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
  onPrepare: () => {
    ensureTauriBinary();
  },
};

function defaultTauriBinaryPath() {
  const binaryName =
    process.platform === "win32"
      ? "artistic-git-shell.exe"
      : "artistic-git-shell";
  return path.join(rootDir, "target", "debug", binaryName);
}

function defaultTauriDriverPath() {
  const executableName =
    process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver";
  const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), ".cargo");
  const cargoDriverPath = path.join(cargoHome, "bin", executableName);
  return findExecutableOnPath(executableName) ?? cargoDriverPath;
}

function ensureTauriBinary() {
  if (process.env.ARTISTIC_GIT_E2E_SKIP_BUILD !== "1") {
    const result = runPnpm(["tauri", "build", "--debug", "--no-bundle"]);
    assertSuccessfulProcess(result, "pnpm tauri build --debug --no-bundle");
  }

  if (!existsSync(appBinaryPath)) {
    throw new Error(
      `Tauri application binary was not found at ${appBinaryPath}. ` +
        "Set ARTISTIC_GIT_E2E_APP to an existing binary or rerun without ARTISTIC_GIT_E2E_SKIP_BUILD=1.",
    );
  }
}

function runPnpm(args: string[]) {
  const pnpmExecPath = process.env.npm_execpath;
  if (pnpmExecPath && existsSync(pnpmExecPath) && isNodeScript(pnpmExecPath)) {
    return spawnSync(process.execPath, [pnpmExecPath, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
    });
  }

  const executableName = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const command =
    pnpmExecPath && existsSync(pnpmExecPath)
      ? pnpmExecPath
      : (findExecutableOnPath(executableName) ?? executableName);
  return spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
}

function isNodeScript(filePath: string) {
  return /\.[cm]?js$/i.test(filePath);
}

function findExecutableOnPath(executableName: string) {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) {
      continue;
    }

    const candidate = path.join(entry, executableName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function assertSuccessfulProcess(
  result: SpawnSyncReturns<Buffer>,
  commandLabel: string,
) {
  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${commandLabel} failed with exit code ${result.status}`);
  }
}

function prepareGitDistFixture() {
  const root = path.join(tmpdir(), "artistic-git-e2e-git-dist");
  const executableExtension = process.platform === "win32" ? ".cmd" : "";
  const gitExecutable = `git/bin/git${executableExtension}`;
  const gitLfsExecutable = `git-lfs/git-lfs${executableExtension}`;
  const credentialHelper = `helpers/artistic-git-credential-helper${executableExtension}`;
  const sshAskpass = `helpers/artistic-git-ssh-askpass${executableExtension}`;

  writeVersionExecutable(path.join(root, gitExecutable), "git version 2.50.0");
  writeVersionExecutable(path.join(root, gitLfsExecutable), "git-lfs/3.6.0");
  writeExitExecutable(path.join(root, credentialHelper));
  writeExitExecutable(path.join(root, sshAskpass));
  writeFileSync(
    path.join(root, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform: process.platform,
        gitVersion: "git version 2.50.0",
        gitLfsVersion: "git-lfs/3.6.0",
        windowsOpenSshVersion: null,
        helperVersion: "e2e-fixture",
        paths: {
          gitExecutable,
          gitLfsExecutable,
          windowsSshExecutable: null,
          credentialHelper,
          sshAskpass,
        },
        sha256: {},
      },
      null,
      2,
    )}\n`,
  );

  return root;
}

function defaultGitDistFixturePath() {
  if (process.env.ARTISTIC_GIT_E2E_REAL_GIT === "1") {
    throw new Error(
      "ARTISTIC_GIT_E2E_REAL_GIT=1 requires ARTISTIC_GIT_DIST_DIR to point at a real embedded Git distribution.",
    );
  }

  return prepareGitDistFixture();
}

function writeVersionExecutable(filePath: string, versionOutput: string) {
  if (process.platform === "win32") {
    writeExecutable(
      filePath,
      [
        "@echo off",
        'if "%1"=="--version" (',
        `  echo ${versionOutput}`,
        "  exit /b 0",
        ")",
        'if "%1"=="version" (',
        `  echo ${versionOutput}`,
        "  exit /b 0",
        ")",
        "exit /b 1",
        "",
      ].join("\r\n"),
    );
    return;
  }

  writeExecutable(
    filePath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ] || [ "$1" = "version" ]; then',
      `  printf '%s\\n' '${versionOutput}'`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
}

function writeExitExecutable(filePath: string) {
  if (process.platform === "win32") {
    writeExecutable(filePath, "@echo off\r\nexit /b 0\r\n");
    return;
  }

  writeExecutable(filePath, "#!/bin/sh\nexit 0\n");
}

function writeExecutable(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);

  if (process.platform !== "win32") {
    chmodSync(filePath, 0o755);
  }
}
