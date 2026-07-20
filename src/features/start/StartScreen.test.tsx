import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createI18n } from "@/i18n/i18n";
import {
  createWindowStore,
  WindowStoreProvider,
  type WindowStoreState,
} from "@/store/window-store";

import { StartScreen } from "./StartScreen";

const commandMocks = vi.hoisted(() => ({
  cancelPendingWindowExit: vi.fn(),
  cancelCloneRepository: vi.fn(),
  cancelOperation: vi.fn(),
  cloneRepository: vi.fn(),
  closeCurrentWindow: vi.fn(),
  openRepository: vi.fn(),
  openRepositoryWindow: vi.fn(),
  openLogDir: vi.fn(),
  probeRemoteRepository: vi.fn(),
  saveAppSettings: vi.fn(),
  setWindowCloseGuard: vi.fn(),
}));
const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));
const eventMocks = vi.hoisted(() => ({
  listeners: [] as Array<(event: { payload: unknown }) => void>,
  listenAppEvent: vi.fn(
    async (_name: string, handler: (event: { payload: unknown }) => void) => {
      eventMocks.listeners.push(handler);
      return () => {
        eventMocks.listeners = eventMocks.listeners.filter(
          (listener) => listener !== handler,
        );
      };
    },
  ),
}));

vi.mock("@/lib/ipc/commands", () => commandMocks);
vi.mock("@/lib/ipc/events", () => ({
  listenAppEvent: eventMocks.listenAppEvent,
}));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);

const tauriEventListeners = new Map<
  string,
  (event: { payload: unknown }) => void
>();

function renderWithStore(
  ui: ReactElement,
  initialState?: Partial<WindowStoreState>,
) {
  const store = createWindowStore(initialState);

  render(
    <I18nextProvider i18n={createI18n("en")}>
      <WindowStoreProvider enableRealtimeEvents={false} store={store}>
        {ui}
      </WindowStoreProvider>
    </I18nextProvider>,
  );

  return store;
}

