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
  commitDetails,
  commitFileDetail,
  logPage,
  revertCommit,
  searchLog,
} from "@/lib/ipc/commands";
import type {
  CommitDetailsResponse,
  CommitFileDetailResponse,
  CommitSummary,
  LogPageResponse,
} from "@/lib/ipc/generated";
import { createAppQueryClient } from "@/lib/query/client";
import {
  createWindowStore,
  type WindowStoreApi,
  type WindowStoreState,
} from "@/store/window-store";

import { resolveAvatarPresentation } from "./avatar";
import { HistoryWorkbench } from "./HistoryWorkbench";
import {
  attachGraphRows,
  collectUnsyncedCommitIds,
  createHistoryGraphBuilder,
  mapCommitSummaryToHistoryCommit,
  parseCommitRefs,
} from "./history-data";
import { createMockHistorySearchSource, searchCommits } from "./history-search";
import { mockHistoryCommits, mockHistoryRows } from "./fixtures";
import { useIncrementalLogRows } from "./useIncrementalHistoryRows";

vi.mock("@/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc/commands")>();

  return {
    ...actual,
    cancelOperation: vi.fn(),
    commitDetails: vi.fn(),
    commitFileDetail: vi.fn(),
    logPage: vi.fn(),
    revertCommit: vi.fn(),
    searchLog: vi.fn(),
  };
});

const cancelOperationMock = vi.mocked(cancelOperation);
const commitDetailsMock = vi.mocked(commitDetails);
const commitFileDetailMock = vi.mocked(commitFileDetail);
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

