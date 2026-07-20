import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { useContext, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { AppProviders } from "./AppProviders";
import { ConfirmDialog } from "./components/dialogs/ConfirmDialog";
import { CrashDetailsDialog } from "./components/dialogs/CrashDetailsDialog";
import { ErrorDetailsDialog } from "./components/dialogs/ErrorDetailsDialog";
import { DialogFrame } from "./components/dialogs/DialogFrame";
import { AppErrorBoundary } from "./components/layout/AppErrorBoundary";
import { createI18n } from "./i18n/i18n";
import type { LanguagePreference } from "./i18n/resources";
import type { AppError } from "./lib/ipc/generated";
import { DialogLayerContext, dialogOpenedEventName } from "./lib/dialog-layer";
import { createAppQueryClient } from "./lib/query/client";
import type { WindowStoreState } from "./store/window-store";
import type { ThemePreference } from "./theme/ThemeProvider";

const commandMocks = vi.hoisted(() => ({
  acknowledgeRendererCrash: vi.fn(),
  closeCurrentWindow: vi.fn(),
  clearRecentProjects: vi.fn(),
  forgetRecentProject: vi.fn(),
  listRecentProjects: vi.fn(),
  newProjectWindow: vi.fn(),
  openLogDir: vi.fn(),
  registerWindowRepository: vi.fn(),
  saveAppSettings: vi.fn(),
  setAuthPromptListenerReady: vi.fn(),
  settingsSnapshot: vi.fn(),
  windowContext: vi.fn(),
}));
const coreMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, isTauri: coreMocks.isTauri };
});

const tauriEventListeners = new Map<string, EventCallback<unknown>>();

vi.mock("@/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc/commands")>();
  return {
    ...actual,
    acknowledgeRendererCrash: commandMocks.acknowledgeRendererCrash,
    closeCurrentWindow: commandMocks.closeCurrentWindow,
    clearRecentProjects: commandMocks.clearRecentProjects,
    forgetRecentProject: commandMocks.forgetRecentProject,
    listRecentProjects: commandMocks.listRecentProjects,
    newProjectWindow: commandMocks.newProjectWindow,
    openLogDir: commandMocks.openLogDir,
    registerWindowRepository: commandMocks.registerWindowRepository,
    saveAppSettings: commandMocks.saveAppSettings,
    setAuthPromptListenerReady: commandMocks.setAuthPromptListenerReady,
    settingsSnapshot: commandMocks.settingsSnapshot,
    windowContext: commandMocks.windowContext,
  };
});

interface RenderOptions {
  initialLanguagePreference?: LanguagePreference;
  initialThemePreference?: ThemePreference;
  initialWindowState?: Partial<WindowStoreState>;
}