async function emitWindowCloseBlocked(payload: unknown) {
  await waitFor(() =>
    expect(tauriEventListeners.has("window-close-blocked")).toBe(true),
  );
  await act(async () => {
    tauriEventListeners.get("window-close-blocked")?.({ payload });
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  tauriEventListeners.clear();
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    tauriEventListeners.set(
      event,
      handler as (event: { payload: unknown }) => void,
    );
    return () => undefined;
  });
  eventMocks.listeners = [];
  commandMocks.cancelPendingWindowExit.mockResolvedValue(undefined);
  commandMocks.cancelOperation.mockResolvedValue({ cancelled: true });
  commandMocks.closeCurrentWindow.mockResolvedValue(undefined);
  commandMocks.setWindowCloseGuard.mockResolvedValue(undefined);
  dialogMocks.open.mockResolvedValue("/projects");
  commandMocks.saveAppSettings.mockImplementation(
    async ({ settings }) => settings,
  );
  commandMocks.openRepositoryWindow.mockImplementation(
    async ({ repositoryPath }) => ({
      action: "useCurrent",
      label: "main",
      repositoryPath,
    }),
  );
  commandMocks.probeRemoteRepository.mockResolvedValue({
    branches: ["develop", "main"],
    defaultBranch: "main",
    isEmpty: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StartScreen open repository close guard", () => {
  it("guards an in-flight repository open as wait-only on close requests", async () => {
    commandMocks.openRepository.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderWithStore(<StartScreen />);

    chooseRepositoryDirectory();

    expect(dialogMocks.open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Choose a Git repository root folder",
    });
    await waitFor(() =>
      expect(commandMocks.openRepository).toHaveBeenCalledWith({
        path: "/selected/art-project",
        toolIdentity: null,
      }),
    );
    await waitFor(() =>
      expect(commandMocks.setWindowCloseGuard).toHaveBeenCalledWith({
        active: true,
      }),
    );

    await emitWindowCloseBlocked({ reason: "closeWindow" });
    const dialog = await screen.findByRole("dialog", {
      name: "Close window?",
    });
    expect(dialog).toHaveTextContent(
      "This operation cannot be safely canceled yet. Wait for it to finish, then close again.",
    );
    expect(
      within(dialog).queryByRole("button", { name: "Close and recover" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep waiting" }),
    );

    expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();
    expect(commandMocks.cancelCloneRepository).not.toHaveBeenCalled();
  });

  it("cancels pending app quit when a repository open must keep waiting", async () => {
    commandMocks.openRepository.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderWithStore(<StartScreen />);

    chooseRepositoryDirectory();
    await waitFor(() =>
      expect(commandMocks.setWindowCloseGuard).toHaveBeenCalledWith({
        active: true,
      }),
    );
    await emitWindowCloseBlocked({ reason: "quit" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Keep waiting" }),
    );

    expect(commandMocks.cancelPendingWindowExit).toHaveBeenCalledTimes(1);
    expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();
  });

  it("does nothing when repository folder selection is cancelled", async () => {
    dialogMocks.open.mockResolvedValueOnce(null);
    renderWithStore(<StartScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));

    await waitFor(() => expect(dialogMocks.open).toHaveBeenCalledTimes(1));
    expect(commandMocks.openRepository).not.toHaveBeenCalled();
  });

  it("prevents duplicate repository folder pickers", async () => {
    let resolvePicker: (path: string | null) => void = () => undefined;
    dialogMocks.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve;
        }),
    );
    renderWithStore(<StartScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    act(() => {
      window.dispatchEvent(new Event("artistic-git:open-project"));
      window.dispatchEvent(new Event("artistic-git:clone-project"));
    });

    expect(dialogMocks.open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Open Project" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Clone Project" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("dialog", { name: "Clone Project" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolvePicker(null);
    });
    expect(screen.getByRole("button", { name: "Open Project" })).toBeEnabled();
  });

  it("reports repository folder picker errors without losing details", async () => {
    const pickerError = new Error("native folder picker unavailable");
    const handleAppError = vi.fn();
    dialogMocks.open.mockRejectedValueOnce(pickerError);
    window.addEventListener("artistic-git:error", handleAppError);
    renderWithStore(<StartScreen />);

    try {
      fireEvent.click(screen.getByRole("button", { name: "Open Project" }));

      await waitFor(() => expect(handleAppError).toHaveBeenCalledTimes(1));
      expect((handleAppError.mock.calls[0][0] as CustomEvent).detail).toBe(
        pickerError,
      );
    } finally {
      window.removeEventListener("artistic-git:error", handleAppError);
    }
  });

  it("uses the native repository folder picker from the app menu", async () => {
    commandMocks.openRepository.mockImplementation(
      () => new Promise(() => undefined),
    );
    dialogMocks.open.mockResolvedValueOnce("/projects/menu-repository");
    renderWithStore(<StartScreen />);

    act(() => {
      window.dispatchEvent(new Event("artistic-git:open-project"));
    });

    await waitFor(() =>
      expect(commandMocks.openRepository).toHaveBeenCalledWith({
        path: "/projects/menu-repository",
        toolIdentity: null,
      }),
    );
  });
});

describe("StartScreen clone flow", () => {
  it("shows automatic repository checking before the debounce elapses", async () => {
    vi.useFakeTimers();
    try {
      renderWithStore(<StartScreen />);
      fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
      const dialog = screen.getByRole("dialog", { name: "Clone Project" });

      fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
        target: { value: "https://example.test/studio/project.git" },
      });

      expect(
        within(dialog).getByText("Checking repository and branches..."),
      ).toBeInTheDocument();
      expect(commandMocks.probeRemoteRepository).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(399);
      });
      expect(commandMocks.probeRemoteRepository).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(commandMocks.probeRemoteRepository).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("infers the directory name and opens the cloned repository", async () => {
    commandMocks.cloneRepository.mockResolvedValue({
      repository: openRepositoryResponse("/projects/art-project"),
    });
    const store = renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));

    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    await enterCloneUrl(dialog, "https://github.com/studio/art-project.git");

    expect(within(dialog).getByLabelText("Project folder name")).toHaveValue(
      "art-project",
    );
    expect(within(dialog).getByLabelText("Branch to clone")).toHaveValue(
      "main",
    );
    fireEvent.change(within(dialog).getByLabelText("Branch to clone"), {
      target: { value: "develop" },
    });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clone Project" }),
    );

    await waitFor(() => {
      expect(commandMocks.cloneRepository).toHaveBeenCalledWith({
        branchName: "develop",
        directoryName: "art-project",
        operationId: expect.stringMatching(/^clone-/),
        targetParentDirectory: "/projects",
        toolIdentity: null,
        url: "https://github.com/studio/art-project.git",
      });
    });
    await waitFor(() => {
      expect(store.getState().activeRepositoryPath).toBe(
        "/projects/art-project",
      );
    });
    expect(store.getState().recentProjects[0]).toMatchObject({
      displayName: "art-project",
      path: "/projects/art-project",
    });
    expect(
      window.localStorage.getItem("artistic-git:last-clone-parent-dir"),
    ).toBe("/projects");
    expect(
      screen.queryByRole("dialog", { name: "Clone Project" }),
    ).not.toBeInTheDocument();
  });

  it("shows clone errors inside the dialog", async () => {
    commandMocks.cloneRepository.mockRejectedValue({
      summary: "target directory already exists",
    });
    const store = renderWithStore(<StartScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));

    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    await enterCloneUrl(dialog, "git@github.com:studio/art.git");
    fireEvent.change(within(dialog).getByLabelText("Branch to clone"), {
      target: { value: "develop" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Save in")).toHaveValue("/projects");
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clone Project" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "target directory already exists",
    );
    expect(within(dialog).getByLabelText("Branch to clone")).toHaveValue(
      "develop",
    );
    expect(commandMocks.probeRemoteRepository).toHaveBeenCalledTimes(1);
    expect(store.getState().activeRepositoryPath).toBeNull();
  });

  it("retries repository detection interactively after an access error", async () => {
    const probeError = structuredAppError("authentication required");
    commandMocks.probeRemoteRepository
      .mockRejectedValueOnce(probeError)
      .mockResolvedValueOnce({
        branches: ["main"],
        defaultBranch: "main",
        isEmpty: false,
      });
    renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "https://github.com/studio/private.git" },
    });

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Couldn't access this repository. Check the address and your access, then try again.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show technical details" }),
    );
    const errorDialog = screen.getByRole("dialog", { name: "Error Details" });
    expect(
      screen.queryByRole("dialog", { name: "Clone Project" }),
    ).not.toBeInTheDocument();
    expect(errorDialog).toHaveTextContent("authentication required");
    fireEvent.click(
      within(errorDialog).getByRole("button", {
        name: "Show technical details",
      }),
    );
    expect(errorDialog).toHaveTextContent("fatal: authentication failed");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Error Details" }),
      ).not.toBeInTheDocument();
    });
    const restoredDialog = screen.getByRole("dialog", {
      name: "Clone Project",
    });
    expect(within(restoredDialog).getByLabelText("Repository URL")).toHaveValue(
      "https://github.com/studio/private.git",
    );
    expect(
      within(restoredDialog).getByRole("button", {
        name: "Show technical details",
      }),
    ).toHaveFocus();
    fireEvent.click(
      within(restoredDialog).getByRole("button", { name: "Check again" }),
    );
    expect(
      within(restoredDialog).getByLabelText("Repository URL"),
    ).toHaveFocus();

    await waitFor(() => {
      expect(commandMocks.probeRemoteRepository).toHaveBeenLastCalledWith({
        interactive: true,
        operationId: expect.stringMatching(/^clone-probe-/),
        url: "https://github.com/studio/private.git",
      });
    });
    expect(
      await within(restoredDialog).findByLabelText("Branch to clone"),
    ).toHaveValue("main");
  });

  it("keeps the detected branch when clone is requested again from the menu", async () => {
    renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    await enterCloneUrl(dialog, "https://github.com/studio/art-project.git");
    fireEvent.change(within(dialog).getByLabelText("Branch to clone"), {
      target: { value: "develop" },
    });

    act(() => {
      window.dispatchEvent(new Event("artistic-git:clone-project"));
    });

    expect(within(dialog).getByLabelText("Branch to clone")).toHaveValue(
      "develop",
    );
    expect(commandMocks.probeRemoteRepository).toHaveBeenCalledTimes(1);
  });

  it("allows cloning an empty repository without a branch", async () => {
    commandMocks.probeRemoteRepository.mockResolvedValue({
      branches: [],
      defaultBranch: null,
      isEmpty: true,
    });
    commandMocks.cloneRepository.mockResolvedValue({
      repository: openRepositoryResponse("/projects/empty"),
    });
    renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "https://github.com/studio/empty.git" },
    });

    expect(
      await within(dialog).findByText(
        "Repository found. No branches are available yet.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("Branch to clone"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clone Project" }),
    );

    await waitFor(() => {
      expect(commandMocks.cloneRepository).toHaveBeenCalledWith(
        expect.objectContaining({ branchName: null }),
      );
    });
  });

  it("cancels stale detection and ignores its late result", async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    commandMocks.probeRemoteRepository
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        branches: ["release"],
        defaultBranch: "release",
        isEmpty: false,
      });
    renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "https://example.test/old.git" },
    });
    await waitFor(() =>
      expect(commandMocks.probeRemoteRepository).toHaveBeenCalledTimes(1),
    );
    const staleOperationId =
      commandMocks.probeRemoteRepository.mock.calls[0][0].operationId;

    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "https://example.test/new.git" },
    });
    await waitFor(() => {
      expect(commandMocks.cancelOperation).toHaveBeenCalledWith({
        operationId: staleOperationId,
      });
    });
    expect(await within(dialog).findByLabelText("Branch to clone")).toHaveValue(
      "release",
    );

    await act(async () => {
      resolveFirst({
        branches: ["old"],
        defaultBranch: "old",
        isEmpty: false,
      });
    });
    expect(within(dialog).getByLabelText("Branch to clone")).toHaveValue(
      "release",
    );
  });

  it("shows clone progress events in the dialog", async () => {
    let resolveClone: (value: unknown) => void = () => undefined;
    commandMocks.cloneRepository.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClone = resolve;
        }),
    );
    renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    await enterCloneUrl(dialog, "https://github.com/studio/art-project.git");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clone Project" }),
    );

    await waitFor(() => expect(eventMocks.listeners).toHaveLength(1));
    const request = commandMocks.cloneRepository.mock.calls[0][0];
    eventMocks.listeners[0]({
      payload: {
        cancellable: true,
        label: "Downloading LFS objects",
        operationId: request.operationId,
        progress: { kind: "percent", value: 42 },
      },
    });

    expect(
      await within(dialog).findByText("Downloading LFS objects"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("42%")).toBeInTheDocument();

    resolveClone({
      repository: openRepositoryResponse("/projects/art-project"),
    });
  });

  it("confirms and cancels an in-flight clone", async () => {
    commandMocks.cancelCloneRepository.mockResolvedValue({ cancelled: true });
    commandMocks.cloneRepository.mockImplementation(
      () => new Promise(() => undefined),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    await enterCloneUrl(dialog, "https://github.com/studio/art-project.git");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clone Project" }),
    );
    await waitFor(() => {
      expect(commandMocks.cloneRepository).toHaveBeenCalled();
    });

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Cancel clone" }),
    );

    await waitFor(() => {
      expect(commandMocks.cancelCloneRepository).toHaveBeenCalledWith({
        operationId: commandMocks.cloneRepository.mock.calls[0][0].operationId,
      });
    });
  });

  it("cancels an in-flight clone before closing a guarded window", async () => {
    commandMocks.cancelCloneRepository.mockResolvedValue({ cancelled: true });
    commandMocks.cloneRepository.mockImplementation(
      () => new Promise(() => undefined),
    );
    const confirmSpy = vi.spyOn(window, "confirm");
    renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
    const cloneDialog = screen.getByRole("dialog", { name: "Clone Project" });
    await enterCloneUrl(
      cloneDialog,
      "https://github.com/studio/art-project.git",
    );
    fireEvent.click(
      within(cloneDialog).getByRole("button", { name: "Clone Project" }),
    );
    await waitFor(() =>
      expect(commandMocks.setWindowCloseGuard).toHaveBeenCalledWith({
        active: true,
      }),
    );

    await emitWindowCloseBlocked({ reason: "closeWindow" });
    const closeDialog = await screen.findByRole("dialog", {
      name: "Close window?",
    });
    expect(closeDialog).toHaveTextContent(
      "An operation is in progress. Closing will cancel it and restore the pre-operation state.",
    );
    fireEvent.click(
      within(closeDialog).getByRole("button", { name: "Close and recover" }),
    );

    await waitFor(() =>
      expect(commandMocks.cancelCloneRepository).toHaveBeenCalledWith({
        operationId: commandMocks.cloneRepository.mock.calls[0][0].operationId,
      }),
    );
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("cancels pending app quit when a guarded clone close prompt is dismissed", async () => {
    commandMocks.cloneRepository.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));
    const cloneDialog = screen.getByRole("dialog", { name: "Clone Project" });
    await enterCloneUrl(
      cloneDialog,
      "https://github.com/studio/art-project.git",
    );
    fireEvent.click(
      within(cloneDialog).getByRole("button", { name: "Clone Project" }),
    );

    await emitWindowCloseBlocked({ reason: "quit" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Cancel" }),
    );

    expect(commandMocks.cancelPendingWindowExit).toHaveBeenCalledTimes(1);
    expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();
  });
});

