import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { EventCallback } from "@tauri-apps/api/event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEventPayloads } from "@/lib/ipc/events";
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
    await waitFor(() => expect(screen.getByText("allowed")).toBeInTheDocument());
    expect(bridgeMocks.updateInstallGate).toHaveBeenCalled();
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
  return (
    <WindowStoreProvider
      initialState={{
        appSettings: defaultAppSettings,
        windowLabel: "main",
        ...initialWindowState,
      }}
    >
      {children}
    </WindowStoreProvider>
  );
}
