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
  cloneRepository: vi.fn(),
  closeCurrentWindow: vi.fn(),
  openRepository: vi.fn(),
  openRepositoryWindow: vi.fn(),
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
    await emitWindowCloseBlocked({ reason: "quit" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Keep waiting" }),
    );

    expect(commandMocks.cancelPendingWindowExit).toHaveBeenCalledTimes(1);
    expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();
  });
});

describe("StartScreen clone flow", () => {
  it("infers the directory name and opens the cloned repository", async () => {
    commandMocks.cloneRepository.mockResolvedValue({
      repository: openRepositoryResponse("/projects/art-project"),
    });
    const store = renderWithStore(<StartScreen />, {
      appSettings: { paths: { lastCloneParentDir: "/projects" } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone Project" }));

    const dialog = screen.getByRole("dialog", { name: "Clone Project" });
    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "https://github.com/studio/art-project.git" },
    });

    expect(within(dialog).getByLabelText("Directory name")).toHaveValue(
      "art-project",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clone Project" }),
    );

    await waitFor(() => {
      expect(commandMocks.cloneRepository).toHaveBeenCalledWith({
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
    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "git@github.com:studio/art.git" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Target parent directory"),
      ).toHaveValue("/projects");
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clone Project" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "target directory already exists",
    );
    expect(store.getState().activeRepositoryPath).toBeNull();
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
    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "https://github.com/studio/art-project.git" },
    });
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
    fireEvent.change(within(dialog).getByLabelText("Repository URL"), {
      target: { value: "https://github.com/studio/art-project.git" },
    });
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
    fireEvent.change(within(cloneDialog).getByLabelText("Repository URL"), {
      target: { value: "https://github.com/studio/art-project.git" },
    });
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
    fireEvent.change(within(cloneDialog).getByLabelText("Repository URL"), {
      target: { value: "https://github.com/studio/art-project.git" },
    });
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

function chooseRepositoryDirectory(relativePath = "art-project/.git/config") {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  const file = new File([""], "config");
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: relativePath,
  });

  fireEvent.change(input!, { target: { files: [file] } });
}
