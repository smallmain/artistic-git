import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { revertCommit } from "@/lib/ipc/commands";
import { createAppQueryClient } from "@/lib/query/client";
import {
  createWindowStore,
  type WindowStoreApi,
  type WindowStoreState,
} from "@/store/window-store";

import { resolveAvatarPresentation } from "./avatar";
import { HistoryWorkbench } from "./HistoryWorkbench";
import { createMockHistorySearchSource, searchCommits } from "./history-search";
import { mockHistoryCommits, mockHistoryRows } from "./fixtures";

vi.mock("@/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc/commands")>();

  return {
    ...actual,
    revertCommit: vi.fn(),
  };
});

const revertCommitMock = vi.mocked(revertCommit);

function renderWithProviders(
  ui: ReactElement,
  options: {
    initialWindowState?: Partial<WindowStoreState>;
    windowStore?: WindowStoreApi;
  } = {},
) {
  const windowStore =
    options.windowStore ?? createWindowStore(options.initialWindowState);

  return {
    windowStore,
    ...render(
      <AppProviders
        i18n={createI18n("en")}
        initialLanguagePreference="en"
        initialThemePreference="light"
        queryClient={createAppQueryClient()}
        windowStore={windowStore}
      >
        {ui}
      </AppProviders>,
    ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  revertCommitMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("history search", () => {
  it("merges message, author, and content matches without duplicates", () => {
    const results = searchCommits(mockHistoryCommits, "history");

    expect(results.map((commit) => commit.shortId)).toEqual([
      "8b43f0e",
      "71cfb9a",
      "d4512aa",
      "6df1253",
    ]);
    expect(results[0].searchMatches).toEqual(["message", "content"]);
  });

  it("cancels an in-flight search request", async () => {
    const source = createMockHistorySearchSource(mockHistoryCommits, 500);
    const controller = new AbortController();
    const promise = source("history", controller.signal);

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("history avatars", () => {
  it("does not create a remote Gravatar URL by default", () => {
    const avatar = resolveAvatarPresentation({
      email: "mira@example.test",
      name: "Mira Chen",
    });

    expect(avatar.initials).toBe("MC");
    expect(avatar.remoteUrl).toBeNull();
  });
});

describe("HistoryWorkbench", () => {
  it("filters branches and opens the commit detail panel", () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

    expect(
      screen.getByText("Merge color pipeline preview"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Auto/ }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(
      screen.getByText("Tag release candidate assets"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Tag release candidate assets"));
    expect(screen.getByText("Copy hash")).toBeInTheDocument();
    expect(screen.getByLabelText("Diff viewer")).toBeInTheDocument();
  });

  it("debounces search, shows loading, and renders de-duplicated results", async () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

    fireEvent.click(screen.getByRole("button", { name: /Auto/ }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Search history" }), {
      target: { value: "viewport" },
    });

    await act(async () => {
      vi.advanceTimersByTime(230);
    });
    expect(
      screen.getByText("Merge color pipeline preview"),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    expect(screen.queryByText("Merge color pipeline preview")).toBeNull();
    expect(
      screen.getByText("Add lightweight graph viewport"),
    ).toBeInTheDocument();
  });

  it("confirms and calls revertCommit for a selected commit", async () => {
    revertCommitMock.mockResolvedValue({
      message: "Revert: Refine branch filter interactions",
      oid: "abc123456789",
      status: "reverted",
    });

    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />, {
      initialWindowState: { activeRepositoryPath: "/repo/art" },
    });

    fireEvent.click(screen.getByText("Refine branch filter interactions"));
    fireEvent.click(screen.getByRole("button", { name: "Revert commit" }));

    const dialog = screen.getByRole("dialog", {
      name: "Revert this commit?",
    });
    expect(
      within(dialog).getByText(
        "Create a new commit that reverses d4512aa: Refine branch filter interactions.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "New commit message: Revert: Refine branch filter interactions",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "This uses git revert and does not rewrite history.",
      ),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Revert commit" }),
      );
    });

    expect(revertCommitMock).toHaveBeenCalledWith({
      oid: "d4512aa7e8fb9ec3f93a545cb658f7de71f18291",
      repositoryPath: "/repo/art",
    });
    expect(
      screen.getByText(
        "Created Revert: Refine branch filter interactions at abc1234.",
      ),
    ).toBeInTheDocument();
  });

  it("stores conflicted revert responses for the existing conflict overlay", async () => {
    revertCommitMock.mockResolvedValue({
      files: [{ fileKind: "text", path: "src/main.ts", status: "unresolved" }],
      operationId: "op-revert",
      status: "conflicted",
    });
    const { windowStore } = renderWithProviders(
      <HistoryWorkbench rows={mockHistoryRows} />,
      {
        initialWindowState: { activeRepositoryPath: "/repo/art" },
      },
    );

    fireEvent.click(screen.getByText("Refine branch filter interactions"));
    fireEvent.click(screen.getByRole("button", { name: "Revert commit" }));

    await act(async () => {
      fireEvent.click(
        within(
          screen.getByRole("dialog", { name: "Revert this commit?" }),
        ).getByRole("button", { name: "Revert commit" }),
      );
    });

    expect(
      windowStore.getState().conflictsByRepository["/repo/art"],
    ).toMatchObject({
      files: [{ path: "src/main.ts", status: "unresolved" }],
      operationId: "op-revert",
      operationName: "revertCommit",
      repositoryPath: "/repo/art",
    });
  });

  it("shows backend disabled reasons without closing the confirmation dialog", async () => {
    revertCommitMock.mockResolvedValue({
      reason: "notOnCurrentBranch",
      status: "disabled",
    });

    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />, {
      initialWindowState: { activeRepositoryPath: "/repo/art" },
    });

    fireEvent.click(screen.getByText("Refine branch filter interactions"));
    fireEvent.click(screen.getByRole("button", { name: "Revert commit" }));

    await act(async () => {
      fireEvent.click(
        within(
          screen.getByRole("dialog", { name: "Revert this commit?" }),
        ).getByRole("button", { name: "Revert commit" }),
      );
    });

    expect(
      screen.getByText(
        "Switch to the branch containing this commit before reverting it.",
      ),
    ).toBeInTheDocument();
  });

  it("shows busy and error states while reverting", async () => {
    let rejectRevert!: (reason: unknown) => void;
    revertCommitMock.mockReturnValue(
      new Promise((_, reject) => {
        rejectRevert = reject;
      }),
    );

    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />, {
      initialWindowState: { activeRepositoryPath: "/repo/art" },
    });

    fireEvent.click(screen.getByText("Refine branch filter interactions"));
    fireEvent.click(screen.getByRole("button", { name: "Revert commit" }));

    const dialog = screen.getByRole("dialog", {
      name: "Revert this commit?",
    });
    const confirmButton = within(dialog).getByRole("button", {
      name: "Revert commit",
    });

    await act(async () => {
      fireEvent.click(confirmButton);
    });

    expect(screen.getByText("Reverting...")).toBeInTheDocument();
    expect(confirmButton).toBeDisabled();

    await act(async () => {
      rejectRevert({ summary: "git revert failed" });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("git revert failed");
  });

  it("disables reverting merge commits before calling IPC", () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />, {
      initialWindowState: { activeRepositoryPath: "/repo/art" },
    });

    fireEvent.click(screen.getByText("Merge color pipeline preview"));

    expect(
      screen.getByRole("button", { name: "Revert commit" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Merge commits cannot be reverted."),
    ).toBeInTheDocument();
    expect(revertCommitMock).not.toHaveBeenCalled();
  });
});