function renderWithProviders(
  ui: ReactElement,
  {
    initialLanguagePreference = "en",
    initialThemePreference = "light",
    initialWindowState,
  }: RenderOptions = {},
) {
  return render(
    <AppProviders
      i18n={createI18n("en")}
      initialLanguagePreference={initialLanguagePreference}
      initialThemePreference={initialThemePreference}
      initialWindowState={{
        settingsRuntime: { status: "ready", error: null },
        recentProjectsRuntime: { status: "ready", error: null },
        windowRuntime: { status: "ready", error: null },
        ...initialWindowState,
      }}
      queryClient={createAppQueryClient()}
    >
      {ui}
    </AppProviders>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  vi.clearAllMocks();
  coreMocks.isTauri.mockReturnValue(false);
  tauriEventListeners.clear();
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    tauriEventListeners.set(name, handler as EventCallback<unknown>);
    return () => undefined;
  });
  commandMocks.acknowledgeRendererCrash.mockResolvedValue(undefined);
  commandMocks.closeCurrentWindow.mockResolvedValue(undefined);
  commandMocks.clearRecentProjects.mockResolvedValue(undefined);
  commandMocks.forgetRecentProject.mockResolvedValue(undefined);
  commandMocks.listRecentProjects.mockResolvedValue([]);
  commandMocks.newProjectWindow.mockResolvedValue({ label: "start-1" });
  commandMocks.openLogDir.mockResolvedValue({ opened: false, path: "/logs" });
  commandMocks.registerWindowRepository.mockResolvedValue({
    label: "main",
    repositoryPath: "/repo/art-project",
  });
  commandMocks.saveAppSettings.mockImplementation(({ settings }) =>
    Promise.resolve(settings),
  );
  commandMocks.setAuthPromptListenerReady.mockResolvedValue(undefined);
  commandMocks.settingsSnapshot.mockResolvedValue({
    appVersion: "0.2.5",
    identitySources: {
      globalGitconfig: { email: null, name: null },
      globalGitconfigPath: null,
      settings: { email: null, name: null },
    },
    settings: { onboarding: { onboarded: true } },
    sshKey: {
      exists: false,
      privateKeyPath: null,
      publicKey: null,
      publicKeyPath: null,
    },
  });
  commandMocks.windowContext.mockResolvedValue({
    label: "main",
    pendingCrash: null,
    repositoryPath: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("shows startup progress until runtime settings and window context are ready", async () => {
    let resolveSettings!: (value: unknown) => void;
    let resolveWindowContext!: (value: unknown) => void;
    commandMocks.settingsSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    commandMocks.windowContext.mockReturnValue(
      new Promise((resolve) => {
        resolveWindowContext = resolve;
      }),
    );

    renderWithProviders(<App />, {
      initialWindowState: {
        settingsRuntime: { status: "loading", error: null },
        windowRuntime: { status: "loading", error: null },
      },
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Starting Artistic Git...",
    );

    await act(async () => {
      resolveSettings({
        appVersion: "0.2.5",
        identitySources: {
          globalGitconfig: { email: null, name: null },
          globalGitconfigPath: null,
          settings: { email: null, name: null },
        },
        settings: { onboarding: { onboarded: true } },
        sshKey: {
          exists: false,
          privateKeyPath: null,
          publicKey: null,
          publicKeyPath: null,
        },
      });
      resolveWindowContext({
        label: "main",
        pendingCrash: null,
        repositoryPath: null,
      });
    });

    expect(
      await screen.findByRole("button", { name: "Open Project" }),
    ).toBeInTheDocument();
  });

  it("reports window context failures in the desktop runtime", async () => {
    const contextError = {
      operation: "windowContext",
      stderr: "window registry unavailable",
      summary: "Unable to load window context",
    };
    coreMocks.isTauri.mockReturnValue(true);
    commandMocks.windowContext.mockRejectedValue(contextError);

    renderWithProviders(<App />);

    const dialog = await screen.findByRole("dialog", {
      name: "Error Details",
    });
    expect(dialog).toHaveTextContent("Unable to load window context");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show technical details" }),
    );
    expect(dialog).toHaveTextContent("window registry unavailable");
  });

  it("keeps browser previews usable when window context is unavailable", async () => {
    commandMocks.windowContext.mockRejectedValue(new Error("No Tauri"));

    renderWithProviders(<App />);

    await waitFor(() => expect(commandMocks.windowContext).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders the start screen with recent project actions", async () => {
    const recentProjects = [
      {
        displayName: "Environment Art",
        path: "/Users/artist/Projects/Environment Art",
      },
      {
        displayName: "Moved Project",
        missing: true,
        path: "/Users/artist/Projects/Moved",
      },
    ];
    commandMocks.listRecentProjects.mockResolvedValue(recentProjects);
    renderWithProviders(<App />, {
      initialWindowState: {
        recentProjects,
      },
    });

    await waitFor(() =>
      expect(commandMocks.listRecentProjects).toHaveBeenCalled(),
    );

    expect(
      screen.getByRole("heading", { name: "Artistic Git" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Project" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone Project" })).toBeEnabled();

    fireEvent.click(screen.getByText("Moved Project").closest("button")!);

    expect(screen.getByRole("alert")).toHaveTextContent("was deleted or moved");

    fireEvent.click(screen.getByRole("button", { name: "Remove from list" }));

    await waitFor(() =>
      expect(screen.queryByText("Moved Project")).not.toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Clear recent projects" }),
    );

    expect(
      await screen.findByText("Repositories you open will appear here."),
    ).toBeInTheDocument();
  });

  it("routes first-run windows to the onboarding placeholder", async () => {
    commandMocks.settingsSnapshot.mockResolvedValueOnce({
      appVersion: "0.2.5",
      identitySources: {
        globalGitconfig: { email: null, name: null },
        globalGitconfigPath: null,
        settings: { email: null, name: null },
      },
      settings: { onboarding: { onboarded: false } },
      sshKey: {
        exists: false,
        privateKeyPath: null,
        publicKey: null,
        publicKeyPath: null,
      },
    });
    renderWithProviders(<App />, {
      initialWindowState: { onboarded: false },
    });

    expect(
      screen.getByRole("heading", { name: "Setup Wizard" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Set the author details attached to commits and configure SSH access.",
      ),
    ).toBeInTheDocument();

    const skipButton = await screen.findByRole("button", {
      name: "Set up later",
    });
    await waitFor(() => expect(skipButton).toBeEnabled());
    fireEvent.click(skipButton);

    expect(
      await screen.findByRole("button", { name: "Open Project" }),
    ).toBeInTheDocument();
  });

  it("blocks repeated setup completion while settings are saving", async () => {
    commandMocks.settingsSnapshot.mockResolvedValueOnce({
      appVersion: "0.2.5",
      identitySources: {
        globalGitconfig: { email: null, name: null },
        globalGitconfigPath: null,
        settings: { email: null, name: null },
      },
      settings: { onboarding: { onboarded: false } },
      sshKey: {
        exists: false,
        privateKeyPath: null,
        publicKey: null,
        publicKeyPath: null,
      },
    });
    let finishSave: (() => void) | undefined;
    commandMocks.saveAppSettings.mockImplementation(
      ({ settings }) =>
        new Promise((resolve) => {
          finishSave = () => resolve(settings);
        }),
    );
    renderWithProviders(<App />, {
      initialWindowState: { onboarded: false },
    });

    const skipButton = await screen.findByRole("button", {
      name: "Set up later",
    });
    await waitFor(() => expect(skipButton).toBeEnabled());
    fireEvent.click(skipButton);
    fireEvent.click(skipButton);

    expect(commandMocks.saveAppSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(skipButton).toBeDisabled());
    expect(screen.queryByRole("button", { name: "Open Project" })).toBeNull();

    await act(async () => {
      finishSave?.();
    });
    expect(
      await screen.findByRole("button", { name: "Open Project" }),
    ).toBeInTheDocument();
  });

  it("renders the repository shell without leaking demo repository data", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
      },
    });

    expect(
      screen.queryByText("No remote repository configured"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Local Changes/ }),
    ).not.toHaveTextContent("4");
    expect(screen.queryByText("feature/material-library")).toBeNull();
    expect(screen.queryByText("Merge color pipeline preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Local Changes/ }));

    expect(
      screen.getByLabelText("Search files and contents"),
    ).toBeInTheDocument();
    expect(screen.queryByText("src/preview/render-preview.ts")).toBeNull();
    expect(screen.queryByLabelText("File comparison")).toBeNull();
  });

  it("filters and collapses sidebar sections", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
      },
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Search branches" }), {
      target: { value: "nope" },
    });

    expect(screen.getAllByText("Loading branches...").length).toBeGreaterThan(
      0,
    );

    fireEvent.click(screen.getByRole("button", { name: "Branches" }));

    expect(
      screen.queryByRole("textbox", { name: "Search branches" }),
    ).not.toBeInTheDocument();
  });

  it("persists sidebar resize settings", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
      },
    });

    fireEvent.pointerDown(screen.getByLabelText("Resize sidebar"), {
      clientX: 320,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { clientX: 380 });
    fireEvent.pointerUp(window);

    expect(
      window.localStorage.getItem("artistic-git:sidebar-layout"),
    ).toContain('"widthPx":380');
  });

  it("shows operation progress while repository data is loading", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
        operationsById: {
          "op-1": {
            cancellable: false,
            label: "Fetching branches",
            operationId: "op-1",
            progress: { kind: "indeterminate" },
            repositoryPath: "/repo/art-project",
            windowLabel: "repo-1",
          },
        },
      },
    });

    expect(screen.getByText("Working...")).toBeInTheDocument();
    expect(screen.queryByText("Fetching branches")).not.toBeInTheDocument();
    expect(screen.queryByText("feature/material-library")).toBeNull();
  });

  it("dispatches window shortcuts and focuses the active search", async () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
      },
    });

    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(commandMocks.newProjectWindow).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "w", metaKey: true });
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.getByLabelText("Search history")).toHaveFocus();
  });

  it("persists theme changes triggered from the native app menu", async () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
        appSettings: {
          appearance: { theme: "light" },
          onboarding: { onboarded: true },
        },
      },
    });

    await waitFor(() => expect(tauriEventListeners.has("app-menu")).toBe(true));
    await act(async () => {
      tauriEventListeners.get("app-menu")?.({
        event: "app-menu",
        id: 1,
        payload: { id: "toggle-theme" },
      });
    });

    await waitFor(() =>
      expect(commandMocks.saveAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          openRepositoryPaths: ["/repo/art-project"],
          settings: expect.objectContaining({
            appearance: expect.objectContaining({ theme: "dark" }),
          }),
        }),
      ),
    );
  });

  it("blocks background navigation and search during a modal workflow", async () => {
    const handleViewTab = vi.fn();
    window.addEventListener("artistic-git:view-tab", handleViewTab);
    renderWithProviders(
      <>
        <App />
        <input aria-label="Background search" data-app-search="current" />
        <DialogFrame
          description="A protected workflow is active."
          onOpenChange={vi.fn()}
          title="Protected workflow"
        >
          <button type="button">Continue workflow</button>
        </DialogFrame>
      </>,
    );

    await waitFor(() => expect(tauriEventListeners.has("app-menu")).toBe(true));
    await act(async () => {
      tauriEventListeners.get("app-menu")?.({
        event: "app-menu",
        id: 1,
        payload: { id: "open-settings" },
      });
      tauriEventListeners.get("app-menu")?.({
        event: "app-menu",
        id: 2,
        payload: { id: "view-local-changes" },
      });
      tauriEventListeners.get("app-menu")?.({
        event: "app-menu",
        id: 3,
        payload: { id: "clone-project" },
      });
    });
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    fireEvent.keyDown(window, { key: "f", metaKey: true });

    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
    expect(handleViewTab).not.toHaveBeenCalled();
    expect(commandMocks.newProjectWindow).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Background search")).not.toHaveFocus();
    expect(
      screen.getByText(
        "Close the current dialog or finish the current operation before navigating elsewhere.",
      ),
    ).toBeInTheDocument();
    window.removeEventListener("artistic-git:view-tab", handleViewTab);
  });

  it("opens global error and crash dialogs from window events", async () => {
    renderWithProviders(<App />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", {
          detail: new Error("Repository failed"),
        }),
      );
    });

    expect(screen.getByRole("dialog")).toHaveTextContent("Repository failed");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:crash", {
          detail: "Renderer crashed",
        }),
      );
    });

    expect(screen.getByRole("dialog")).toHaveTextContent("Renderer crashed");
  });

  it("preserves structured details in global error dialogs", async () => {
    renderWithProviders(<App />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: createAppError() }),
      );
    });

    const dialog = screen.getByRole("dialog", { name: "Error Details" });
    expect(dialog).toHaveTextContent("Merge failed");
    fireEvent.click(
      screen.getByRole("button", { name: "Show technical details" }),
    );
    expect(dialog).toHaveTextContent('"command": [');
    expect(dialog).toHaveTextContent('"stderr": "conflict"');
  });

  it("queues concurrent errors instead of replacing the visible details", async () => {
    renderWithProviders(<App />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", {
          detail: { stderr: "first details", summary: "First failure" },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", {
          detail: { stderr: "second details", summary: "Second failure" },
        }),
      );
    });

    let dialog = screen.getByRole("dialog", { name: "Error Details" });
    expect(dialog).toHaveTextContent("First failure");
    expect(dialog).not.toHaveTextContent("Second failure");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    dialog = await screen.findByRole("dialog", { name: "Error Details" });
    expect(dialog).toHaveTextContent("Second failure");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show technical details" }),
    );
    expect(dialog).toHaveTextContent("second details");
  });

  it("preserves nested error causes in technical details", () => {
    const original = createAppError();
    const wrapped = new Error("Could not cancel cloning", { cause: original });

    renderWithProviders(
      <ErrorDetailsDialog error={wrapped} onOpenChange={vi.fn()} open />,
    );

    const dialog = screen.getByRole("dialog", { name: "Error Details" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show technical details" }),
    );
    expect(dialog).toHaveTextContent('"cause": {');
    expect(dialog).toHaveTextContent('"stderr": "conflict"');
  });

  it("preserves structured crash details and handles circular values", async () => {
    const crash = createAppError() as AppError & { self?: unknown };
    crash.self = crash;
    renderWithProviders(<App />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:crash", { detail: crash }),
      );
    });

    const dialog = screen.getByRole("dialog", { name: "Crash Details" });
    expect(dialog).toHaveTextContent("Merge failed");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show technical details" }),
    );
    expect(dialog).toHaveTextContent('"stderr": "conflict"');
    expect(dialog).toHaveTextContent('"self": "[Circular]"');
  });

  it("registers global auth prompt listeners", async () => {
    renderWithProviders(<App />);

    await waitFor(() =>
      expect(tauriEventListeners.has("https-credential-prompt")).toBe(true),
    );
    expect(tauriEventListeners.has("ssh-passphrase-prompt")).toBe(true);
  });

  it("opens the crash dialog from Rust panic reports emitted by Tauri", async () => {
    renderWithProviders(<App />);

    await waitFor(() =>
      expect(tauriEventListeners.has("crash-reported")).toBe(true),
    );

    await act(async () => {
      tauriEventListeners.get("crash-reported")?.({
        event: "crash-reported",
        id: 1,
        payload: {
          details:
            "Rust panic crossed a runtime boundary.\n\nLocation: src/lib.rs:1:1\nPayload: panic payload",
          source: "rustPanic",
          summary: "Rust panic: panic payload",
          windowLabel: null,
        },
      });
    });

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Rust panic: panic payload",
    );
  });

  it("opens a pending renderer crash after a window reload", async () => {
    commandMocks.windowContext.mockResolvedValue({
      label: "repo-1",
      pendingCrash: {
        details:
          "Renderer process for window `repo-1` was reported unhealthy. The window was reloaded to isolate the crash from other windows.",
        source: "renderer",
        summary: "Renderer process crashed; this window was reloaded.",
        windowLabel: "repo-1",
      },
      repositoryPath: "/repo/art-project",
    });

    renderWithProviders(<App />);

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Renderer process crashed; this window was reloaded.",
    );
    await waitFor(() =>
      expect(commandMocks.acknowledgeRendererCrash).toHaveBeenCalledTimes(1),
    );
  });

  it("keeps a pending renderer crash available across a cancelled effect replay", async () => {
    const pendingCrash = {
      details:
        "Renderer process for window `repo-1` was reported unhealthy. The window was reloaded to isolate the crash from other windows.",
      source: "renderer" as const,
      summary: "Renderer process crashed during StrictMode replay.",
      windowLabel: "repo-1",
    };
    let resolveFirstContext!: (value: unknown) => void;
    const firstContext = new Promise((resolve) => {
      resolveFirstContext = resolve;
    });
    commandMocks.windowContext
      .mockReturnValueOnce(firstContext)
      .mockResolvedValue({
        label: "repo-1",
        pendingCrash,
        repositoryPath: null,
      });

    const firstRender = renderWithProviders(<App />);
    firstRender.unmount();
    renderWithProviders(<App />);

    await waitFor(() =>
      expect(commandMocks.windowContext).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      resolveFirstContext({
        label: "repo-1",
        pendingCrash,
        repositoryPath: null,
      });
    });

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Renderer process crashed during StrictMode replay.",
    );
    await waitFor(() =>
      expect(commandMocks.acknowledgeRendererCrash).toHaveBeenCalled(),
    );
  });
});

