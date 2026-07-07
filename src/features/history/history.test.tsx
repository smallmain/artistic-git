import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { logPage, revertCommit, searchLog } from "@/lib/ipc/commands";
import type { CommitSummary } from "@/lib/ipc/generated";
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
    logPage: vi.fn(),
    revertCommit: vi.fn(),
    searchLog: vi.fn(),
  };
});

const logPageMock = vi.mocked(logPage);
const revertCommitMock = vi.mocked(revertCommit);
const searchLogMock = vi.mocked(searchLog);

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
  logPageMock.mockReset();
  revertCommitMock.mockReset();
  searchLogMock.mockReset();
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
  it("loads repository history pages when scrolling near the end", async () => {
    vi.useRealTimers();
    const firstPageCommit = createCommitSummary({
      oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      subject: "Initial backend history page",
      time: 1_783_488_000,
    });
    const secondPageCommit = createCommitSummary({
      oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      parent: firstPageCommit.oid,
      subject: "Loaded from the next backend page",
      time: 1_783_491_600,
    });
    logPageMock
      .mockResolvedValueOnce({
        commits: [firstPageCommit],
        nextAfter: "200",
      })
      .mockResolvedValueOnce({
        commits: [secondPageCommit],
        nextAfter: null,
      });

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );

    expect(
      await screen.findByText("Initial backend history page"),
    ).toBeInTheDocument();
    expect(logPageMock).toHaveBeenCalledWith({
      after: null,
      limit: 200,
      repositoryPath: "/repo/art",
    });

    const viewport = screen.getByTestId("history-scroll-viewport");
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 504,
    });
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 900,
    });

    fireEvent.scroll(viewport, { target: { scrollTop: 360 } });

    await waitFor(() => {
      expect(logPageMock).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText("Loaded from the next backend page"),
    ).toBeInTheDocument();
  });

  it("merges backend message, author, and content search results", async () => {
    vi.useRealTimers();
    logPageMock.mockResolvedValue({ commits: [], nextAfter: null });
    const messageCommit = createCommitSummary({
      oid: "cccccccccccccccccccccccccccccccccccccccc",
      subject: "Viewport search message",
      time: 1_783_488_000,
    });
    const authorCommit = createCommitSummary({
      author: "Viewport Artist",
      oid: "dddddddddddddddddddddddddddddddddddddddd",
      subject: "Author match",
      time: 1_783_491_600,
    });
    const contentCommit = createCommitSummary({
      oid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      subject: "Content match",
      time: 1_783_495_200,
    });
    searchLogMock.mockImplementation((request) => {
      if (request.grep) {
        return Promise.resolve({ commits: [messageCommit], nextAfter: null });
      }
      if (request.author) {
        return Promise.resolve({ commits: [authorCommit], nextAfter: null });
      }
      if (request.pickaxe) {
        return Promise.resolve({ commits: [contentCommit], nextAfter: null });
      }
      return Promise.resolve({ commits: [], nextAfter: null });
    });

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search history" }), {
      target: { value: "viewport" },
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 230));
    });

    expect(
      await screen.findByText("Viewport search message"),
    ).toBeInTheDocument();
    expect(screen.getByText("Author match")).toBeInTheDocument();
    expect(screen.getByText("Content match")).toBeInTheDocument();
    expect(screen.getByText("message")).toBeInTheDocument();
    expect(screen.getByText("author")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(searchLogMock).toHaveBeenCalledWith({
      after: null,
      author: null,
      grep: "viewport",
      limit: 200,
      pickaxe: null,
      repositoryPath: "/repo/art",
    });
    expect(searchLogMock).toHaveBeenCalledWith({
      after: null,
      author: "viewport",
      grep: null,
      limit: 200,
      pickaxe: null,
      repositoryPath: "/repo/art",
    });
    expect(searchLogMock).toHaveBeenCalledWith({
      after: null,
      author: null,
      grep: null,
      limit: 200,
      pickaxe: "viewport",
      repositoryPath: "/repo/art",
    });
  });

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
      pushed: false,
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
      within(dialog).getByRole("checkbox", { name: "Push immediately" }),
    ).toBeChecked();
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
      pushAfterRevert: true,
      repositoryPath: "/repo/art",
    });
    expect(
      screen.getByText(
        "Created Revert: Refine branch filter interactions at abc1234.",
      ),
    ).toBeInTheDocument();
  });

  it("stores conflicted revert responses for the existing conflict overlay", async () => {
    const onRevertAutoStash = vi.fn();
    revertCommitMock.mockResolvedValue({
      autoStash: {
        branch: "main",
        createdAtUnixSeconds: "1783488000",
        index: 0,
        isAutoStash: true,
        message: "Auto Stash: before reverting commit",
        origin: null,
        oid: "stash-oid",
        selector: "stash@{0}",
      },
      conflict: {
        files: [
          { fileKind: "text", path: "src/main.ts", status: "unresolved" },
        ],
        operationId: "op-revert",
        operationName: "revertCommit",
        repositoryPath: "/repo/art",
      },
      stashRecovery: null,
      status: "conflicted",
    });
    const { windowStore } = renderWithProviders(
      <HistoryWorkbench
        onRevertAutoStash={onRevertAutoStash}
        rows={mockHistoryRows}
      />,
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
    expect(onRevertAutoStash).toHaveBeenCalledWith(
      "op-revert",
      expect.objectContaining({ selector: "stash@{0}" }),
    );
  });

  it("hides the immediate push checkbox without a remote", () => {
    renderWithProviders(
      <HistoryWorkbench hasRemote={false} rows={mockHistoryRows} />,
      {
        initialWindowState: { activeRepositoryPath: "/repo/art" },
      },
    );

    fireEvent.click(screen.getByText("Refine branch filter interactions"));
    fireEvent.click(screen.getByRole("button", { name: "Revert commit" }));

    expect(
      screen.queryByRole("checkbox", { name: "Push immediately" }),
    ).not.toBeInTheDocument();
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

function createCommitSummary({
  author = "Mira Chen",
  oid,
  parent,
  subject,
  time,
}: {
  author?: string;
  oid: string;
  parent?: string;
  subject: string;
  time: number;
}): CommitSummary {
  return {
    authorEmail: "mira@example.test",
    authorName: author,
    authoredAtUnixSeconds: String(time),
    oid,
    parents: parent ? [parent] : [],
    refs: [],
    subject,
  };
}
