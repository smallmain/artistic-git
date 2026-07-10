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

import type { AppEventName, AppEventPayloads } from "@/lib/ipc/events";
import { createI18n } from "@/i18n/i18n";
import type {
  UpdateInstallGateResponse,
  UpdateStatusEvent,
} from "@/lib/ipc/update-types";
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

type AppEventHandler = EventCallback<AppEventPayloads[AppEventName]>;
type UpdateStatusHandler = EventCallback<AppEventPayloads["update-status"]>;

const bridgeMocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  emitAppEvent: vi.fn(),
  installReadyUpdate: vi.fn(),
  listenAppEvent: vi.fn(),
  openUpdateReleasePage: vi.fn(),
  updateInstallGate: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => ({
  checkForUpdates: bridgeMocks.checkForUpdates,
  installReadyUpdate: bridgeMocks.installReadyUpdate,
  openUpdateReleasePage: bridgeMocks.openUpdateReleasePage,
  updateInstallGate: bridgeMocks.updateInstallGate,
}));

vi.mock("@/lib/ipc/events", () => ({
  emitAppEvent: bridgeMocks.emitAppEvent,
  listenAppEvent: bridgeMocks.listenAppEvent,
}));

let appEventHandlers: Map<AppEventName, Set<AppEventHandler>>;
let updateStatusHandler: UpdateStatusHandler | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  appEventHandlers = new Map();
  updateStatusHandler = null;
  bridgeMocks.listenAppEvent.mockImplementation(
    (name: AppEventName, handler: AppEventHandler) => {
      let handlers = appEventHandlers.get(name);
      if (!handlers) {
        handlers = new Set();
        appEventHandlers.set(name, handlers);
      }
      handlers.add(handler);

      if (name === "update-status") {
        updateStatusHandler = handler as UpdateStatusHandler;
      }
      return Promise.resolve(() => {
        handlers.delete(handler);
        if (name === "update-status" && updateStatusHandler === handler) {
          updateStatusHandler = null;
        }
      });
    },
  );
  bridgeMocks.emitAppEvent.mockImplementation(defaultEmitAppEvent);
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
  bridgeMocks.openUpdateReleasePage.mockResolvedValue(undefined);
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
        <UpdateProbe />
      </TestProviders>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INITIAL_DELAY_MS);
    });

    expect(bridgeMocks.checkForUpdates).toHaveBeenCalledWith({
      source: "automatic",
    });
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stores automatic update progress and failures without opening a prompt", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
        <UpdateProbe />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    const statuses: UpdateStatusEvent["status"][] = [
      { state: "checking" },
      {
        notes: "Release notes",
        state: "available",
        version: "0.2.0",
      },
      {
        downloadedBytes: 50,
        notes: "Release notes",
        progress: 0.5,
        state: "downloading",
        totalBytes: 100,
        version: "0.2.0",
      },
      { state: "notAvailable" },
      { message: "offline", state: "failed", visible: false },
    ];

    for (const status of statuses) {
      await emitUpdateStatus({
        requestId: "auto-1",
        source: "automatic",
        targetWindowLabel: "main",
        status,
      });

      expect(screen.getByText(status.state)).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }
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
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Restart and install" }),
      ).toBeEnabled(),
    );
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

  it("shows a release-page fallback without download or install for package-managed Linux installs", async () => {
    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    await emitUpdateStatus({
      requestId: "manual-deb-fallback-1",
      source: "manual",
      targetWindowLabel: "main",
      status: {
        notes: "Manual package release notes",
        reason: "linuxPackageManager",
        state: "releaseAvailable",
        version: "0.2.0",
      },
    });

    expect(
      await screen.findByRole("dialog", { name: "Update available" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Version 0.2.0 is available. This installation needs a fresh download from GitHub Releases.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("progressbar", { name: "Update download progress" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restart and install" }),
    ).not.toBeInTheDocument();

    window.dispatchEvent(new CustomEvent("artistic-git:install-update"));
    expect(bridgeMocks.installReadyUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open Releases" }));
    expect(bridgeMocks.openUpdateReleasePage).toHaveBeenCalled();
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

  it("blocks install when conflict resolution is active in another window", async () => {
    mockRemoteWindowInstallGate({
      blocked: true,
      message: "finish conflict resolution before installing an update",
      reason: "conflict",
    });

    render(
      <TestProviders
        initialWindowState={{
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

  it("blocks install when review mode is active in another window", async () => {
    mockRemoteWindowInstallGate({
      blocked: true,
      message: "finish review mode before installing an update",
      reason: "reviewMode",
    });

    render(
      <TestProviders
        initialWindowState={{
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

  it("shows a close guard blocker returned by the backend install gate", async () => {
    bridgeMocks.updateInstallGate.mockResolvedValue({
      blocked: true,
      message:
        "restart update is blocked because a window has an operation or recovery prompt that must finish before closing",
      reason: "closeGuard",
    });

    render(
      <TestProviders>
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    await waitFor(() => expect(updateStatusHandler).not.toBeNull());

    await emitUpdateStatus({
      requestId: "manual-close-guard-1",
      source: "manual",
      targetWindowLabel: "main",
      status: {
        notes: null,
        state: "ready",
        version: "0.2.0",
      },
    });

    expect(
      await screen.findByText(
        "Finish the active window operation before restarting to install the update.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restart and install" }),
    ).toBeDisabled();
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

  it("answers install gate requests when this window has a blocker", async () => {
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
        }}
      >
        <UpdaterRuntimeBridge />
      </TestProviders>,
    );

    await waitFor(() =>
      expect(appEventHandlers.has("update-install-gate-request")).toBe(true),
    );

    emitToAppEventHandlers("update-install-gate-request", {
      requestId: "external-request-1",
      requesterWindowLabel: "repo-2",
    });

    await waitFor(() =>
      expect(bridgeMocks.emitAppEvent).toHaveBeenCalledWith(
        "update-install-gate-response",
        expect.objectContaining({
          gate: expect.objectContaining({ reason: "conflict" }),
          requestId: "external-request-1",
          responderWindowLabel: "main",
        }),
      ),
    );
  });
});

async function emitUpdateStatus(payload: UpdateStatusEvent) {
  await act(async () => {
    updateStatusHandler?.({ payload } as Parameters<UpdateStatusHandler>[0]);
  });
}

function defaultEmitAppEvent<TName extends AppEventName>(
  name: TName,
  payload: AppEventPayloads[TName],
): Promise<void> {
  emitToAppEventHandlers(name, payload);
  return Promise.resolve();
}

function emitToAppEventHandlers<TName extends AppEventName>(
  name: TName,
  payload: AppEventPayloads[TName],
): void {
  const event = {
    payload,
  } as Parameters<EventCallback<AppEventPayloads[TName]>>[0];
  for (const handler of appEventHandlers.get(name) ?? []) {
    (handler as EventCallback<AppEventPayloads[TName]>)(event);
  }
}

function mockRemoteWindowInstallGate(gate: UpdateInstallGateResponse) {
  bridgeMocks.emitAppEvent.mockImplementation(
    (name: AppEventName, payload: AppEventPayloads[AppEventName]) => {
      defaultEmitAppEvent(name, payload);

      if (name === "update-install-gate-request") {
        const request =
          payload as AppEventPayloads["update-install-gate-request"];
        emitToAppEventHandlers("update-install-gate-response", {
          gate,
          requestId: request.requestId,
          responderWindowLabel: "repo-2",
        });
      }

      return Promise.resolve();
    },
  );
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
