import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import {
  cancelOperation,
  logPage,
  revertCommit,
  searchLog,
} from "@/lib/ipc/commands";
import type { CommitSummary, LogPageResponse } from "@/lib/ipc/generated";
import { createAppQueryClient } from "@/lib/query/client";
import {
  createWindowStore,
  type WindowStoreApi,
  type WindowStoreState,
} from "@/store/window-store";

import { resolveAvatarPresentation } from "./avatar";
import { HistoryWorkbench } from "./HistoryWorkbench";
import { attachGraphRows, createHistoryGraphBuilder } from "./history-data";
import { createMockHistorySearchSource, searchCommits } from "./history-search";
import { mockHistoryCommits, mockHistoryRows } from "./fixtures";
import { useIncrementalLogRows } from "./useIncrementalHistoryRows";

vi.mock("@/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc/commands")>();

  return {
    ...actual,
    cancelOperation: vi.fn(),
    logPage: vi.fn(),
    revertCommit: vi.fn(),
    searchLog: vi.fn(),
  };
});

const cancelOperationMock = vi.mocked(cancelOperation);
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
  cancelOperationMock.mockReset();
  cancelOperationMock.mockResolvedValue({ cancelled: true });
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

describe("history graph pagination", () => {
  it("preserves graph continuity when rows arrive in multiple pages", () => {
    const builder = createHistoryGraphBuilder();
    const pagedRows = [
      ...builder.append(mockHistoryCommits.slice(0, 2)),
      ...builder.append(mockHistoryCommits.slice(2)),
    ];

    expect(pagedRows).toEqual(attachGraphRows(mockHistoryCommits));
  });

  it("bounds graph lanes for commits with exceptionally many parents", () => {
    const rows = attachGraphRows([
      {
        ...mockHistoryCommits[0],
        id: "octopus-merge",
        parents: Array.from({ length: 1_000 }, (_, index) => `parent-${index}`),
        shortId: "octopus",
      },
    ]);
    const graph = rows[0].graph;

    expect(graph.laneCount).toBeLessThanOrEqual(6);
    expect(graph.lanesBefore).toHaveLength(1);
    expect(graph.lanesAfter).toHaveLength(6);
    expect(graph.segments.length).toBeLessThanOrEqual(6);
    expect(
      graph.segments.every(
        (segment) => segment.fromLane < 6 && segment.toLane < 6,
      ),
    ).toBe(true);
  });
});