function openExpandableSearch(label: string) {
  const existing = screen.queryByRole("textbox", { name: label });
  if (existing) {
    return existing;
  }
  fireEvent.click(screen.getByRole("button", { name: label }));
  return screen.getByRole("textbox", { name: label });
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelOperationMock.mockReset();
  cancelOperationMock.mockResolvedValue({ cancelled: true });
  commitDetailsMock.mockReset();
  commitFileDetailMock.mockReset();
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

describe("history commit refs", () => {
  it("keeps local and remote branch decorations distinct", () => {
    expect(
      parseCommitRefs([
        "HEAD -> main",
        "origin/main",
        "feature/lookdev",
        "origin/feature/lookdev",
        "tag: v1.4.0-rc.1",
        "HEAD",
      ]),
    ).toEqual([
      { current: true, name: "main", type: "branch" },
      { name: "main", remote: true, type: "branch" },
      { name: "feature/lookdev", type: "branch" },
      { name: "feature/lookdev", remote: true, type: "branch" },
      { name: "v1.4.0-rc.1", type: "tag" },
    ]);

    const commit = mapCommitSummaryToHistoryCommit({
      authorEmail: "mira@example.test",
      authorName: "Mira Chen",
      authoredAtUnixSeconds: "1783488000",
      oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parents: [],
      refs: ["HEAD -> main", "origin/main"],
      subject: "Synced tip",
    });
    expect(commit.refs).toEqual([
      { current: true, name: "main", type: "branch" },
      { name: "main", remote: true, type: "branch" },
    ]);
  });

  it("marks only divergent local and remote commits as unsynced", () => {
    const shared = {
      ...mockHistoryCommits[0],
      id: "shared",
      parents: [],
      refs: [],
      shortId: "shared",
    };
    const localOnly = {
      ...shared,
      id: "local-only",
      parents: [shared.id],
      refs: [{ name: "main", type: "branch" as const }],
      shortId: "local-only",
    };
    const remoteOnly = {
      ...shared,
      id: "remote-only",
      parents: [shared.id],
      refs: [{ name: "main", remote: true, type: "branch" as const }],
      shortId: "remote-only",
    };

    expect(
      Array.from(
        collectUnsyncedCommitIds(
          attachGraphRows([localOnly, remoteOnly, shared]),
          "main",
        ),
      ).toSorted(),
    ).toEqual(["local-only", "remote-only"]);

    expect(
      collectUnsyncedCommitIds(
        attachGraphRows([
          {
            ...shared,
            refs: [
              { current: true, name: "main", type: "branch" as const },
              { name: "main", remote: true, type: "branch" as const },
            ],
          },
        ]),
        "main",
      ).size,
    ).toBe(0);
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
  it("keeps the toolbar and column labels outside the list scroll viewport", () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

    const frame = screen.getByTestId("history-frame");
    const viewport = screen.getByTestId("history-scroll-viewport");
    const columnHeader = screen.getByTestId("history-column-header");
    const toolbar = screen
      .getByRole("heading", { name: "Commit History" })
      .closest("header");

    expect(frame).toHaveClass("overflow-hidden", "border");
    expect(frame).toContainElement(viewport);
    expect(viewport).toHaveClass(
      "overlay-scrollbar-viewport",
      "overflow-auto",
      "overscroll-contain",
    );
    expect(viewport).not.toContainElement(columnHeader);
    expect(viewport).not.toContainElement(toolbar);
  });

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
      revisions: [],
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

  it("does not report a history search as initial repository loading", async () => {
    vi.useRealTimers();
    const onInitialLoadingChange = vi.fn();
    logPageMock.mockResolvedValue({ commits: [], nextAfter: null });
    searchLogMock.mockReturnValue(new Promise(() => undefined));

    renderWithProviders(
      <HistoryWorkbench
        historyRepositoryPath="/repo/art"
        onInitialLoadingChange={onInitialLoadingChange}
        rows={[]}
      />,
    );

    await screen.findByText("No commits match the current filters.");
    onInitialLoadingChange.mockClear();
    fireEvent.change(openExpandableSearch("Search history"), {
      target: { value: "lookdev" },
    });
    await waitFor(() => expect(searchLogMock).toHaveBeenCalledTimes(3));

    expect(onInitialLoadingChange).not.toHaveBeenCalledWith(true);
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

  it("uses true branch reachability for automatic fixture filtering", () => {
    const root = {
      ...mockHistoryCommits[0],
      id: "root",
      message: "Shared root",
      parents: [],
      refs: [],
      shortId: "root",
    };
    const featureAncestor = {
      ...root,
      id: "feature-ancestor",
      message: "Feature ancestor without a branch label",
      parents: [root.id],
      shortId: "feature-ancestor",
    };
    const featureTip = {
      ...root,
      id: "feature-tip",
      message: "Feature tip",
      parents: [featureAncestor.id],
      refs: [{ name: "feature/color-pipeline", type: "branch" as const }],
      shortId: "feature-tip",
    };
    const mainAncestor = {
      ...root,
      id: "main-ancestor",
      message: "Unrelated main commit without a branch label",
      parents: [root.id],
      shortId: "main-ancestor",
    };
    const mainTip = {
      ...root,
      id: "main-tip",
      message: "Main tip",
      parents: [mainAncestor.id],
      refs: [{ name: "main", type: "branch" as const }],
      shortId: "main-tip",
    };
    renderWithProviders(
      <HistoryWorkbench
        branches={[
          { name: "main" },
          { current: true, name: "feature/color-pipeline" },
        ]}
        rows={attachGraphRows([
          featureTip,
          mainTip,
          featureAncestor,
          mainAncestor,
          root,
        ])}
      />,
    );

    expect(screen.getByText("Feature tip")).toBeVisible();
    expect(
      screen.getByText("Feature ancestor without a branch label"),
    ).toBeVisible();
    expect(screen.getByText("Shared root")).toBeVisible();
    expect(screen.queryByText("Main tip")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Unrelated main commit without a branch label"),
    ).not.toBeInTheDocument();
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
      revisions: [],
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

  it("caps loaded history and explains how to find older commits", async () => {
    vi.useRealTimers();
    const commits = Array.from({ length: 2_000 }, (_, index) => {
      const oid = index.toString(16).padStart(40, "0");
      const parent =
        index + 1 < 2_000
          ? (index + 1).toString(16).padStart(40, "0")
          : undefined;
      return createCommitSummary({
        oid,
        parent,
        subject: `History commit ${index}`,
        time: 1_783_488_000 - index,
      });
    });
    logPageMock.mockResolvedValue({
      commits,
      nextAfter: "2000",
    });

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );

    expect(
      await screen.findByText(
        "Showing the first 2000 commits to keep this view responsive. Choose a branch or search to find older commits.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("history-load-more")).not.toBeInTheDocument();
    expect(logPageMock).toHaveBeenCalledTimes(1);
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

    fireEvent.change(openExpandableSearch("Search history"), {
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
      revisions: [],
    });
    expect(searchLogMock).toHaveBeenCalledWith({
      after: null,
      author: "viewport",
      grep: null,
      limit: 200,
      operationId: expect.stringMatching(/^history-search-author-/),
      pickaxe: null,
      repositoryPath: "/repo/art",
      revisions: [],
    });
    expect(searchLogMock).toHaveBeenCalledWith({
      after: null,
      author: null,
      grep: null,
      limit: 200,
      operationId: expect.stringMatching(/^history-search-content-/),
      pickaxe: "viewport",
      repositoryPath: "/repo/art",
      revisions: [],
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
    fireEvent.change(openExpandableSearch("Search history"), {
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
    const search = openExpandableSearch("Search history");

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
    const initialRenderedCount =
      screen.getAllByTestId("history-commit-row").length;
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 1_000,
    });
    fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
    expect(screen.getAllByTestId("history-commit-row").length).toBeGreaterThan(
      initialRenderedCount,
    );

    fireEvent.scroll(viewport, { target: { scrollTop: 5_000 * 72 - 1_000 } });

    expect(screen.getByText("Commit 4999")).toBeInTheDocument();
    expect(screen.getAllByTestId("history-commit-row").length).toBeLessThan(30);
  });

  it("keeps a long current branch name inside the history toolbar", () => {
    const branchName = `feature/${"long-name-".repeat(30)}`;
    renderWithProviders(
      <HistoryWorkbench
        branches={[{ current: true, name: branchName }]}
        rows={mockHistoryRows}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: `Current branch: ${branchName}`,
    });
    const filter = screen.getByTestId("history-branch-filter");
    const search = screen.getByTestId("expandable-search");
    const expandedSearch = openExpandableSearch("Search history");

    expect(filter).toHaveClass("max-w-64", "min-w-0", "shrink");
    expect(filter).toContainElement(trigger);
    expect(trigger.parentElement).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-full",
    );
    expect(trigger).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
    );
    expect(
      within(trigger).getByText(`Current branch: ${branchName}`),
    ).toHaveClass("min-w-0", "flex-1", "truncate");
    expect(trigger).toHaveAttribute("aria-describedby");
    expect(search).toHaveClass("min-w-0", "flex-1");
    expect(search).not.toHaveClass("min-w-[240px]");
    expect(expandedSearch).toHaveAttribute("aria-label", "Search history");
  });

  it("keeps the branch filter bounded with thousands of branches", async () => {
    const branches = Array.from({ length: 5_000 }, (_, index) => ({
      current: index === 0,
      name: `branch-${index}`,
    }));
    renderWithProviders(
      <HistoryWorkbench branches={branches} rows={mockHistoryRows} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Current branch:/ }));

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

  it("limits custom branch combinations before they exceed Git argument limits", async () => {
    const branches = Array.from({ length: 21 }, (_, index) => ({
      current: index === 0,
      name: `branch-${index}`,
      revision: `refs/heads/branch-${index}`,
    }));
    renderWithProviders(
      <HistoryWorkbench branches={branches} rows={mockHistoryRows} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Current branch:/ }));
    const search = screen.getByLabelText("Search branches");
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        fireEvent.change(search, { target: { value: `branch-${index}` } });
      });
      fireEvent.click(
        screen.getByRole("option", {
          name:
            index === 0
              ? /^branch-0 • current$/
              : new RegExp(`^branch-${index}$`),
        }),
      );
    }

    expect(
      screen.getByText(
        "You can select up to 20 branches. Choose All to include every branch.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "20 selected" })).toBeVisible();

    await act(async () => {
      fireEvent.change(search, { target: { value: "branch-20" } });
    });
    expect(screen.getByRole("option", { name: "branch-20" })).toBeDisabled();
  });

  it("distinguishes local and remote branch badges with branch and cloud icons", () => {
    const row = {
      ...mockHistoryRows[0],
      commit: {
        ...mockHistoryRows[0].commit,
        refs: [
          { current: true, name: "main", type: "branch" as const },
          { name: "main", remote: true, type: "branch" as const },
          { name: "v1.4.0-rc.1", type: "tag" as const },
        ],
      },
    };

    renderWithProviders(<HistoryWorkbench rows={[row]} />);

    const badges = screen.getAllByTestId("history-ref-badge");
    expect(badges).toHaveLength(3);
    expect(badges[0]).not.toHaveAttribute("data-remote");
    expect(badges[0].querySelector("svg.lucide-git-branch")).not.toBeNull();
    expect(badges[1]).toHaveAttribute("data-remote", "true");
    expect(badges[1].querySelector("svg.lucide-cloud")).not.toBeNull();
    expect(badges[2].querySelector("svg.lucide-tag")).not.toBeNull();
  });

  it("highlights unpushed local and unsynced remote commits for a single branch", () => {
    const shared = {
      ...mockHistoryCommits[0],
      id: "shared",
      message: "Shared base",
      parents: [],
      refs: [],
      shortId: "shared",
    };
    const unpushed = {
      ...shared,
      id: "local-only",
      message: "Unpushed local commit",
      parents: [shared.id],
      refs: [{ current: true, name: "main", type: "branch" as const }],
      shortId: "local-only",
    };
    const remoteOnly = {
      ...shared,
      id: "remote-only",
      message: "Unsynced remote commit",
      parents: [shared.id],
      refs: [{ name: "main", remote: true, type: "branch" as const }],
      shortId: "remote-only",
    };

    renderWithProviders(
      <HistoryWorkbench
        activeBranchName="main"
        branches={[
          {
            current: true,
            name: "main",
            remoteRevision: "refs/remotes/origin/main",
            revision: "refs/heads/main",
          },
        ]}
        rows={attachGraphRows([unpushed, remoteOnly, shared])}
      />,
    );

    expect(
      screen
        .getByText("Unpushed local commit")
        .closest("[data-testid='history-commit-row']"),
    ).toHaveAttribute("data-unsynced", "true");
    expect(
      screen
        .getByText("Unsynced remote commit")
        .closest("[data-testid='history-commit-row']"),
    ).toHaveAttribute("data-unsynced", "true");
    expect(
      screen
        .getByText("Shared base")
        .closest("[data-testid='history-commit-row']"),
    ).not.toHaveAttribute("data-unsynced");
  });

  it("does not highlight unsynced commits when browsing all branches", () => {
    const shared = {
      ...mockHistoryCommits[0],
      id: "shared",
      message: "Shared base",
      parents: [],
      refs: [],
      shortId: "shared",
    };
    const unpushed = {
      ...shared,
      id: "local-only",
      message: "Unpushed local commit",
      parents: [shared.id],
      refs: [{ current: true, name: "main", type: "branch" as const }],
      shortId: "local-only",
    };
    const remoteOnly = {
      ...shared,
      id: "remote-only",
      message: "Unsynced remote commit",
      parents: [shared.id],
      refs: [{ name: "main", remote: true, type: "branch" as const }],
      shortId: "remote-only",
    };

    renderWithProviders(
      <HistoryWorkbench
        activeBranchName="main"
        branches={[
          {
            current: true,
            name: "main",
            remoteRevision: "refs/remotes/origin/main",
            revision: "refs/heads/main",
          },
        ]}
        rows={attachGraphRows([unpushed, remoteOnly, shared])}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Current branch: main" }),
    );
    fireEvent.click(screen.getByText("All"));

    expect(
      screen
        .getByText("Unpushed local commit")
        .closest("[data-testid='history-commit-row']"),
    ).not.toHaveAttribute("data-unsynced");
    expect(
      screen
        .getByText("Unsynced remote commit")
        .closest("[data-testid='history-commit-row']"),
    ).not.toHaveAttribute("data-unsynced");
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

  it("loads bounded production commit details and retries the selected file", async () => {
    vi.useRealTimers();
    const summary = createCommitSummary({
      author: "A very long author name ".repeat(30),
      oid: "abababababababababababababababababababab",
      subject: "Production commit details",
      time: 1_783_488_000,
    });
    const fileError = { summary: "historical blob unavailable" };
    let resolveDetails!: (response: CommitDetailsResponse) => void;
    logPageMock.mockResolvedValue({ commits: [summary], nextAfter: null });
    commitDetailsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDetails = resolve;
      }),
    );
    commitFileDetailMock
      .mockRejectedValueOnce(fileError)
      .mockResolvedValueOnce(
        createCommitFileDetailResponse(summary.oid, "src/main.ts"),
      );

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );
    fireEvent.click(await screen.findByText(summary.subject));
    expect(await screen.findByText("Loading commit details...")).toBeVisible();

    await act(async () => {
      resolveDetails({
        body: `Long body\n${"detail line\n".repeat(200)}`,
        bodyTruncated: true,
        files: [
          {
            additions: 0,
            changeKind: "modified",
            deletions: 0,
            newMode: "100755",
            oldMode: "100644",
            oldPath: null,
            path: "src/main.ts",
          },
        ],
        oid: summary.oid,
        repositoryPath: "/repo/art",
        truncated: true,
      });
    });

    const body = await screen.findByTestId("history-commit-body");
    expect(body).toHaveClass("max-h-24", "select-text", "overflow-auto");
    expect(body).toHaveTextContent(
      "The rest of this commit description is hidden",
    );
    expect(
      screen.getByText(
        "Showing the first 1 changed files to keep this view responsive.",
      ),
    ).toBeInTheDocument();
    const selectedFileButton = screen.getByRole("button", {
      name: /src\/main\.ts/,
    });
    expect(selectedFileButton).toHaveAttribute("aria-current", "true");
    expect(selectedFileButton).toHaveTextContent(
      "+0 -0 · permissions 100644 -> 100755",
    );
    expect(screen.getByTestId("history-commit-byline")).toHaveClass("truncate");
    expect(commitDetailsMock).toHaveBeenCalledWith({
      limit: 5_000,
      oid: summary.oid,
      operationId: expect.stringMatching(/^commit-details-/),
      repositoryPath: "/repo/art",
    });

    const fileAlert = await screen.findByRole("alert");
    expect(fileAlert).toHaveTextContent("Could not load this file comparison.");
    const receivedErrors: unknown[] = [];
    const handleError = (event: Event) => {
      receivedErrors.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);
    try {
      fireEvent.click(
        within(fileAlert).getByRole("button", { name: "View error details" }),
      );
      expect(receivedErrors).toEqual([fileError]);
      fireEvent.click(
        within(fileAlert).getByRole("button", { name: "Try again" }),
      );
      expect(await screen.findByLabelText("File comparison")).toBeVisible();
      expect(screen.getByText("File permissions changed")).toBeVisible();
      expect(screen.getByText("100644 -> 100755")).toBeVisible();
      expect(commitFileDetailMock).toHaveBeenLastCalledWith({
        file: {
          additions: 0,
          changeKind: "modified",
          deletions: 0,
          newMode: "100755",
          oldMode: "100644",
          oldPath: null,
          path: "src/main.ts",
        },
        oid: summary.oid,
        operationId: expect.stringMatching(/^commit-file-detail-/),
        repositoryPath: "/repo/art",
      });
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("shows production commit detail errors with details and retry", async () => {
    vi.useRealTimers();
    const summary = createCommitSummary({
      oid: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      subject: "Retry commit details",
      time: 1_783_488_000,
    });
    const detailError = {
      stderr: "fatal: missing tree",
      summary: "read failed",
    };
    logPageMock.mockResolvedValue({ commits: [summary], nextAfter: null });
    commitDetailsMock.mockRejectedValueOnce(detailError).mockResolvedValueOnce({
      body: null,
      bodyTruncated: false,
      files: [],
      oid: summary.oid,
      repositoryPath: "/repo/art",
      truncated: false,
    });

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );
    fireEvent.click(await screen.findByText(summary.subject));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load commit details.");

    const receivedErrors: unknown[] = [];
    const handleError = (event: Event) => {
      receivedErrors.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);
    try {
      fireEvent.click(
        within(alert).getByRole("button", { name: "View error details" }),
      );
      expect(receivedErrors).toEqual([detailError]);
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      expect(
        await screen.findByText("This commit does not change any files."),
      ).toBeVisible();
      expect(commitDetailsMock).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("cancels production commit details when the drawer closes", async () => {
    vi.useRealTimers();
    const summary = createCommitSummary({
      oid: "efefefefefefefefefefefefefefefefefefefef",
      subject: "Close pending commit details",
      time: 1_783_488_000,
    });
    logPageMock.mockResolvedValue({ commits: [summary], nextAfter: null });
    commitDetailsMock.mockReturnValue(new Promise<never>(() => undefined));

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );
    fireEvent.click(await screen.findByText(summary.subject));
    expect(await screen.findByText("Loading commit details...")).toBeVisible();
    cancelOperationMock.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Close commit details" }),
    );

    await waitFor(() => {
      expect(cancelOperationMock).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^commit-details-/),
      });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels a pending production file comparison when the drawer closes", async () => {
    vi.useRealTimers();
    const summary = createCommitSummary({
      oid: "1212121212121212121212121212121212121212",
      subject: "Close pending file comparison",
      time: 1_783_488_000,
    });
    logPageMock.mockResolvedValue({ commits: [summary], nextAfter: null });
    commitDetailsMock.mockResolvedValue({
      body: null,
      bodyTruncated: false,
      files: [
        {
          additions: 1,
          changeKind: "modified",
          deletions: 1,
          newMode: "100644",
          oldMode: "100644",
          oldPath: null,
          path: "src/pending.ts",
        },
      ],
      oid: summary.oid,
      repositoryPath: "/repo/art",
      truncated: false,
    });
    commitFileDetailMock.mockReturnValue(new Promise<never>(() => undefined));

    renderWithProviders(
      <HistoryWorkbench historyRepositoryPath="/repo/art" rows={[]} />,
    );
    fireEvent.click(await screen.findByText(summary.subject));
    expect(await screen.findByText("Loading file comparison...")).toBeVisible();
    await waitFor(() => expect(commitFileDetailMock).toHaveBeenCalledTimes(1));
    cancelOperationMock.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Close commit details" }),
    );

    await waitFor(() => {
      expect(cancelOperationMock).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^commit-file-detail-/),
      });
    });
  });

  it("filters branches, opens commit details, and confirms hash copying", async () => {
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

      expect(
        screen.getByText("Merge color pipeline preview"),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Current branch:/ }));
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      expect(
        screen.getByText("Tag release candidate assets"),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByText("Tag release candidate assets"));
      expect(screen.getByText("Copy hash")).toBeInTheDocument();
      expect(screen.getByLabelText("File comparison")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy hash" }));
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("app-toast")).toHaveTextContent(
        "Commit hash copied",
      );
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("opens commit details at 90% height and resizes from its top edge", () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

    fireEvent.click(screen.getByText("Merge color pipeline preview"));
    const panel = screen.getByTestId("history-commit-detail-panel");
    const resizeHandle = screen.getByRole("separator", {
      name: "Resize commit details",
    });

    expect(panel).toHaveStyle({ height: "90vh" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "90");
    expect(resizeHandle.firstElementChild).toHaveClass(
      "bg-border",
      "group-hover:bg-ring",
    );

    fireEvent.pointerDown(resizeHandle, {
      clientY: window.innerHeight * 0.1,
      pointerId: 5,
    });
    fireEvent.pointerMove(window, { clientY: window.innerHeight * 0.3 });

    expect(panel).toHaveStyle({ height: "70vh" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "70");

    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientY: window.innerHeight * 0.5 });
    expect(panel).toHaveStyle({ height: "70vh" });
  });

  it("keeps focus inside commit details and returns it to the commit row", () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

    const commitRow = screen
      .getByText("Merge color pipeline preview")
      .closest("button")!;
    commitRow.focus();
    fireEvent.click(commitRow);

    const dialog = screen.getByRole("dialog", {
      name: "Merge color pipeline preview",
    });
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    commitRow.focus();
    expect(commitRow).not.toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close commit details" }),
    );
    expect(dialog).not.toBeInTheDocument();
    expect(commitRow).toHaveFocus();
  });

  it("shows hash copy failures as a toast and preserves the original error", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const copyError = new Error("clipboard denied");
    const handleError = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(copyError) },
    });
    window.addEventListener("artistic-git:error", handleError);

    try {
      renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);
      fireEvent.click(screen.getByText("Merge color pipeline preview"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy hash" }));
        await Promise.resolve();
      });

      expect(screen.getByTestId("app-toast")).toHaveTextContent(
        "Could not copy the commit hash",
      );
      expect(handleError).toHaveBeenCalledTimes(1);
      expect((handleError.mock.calls[0][0] as CustomEvent).detail).toEqual({
        cause: copyError,
        operationName: "copyCommitHash",
        summary: "Could not copy the commit hash",
      });
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("virtualizes very large changed-file lists in commit details", () => {
    const row = mockHistoryRows[1];
    const changedFiles = Array.from({ length: 5_000 }, (_, index) => ({
      additions: index + 1,
      changeKind: "modified" as const,
      deletions: index,
      path: `generated/file-${index.toString().padStart(4, "0")}.txt`,
      preview: `content ${index}`,
    }));
    renderWithProviders(
      <HistoryWorkbench
        rows={[
          {
            ...row,
            commit: { ...row.commit, changedFiles },
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText(row.commit.message));
    const viewport = screen.getByTestId("history-detail-changed-files");
    const initialRenderedCount = screen.getAllByTestId(
      "history-detail-changed-file",
    ).length;
    expect(initialRenderedCount).toBeLessThan(30);
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 900,
    });
    fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
    expect(
      screen.getAllByTestId("history-detail-changed-file").length,
    ).toBeGreaterThan(initialRenderedCount);

    fireEvent.scroll(viewport, {
      target: { scrollTop: changedFiles.length * 60 - 900 },
    });

    expect(
      screen.getAllByText("generated/file-4999.txt").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByTestId("history-detail-changed-file").length,
    ).toBeLessThan(30);
  });

  it("debounces search, shows loading, and renders de-duplicated results", async () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

    fireEvent.click(screen.getByRole("button", { name: /Current branch:/ }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    fireEvent.change(openExpandableSearch("Search history"), {
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
    expect(screen.getByTestId("app-toast")).toHaveTextContent(
      "Revert commit created: Revert: Refine branch filter interactions (abc1234).",
    );
    expect(
      screen.queryByRole("dialog", { name: "Revert this commit?" }),
    ).not.toBeInTheDocument();
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

    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);
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

    expect(within(dialog).getByRole("button", { name: "Reverting..." })).toBe(
      confirmButton,
    );
    for (const openButton of screen.getAllByTestId("history-revert-open")) {
      expect(openButton).toHaveAccessibleName("Reverting...");
    }
    expect(screen.getAllByText("Reverting...").length).toBeGreaterThan(1);
    expect(confirmButton).toBeDisabled();
    expect(
      within(dialog).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    const closeDetailsButtons = screen.getAllByRole("button", {
      name: "Close commit details",
    });
    expect(closeDetailsButtons).toHaveLength(1);
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

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The commit could not be reverted.",
    );
    expect(handleError).toHaveBeenCalledTimes(1);
    expect((handleError.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      summary: "git revert failed",
    });
    for (const closeButton of screen.getAllByRole("button", {
      name: "Close commit details",
    })) {
      expect(closeButton).toBeEnabled();
    }
    window.removeEventListener("artistic-git:error", handleError);
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

function createCommitFileDetailResponse(
  oid: string,
  path: string,
): CommitFileDetailResponse {
  return {
    diff: { kind: "moved", message: null },
    file: {
      additions: 0,
      changeKind: "modified",
      deletions: 0,
      newMode: "100755",
      oldMode: "100644",
      oldPath: null,
      path,
    },
    oid,
    payload: {
      changeKind: "modified",
      fileKind: "text",
      lfsLock: null,
      metadata: {
        additions: "0",
        contentChanged: "false",
        deletions: "0",
        modeChanged: "true",
        newMode: "100755",
        oldMode: "100644",
      },
      newPath: path,
      oldPath: null,
    },
    repositoryPath: "/repo/art",
  };
}
