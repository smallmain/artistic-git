import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultAppSettings } from "./settings-model";
import { SettingsRuntimeBridge } from "./SettingsRuntimeBridge";

const runtimeMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  listRecentProjects: vi.fn(),
  listenAppEvent: vi.fn(),
  saveAppSettings: vi.fn(),
  setAppSettings: vi.fn(),
  setAppVersion: vi.fn(),
  setLanguagePreference: vi.fn(),
  setOnboarded: vi.fn(),
  setRecentProjects: vi.fn(),
  setRecentProjectsRuntime: vi.fn(),
  setSettingsRuntime: vi.fn(),
  setProjectSettings: vi.fn(),
  setThemePreference: vi.fn(),
  settingsSnapshot: vi.fn(),
  storeState: {
    activeRepositoryPath: null,
    appSettings: null,
    runtimeBootstrapAttempt: 0,
    recentProjectsRefreshAttempt: 0,
  } as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: runtimeMocks.isTauri,
}));

vi.mock("@/i18n/LanguageProvider", () => ({
  useLanguage: () => ({
    setLanguagePreference: runtimeMocks.setLanguagePreference,
  }),
}));

vi.mock("@/theme/ThemeProvider", () => ({
  useTheme: () => ({
    setThemePreference: runtimeMocks.setThemePreference,
  }),
}));

vi.mock("@/lib/ipc/commands", () => ({
  listRecentProjects: runtimeMocks.listRecentProjects,
  saveAppSettings: runtimeMocks.saveAppSettings,
  settingsSnapshot: runtimeMocks.settingsSnapshot,
}));

vi.mock("@/lib/ipc/events", () => ({
  listenAppEvent: runtimeMocks.listenAppEvent,
}));

vi.mock("@/store/window-store", () => ({
  useWindowStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...runtimeMocks.storeState,
      setAppSettings: runtimeMocks.setAppSettings,
      setAppVersion: runtimeMocks.setAppVersion,
      setOnboarded: runtimeMocks.setOnboarded,
      setRecentProjects: runtimeMocks.setRecentProjects,
      setRecentProjectsRuntime: runtimeMocks.setRecentProjectsRuntime,
      setSettingsRuntime: runtimeMocks.setSettingsRuntime,
      setProjectSettings: runtimeMocks.setProjectSettings,
    }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  runtimeMocks.isTauri.mockReturnValue(true);
  runtimeMocks.settingsSnapshot.mockResolvedValue({
    appVersion: "0.1.0",
    identitySourcesError: null,
    settings: defaultAppSettings,
    sshKeyError: null,
  });
  runtimeMocks.listRecentProjects.mockResolvedValue([]);
  runtimeMocks.listenAppEvent.mockResolvedValue(() => undefined);
  runtimeMocks.storeState.activeRepositoryPath = null;
  runtimeMocks.storeState.appSettings = null;
  runtimeMocks.storeState.runtimeBootstrapAttempt = 0;
  runtimeMocks.storeState.recentProjectsRefreshAttempt = 0;
});

describe("SettingsRuntimeBridge", () => {
  it("reports the original settings snapshot error in the desktop runtime", async () => {
    const snapshotError = {
      operation: "settingsSnapshot",
      stderr: "permission denied",
      summary: "Unable to load settings",
    };
    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    runtimeMocks.settingsSnapshot.mockRejectedValue(snapshotError);
    window.addEventListener("artistic-git:error", handleError);

    try {
      render(<SettingsRuntimeBridge />);
      await waitFor(() => expect(receivedDetails).toEqual([snapshotError]));
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("reports event listener failures only in the desktop runtime", async () => {
    const listenerError = new Error("event channel unavailable");
    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    runtimeMocks.listenAppEvent.mockRejectedValue(listenerError);
    window.addEventListener("artistic-git:error", handleError);

    try {
      const view = render(<SettingsRuntimeBridge />);
      await waitFor(() => expect(receivedDetails).toEqual([listenerError]));

      view.unmount();
      receivedDetails.length = 0;
      runtimeMocks.isTauri.mockReturnValue(false);
      render(<SettingsRuntimeBridge />);
      await waitFor(() =>
        expect(runtimeMocks.listenAppEvent).toHaveBeenCalled(),
      );
      expect(receivedDetails).toEqual([]);
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("ignores an older recent-project response after a refresh", async () => {
    let resolveFirst!: (projects: unknown[]) => void;
    let resolveSecond!: (projects: unknown[]) => void;
    runtimeMocks.storeState.appSettings = defaultAppSettings;
    runtimeMocks.listRecentProjects
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const view = render(<SettingsRuntimeBridge />);
    await waitFor(() =>
      expect(runtimeMocks.listRecentProjects).toHaveBeenCalledTimes(1),
    );
    runtimeMocks.storeState.recentProjectsRefreshAttempt = 1;
    view.rerender(<SettingsRuntimeBridge />);
    await waitFor(() =>
      expect(runtimeMocks.listRecentProjects).toHaveBeenCalledTimes(2),
    );

    const newest = [{ displayName: "Newest", path: "/repo/newest" }];
    const stale = [{ displayName: "Stale", path: "/repo/stale" }];
    await act(async () => resolveSecond(newest));
    expect(runtimeMocks.setRecentProjects).toHaveBeenLastCalledWith(newest);
    await act(async () => resolveFirst(stale));
    expect(runtimeMocks.setRecentProjects).toHaveBeenLastCalledWith(newest);
  });
});