describe("HistoryWorkbench", () => {
  it("does not show fixture rows while backend history is loading", () => {
    logPageMock.mockReturnValue(new Promise<never>(() => undefined));

    renderWithProviders(
      <HistoryWorkbench
        historyRepositoryPath="/repo/art"
        rows={mockHistoryRows}
      />,
    );

    expect(logPageMock).toHaveBeenCalledWith({
      after: null,
      limit: 200,
      operationId: expect.stringMatching(/^history-page-/),
      repositoryPath: "/repo/art",
    });
    expect(screen.queryByText("Merge color pipeline preview")).toBeNull();
    expect(screen.queryByText("Create initial scene layout")).toBeNull();
  });

  it("shows initial history errors with retry and the original details", async () => {
    vi.useRealTimers();
    const queryError = {
      operation: "git log",
      repositoryPath: "/repo/art",
      stderr: "fatal: bad object HEAD",
      summary: "Unable to load history",
    };
    logPageMock.mockRejectedValue(queryError);

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );

    const banner = await screen.findByTestId("history-load-error");
    expect(banner).toHaveTextContent("Could not load commit history.");
    expect(
      screen.queryByText("No commits match the current filters."),
    ).not.toBeInTheDocument();

    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);

    try {
      fireEvent.click(
        within(banner).getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails).toEqual([queryError]);
      expect(receivedDetails[0]).toBe(queryError);

      logPageMock.mockResolvedValue({ commits: [], nextAfter: null });
      fireEvent.click(
        within(banner).getByRole("button", { name: "Try again" }),
      );

      await waitFor(() => expect(logPageMock).toHaveBeenCalledTimes(2));
      expect(
        await screen.findByText("No commits match the current filters."),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("history-load-error")).toBeNull();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("uses the current time when no relative-time base is provided", () => {
    vi.setSystemTime(new Date("2026-07-08T05:12:00Z"));

    const { container } = renderWithProviders(
      <HistoryWorkbench rows={mockHistoryRows} />,
    );

    expect(
      container.querySelector('time[datetime="2026-07-07T05:12:00Z"]'),
    ).toHaveTextContent("yesterday");
  });

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
    expect(logPageMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("history-load-more")).toBeInTheDocument();
    expect(logPageMock).toHaveBeenCalledWith({
      after: null,
      limit: 200,
      operationId: expect.stringMatching(/^history-page-/),
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
    fireEvent.scroll(viewport, { target: { scrollTop: 370 } });

    await waitFor(() => {
      expect(logPageMock).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText("Loaded from the next backend page"),
    ).toBeInTheDocument();
  });

  it("keeps loaded commits visible when the next page fails and retries it", async () => {
    vi.useRealTimers();
    const firstPageCommit = createCommitSummary({
      oid: "1212121212121212121212121212121212121212",
      subject: "History already on screen",
      time: 1_783_488_000,
    });
    const recoveredCommit = createCommitSummary({
      oid: "3434343434343434343434343434343434343434",
      parent: firstPageCommit.oid,
      subject: "History page recovered",
      time: 1_783_487_000,
    });
    const queryError = {
      operation: "git log --skip=200",
      stderr: "fatal: unable to read tree",
      summary: "Unable to load more history",
    };
    logPageMock
      .mockResolvedValueOnce({
        commits: [firstPageCommit],
        nextAfter: "200",
      })
      .mockRejectedValueOnce(queryError)
      .mockResolvedValueOnce({
        commits: [recoveredCommit],
        nextAfter: null,
      });

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );

    expect(await screen.findByText("History already on screen")).toBeVisible();
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

    const banner = await screen.findByTestId("history-load-error");
    expect(banner).toHaveTextContent("Could not load more commits.");
    expect(screen.getByText("History already on screen")).toBeVisible();

    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);

    try {
      fireEvent.click(
        within(banner).getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails).toEqual([queryError]);

      fireEvent.click(
        within(banner).getByRole("button", { name: "Try again" }),
      );
      expect(await screen.findByText("History page recovered")).toBeVisible();
      expect(screen.queryByTestId("history-load-error")).toBeNull();
      expect(logPageMock).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
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
    expect(screen.getByText("commit message")).toBeInTheDocument();
    expect(screen.getByText("author")).toBeInTheDocument();
    expect(screen.getByText("file content")).toBeInTheDocument();
    expect(searchLogMock).toHaveBeenCalledWith({
      after: null,
      author: null,
      grep: "viewport",
      limit: 200,
      operationId: expect.stringMatching(/^history-search-message-/),
      pickaxe: null,
      repositoryPath: "/repo/art",
    });
    expect(searchLogMock).toHaveBeenCalledWith({
      after: null,
      author: "viewport",
      grep: null,
      limit: 200,
      operationId: expect.stringMatching(/^history-search-author-/),
      pickaxe: null,
      repositoryPath: "/repo/art",
    });
    expect(searchLogMock).toHaveBeenCalledWith({
      after: null,
      author: null,
      grep: null,
      limit: 200,
      operationId: expect.stringMatching(/^history-search-content-/),
      pickaxe: "viewport",
      repositoryPath: "/repo/art",
    });
  });

  it("shows backend search errors instead of an empty result", async () => {
    vi.useRealTimers();
    const queryError = {
      operation: "git log search",
      stderr: "fatal: search failed",
      summary: "Unable to search history",
    };
    logPageMock.mockResolvedValue({ commits: [], nextAfter: null });
    searchLogMock.mockRejectedValue(queryError);

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search history" }), {
      target: { value: "missing" },
    });

    const banner = await screen.findByTestId("history-load-error");
    expect(banner).toHaveTextContent("Could not search commit history.");
    expect(
      screen.queryByText("No commits match the current filters."),
    ).not.toBeInTheDocument();
    expect(searchLogMock).toHaveBeenCalledTimes(3);

    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);

    try {
      fireEvent.click(
        within(banner).getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails).toEqual([queryError]);

      searchLogMock.mockResolvedValue({ commits: [], nextAfter: null });
      fireEvent.click(
        within(banner).getByRole("button", { name: "Try again" }),
      );

      await waitFor(() => expect(searchLogMock).toHaveBeenCalledTimes(6));
      expect(screen.queryByTestId("history-load-error")).toBeNull();
      expect(
        await screen.findByText("No commits match the current filters."),
      ).toBeInTheDocument();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("cancels superseded backend searches and discards their results", async () => {
    vi.useRealTimers();
    logPageMock.mockResolvedValue({ commits: [], nextAfter: null });
    const oldResolvers: Array<(value: LogPageResponse) => void> = [];
    const oldOperationIds: string[] = [];
    const freshCommit = createCommitSummary({
      oid: "ffffffffffffffffffffffffffffffffffffffff",
      subject: "Newest search result",
      time: 1_783_499_000,
    });
    const staleCommit = createCommitSummary({
      oid: "9999999999999999999999999999999999999999",
      subject: "Outdated search result",
      time: 1_783_498_000,
    });
    searchLogMock.mockImplementation((request) => {
      if (
        request.grep === "old" ||
        request.author === "old" ||
        request.pickaxe === "old"
      ) {
        oldOperationIds.push(request.operationId ?? "");
        return new Promise((resolve) => {
          oldResolvers.push(resolve);
        });
      }
      return Promise.resolve({
        commits: request.grep === "new" ? [freshCommit] : [],
        nextAfter: null,
      });
    });

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );
    const search = screen.getByRole("textbox", { name: "Search history" });

    fireEvent.change(search, { target: { value: "old" } });
    await waitFor(() => {
      expect(oldResolvers).toHaveLength(3);
    });

    fireEvent.change(search, { target: { value: "new" } });
    expect(await screen.findByText("Newest search result")).toBeInTheDocument();
    await waitFor(() => {
      expect(cancelOperationMock).toHaveBeenCalledTimes(3);
    });
    expect(
      cancelOperationMock.mock.calls.map(([request]) => request.operationId),
    ).toEqual(expect.arrayContaining(oldOperationIds));

    await act(async () => {
      for (const resolve of oldResolvers) {
        resolve({ commits: [staleCommit], nextAfter: null });
      }
    });
    expect(screen.queryByText("Outdated search result")).toBeNull();
  });

  it("only derives graph rows for newly appended history pages", () => {
    const firstPage: LogPageResponse = {
      commits: [
        createCommitSummary({
          oid: "1111111111111111111111111111111111111111",
          subject: "First incremental commit",
          time: 1_783_488_000,
        }),
      ],
      nextAfter: "200",
    };
    const secondPage: LogPageResponse = {
      commits: [
        createCommitSummary({
          oid: "2222222222222222222222222222222222222222",
          parent: firstPage.commits[0].oid,
          subject: "Second incremental commit",
          time: 1_783_487_000,
        }),
      ],
      nextAfter: null,
    };
    const { result, rerender } = renderHook(
      ({ pages }) => useIncrementalLogRows(pages),
      { initialProps: { pages: [firstPage] } },
    );
    const rows = result.current.rows;
    const firstRow = result.current.rows[0];

    rerender({ pages: [firstPage, secondPage] });

    expect(result.current.changedFrom).toBe(1);
    expect(result.current.rows).toBe(rows);
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.rows[0]).toBe(firstRow);
  });

  it("keeps a bounded render window while navigating a large history", () => {
    const largeRows = Array.from({ length: 5_000 }, (_, index) => ({
      ...mockHistoryRows[0],
      commit: {
        ...mockHistoryRows[0].commit,
        id: `large-${index}`,
        message: `Commit ${index}`,
        shortId: `c${index}`,
      },
    }));
    renderWithProviders(<HistoryWorkbench rows={largeRows} />);

    expect(screen.getAllByTestId("history-commit-row").length).toBeLessThan(30);
    expect(
      Number(screen.getByTestId("history-graph-window").getAttribute("height")),
    ).toBeLessThan(2_000);

    const viewport = screen.getByTestId("history-scroll-viewport");
    fireEvent.scroll(viewport, { target: { scrollTop: 5_000 * 72 - 504 } });

    expect(screen.getByText("Commit 4999")).toBeInTheDocument();
    expect(screen.getAllByTestId("history-commit-row").length).toBeLessThan(30);
  });

  it("keeps the branch filter bounded with thousands of branches", async () => {
    const branches = Array.from({ length: 5_000 }, (_, index) => ({
      current: index === 0,
      name: `branch-${index}`,
    }));
    renderWithProviders(
      <HistoryWorkbench branches={branches} rows={mockHistoryRows} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Auto/ }));

    const viewport = screen.getByTestId("history-branch-filter-viewport");
    expect(
      within(viewport).getAllByTestId("history-branch-filter-option").length,
    ).toBeLessThan(30);

    fireEvent.scroll(viewport, {
      target: { scrollTop: 5_000 * 36 - 216 },
    });

    expect(screen.getByText("branch-4999")).toBeInTheDocument();
    expect(
      within(viewport).getAllByTestId("history-branch-filter-option").length,
    ).toBeLessThan(30);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search branches"), {
        target: { value: "branch-4999" },
      });
    });
    expect(
      within(viewport).getAllByTestId("history-branch-filter-option"),
    ).toHaveLength(1);
    const searchedOption = screen.getByRole("option", { name: "branch-4999" });
    expect(searchedOption).toBeVisible();
    fireEvent.click(searchedOption);
    expect(searchedOption).toHaveAttribute("aria-selected", "true");
  });

  it("bounds reference badges for a commit with thousands of refs", async () => {
    const refs = Array.from({ length: 5_000 }, (_, index) => ({
      name: index === 0 ? "main" : `branch-${index}`,
      type: "branch" as const,
    }));
    const row = {
      ...mockHistoryRows[0],
      commit: { ...mockHistoryRows[0].commit, refs },
    };

    renderWithProviders(<HistoryWorkbench rows={[row]} />);

    expect(screen.getAllByTestId("history-ref-badge")).toHaveLength(6);
    expect(screen.getByTestId("history-ref-overflow")).toHaveTextContent(
      "+4994",
    );

    fireEvent.click(screen.getByText(row.commit.message));
    fireEvent.click(
      screen.getByRole("button", { name: "5000 branches or tags" }),
    );
    expect(
      screen.getAllByTestId("history-detail-ref-item").length,
    ).toBeLessThan(30);

    await act(async () => {
      fireEvent.change(
        screen.getByRole("textbox", {
          name: "Search commit branches and tags",
        }),
        { target: { value: "branch-4999" } },
      );
    });
    expect(screen.getAllByTestId("history-detail-ref-item")).toHaveLength(1);
    expect(screen.getByText("branch-4999")).toBeInTheDocument();
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
    expect(screen.getByLabelText("File comparison")).toBeInTheDocument();
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
        "Existing commit history will remain unchanged.",
      ),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Revert commit" }),
      );
    });

    expect(revertCommitMock).toHaveBeenCalledWith({
      oid: "d4512aa7e8fb9ec3f93a545cb658f7de71f18291",
      operationId: expect.stringMatching(/^revert-commit-/),
      pushAfterRevert: true,
      repositoryPath: "/repo/art",
    });
    expect(
      screen.getByText(
        "Revert commit created: Revert: Refine branch filter interactions (abc1234).",
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
    const closeDetailsButtons = screen.getAllByRole("button", {
      name: "Close commit details",
    });
    expect(closeDetailsButtons).toHaveLength(2);
    for (const closeButton of closeDetailsButtons) {
      expect(closeButton).toBeDisabled();
      fireEvent.click(closeButton);
    }
    expect(
      screen.getByRole("heading", {
        name: "Refine branch filter interactions",
      }),
    ).toBeInTheDocument();

    await act(async () => {
      rejectRevert({ summary: "git revert failed" });
    });

    expect(screen.getByRole("alert")).toHaveTextContent("git revert failed");
    for (const closeButton of screen.getAllByRole("button", {
      name: "Close commit details",
    })) {
      expect(closeButton).toBeEnabled();
    }
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
      screen.getByText("Reverting merge commits isn't supported."),
    ).toBeInTheDocument();
    expect(revertCommitMock).not.toHaveBeenCalled();
  });

  it("disables revert while another repository write is running", () => {
    renderWithProviders(
      <HistoryWorkbench rows={mockHistoryRows} writeDisabled />,
      {
        initialWindowState: { activeRepositoryPath: "/repo/art" },
      },
    );

    fireEvent.click(screen.getByText("Refine branch filter interactions"));

    const revertButton = screen.getByRole("button", { name: "Revert commit" });
    expect(revertButton).toBeDisabled();
    fireEvent.click(revertButton);
    expect(
      screen.queryByRole("dialog", { name: "Revert this commit?" }),
    ).toBeNull();
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
