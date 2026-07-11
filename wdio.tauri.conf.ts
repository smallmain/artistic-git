import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createE2eProfile, ensureE2eProfile } from "./e2e/tauri/profile";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const driverHost = process.env.TAURI_DRIVER_HOST ?? "127.0.0.1";
const driverPort = Number.parseInt(process.env.TAURI_DRIVER_PORT ?? "4444", 10);
const appBinaryPath = defaultTauriBinaryPath();
const tauriDriverPath =
  readNonEmptyEnv("TAURI_DRIVER") ?? defaultTauriDriverPath();
const e2eLogDir = readNonEmptyEnv("ARTISTIC_GIT_E2E_LOG_DIR");
const e2eProfile = createE2eProfile();
const connectionRetryTimeout = readPositiveIntegerEnv(
  "ARTISTIC_GIT_E2E_CONNECTION_RETRY_TIMEOUT_MS",
  240_000,
);
const connectionRetryCount = readPositiveIntegerEnv(
  "ARTISTIC_GIT_E2E_CONNECTION_RETRY_COUNT",
  process.env.CI ? 2 : 1,
);
const startTimeout = readPositiveIntegerEnv(
  "ARTISTIC_GIT_E2E_START_TIMEOUT_MS",
  90_000,
);
const commandTimeout = readPositiveIntegerEnv(
  "ARTISTIC_GIT_E2E_COMMAND_TIMEOUT_MS",
  60_000,
);
const wdioLogLevel =
  readNonEmptyEnv("ARTISTIC_GIT_E2E_WDIO_LOG_LEVEL") ?? "info";
const e2eSpecSet = readNonEmptyEnv("ARTISTIC_GIT_E2E_SPEC_SET");
const e2eSpecs = selectE2eSpecs(e2eSpecSet);
const mochaTimeout = readPositiveIntegerEnv(
  "ARTISTIC_GIT_E2E_MOCHA_TIMEOUT_MS",
  defaultMochaTimeout(e2eSpecSet),
);
const tauriServiceOptions = {
  appBinaryPath,
  autoDownloadEdgeDriver: true,
  autoInstallTauriDriver: false,
  backendLogLevel: "debug",
  captureBackendLogs: true,
  captureFrontendLogs: true,
  commandTimeout,
  driverProvider: "external",
  env: tauriDriverEnvironment(e2eProfile.env),
  frontendLogLevel: "debug",
  logLevel: wdioLogLevel,
  startTimeout,
  tauriDriverPath,
  tauriDriverPort: driverPort,
  ...(e2eLogDir ? { logDir: e2eLogDir } : {}),
} as const;

export const config = {
  runner: "local",
  specs: e2eSpecs,
  ...(e2eLogDir ? { outputDir: e2eLogDir } : {}),
  maxInstances: 1,
  hostname: driverHost,
  port: driverPort,
  path: "/",
  logLevel: wdioLogLevel,
  bail: 1,
  waitforTimeout: 10_000,
  connectionRetryTimeout,
  connectionRetryCount,
  framework: "mocha",
  reporters: ["spec"],
  services: [["@wdio/tauri-service", tauriServiceOptions]],
  capabilities: [
    {
      browserName: "tauri",
      maxInstances: 1,
      "tauri:options": {
        application: appBinaryPath,
      },
      "wdio:tauriServiceOptions": {
        ...tauriServiceOptions,
      },
    },
  ],
  mochaOpts: {
    ui: "bdd",
    timeout: mochaTimeout,
  },
  onPrepare: () => {
    ensureE2eProfile(e2eProfile);
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

function readNonEmptyEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = readNonEmptyEnv(name);
  if (raw === null) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

function tauriDriverEnvironment(profileEnv: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {
    ...profileEnv,
  };
  for (const name of [
    "APPDATA",
    "CI",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "GDK_BACKEND",
    "GALLIUM_DRIVER",
    "GSK_RENDERER",
    "GTK_USE_PORTAL",
    "HOME",
    "LIBGL_ALWAYS_SOFTWARE",
    "LOCALAPPDATA",
    "MESA_GL_VERSION_OVERRIDE",
    "NO_AT_BRIDGE",
    "PATH",
    "PIPEWIRE_RUNTIME_DIR",
    "RUST_BACKTRACE",
    "RUST_LOG",
    "TEMP",
    "TMP",
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "XAUTHORITY",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CURRENT_DESKTOP",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
  ]) {
    copyEnvIfSet(env, name);
  }
  return env;
}

function copyEnvIfSet(target: NodeJS.ProcessEnv, name: string) {
  if (target[name]) {
    return;
  }

  const value = readNonEmptyEnv(name);
  if (value !== null) {
    target[name] = value;
  }
}

function selectE2eSpecs(specSet: string | null) {
  switch (specSet) {
    case "smoke":
      return ["./e2e/tauri/smoke.e2e.ts"];
    case "crash":
      return ["./e2e/tauri/crash-isolation.e2e.ts"];
    case "real":
      return ["./e2e/tauri/full-chain-real-git.e2e.ts"];
    case null:
      return ["./e2e/tauri/full-chain-real-git.e2e.ts"];
    default:
      throw new Error(
        `Unsupported ARTISTIC_GIT_E2E_SPEC_SET=${specSet}. Use smoke, crash, or real.`,
      );
  }
}

function defaultMochaTimeout(specSet: string | null) {
  if (specSet === "real" || specSet === null) {
    return 1_800_000;
  }

  if (specSet === "crash") {
    return 300_000;
  }

  return 60_000;
}

function defaultTauriDriverPath() {
  const executableName =
    process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver";
  const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), ".cargo");
  const cargoDriverPath = path.join(cargoHome, "bin", executableName);
  return findExecutableOnPath(executableName) ?? cargoDriverPath;
}

function ensureTauriBinary() {
  const result = runPnpm(["tauri", "build", "--debug", "--no-bundle"]);
  assertSuccessfulProcess(result, "pnpm tauri build --debug --no-bundle");

  if (!existsSync(appBinaryPath)) {
    throw new Error(
      `The freshly built Tauri application binary was not found at ${appBinaryPath}.`,
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