function openRepositoryResponse(repositoryPath: string) {
  return {
    gitDir: `${repositoryPath}/.git`,
    health: {
      head: { kind: "branch", name: "main", oid: "abc1234" },
      indexLock: null,
      middleStates: [],
    },
    remoteMode: "origin",
    remotes: [
      {
        isOrigin: true,
        managed: true,
        name: "origin",
        url: "https://github.com/studio/art-project.git",
      },
    ],
    repositoryPath,
    summary: {
      currentBranch: "main",
      hasOrigin: true,
      headOid: "abc1234",
      inProgress: false,
      isDetached: false,
      isUnborn: false,
      remoteMode: "origin",
      repositoryPath,
    },
    warnings: [],
  };
}

function structuredAppError(summary: string) {
  return {
    category: "expected",
    context: {
      operationId: "clone-probe-test",
      operationName: "probeRemoteRepository",
      repositoryPath: null,
      windowLabel: "main",
    },
    git: {
      command: ["git", "ls-remote", "--", "[REDACTED]"],
      exitCode: 128,
      stderr: "fatal: authentication failed",
      stdout: "",
    },
    summary,
  };
}

async function enterCloneUrl(dialog: HTMLElement, url: string) {
  fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
    target: { value: url },
  });
  expect(
    within(dialog).getByText("Checking repository and branches..."),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(commandMocks.probeRemoteRepository).toHaveBeenLastCalledWith({
      interactive: false,
      operationId: expect.stringMatching(/^clone-probe-/),
      url,
    });
  });
  await within(dialog).findByLabelText("Branch to clone");
}

function chooseRepositoryDirectory(path = "/selected/art-project") {
  dialogMocks.open.mockResolvedValueOnce(path);
  fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
}
