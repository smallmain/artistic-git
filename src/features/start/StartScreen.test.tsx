import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
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
  cloneRepository: vi.fn(),
  openRepository: vi.fn(),
  saveAppSettings: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => commandMocks);

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

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  commandMocks.saveAppSettings.mockImplementation(
    async ({ settings }) => settings,
  );
});

afterEach(() => {
  cleanup();
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
    fireEvent.change(within(dialog).getByLabelText("Target parent directory"), {
      target: { value: "/projects" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clone Project" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "target directory already exists",
    );
    expect(store.getState().activeRepositoryPath).toBeNull();
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
