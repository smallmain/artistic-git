import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_IDENTIFIER = "com.smallmain.artistic-git";

export type E2eProfile = {
  appConfigDir: string;
  env: NodeJS.ProcessEnv;
  runtimeDir: string | null;
};

export type CreateE2eProfileOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  processId?: number;
  tmpDir?: string;
};

export function e2eTemporaryRoot(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = tmpdir(),
) {
  return readNonEmptyEnv(env, "RUNNER_TEMP") ?? fallback;
}

export function createE2eProfile({
  env = process.env,
  platform = process.platform,
  processId = process.pid,
  tmpDir = tmpdir(),
}: CreateE2eProfileOptions = {}): E2eProfile {
  const root =
    readNonEmptyEnv(env, "ARTISTIC_GIT_E2E_PROFILE_DIR") ??
    path.join(tmpDir, `artistic-git-e2e-profile-${processId}`);

  if (platform === "win32") {
    const appData = profileEnvPath(root, env, "APPDATA", "AppData/Roaming");
    const localAppData = profileEnvPath(
      root,
      env,
      "LOCALAPPDATA",
      "AppData/Local",
    );
    const tempDir =
      readNonEmptyEnv(env, "TEMP") ??
      readNonEmptyEnv(env, "TMP") ??
      path.join(root, "Temp");

    return {
      appConfigDir: path.join(appData, APP_IDENTIFIER),
      env: {
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        TEMP: tempDir,
        TMP: tempDir,
      },
      runtimeDir: null,
    };
  }

  if (platform === "darwin") {
    const home = path.join(root, "home");
    return {
      appConfigDir: path.join(
        home,
        "Library",
        "Application Support",
        APP_IDENTIFIER,
      ),
      env: {
        HOME: home,
        TMPDIR: path.join(root, "tmp"),
      },
      runtimeDir: null,
    };
  }

  const configHome = profileEnvPath(root, env, "XDG_CONFIG_HOME", "config");
  const dataHome = profileEnvPath(root, env, "XDG_DATA_HOME", "data");
  const cacheHome = profileEnvPath(root, env, "XDG_CACHE_HOME", "cache");
  const runtimeDir = profileEnvPath(root, env, "XDG_RUNTIME_DIR", "runtime");

  return {
    appConfigDir: path.join(configHome, APP_IDENTIFIER),
    env: {
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    runtimeDir,
  };
}

export function ensureE2eProfile(profile: E2eProfile) {
  for (const dir of Object.values(profile.env)) {
    if (dir) {
      mkdirSync(dir, { recursive: true });
    }
  }
  if (profile.runtimeDir && process.platform !== "win32") {
    chmodSync(profile.runtimeDir, 0o700);
  }

  mkdirSync(profile.appConfigDir, { recursive: true });
  writeFileSync(
    path.join(profile.appConfigDir, "settings.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        onboarding: { onboarded: true },
        updates: { autoCheck: false },
      },
      null,
      2,
    )}\n`,
  );
}

function profileEnvPath(
  root: string,
  env: NodeJS.ProcessEnv,
  envName: string,
  relativeFallback: string,
) {
  if (readNonEmptyEnv(env, "ARTISTIC_GIT_E2E_PROFILE_DIR")) {
    return path.join(root, ...relativeFallback.split("/"));
  }

  if (env.CI) {
    const ciPath = readNonEmptyEnv(env, envName);
    if (ciPath) {
      return ciPath;
    }
  }

  return path.join(root, ...relativeFallback.split("/"));
}

function readNonEmptyEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