describe("AppErrorBoundary", () => {
  it("renders an error dialog when a React subtree throws", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    function BrokenView(): ReactElement {
      throw new Error("Repository view failed");
    }

    renderWithProviders(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Repository view failed",
    );

    consoleError.mockRestore();
  });

  it("isolates React error boundary state per mounted root", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    function BrokenView(): ReactElement {
      throw new Error("Repository view failed");
    }

    try {
      const firstRoot = renderWithProviders(
        <AppErrorBoundary>
          <BrokenView />
        </AppErrorBoundary>,
      );
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Repository view failed",
      );

      firstRoot.unmount();

      renderWithProviders(
        <AppErrorBoundary>
          <div>Second repository window stays interactive</div>
        </AppErrorBoundary>,
      );

      expect(
        screen.getByText("Second repository window stays interactive"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Repository view failed"),
      ).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("ErrorDetailsDialog", () => {
  it("expands and collapses technical details", () => {
    const onOpenChange = vi.fn();

    renderWithProviders(
      <ErrorDetailsDialog
        error={createAppError()}
        onOpenChange={onOpenChange}
        open
      />,
    );

    expect(
      screen.queryByText(/"summary": "Merge failed"/),
    ).not.toBeInTheDocument();

    const showDetails = screen.getByRole("button", {
      name: "Show technical details",
    });
    expect(showDetails).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(showDetails);

    expect(screen.getByText(/"summary": "Merge failed"/)).toBeInTheDocument();
    expect(showDetails).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Hide technical details" }),
    );

    expect(
      screen.queryByText(/"summary": "Merge failed"/),
    ).not.toBeInTheDocument();
  });

  it("closes with Escape and opens the log directory", async () => {
    const onOpenChange = vi.fn();
    const onOpenLogDir = vi.fn();

    renderWithProviders(
      <ErrorDetailsDialog
        error={createAppError()}
        onOpenChange={onOpenChange}
        onOpenLogDir={onOpenLogDir}
        open
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open log folder" }));
    await waitFor(() => expect(onOpenLogDir).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the original details and appends log directory failures", async () => {
    const logError = {
      operation: "openLogDir",
      stderr: "permission denied",
      summary: "Could not open logs",
    };

    renderWithProviders(
      <ErrorDetailsDialog
        error={createAppError()}
        onOpenChange={vi.fn()}
        onOpenLogDir={() => {
          throw logError;
        }}
        open
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open log folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The log folder could not be opened",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show technical details" }),
    );
    expect(screen.getByText(/"originalError":/)).toBeInTheDocument();
    expect(screen.getByText(/"stderr": "conflict"/)).toBeInTheDocument();
    expect(
      screen.getByText(/"stderr": "permission denied"/),
    ).toBeInTheDocument();
  });
});

describe("DialogFrame", () => {
  it("hides dismissal controls while the dialog is non-dismissible", () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <DialogFrame
        description="A request is still running."
        dismissible={false}
        onOpenChange={onOpenChange}
        title="Busy dialog"
      >
        <button type="button">Pending action</button>
      </DialogFrame>,
    );

    const dialog = screen.getByRole("dialog", { name: "Busy dialog" });
    expect(
      within(dialog).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it("lets only the topmost dialog handle Escape", () => {
    const onFirstOpenChange = vi.fn();
    const onSecondOpenChange = vi.fn();

    renderWithProviders(
      <>
        <DialogFrame
          description="First dialog"
          onOpenChange={onFirstOpenChange}
          title="First"
        >
          <button type="button">First action</button>
        </DialogFrame>
        <DialogFrame
          description="Second dialog"
          onOpenChange={onSecondOpenChange}
          title="Second"
        >
          <button type="button">Second action</button>
        </DialogFrame>
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onFirstOpenChange).not.toHaveBeenCalled();
    expect(onSecondOpenChange).toHaveBeenCalledWith(false);
  });

  it("announces new modal layers and only permits portals owned by the top dialog", () => {
    const onDialogOpened = vi.fn();
    window.addEventListener(dialogOpenedEventName, onDialogOpened);

    function PortalButtons() {
      const dialogOwnerId = useContext(DialogLayerContext);
      return createPortal(
        <>
          <button
            data-dialog-owner={dialogOwnerId ?? undefined}
            data-dialog-portal="true"
            type="button"
          >
            Owned portal action
          </button>
          <button
            data-dialog-owner="another-dialog"
            data-dialog-portal="true"
            type="button"
          >
            Foreign portal action
          </button>
        </>,
        document.body,
      );
    }

    try {
      renderWithProviders(
        <DialogFrame
          description="Layer ownership"
          onOpenChange={vi.fn()}
          title="Owned dialog"
        >
          <button type="button">Dialog action</button>
          <PortalButtons />
        </DialogFrame>,
      );

      expect(onDialogOpened).toHaveBeenCalledTimes(1);
      const ownedPortal = screen.getByRole("button", {
        name: "Owned portal action",
      });
      ownedPortal.focus();
      expect(ownedPortal).toHaveFocus();

      screen.getByRole("button", { name: "Foreign portal action" }).focus();
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    } finally {
      window.removeEventListener(dialogOpenedEventName, onDialogOpened);
    }
  });
});

describe("CrashDetailsDialog", () => {
  it("renders a restart action placeholder", () => {
    const onRestart = vi.fn();

    renderWithProviders(
      <CrashDetailsDialog
        crash="Renderer crashed"
        onOpenChange={vi.fn()}
        onRestart={onRestart}
        open
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reload window" }));

    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmDialog", () => {
  it("confirms, cancels, and closes with Escape", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();

    renderWithProviders(
      <ConfirmDialog
        description="Delete this branch?"
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
        open
        title="Confirm delete"
        variant="danger"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("announces progress while confirmation is busy", () => {
    renderWithProviders(
      <ConfirmDialog
        busy
        description="Delete this branch?"
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
        open
        title="Confirm delete"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Working...");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

function createAppError(): AppError {
  return {
    category: "unexpected",
    context: {
      operationId: null,
      operationName: "merge",
      repositoryPath: "/tmp/art-project",
      windowLabel: "main",
    },
    git: {
      command: ["git", "merge", "feature"],
      exitCode: 1,
      stderr: "conflict",
      stdout: "",
    },
    summary: "Merge failed",
  };
}
