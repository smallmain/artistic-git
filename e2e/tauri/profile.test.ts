import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createE2eProfile, ensureE2eProfile } from "./profile";

describe("Tauri E2E profile", () => {
  it("isolates local Linux runs from host XDG config by default", () => {
    const tmpRoot = path.join(tmpdir(), "ag-e2e-profile-test");
    const profile = createE2eProfile({
      env: {
        XDG_CONFIG_HOME: "/home/user/.config",
        XDG_DATA_HOME: "/home/user/.local/share",
      },
      platform: "linux",
      processId: 42,
      tmpDir: tmpRoot,
    });

    expect(profile.appConfigDir).toBe(
      path.join(
        tmpRoot,
        "artistic-git-e2e-profile-42",
        "config",
        "com.smallmain.artistic-git",
      ),
    );
    expect(profile.env.XDG_CONFIG_HOME).toBe(
      path.join(tmpRoot, "artistic-git-e2e-profile-42", "config"),
    );
  });

  it("preserves CI-provided Linux XDG dirs so artifacts include profile state", () => {
    const profile = createE2eProfile({
      env: {
        CI: "true",
        XDG_CACHE_HOME: "/runner/temp/tauri-e2e-cache/main",
        XDG_CONFIG_HOME: "/runner/temp/tauri-e2e-config/main",
        XDG_DATA_HOME: "/runner/temp/tauri-e2e-data/main",
        XDG_RUNTIME_DIR: "/runner/temp/xdg-runtime",
      },
      platform: "linux",
      processId: 42,
      tmpDir: "/ignored",
    });

    expect(profile.appConfigDir).toBe(
      "/runner/temp/tauri-e2e-config/main/com.smallmain.artistic-git",
    );
    expect(profile.env.XDG_DATA_HOME).toBe(
      "/runner/temp/tauri-e2e-data/main",
    );
    expect(profile.runtimeDir).toBe("/runner/temp/xdg-runtime");
  });

  it("seeds settings that route tests to StartScreen without update noise", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ag-e2e-profile-"));
    try {
      const profile = createE2eProfile({
        env: { ARTISTIC_GIT_E2E_PROFILE_DIR: root },
        platform: "linux",
      });

      ensureE2eProfile(profile);

      const settings = JSON.parse(
        readFileSync(path.join(profile.appConfigDir, "settings.json"), "utf8"),
      ) as {
        onboarding?: { onboarded?: boolean };
        updates?: { autoCheck?: boolean };
      };

      expect(settings.onboarding?.onboarded).toBe(true);
      expect(settings.updates?.autoCheck).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
