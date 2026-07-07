import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { EventCallback } from "@tauri-apps/api/event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEventPayloads } from "@/lib/ipc/events";
import { createI18n } from "@/i18n/i18n";
import type { UpdateStatusEvent } from "@/lib/ipc/update-types";
import {
  WindowStoreProvider,
  useWindowStore,
  type WindowStoreState,
} from "@/store/window-store";
import { defaultAppSettings } from "@/features/settings/settings-model";

import {
  AUTO_UPDATE_INITIAL_DELAY_MS,
  UpdaterRuntimeBridge,
} from "./UpdaterRuntimeBridge";

type UpdateStatusHandler = EventCallback<AppEventPayloads["update-status"]>;

const bridgeMocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  installReadyUpdate: vi.fn(),
  listenAppEvent: vi.fn(),
  updateInstallGate: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => ({
  checkForUpdates: bridgeMocks.checkForUpdates,
  installReadyUpdate: bridgeMocks.installReadyUpdate,
  updateInstallGate: bridgeMocks.updateInstallGate,
}));

vi.mock("@/lib/ipc/events", () => ({
  listenAppEvent: bridgeMocks.listenAppEvent,
}));

let updateStatusHandler: UpdateStatusHandler | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  updateStatusHandler = null;
  bridgeMocks.listenAppEvent.mockImplementation((name, handler) => {
    if (name === "update-status") {
      updateStatusHandler = handler;
    }
    return Promise.resolve(() => {
      updateStatusHandler = null;
    });
  });
  bridgeMocks.checkForUpdates.mockResolvedValue({
    requestId: "manual-1",
    source: "manual",
    targetWindowLabel: "main",
    status: { state: "notAvailable" },
  });
  bridgeMocks.updateInstallGate.mockResolvedValue({
    blocked: false,
    message: null,
    reason: null,
  });
  bridgeMocks.installReadyUpdate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("UpdaterRuntimeBridge", () => {
  it("runs a manual update check from the app event", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    window.dispatchEvent(new CustomEvent("artistic-git:check-updates"));

    await waitFor(() =>
      expect(bridgeMocks.checkForUpdates).toHaveBeenCalledWith({
        source: "manual",
      }),
    );
  });

  it("schedules automatic checks when the persisted setting is enabled", async () => {
    vi.useFakeTimers();
    bridgeMocks.checkForUpdates.mockRejectedValue(new Error("offline"));

    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INITIAL_DELAY_MS);
    });

    expect(bridgeMocks.checkForUpdates).toHaveBeenCalledWith({
      source: "automatic",
    });
  });

  it("keeps automatic discovery and download progress silent until ready", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
        <UpdateProbe />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    await emitUpdateStatus({
      requestId: "auto-1",
      source: "automatic",
      targetWindowLabel: "main",
      status: {
        notes: "Release notes",
        state: "available",
        version: "0.2.0",
      },
    });
    await emitUpdateStatus({
      requestId: "auto-1",
      source: "automatic",
      targetWindowLabel: "main",
      status: {
        downloadedBytes: 50,
        notes: "Release notes",
        progress: 0.5,
        state: "downloading",
        totalBytes: 100,
        version: "0.2.0",
      },
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("opens the update prompt when an automatic download is ready", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    await emitUpdateStatus({
      requestId: "auto-ready-1",
      source: "automatic",
      targetWindowLabel: "main",
      status: {
        notes: "Fixed update flow",
        state: "ready",
        version: "0.2.0",
      },
    });

    expect(
      await screen.findByRole("dialog", { name: "Update ready to install" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Version 0.2.0 is available.")).toBeInTheDocument();
    expect(screen.getByText("Fixed update flow")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restart and install" }),
    ).toBeEnabled();
  });

  it("opens a manual update prompt with download progress", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    await emitUpdateStatus({
      requestId: "manual-progress-1",
      source: "manual",
      targetWindowLabel: "main",
      status: {
        notes: "Manual release notes",
        state: "available",
        version: "0.2.0",
      },
    });

    expect(
      await screen.findByRole("dialog", { name: "Update available" }),
    ).toBeInTheDocument();

    await emitUpdateStatus({
      requestId: "manual-progress-1",
      source: "manual",
      targetWindowLabel: "main",
      status: {
        downloadedBytes: 25,
        notes: "Manual release notes",
        progress: 0.25,
        state: "downloading",
        totalBytes: 100,
        version: "0.2.0",
      },
    });

    expect(screen.getByText("Downloading update (25%).")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Update download progress" }),
    ).toHaveAttribute("aria-valuenow", "25");
  });

  it("shows manual check failures in the update prompt", async () => {
    bridgeMocks.checkForUpdates.mockRejectedValue(new Error("offline"));

    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    window.dispatchEvent(new CustomEvent("artistic-git:check-updates"));

    expect(
      await screen.findByRole("dialog", { name: "Check failed" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Check failed: offline")).toBeInTheDocument();
  });

  it("does not reopen a dismissed prompt for the same update request", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    await emitUpdateStatus({
      requestId: "manual-dismiss-1",
      source: "manual",
      targetWindowLabel: "main",
      status: {
        notes: "Release notes",
        state: "available",
        version: "0.2.0",
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Later" }));

    await emitUpdateStatus({
      requestId: "manual-dismiss-1",
      source: "manual",
      targetWindowLabel: "main",
      status: {
        notes: "Release notes",
        state: "ready",
        version: "0.2.0",
      },
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not schedule automatic checks when disabled in settings", async () => {
    vi.useFakeTimers();

    render(
      <TestProviders
        initialWindowState={{
          appSettings: {
            ...defaultAppSettings,
            updates: { autoCheck: false },
          },
        }}
      >
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INITIAL_DELAY_MS);
    });

    expect(bridgeMocks.checkForUpdates).not.toHaveBeenCalled();
  });

  it("routes ready status to the current window and refreshes the install gate", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
        <UpdateProbe />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    await emitUpdateStatus({
      requestId: "manual-2",
      source: "manual",
      targetWindowLabel: "main",
      status: {
        notes: "Notes",
        state: "ready",
        version: "0.2.0",
      },
    });

    expect(await screen.findByText("ready")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("allowed")).toBeInTheDocument(),
    );
    expect(bridgeMocks.updateInstallGate).toHaveBeenCalled();
  });

  it("opens a ready prompt after a closed target is retargeted to this window", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
        <UpdateProbe />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    await emitUpdateStatus({
      requestId: "auto-retarget-1",
      source: "automatic",
      targetWindowLabel: "repo-2",
      status: {
        notes: "Retargeted notes",
        state: "ready",
        version: "0.2.0",
      },
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();

    await emitUpdateStatus({
      requestId: "auto-retarget-1",
      source: "automatic",
      targetWindowLabel: "main",
      status: {
        notes: "Retargeted notes",
        state: "ready",
        version: "0.2.0",
      },
    });

    expect(
      await screen.findByRole("dialog", { name: "Update ready to install" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Retargeted notes")).toBeInTheDocument();
  });

  it("blocks install when conflict resolution is active in this window", async () => {
    render(
      <TestProviders
        initialWindowState={{
          conflictsByRepository: {
            "/repo/art": {
              files: [],
              operationId: "conflict-1",
              operationName: "restoreStash",
              repositoryPath: "/repo/art",
            },
          },
          updateStatus: {
            requestId: "manual-2",
            source: "manual",
            targetWindowLabel: "main",
            status: {
              notes: null,
              state: "ready",
              version: "0.2.0",
            },
          },
        }}
      >
        <UpdaterRuntimeBridge />
        <UpdateProbe />
      </TestProviders>,
    );

    window.dispatchEvent(new CustomEvent("artistic-git:install-update"));

    expect(await screen.findByText("conflict")).toBeInTheDocument();
    expect(bridgeMocks.installReadyUpdate).not.toHaveBeenCalled();
  });

  it("blocks install when review mode recovery is active in this window", async () => {
    render(
      <TestProviders
        initialWindowState={{
          projectSettingsByRepository: {
            "/repo/art": {
              path: "/repo/art",
              reviewModeCrash: {
                autoStashRef: "refs/stash",
                enteredAt: "2026-07-07T00:00:00Z",
                operationId: "review-1",
              },
            },
          },
          updateStatus: {
            requestId: "manual-2",
            source: "manual",
            targetWindowLabel: "main",
            status: {
              notes: null,
              state: "ready",
              version: "0.2.0",
            },
          },
        }}
      >
        <UpdaterRuntimeBridge />
        <UpdateProbe />
      </TestProviders>,
    );

    window.dispatchEvent(new CustomEvent("artistic-git:install-update"));

    expect(await screen.findByText("reviewMode")).toBeInTheDocument();
    expect(bridgeMocks.installReadyUpdate).not.toHaveBeenCalled();
  });
});

async function emitUpdateStatus(payload: UpdateStatusEvent) {
  await act(async () => {
    updateStatusHandler?.({ payload } as Parameters<UpdateStatusHandler>[0]);
  });
}

function UpdateProbe() {
  const updateStatus = useWindowStore((state) => state.updateStatus);
  const updateInstallGate = useWindowStore((state) => state.updateInstallGate);
  return (
    <div>
      <div>{updateStatus?.status.state ?? "none"}</div>
      <div>{updateInstallGate.reason ?? "allowed"}</div>
    </div>
  );
}

function TestProviders({
  children,
  initialWindowState,
}: {
  children: ReactNode;
  initialWindowState?: Partial<WindowStoreState>;
}) {
  const i18n = createI18n("en");

  return (
    <I18nextProvider i18n={i18n}>
      <WindowStoreProvider
        initialState={{
          appSettings: defaultAppSettings,
          windowLabel: "main",
          ...initialWindowState,
        }}
      >
        {children}
      </WindowStoreProvider>
    </I18nextProvider>
  );
}
