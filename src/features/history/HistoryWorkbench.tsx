import {
  AlertTriangle,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Search,
  Tag,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import { ExpandableSearch } from "@/components/ui/expandable-search";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { IconButton } from "@/components/ui/icon-button";
import { OverlayScrollArea } from "@/components/ui/overlay-scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/truncated-text";
import { DiffViewer } from "@/features/diff";
import { useLocalizedFormatters } from "@/i18n/format";
import { DialogLayerContext, useModalLayer } from "@/lib/dialog-layer";
import {
  cancelOperation,
  commitDetails,
  commitFileDetail,
  logPage,
  revertCommit,
  searchLog,
} from "@/lib/ipc/commands";
import { isOperationCancelledError } from "@/lib/ipc/errors";
import type {
  CommitDetailsResponse,
  ConflictEnteredEvent,
  CommitSummary,
  DiffContent,
  DiffPayload,
  LogPageResponse,
  RevertDisabledReason,
  StashEntry,
  StashRecoveryPoint,
} from "@/lib/ipc/generated";
import { repoQueryKeys } from "@/lib/realtime/query-keys";
import { cn } from "@/lib/utils";
import { useWindowStore } from "@/store/window-store";
import { showToast } from "@/lib/toast";

import { resolveAvatarPresentation } from "./avatar";
import {
  collectUnsyncedCommitIds,
  mapCommitChangedFile,
  mapCommitSummaryToHistoryCommit,
  toCommitChangedFile,
} from "./history-data";
import {
  createMockHistorySearchSource,
  type HistorySearchSource,
} from "./history-search";
import type {
  BranchFilterMode,
  GraphAnchor,
  HistoryBranch,
  HistoryCommit,
  HistoryGraphSegment,
  HistoryRow,
  HistorySearchMatch,
} from "./types";
import {
  useIncrementalFilteredRows,
  useIncrementalLogRows,
  useIncrementalSearchRows,
} from "./useIncrementalHistoryRows";
import { useVirtualWindow } from "./useVirtualWindow";

const rowHeight = 72;
const fallbackViewportHeight = 504;
const graphLaneWidth = 18;
const graphLeftPadding = 14;
const historyPageSize = 200;
const maxHistoryCommits = 2_000;
const maxCustomBranchSelections = 20;
const loadMoreThresholdPx = rowHeight * 4;
const loadMoreFooterHeight = 48;
const branchFilterRowHeight = 36;
const branchFilterViewportHeight = 216;
const commitRefRowHeight = 32;
const commitRefViewportHeight = 224;
const maxVisibleCommitRefs = 6;
const changedFileRowHeight = 60;
const fallbackChangedFileViewportHeight = 504;
const commitDetailFileLimit = 5_000;
const commitDetailDefaultHeightPercent = 90;
const commitDetailMinHeightPercent = 40;
const commitDetailMaxHeightPercent = 100;
type RevertUnavailableReason = RevertDisabledReason | "missingRepository";

interface HistoryWorkbenchProps {
  activeBranchName?: string | null;
  branches?: HistoryBranch[];
  gravatarEnabled?: boolean;
  hasRemote?: boolean;
  historyRepositoryPath?: string | null;
  now?: string;
  onBeforeRevert?: () => Promise<void> | void;
  onInitialLoadingChange?: (loading: boolean) => void;
  onRevertAutoStash?: (operationId: string, stash: StashEntry) => void;
  onRevertStashRecovery?: (
    operationId: string,
    recovery: StashRecoveryPoint,
  ) => void;
  onWriteBusyChange?: (busy: boolean) => void;
  rows?: HistoryRow[];
  searchSource?: HistorySearchSource;
  writeDisabled?: boolean;
}

interface SearchResultSnapshot {
  commits: HistoryCommit[];
  query: string;
}

interface BackendSearchCursor {
  author: string | null;
  authorDone: boolean;
  content: string | null;
  contentDone: boolean;
  message: string | null;
  messageDone: boolean;
}

interface BackendSearchPage {
  commits: HistoryCommit[];
  nextCursor: BackendSearchCursor | null;
}

async function loadBackendSearchPage({
  cursor,
  limit,
  query,
  repositoryPath,
  revisions,
  signal,
}: {
  cursor: BackendSearchCursor;
  limit: number;
  query: string;
  repositoryPath: string;
  revisions: string[];
  signal: AbortSignal;
}): Promise<BackendSearchPage> {
  const specs = [
    {
      after: cursor.message,
      done: cursor.messageDone,
      match: "message",
      request: { author: null, grep: query, pickaxe: null },
    },
    {
      after: cursor.author,
      done: cursor.authorDone,
      match: "author",
      request: { author: query, grep: null, pickaxe: null },
    },
    {
      after: cursor.content,
      done: cursor.contentDone,
      match: "content",
      request: { author: null, grep: null, pickaxe: query },
    },
  ] as const;
  const pages = await Promise.all(
    specs.map((spec) => {
      if (spec.done) {
        return Promise.resolve({ commits: [], nextAfter: null });
      }

      return runCancellableHistoryRequest(
        signal,
        `history-search-${spec.match}`,
        (operationId) =>
          searchLog({
            ...spec.request,
            after: spec.after,
            limit,
            operationId,
            repositoryPath,
            revisions,
          }),
      );
    }),
  );
  const byOid = new Map<
    string,
    { matches: Set<HistorySearchMatch>; summary: CommitSummary }
  >();

  for (const [index, page] of pages.entries()) {
    const match = specs[index].match;
    for (const commit of page.commits) {
      const entry =
        byOid.get(commit.oid) ??
        ({
          matches: new Set<HistorySearchMatch>(),
          summary: commit,
        } satisfies {
          matches: Set<HistorySearchMatch>;
          summary: CommitSummary;
        });
      entry.matches.add(match);
      byOid.set(commit.oid, entry);
    }
  }

  const commits = Array.from(byOid.values())
    .sort((left, right) =>
      compareCommitSummaryTime(right.summary, left.summary),
    )
    .map((entry) =>
      mapCommitSummaryToHistoryCommit(entry.summary, Array.from(entry.matches)),
    );
  const nextCursor = {
    author: pages[1].nextAfter,
    authorDone: cursor.authorDone || pages[1].nextAfter === null,
    content: pages[2].nextAfter,
    contentDone: cursor.contentDone || pages[2].nextAfter === null,
    message: pages[0].nextAfter,
    messageDone: cursor.messageDone || pages[0].nextAfter === null,
  };
  const hasNextPage = !(
    nextCursor.authorDone &&
    nextCursor.contentDone &&
    nextCursor.messageDone
  );

  return {
    commits,
    nextCursor: hasNextPage ? nextCursor : null,
  };
}

async function runCancellableHistoryRequest<T>(
  signal: AbortSignal,
  operationPrefix: string,
  request: (operationId: string) => Promise<T>,
): Promise<T> {
  throwIfHistoryRequestAborted(signal);
  const operationId = createHistoryOperationId(operationPrefix);
  const cancel = () => {
    void cancelOperation({ operationId }).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });

  try {
    const response = await request(operationId);
    throwIfHistoryRequestAborted(signal);
    return response;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function throwIfHistoryRequestAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("History request was cancelled.", "AbortError");
  }
}

function compareCommitSummaryTime(
  left: CommitSummary,
  right: CommitSummary,
): number {
  return (
    Number.parseInt(left.authoredAtUnixSeconds, 10) -
    Number.parseInt(right.authoredAtUnixSeconds, 10)
  );
}

export function HistoryWorkbench({
  activeBranchName,
  branches = [],
  gravatarEnabled = false,
  hasRemote = true,
  historyRepositoryPath = null,
  now,
  onBeforeRevert,
  onInitialLoadingChange,
  onRevertAutoStash,
  onRevertStashRecovery,
  onWriteBusyChange,
  rows = [],
  searchSource,
  writeDisabled = false,
}: HistoryWorkbenchProps) {
  const { t } = useTranslation();
  const effectiveNow = React.useMemo(
    () => now ?? new Date().toISOString(),
    [now],
  );
  const [branchMode, setBranchMode] = React.useState<BranchFilterMode>("auto");
  const [selectedBranches, setSelectedBranches] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [query, setQuery] = React.useState("");
  const trimmedQuery = query.trim();
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [searchResults, setSearchResults] =
    React.useState<SearchResultSnapshot | null>(null);
  const [selectedCommitId, setSelectedCommitId] = React.useState<string | null>(
    null,
  );
  const commitDetailReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const historyViewportRef = React.useRef<HTMLDivElement>(null);
  const [historyViewportHeight, measureHistoryViewport] =
    useObservedViewportHeight(historyViewportRef, fallbackViewportHeight);
  const repositoryPath = useWindowStore((state) => state.activeRepositoryPath);
  const setConflictEntered = useWindowStore(
    (state) => state.setConflictEntered,
  );
  const source = React.useMemo(
    () =>
      searchSource ??
      createMockHistorySearchSource(rows.map((row) => row.commit)),
    [rows, searchSource],
  );
  const backendHistoryEnabled = Boolean(historyRepositoryPath);
  const activeHistoryBranchName =
    activeBranchName ??
    branches.find((branch) => branch.current)?.name ??
    rows
      .flatMap((row) => row.commit.refs)
      .find((reference) => reference.type === "branch" && reference.current)
      ?.name ??
    null;
  const singleHistoryBranchName = React.useMemo(() => {
    if (branchMode === "auto") {
      return activeHistoryBranchName;
    }
    if (branchMode === "custom" && selectedBranches.size === 1) {
      return Array.from(selectedBranches)[0] ?? null;
    }
    return null;
  }, [activeHistoryBranchName, branchMode, selectedBranches]);
  const historyRevisions = React.useMemo(() => {
    if (branchMode === "all") {
      return [];
    }

    const names =
      branchMode === "auto"
        ? activeHistoryBranchName
          ? new Set([activeHistoryBranchName])
          : new Set<string>()
        : selectedBranches;
    const selected = branches.filter((branch) => names.has(branch.name));
    const includeRemoteTracking = singleHistoryBranchName !== null;
    const revisions = new Set<string>();

    for (const branch of selected) {
      revisions.add(branch.revision ?? `refs/heads/${branch.name}`);
      if (includeRemoteTracking && branch.remoteRevision) {
        revisions.add(branch.remoteRevision);
      }
    }

    return Array.from(revisions).toSorted();
  }, [
    activeHistoryBranchName,
    branchMode,
    branches,
    selectedBranches,
    singleHistoryBranchName,
  ]);

  React.useEffect(() => {
    if (!trimmedQuery) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setDebouncedQuery(trimmedQuery);
    }, 220);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [trimmedQuery]);

  React.useEffect(() => {
    if (backendHistoryEnabled || !debouncedQuery) {
      return;
    }

    const controller = new AbortController();
    source(debouncedQuery, controller.signal)
      .then((result) => {
        setSearchResults({ commits: result.commits, query: debouncedQuery });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSearchResults({ commits: [], query: debouncedQuery });
        }
      });

    return () => {
      controller.abort();
    };
  }, [backendHistoryEnabled, debouncedQuery, source]);

  const effectiveSearchTerm =
    trimmedQuery && debouncedQuery === trimmedQuery ? debouncedQuery : "";
  const historyQuery = useInfiniteQuery<
    LogPageResponse,
    Error,
    InfiniteData<LogPageResponse>,
    readonly unknown[],
    string | null
  >({
    enabled: backendHistoryEnabled && !effectiveSearchTerm,
    getNextPageParam: (lastPage, pages) =>
      countLoadedCommits(pages) >= maxHistoryCommits
        ? undefined
        : (lastPage.nextAfter ?? undefined),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      runCancellableHistoryRequest(signal, "history-page", (operationId) =>
        logPage({
          after: pageParam,
          limit: historyPageSize,
          operationId,
          repositoryPath: historyRepositoryPath ?? "",
          revisions: historyRevisions,
        }),
      ),
    queryKey: [
      ...repoQueryKeys.history(historyRepositoryPath ?? "__none__"),
      "pages",
      historyRevisions,
    ] as const,
    retry: false,
  });
  const backendSearchQuery = useInfiniteQuery<
    BackendSearchPage,
    Error,
    InfiniteData<BackendSearchPage>,
    readonly unknown[],
    BackendSearchCursor
  >({
    enabled: backendHistoryEnabled && Boolean(effectiveSearchTerm),
    getNextPageParam: (lastPage: BackendSearchPage, pages) =>
      countLoadedCommits(pages) >= maxHistoryCommits
        ? undefined
        : (lastPage.nextCursor ?? undefined),
    initialPageParam: {
      author: null,
      authorDone: false,
      content: null,
      contentDone: false,
      message: null,
      messageDone: false,
    } satisfies BackendSearchCursor,
    queryFn: ({ pageParam, signal }) =>
      loadBackendSearchPage({
        cursor: pageParam,
        limit: historyPageSize,
        query: effectiveSearchTerm,
        repositoryPath: historyRepositoryPath ?? "",
        revisions: historyRevisions,
        signal,
      }),
    queryKey: [
      ...repoQueryKeys.history(historyRepositoryPath ?? "__none__"),
      "search",
      effectiveSearchTerm,
      historyRevisions,
    ] as const,
    retry: false,
  });

  const activeSearchResults =
    !backendHistoryEnabled &&
    trimmedQuery &&
    searchResults?.query === trimmedQuery
      ? searchResults.commits
      : null;
  const isBackendSearching =
    backendHistoryEnabled &&
    Boolean(trimmedQuery) &&
    (debouncedQuery !== trimmedQuery ||
      backendSearchQuery.isLoading ||
      backendSearchQuery.isFetching);
  const isSearching =
    (!backendHistoryEnabled &&
      Boolean(trimmedQuery) &&
      debouncedQuery !== trimmedQuery) ||
    isBackendSearching;

  const backendRows = useIncrementalLogRows(historyQuery.data?.pages);
  const backendSearchRows = useIncrementalSearchRows(
    backendSearchQuery.data?.pages,
  );
  const fixtureRows = React.useMemo(() => ({ changedFrom: 0, rows }), [rows]);
  const effectiveRows = backendHistoryEnabled ? backendRows : fixtureRows;
  const activeSearchRows = React.useMemo(() => {
    if (backendHistoryEnabled) {
      return effectiveSearchTerm ? backendSearchRows : null;
    }

    if (activeSearchResults === null) {
      return null;
    }

    const searchedIds = new Map(
      activeSearchResults.map((commit) => [commit.id, commit]),
    );
    const searchedRows = rows
      .map((row) => {
        const commit = searchedIds.get(row.commit.id);
        return commit ? { ...row, commit } : null;
      })
      .filter((row): row is HistoryRow => Boolean(row));
    return { changedFrom: 0, rows: searchedRows };
  }, [
    activeSearchResults,
    backendHistoryEnabled,
    backendSearchRows,
    effectiveSearchTerm,
    rows,
  ]);
  const fixtureFilteredRows = useIncrementalFilteredRows(
    effectiveRows,
    branchMode,
    selectedBranches,
    activeHistoryBranchName,
  );
  const visibleRows = React.useMemo(() => {
    const sourceRows = activeSearchRows?.rows ?? effectiveRows.rows;
    if (backendHistoryEnabled) {
      return sourceRows.length > maxHistoryCommits
        ? sourceRows.slice(0, maxHistoryCommits)
        : sourceRows;
    }
    if (activeSearchRows === null) {
      return fixtureFilteredRows;
    }

    const visibleIds = new Set(fixtureFilteredRows.map((row) => row.commit.id));
    return sourceRows.filter((row) => visibleIds.has(row.commit.id));
  }, [
    activeSearchRows,
    backendHistoryEnabled,
    effectiveRows.rows,
    fixtureFilteredRows,
  ]);
  const unsyncedCommitIds = React.useMemo(() => {
    if (singleHistoryBranchName === null) {
      return new Set<string>();
    }
    return collectUnsyncedCommitIds(visibleRows, singleHistoryBranchName);
  }, [singleHistoryBranchName, visibleRows]);

  const virtual = useVirtualWindow({
    count: visibleRows.length,
    estimateSize: rowHeight,
    viewportHeight: historyViewportHeight,
  });
  const canLoadMore = backendHistoryEnabled
    ? effectiveSearchTerm
      ? backendSearchQuery.hasNextPage
      : historyQuery.hasNextPage
    : false;
  const historyLimitReached = effectiveSearchTerm
    ? countLoadedCommits(backendSearchQuery.data?.pages ?? []) >=
        maxHistoryCommits &&
      backendSearchQuery.data?.pages.at(-1)?.nextCursor !== null
    : countLoadedCommits(historyQuery.data?.pages ?? []) >= maxHistoryCommits &&
      historyQuery.data?.pages.at(-1)?.nextAfter !== null;
  const isFetchingNextPage = backendHistoryEnabled
    ? effectiveSearchTerm
      ? backendSearchQuery.isFetchingNextPage
      : historyQuery.isFetchingNextPage
    : false;
  const isHistoryContentLoading =
    backendHistoryEnabled &&
    (effectiveSearchTerm
      ? backendSearchQuery.isLoading
      : historyQuery.isLoading);
  const isInitialHistoryLoading =
    backendHistoryEnabled &&
    !effectiveSearchTerm &&
    historyQuery.isLoading &&
    historyQuery.data === undefined;
  React.useEffect(() => {
    onInitialLoadingChange?.(isInitialHistoryLoading);
    return () => {
      onInitialLoadingChange?.(false);
    };
  }, [isInitialHistoryLoading, onInitialLoadingChange]);
  const historyLoadError = backendHistoryEnabled
    ? effectiveSearchTerm
      ? backendSearchQuery.error
      : historyQuery.error
    : null;
  const historyNextPageFailed = backendHistoryEnabled
    ? effectiveSearchTerm
      ? backendSearchQuery.isFetchNextPageError
      : historyQuery.isFetchNextPageError
    : false;
  const historyRetrying = backendHistoryEnabled
    ? effectiveSearchTerm
      ? backendSearchQuery.isFetching
      : historyQuery.isFetching
    : false;
  const historyLoadErrorMessage = historyNextPageFailed
    ? t("history.loadMoreError")
    : effectiveSearchTerm
      ? t("history.searchLoadError")
      : t("history.loadError");
  const fetchNextPage = effectiveSearchTerm
    ? backendSearchQuery.fetchNextPage
    : historyQuery.fetchNextPage;
  const pageLoadGateRef = React.useRef({ key: "", pending: false });
  const pageLoadKey = effectiveSearchTerm
    ? `search:${effectiveSearchTerm}`
    : "history";
  const retryHistoryLoad = () => {
    pageLoadGateRef.current = { key: pageLoadKey, pending: false };
    if (effectiveSearchTerm) {
      void (backendSearchQuery.isFetchNextPageError
        ? backendSearchQuery.fetchNextPage()
        : backendSearchQuery.refetch());
      return;
    }

    void (historyQuery.isFetchNextPageError
      ? historyQuery.fetchNextPage()
      : historyQuery.refetch());
  };
  const requestNextPage = React.useCallback(() => {
    if (
      !backendHistoryEnabled ||
      !canLoadMore ||
      isFetchingNextPage ||
      historyLoadError
    ) {
      return;
    }

    if (pageLoadGateRef.current.key !== pageLoadKey) {
      pageLoadGateRef.current = { key: pageLoadKey, pending: false };
    }
    if (pageLoadGateRef.current.pending) {
      return;
    }

    pageLoadGateRef.current.pending = true;
    const releaseGate = () => {
      if (pageLoadGateRef.current.key === pageLoadKey) {
        pageLoadGateRef.current.pending = false;
      }
    };
    void fetchNextPage().then(releaseGate, releaseGate);
  }, [
    backendHistoryEnabled,
    canLoadMore,
    fetchNextPage,
    historyLoadError,
    isFetchingNextPage,
    pageLoadKey,
  ]);
  const maybeLoadNextPage = React.useCallback(
    (element: HTMLElement) => {
      const remaining =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      if (remaining <= loadMoreThresholdPx) {
        requestNextPage();
      }
    },
    [requestNextPage],
  );
  const handleScroll = React.useCallback<React.UIEventHandler<HTMLDivElement>>(
    (event) => {
      measureHistoryViewport(event.currentTarget);
      virtual.onScroll(event);
      maybeLoadNextPage(event.currentTarget);
    },
    [maybeLoadNextPage, measureHistoryViewport, virtual],
  );
  const historyContentHeight = Math.max(
    virtual.totalSize,
    canLoadMore ? historyViewportHeight - loadMoreFooterHeight : 0,
  );
  const selectedCommit =
    selectedCommitId === null
      ? null
      : (activeSearchRows?.rows.find(
          (row) => row.commit.id === selectedCommitId,
        )?.commit ??
        effectiveRows.rows.find((row) => row.commit.id === selectedCommitId)
          ?.commit ??
        null);

  return (
    <section
      aria-label={t("history.title")}
      className="isolate flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground"
      data-testid="history-frame"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitPullRequest className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">
              {t("history.title")}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {t("history.subtitle")}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <BranchFilter
            activeBranchName={activeHistoryBranchName}
            branches={branches}
            mode={branchMode}
            onModeChange={setBranchMode}
            onSelectedBranchesChange={setSelectedBranches}
            selectedBranches={selectedBranches}
          />
          <ExpandableSearch
            clearLabel={t("history.search.clear")}
            dataAppSearch="current"
            expandedClassName="min-w-0 max-w-sm flex-1 basis-60"
            isSearching={isSearching}
            label={t("history.search.label")}
            onChange={(nextQuery) => {
              setQuery(nextQuery);
              if (!nextQuery.trim()) {
                setDebouncedQuery("");
                setSearchResults(null);
              }
            }}
            placeholder={t("history.search.placeholder")}
            value={query}
          />
        </div>
      </header>

      {historyLoadError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
          data-testid="history-load-error"
          role="alert"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <AlertTriangle
              className="size-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <span>{historyLoadErrorMessage}</span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              className="h-8 px-2"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("artistic-git:error", {
                    detail: historyLoadError,
                  }),
                );
              }}
              type="button"
              variant="ghost"
            >
              {t("history.viewErrorDetails")}
            </Button>
            <Button
              className="h-8 gap-1.5 px-2"
              disabled={historyRetrying}
              onClick={retryHistoryLoad}
              type="button"
              variant="secondary"
            >
              {historyRetrying ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {historyRetrying
                ? t("history.retryingLoad")
                : t("history.retryLoad")}
            </Button>
          </div>
        </div>
      ) : null}

      {backendHistoryEnabled && historyLimitReached ? (
        <div
          className="border-b bg-muted/35 px-4 py-2 text-sm text-muted-foreground"
          data-testid="history-limit-reached"
          role="status"
        >
          {t(
            effectiveSearchTerm
              ? "history.searchLimitReached"
              : "history.limitReached",
            { count: maxHistoryCommits },
          )}
        </div>
      ) : null}

      <div
        className="grid shrink-0 border-b bg-muted/35 px-4 py-2 text-xs font-medium text-muted-foreground [grid-template-columns:112px_minmax(0,1fr)_180px_140px]"
        data-testid="history-column-header"
      >
        <span>{t("history.columns.graph")}</span>
        <span>{t("history.columns.commit")}</span>
        <span>{t("history.columns.author")}</span>
        <span>{t("history.columns.time")}</span>
      </div>

      <OverlayScrollArea
        className="min-h-0 flex-1"
        data-testid="history-scroll-viewport"
        onScroll={handleScroll}
        ref={historyViewportRef}
        viewportClassName="overscroll-contain"
      >
        <div className="relative" style={{ height: historyContentHeight }}>
          {virtual.items.map((item) => {
            const row = visibleRows[item.index];
            return (
              <HistoryCommitRow
                gravatarEnabled={gravatarEnabled}
                key={row.commit.id}
                now={effectiveNow}
                onSelect={(commitId, trigger) => {
                  commitDetailReturnFocusRef.current = trigger;
                  setSelectedCommitId(commitId);
                }}
                row={row}
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
                unsynced={unsyncedCommitIds.has(row.commit.id)}
              />
            );
          })}
          <HistoryGraphSvg
            rows={visibleRows}
            virtualItems={virtual.items}
            width={112}
          />
        </div>
        {isFetchingNextPage ? (
          <div className="sticky bottom-0 flex h-10 items-center justify-center gap-2 border-t bg-card/95 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("history.loadingMore")}
          </div>
        ) : null}
        {visibleRows.length === 0 && !historyLoadError ? (
          <div className="absolute inset-0 flex items-center justify-center px-4 pb-14 text-center text-sm text-muted-foreground">
            {isHistoryContentLoading
              ? t("history.loading")
              : t("history.empty")}
          </div>
        ) : null}
        {canLoadMore && !isFetchingNextPage && !historyLoadError ? (
          <div className="relative z-10 flex h-12 items-center justify-center border-t bg-card/95">
            <Button
              data-testid="history-load-more"
              onClick={requestNextPage}
              type="button"
              variant="secondary"
            >
              {t("history.loadMore")}
            </Button>
          </div>
        ) : null}
      </OverlayScrollArea>

      {selectedCommit ? (
        <CommitDetailPanel
          commit={selectedCommit}
          detailsRepositoryPath={historyRepositoryPath}
          gravatarEnabled={gravatarEnabled}
          hasRemote={hasRemote}
          now={effectiveNow}
          onBeforeRevert={onBeforeRevert}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedCommitId(null);
            }
          }}
          onRevertAutoStash={onRevertAutoStash}
          onRevertStashRecovery={onRevertStashRecovery}
          onWriteBusyChange={onWriteBusyChange}
          repositoryPath={repositoryPath}
          returnFocusRef={commitDetailReturnFocusRef}
          setConflictEntered={setConflictEntered}
          writeDisabled={writeDisabled}
        />
      ) : null}
    </section>
  );
}

function countLoadedCommits(
  pages: readonly { commits: readonly unknown[] }[],
): number {
  return pages.reduce((count, page) => count + page.commits.length, 0);
}

function BranchFilter({
  activeBranchName,
  branches,
  mode,
  onModeChange,
  onSelectedBranchesChange,
  selectedBranches,
}: {
  activeBranchName: string | null;
  branches: HistoryBranch[];
  mode: BranchFilterMode;
  onModeChange: (mode: BranchFilterMode) => void;
  onSelectedBranchesChange: (selected: Set<string>) => void;
  selectedBranches: Set<string>;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
  const open = anchor !== null;
  const [query, setQuery] = React.useState("");
  const deferredQuery = React.useDeferredValue(query);
  const filteredBranches = React.useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    return normalizedQuery
      ? branches.filter((branch) =>
          branch.name.toLocaleLowerCase().includes(normalizedQuery),
        )
      : branches;
  }, [branches, deferredQuery]);
  const label =
    mode === "all"
      ? t("history.filters.all")
      : mode === "auto"
        ? activeBranchName
          ? t("history.filters.currentBranch", { branch: activeBranchName })
          : t("history.filters.all")
        : t("history.filters.custom", { count: selectedBranches.size });
  const autoLabel = activeBranchName
    ? t("history.filters.currentBranch", { branch: activeBranchName })
    : t("history.filters.all");
  const customSelectionLimitReached =
    selectedBranches.size >= maxCustomBranchSelections;

  return (
    <div
      className="relative min-w-0 max-w-64 shrink"
      data-testid="history-branch-filter"
    >
      <Tooltip className="flex w-full min-w-0 max-w-full" content={label}>
        {({ describedBy }) => (
          <Button
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-describedby={describedBy}
            className="w-full min-w-0 max-w-full justify-start gap-2 overflow-hidden"
            onClick={(event) => {
              if (open) {
                setQuery("");
                setAnchor(null);
              } else {
                setAnchor(event.currentTarget);
              }
            }}
            type="button"
            variant="secondary"
          >
            <GitBranch className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ChevronDown className="size-4 shrink-0" />
          </Button>
        )}
      </Tooltip>
      {open ? (
        <FloatingPanel
          anchor={anchor}
          aria-label={t("history.filters.branches")}
          aria-modal={false}
          className="w-72 p-2"
          onClose={() => {
            setAnchor(null);
            setQuery("");
          }}
          role="dialog"
        >
          <FilterOption
            checked={mode === "auto"}
            label={autoLabel}
            onSelect={() => {
              onModeChange("auto");
              onSelectedBranchesChange(new Set());
            }}
          />
          <FilterOption
            checked={mode === "all"}
            label={t("history.filters.all")}
            onSelect={() => {
              onModeChange("all");
              onSelectedBranchesChange(new Set());
            }}
          />
          <div className="my-2 border-t" />
          <label className="relative flex items-center">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
            />
            <input
              aria-label={t("history.filters.search")}
              className="h-9 w-full rounded-md border bg-background pl-8 pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-autofocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("history.filters.searchPlaceholder")}
              value={query}
            />
          </label>
          <div className="mt-2">
            {filteredBranches.length > 0 ? (
              <VirtualBranchFilterOptions
                branches={filteredBranches}
                onModeChange={onModeChange}
                onSelectedBranchesChange={onSelectedBranchesChange}
                selectionLimitReached={customSelectionLimitReached}
                selectedBranches={selectedBranches}
              />
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                {t("history.filters.noResults")}
              </p>
            )}
          </div>
          {customSelectionLimitReached ? (
            <p className="px-2 pt-2 text-xs text-warning" role="status">
              {t("history.filters.selectionLimitReached", {
                count: maxCustomBranchSelections,
              })}
            </p>
          ) : null}
        </FloatingPanel>
      ) : null}
    </div>
  );
}

function VirtualBranchFilterOptions({
  branches,
  onModeChange,
  onSelectedBranchesChange,
  selectionLimitReached,
  selectedBranches,
}: {
  branches: HistoryBranch[];
  onModeChange: (mode: BranchFilterMode) => void;
  onSelectedBranchesChange: (selected: Set<string>) => void;
  selectionLimitReached: boolean;
  selectedBranches: Set<string>;
}) {
  const { t } = useTranslation();
  const virtual = useVirtualWindow({
    count: branches.length,
    estimateSize: branchFilterRowHeight,
    overscan: 4,
    viewportHeight: branchFilterViewportHeight,
  });
  const height = Math.min(virtual.totalSize, branchFilterViewportHeight);

  return (
    <OverlayScrollArea
      aria-label={t("history.filters.branches")}
      aria-multiselectable="true"
      data-testid="history-branch-filter-viewport"
      onScroll={virtual.onScroll}
      role="listbox"
      style={{ height }}
    >
      <div className="relative" style={{ height: virtual.totalSize }}>
        {virtual.items.map((item) => {
          const branch = branches[item.index];
          return (
            <div
              className="absolute left-0 right-0"
              key={branch.name}
              style={{
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              <FilterOption
                checked={selectedBranches.has(branch.name)}
                disabled={
                  selectionLimitReached && !selectedBranches.has(branch.name)
                }
                label={
                  branch.current
                    ? `${branch.name} • ${t("history.filters.current")}`
                    : branch.name
                }
                onSelect={() => {
                  const next = new Set(selectedBranches);
                  if (next.has(branch.name)) {
                    next.delete(branch.name);
                  } else if (next.size < maxCustomBranchSelections) {
                    next.add(branch.name);
                  }
                  onSelectedBranchesChange(next);
                  onModeChange(next.size === 0 ? "auto" : "custom");
                }}
                optionCount={branches.length}
                optionIndex={item.index}
                testId="history-branch-filter-option"
              />
            </div>
          );
        })}
      </div>
    </OverlayScrollArea>
  );
}

function FilterOption({
  checked,
  disabled = false,
  label,
  onSelect,
  optionCount,
  optionIndex,
  testId,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onSelect: () => void;
  optionCount?: number;
  optionIndex?: number;
  testId?: string;
}) {
  const isOption = optionIndex !== undefined && optionCount !== undefined;
  return (
    <button
      aria-posinset={isOption ? optionIndex + 1 : undefined}
      aria-selected={isOption ? checked : undefined}
      aria-setsize={isOption ? optionCount : undefined}
      className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      role={isOption ? "option" : undefined}
      type="button"
    >
      <span className="flex size-4 items-center justify-center rounded border">
        {checked ? <Check className="size-3" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function HistoryCommitRow({
  gravatarEnabled,
  now,
  onSelect,
  row,
  style,
  unsynced = false,
}: {
  gravatarEnabled: boolean;
  now: string;
  onSelect: (commitId: string, trigger: HTMLButtonElement) => void;
  row: HistoryRow;
  style: React.CSSProperties;
  unsynced?: boolean;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const { commit } = row;
  const visibleRefs = commit.refs.slice(0, maxVisibleCommitRefs);
  const hiddenRefCount = commit.refs.length - visibleRefs.length;

  return (
    <button
      className={cn(
        "absolute left-0 right-0 grid border-b px-4 text-left transition-colors [grid-template-columns:112px_minmax(0,1fr)_180px_140px]",
        unsynced
          ? "bg-warning/15 hover:bg-warning/25"
          : "bg-card hover:bg-accent/45",
      )}
      data-commit-id={commit.id}
      data-commit-message={commit.message}
      data-commit-short-id={commit.shortId}
      data-testid="history-commit-row"
      data-unsynced={unsynced ? "true" : undefined}
      onClick={(event) => {
        onSelect(commit.id, event.currentTarget);
      }}
      style={style}
      type="button"
    >
      <span aria-hidden="true" />
      <span className="flex min-w-0 items-center gap-3 py-3">
        <Avatar author={commit.author} gravatarEnabled={gravatarEnabled} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">
              {commit.message}
            </span>
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5">
            {visibleRefs.map((ref, index) => (
              <RefBadge
                key={`${ref.type}:${ref.remote ? "remote" : "local"}:${ref.name}:${index}`}
                refItem={ref}
              />
            ))}
            {hiddenRefCount > 0 ? (
              <Tooltip
                content={t("history.moreRefs", { count: hiddenRefCount })}
              >
                {({ describedBy }) => (
                  <span
                    aria-describedby={describedBy}
                    className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                    data-testid="history-ref-overflow"
                  >
                    +{hiddenRefCount}
                  </span>
                )}
              </Tooltip>
            ) : null}
            {commit.searchMatches?.map((match) => (
              <span
                className="rounded bg-warning/20 px-1.5 py-0.5 text-[11px] text-foreground"
                key={match}
              >
                {t(`history.search.matches.${match}`)}
              </span>
            ))}
          </span>
        </span>
      </span>
      <span className="flex min-w-0 items-center text-sm">
        <TruncatedText text={commit.author.name} />
      </span>
      <time
        className="flex items-center text-sm text-muted-foreground"
        dateTime={commit.authoredAt}
        title={formatters.formatDate(commit.authoredAt, {
          dateStyle: "full",
          timeStyle: "long",
        })}
      >
        {formatters.formatRelativeTime(commit.authoredAt, now)}
      </time>
    </button>
  );
}

function Avatar({
  author,
  gravatarEnabled,
}: {
  author: HistoryCommit["author"];
  gravatarEnabled: boolean;
}) {
  const presentation = resolveAvatarPresentation(author, { gravatarEnabled });
  const [failed, setFailed] = React.useState(false);

  if (presentation.remoteUrl && !failed) {
    return (
      <img
        alt=""
        className="size-9 rounded-full border object-cover"
        onError={() => {
          setFailed(true);
        }}
        src={presentation.remoteUrl}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ backgroundColor: presentation.background }}
    >
      {presentation.initials}
    </span>
  );
}

function createHistoryOperationId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function RefBadge({ refItem }: { refItem: HistoryCommit["refs"][number] }) {
  const isTag = refItem.type === "tag";
  const isRemoteBranch = !isTag && Boolean(refItem.remote);
  return (
    <span
      className={cn(
        "inline-flex max-w-44 items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
        isTag
          ? "bg-warning/20 text-foreground"
          : isRemoteBranch
            ? "bg-muted text-foreground"
            : "bg-sync/15 text-foreground",
      )}
      data-remote={isRemoteBranch ? "true" : undefined}
      data-testid="history-ref-badge"
    >
      {isTag ? (
        <Tag className="size-3 shrink-0" />
      ) : isRemoteBranch ? (
        <Cloud className="size-3 shrink-0" />
      ) : (
        <GitBranch className="size-3 shrink-0" />
      )}
      <span className="truncate">{refItem.name}</span>
    </span>
  );
}

function CommitRefsBrowser({ refs }: { refs: HistoryCommit["refs"] }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
  const open = anchor !== null;
  const [query, setQuery] = React.useState("");
  const deferredQuery = React.useDeferredValue(query);
  const filteredRefs = React.useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    return normalizedQuery
      ? refs.filter((ref) =>
          ref.name.toLocaleLowerCase().includes(normalizedQuery),
        )
      : refs;
  }, [deferredQuery, refs]);

  if (refs.length === 0) {
    return null;
  }

  return (
    <div className="relative mt-2 w-fit">
      <Button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={(event) => {
          if (open) {
            setQuery("");
            setAnchor(null);
          } else {
            setAnchor(event.currentTarget);
          }
        }}
        type="button"
        variant="ghost"
      >
        <GitBranch aria-hidden="true" className="size-3.5" />
        {t("history.refs.count", { count: refs.length })}
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </Button>
      {open ? (
        <FloatingPanel
          anchor={anchor}
          aria-label={t("history.refs.list")}
          aria-modal={false}
          className="w-80 p-2"
          onClose={() => {
            setAnchor(null);
            setQuery("");
          }}
          role="dialog"
        >
          <label className="relative flex items-center">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
            />
            <input
              aria-label={t("history.refs.search")}
              className="h-9 w-full rounded-md border bg-background pl-8 pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-autofocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("history.refs.searchPlaceholder")}
              value={query}
            />
          </label>
          <div className="mt-2">
            {filteredRefs.length > 0 ? (
              <VirtualCommitRefList refs={filteredRefs} />
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                {t("history.refs.noResults")}
              </p>
            )}
          </div>
        </FloatingPanel>
      ) : null}
    </div>
  );
}

function VirtualCommitRefList({ refs }: { refs: HistoryCommit["refs"] }) {
  const { t } = useTranslation();
  const virtual = useVirtualWindow({
    count: refs.length,
    estimateSize: commitRefRowHeight,
    overscan: 4,
    viewportHeight: commitRefViewportHeight,
  });
  const height = Math.min(virtual.totalSize, commitRefViewportHeight);

  return (
    <OverlayScrollArea
      aria-label={t("history.refs.list")}
      onScroll={virtual.onScroll}
      role="list"
      style={{ height }}
    >
      <div className="relative" style={{ height: virtual.totalSize }}>
        {virtual.items.map((item) => {
          const ref = refs[item.index];
          const isTag = ref.type === "tag";
          const isRemoteBranch = !isTag && Boolean(ref.remote);
          return (
            <div
              aria-posinset={item.index + 1}
              aria-setsize={refs.length}
              className="absolute left-0 right-0 flex items-center gap-2 px-2 text-sm"
              data-remote={isRemoteBranch ? "true" : undefined}
              data-testid="history-detail-ref-item"
              key={`${ref.type}:${ref.remote ? "remote" : "local"}:${ref.name}:${item.index}`}
              role="listitem"
              style={{
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              {isTag ? (
                <Tag aria-hidden="true" className="size-3.5 shrink-0" />
              ) : isRemoteBranch ? (
                <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate" title={ref.name}>
                {ref.name}
              </span>
            </div>
          );
        })}
      </div>
    </OverlayScrollArea>
  );
}

function HistoryGraphSvg({
  rows,
  virtualItems,
  width,
}: {
  rows: HistoryRow[];
  virtualItems: Array<{ index: number; start: number; size: number }>;
  width: number;
}) {
  const firstItem = virtualItems.at(0);
  const lastItem = virtualItems.at(-1);
  if (!firstItem || !lastItem) {
    return null;
  }
  const windowStart = firstItem.start;
  const height = lastItem.start + lastItem.size - windowStart;

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-4 top-0"
      data-testid="history-graph-window"
      height={height}
      style={{ transform: `translateY(${windowStart}px)` }}
      width={width}
    >
      {virtualItems.flatMap((item) =>
        rows[item.index].graph.segments.map((segment, segmentIndex) => (
          <GraphSegmentLine
            key={`${rows[item.index].commit.id}-${segmentIndex}`}
            rowStart={item.start - windowStart}
            segment={segment}
          />
        )),
      )}
      {virtualItems.map((item) => {
        const row = rows[item.index];
        return (
          <circle
            cx={laneX(row.graph.node.lane)}
            cy={item.start - windowStart + rowHeight / 2}
            fill={row.graph.node.color}
            key={`${row.commit.id}:node`}
            r="5"
            stroke="hsl(var(--card))"
            strokeWidth="2"
          />
        );
      })}
    </svg>
  );
}

function GraphSegmentLine({
  rowStart,
  segment,
}: {
  rowStart: number;
  segment: HistoryGraphSegment;
}) {
  return (
    <line
      stroke={segment.color}
      strokeLinecap="round"
      strokeWidth={segment.kind === "vertical" ? 2 : 2.5}
      x1={laneX(segment.fromLane)}
      x2={laneX(segment.toLane)}
      y1={rowStart + anchorY(segment.fromY)}
      y2={rowStart + anchorY(segment.toY)}
    />
  );
}

interface LoadedCommitDetails {
  body: string | null;
  bodyTruncated: boolean;
  files: HistoryCommit["changedFiles"];
  truncated: boolean;
}

type CommitDetailsLoadState =
  | { status: "loading" }
  | { status: "loaded"; value: LoadedCommitDetails }
  | { status: "error"; error: unknown };

type CommitFileLoadState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | {
      status: "loaded";
      key: string;
      content: DiffContent;
      payload: DiffPayload;
    }
  | { status: "error"; key: string; error: unknown };

function CommitDetailPanel({
  commit,
  detailsRepositoryPath,
  gravatarEnabled,
  hasRemote,
  now,
  onBeforeRevert,
  onOpenChange,
  onRevertAutoStash,
  onRevertStashRecovery,
  onWriteBusyChange,
  repositoryPath,
  returnFocusRef,
  setConflictEntered,
  writeDisabled,
}: {
  commit: HistoryCommit;
  detailsRepositoryPath: string | null;
  gravatarEnabled: boolean;
  hasRemote: boolean;
  now: string;
  onBeforeRevert?: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  onRevertAutoStash?: (operationId: string, stash: StashEntry) => void;
  onRevertStashRecovery?: (
    operationId: string,
    recovery: StashRecoveryPoint,
  ) => void;
  onWriteBusyChange?: (busy: boolean) => void;
  repositoryPath: string | null;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  setConflictEntered: (event: ConflictEnteredEvent) => void;
  writeDisabled: boolean;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const fixtureDetails = React.useMemo<LoadedCommitDetails>(
    () => ({
      body: commit.body ?? null,
      bodyTruncated: false,
      files: commit.changedFiles,
      truncated: false,
    }),
    [commit.body, commit.changedFiles],
  );
  const [detailsAttempt, setDetailsAttempt] = React.useState(0);
  const [remoteDetailsState, setDetailsState] =
    React.useState<CommitDetailsLoadState>({ status: "loading" });
  const detailsState: CommitDetailsLoadState = detailsRepositoryPath
    ? remoteDetailsState
    : { status: "loaded", value: fixtureDetails };
  const [selectedFile, setSelectedFile] = React.useState<{
    commitId: string;
    path: string | null;
  } | null>(null);
  const [revertTarget, setRevertTarget] = React.useState<HistoryCommit | null>(
    null,
  );
  const [revertBusy, setRevertBusy] = React.useState(false);
  const [revertError, setRevertError] = React.useState<string | null>(null);
  const [revertPushAfterRevert, setRevertPushAfterRevert] =
    React.useState(true);
  const [fileAttempt, setFileAttempt] = React.useState(0);
  const [fileState, setFileState] = React.useState<CommitFileLoadState>({
    status: "idle",
  });
  const [panelHeightPercent, setPanelHeightPercent] = React.useState(
    commitDetailDefaultHeightPercent,
  );
  const finishPanelResizeRef = React.useRef<(() => void) | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const dialogId = useModalLayer(panelRef, {
    onEscape: revertBusy ? undefined : () => onOpenChange(false),
    restoreFocusRef: returnFocusRef,
  });
  const activeRevertTarget =
    revertTarget && revertTarget.id === commit.id ? revertTarget : null;

  React.useEffect(
    () => () => {
      finishPanelResizeRef.current?.();
    },
    [],
  );

  React.useEffect(() => {
    if (!detailsRepositoryPath) {
      return;
    }

    let disposed = false;
    let settled = false;
    const operationId = createHistoryOperationId("commit-details");

    void commitDetails({
      limit: commitDetailFileLimit,
      oid: commit.id,
      operationId,
      repositoryPath: detailsRepositoryPath,
    })
      .then((response) => {
        if (response.oid !== commit.id) {
          throw new Error(
            "Commit details response did not match the requested commit.",
          );
        }
        settled = true;
        if (!disposed) {
          setDetailsState({
            status: "loaded",
            value: mapLoadedCommitDetails(response),
          });
        }
      })
      .catch((error: unknown) => {
        settled = true;
        if (!disposed && !isOperationCancelledError(error)) {
          setDetailsState({ error, status: "error" });
        }
      });

    return () => {
      disposed = true;
      if (!settled) {
        cancelHistoryReadOperation(
          operationId,
          "cancelCommitDetails",
          t("history.details.cancelFailed"),
        );
      }
    };
  }, [commit.id, detailsAttempt, detailsRepositoryPath, t]);

  React.useEffect(() => {
    onWriteBusyChange?.(revertBusy);
  }, [onWriteBusyChange, revertBusy]);

  React.useEffect(
    () => () => {
      onWriteBusyChange?.(false);
    },
    [onWriteBusyChange],
  );

  const closeRevertDialog = React.useCallback(
    (open: boolean) => {
      if (!open && !revertBusy) {
        setRevertTarget(null);
        setRevertError(null);
      }
    },
    [revertBusy],
  );

  const runRevert = React.useCallback(async () => {
    if (!activeRevertTarget || !repositoryPath || writeDisabled) {
      return;
    }

    setRevertBusy(true);
    setRevertError(null);

    try {
      await onBeforeRevert?.();

      const operationId = createHistoryOperationId("revert-commit");
      const response = await revertCommit({
        oid: activeRevertTarget.id,
        operationId,
        pushAfterRevert: hasRemote && revertPushAfterRevert,
        repositoryPath,
      });

      if (response.status === "reverted") {
        showToast({
          key: "history-revert-result",
          message: t(
            response.pushed
              ? "history.revert.revertedAndPushed"
              : "history.revert.reverted",
            {
              message: response.message,
              shortId: response.oid.slice(0, 7),
            },
          ),
          tone: "success",
        });
        setRevertTarget(null);
        return;
      }

      if (response.status === "disabled") {
        setRevertError(t(`history.revert.disabled.${response.reason}`));
        return;
      }

      if (response.stashRecovery) {
        onRevertStashRecovery?.(
          response.conflict.operationId,
          response.stashRecovery,
        );
      }
      if (response.autoStash) {
        onRevertAutoStash?.(response.conflict.operationId, response.autoStash);
      }
      setConflictEntered(response.conflict);
      setRevertTarget(null);
      onOpenChange(false);
    } catch (error) {
      setRevertError(t("history.revert.failed"));
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setRevertBusy(false);
    }
  }, [
    activeRevertTarget,
    hasRemote,
    onBeforeRevert,
    onOpenChange,
    onRevertAutoStash,
    onRevertStashRecovery,
    repositoryPath,
    revertPushAfterRevert,
    setConflictEntered,
    t,
    writeDisabled,
  ]);

  const loadedDetails =
    detailsState.status === "loaded" ? detailsState.value : null;
  const selectedPath =
    selectedFile?.commitId === commit.id ? selectedFile.path : null;
  const activeFile =
    loadedDetails?.files.find((file) => file.path === selectedPath) ??
    loadedDetails?.files[0] ??
    null;
  const activeFileKey = activeFile ? `${commit.id}\0${activeFile.path}` : null;

  React.useEffect(() => {
    if (!detailsRepositoryPath || !activeFile || !activeFileKey) {
      return;
    }

    let disposed = false;
    let settled = false;
    const operationId = createHistoryOperationId("commit-file-detail");
    const requestedPath = activeFile.path;

    void commitFileDetail({
      file: toCommitChangedFile(activeFile),
      oid: commit.id,
      operationId,
      repositoryPath: detailsRepositoryPath,
    })
      .then((response) => {
        if (
          response.oid !== commit.id ||
          response.file.path !== requestedPath
        ) {
          throw new Error(
            "File comparison response did not match the requested file.",
          );
        }
        settled = true;
        if (!disposed) {
          setFileState({
            content: response.diff,
            key: activeFileKey,
            payload: response.payload,
            status: "loaded",
          });
        }
      })
      .catch((error: unknown) => {
        settled = true;
        if (!disposed && !isOperationCancelledError(error)) {
          setFileState({ error, key: activeFileKey, status: "error" });
        }
      });

    return () => {
      disposed = true;
      if (!settled) {
        cancelHistoryReadOperation(
          operationId,
          "cancelCommitFileDetail",
          t("history.details.fileCancelFailed"),
        );
      }
    };
  }, [
    activeFile,
    activeFileKey,
    commit.id,
    detailsRepositoryPath,
    fileAttempt,
    t,
  ]);

  const copyCommitHash = async () => {
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard API is unavailable.");
      }
      await navigator.clipboard.writeText(commit.id);
      showToast({
        key: "history-copy-result",
        message: t("history.details.hashCopied"),
        tone: "success",
      });
    } catch (error) {
      const summary = t("history.details.hashCopyFailed");
      showToast({
        key: "history-copy-result",
        message: summary,
        tone: "error",
      });
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", {
          detail: {
            cause: error,
            operationName: "copyCommitHash",
            summary,
          },
        }),
      );
    }
  };

  const startPanelResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResizeRef.current?.();
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (window.innerHeight <= 0) {
          return;
        }

        const nextHeight =
          ((window.innerHeight - moveEvent.clientY) / window.innerHeight) * 100;
        setPanelHeightPercent(
          Math.min(
            commitDetailMaxHeightPercent,
            Math.max(
              commitDetailMinHeightPercent,
              Math.round(nextHeight * 10) / 10,
            ),
          ),
        );
      };
      let finished = false;
      const finishResize = () => {
        if (finished) {
          return;
        }
        finished = true;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", finishResize);
        window.removeEventListener("pointercancel", finishResize);
        window.removeEventListener("blur", finishResize);
        if (finishPanelResizeRef.current === finishResize) {
          finishPanelResizeRef.current = null;
        }
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finishResize);
      window.addEventListener("pointercancel", finishResize);
      window.addEventListener("blur", finishResize);
      finishPanelResizeRef.current = finishResize;
    },
    [],
  );

  return (
    <DialogLayerContext.Provider value={dialogId}>
      <div
        ref={panelRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="fixed inset-0 z-50 flex items-end bg-black/35 focus-visible:outline-none"
        role="dialog"
        tabIndex={-1}
      >
        <button
          aria-hidden="true"
          aria-label={t("history.details.close")}
          className="absolute inset-0 cursor-default"
          disabled={revertBusy}
          onClick={() => {
            if (!revertBusy) {
              onOpenChange(false);
            }
          }}
          tabIndex={-1}
          type="button"
        />
        <aside
          aria-busy={
            detailsState.status === "loading" ||
            Boolean(
              detailsRepositoryPath &&
              activeFileKey !== null &&
              (fileState.status === "idle" ||
                fileState.key !== activeFileKey ||
                fileState.status === "loading"),
            )
          }
          className="relative z-10 w-full bg-card shadow-floating"
          data-testid="history-commit-detail-panel"
          style={{ height: `${panelHeightPercent}vh` }}
        >
          <div
            aria-label={t("history.details.resize")}
            aria-orientation="horizontal"
            aria-valuemax={commitDetailMaxHeightPercent}
            aria-valuemin={commitDetailMinHeightPercent}
            aria-valuenow={panelHeightPercent}
            className="group absolute inset-x-0 top-0 z-20 h-2 -translate-y-1/2 touch-none cursor-row-resize"
            onPointerDown={startPanelResize}
            role="separator"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover:bg-ring"
            />
          </div>
          <div className="flex h-full flex-col">
            <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
              <div className="flex min-w-0 items-start gap-3">
                <Avatar
                  author={commit.author}
                  gravatarEnabled={gravatarEnabled}
                />
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold" id={titleId}>
                    {commit.message}
                  </h3>
                  <p
                    className="mt-1 truncate text-sm text-muted-foreground"
                    data-testid="history-commit-byline"
                    title={commit.author.name}
                  >
                    {commit.author.name} ·{" "}
                    <time dateTime={commit.authoredAt}>
                      {formatters.formatDate(commit.authoredAt, {
                        dateStyle: "full",
                        timeStyle: "long",
                      })}
                    </time>{" "}
                    · {formatters.formatRelativeTime(commit.authoredAt, now)}
                  </p>
                  {loadedDetails?.body ? (
                    <p
                      className="mt-2 max-h-24 max-w-3xl overflow-auto whitespace-pre-wrap pr-2 text-sm text-muted-foreground"
                      data-testid="history-commit-body"
                    >
                      {loadedDetails.body}
                      {loadedDetails.bodyTruncated ? (
                        <span className="mt-1 block text-xs">
                          {t("history.details.bodyTruncated")}
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  <CommitRefsBrowser refs={commit.refs} />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <RevertActionButton
                  busy={revertBusy}
                  commit={commit}
                  disabled={writeDisabled}
                  onClick={() => {
                    setRevertTarget(commit);
                    setRevertError(null);
                    setRevertPushAfterRevert(true);
                  }}
                  repositoryPath={repositoryPath}
                />
                <Button
                  className="gap-2"
                  onClick={() => void copyCommitHash()}
                  variant="secondary"
                >
                  <Copy className="size-4" />
                  {t("history.details.copyHash")}
                </Button>
                <IconButton
                  disabled={revertBusy}
                  label={t("history.details.close")}
                  onClick={() => {
                    if (!revertBusy) {
                      onOpenChange(false);
                    }
                  }}
                  variant="ghost"
                >
                  <X className="size-5" />
                </IconButton>
              </div>
            </header>
            <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
              {detailsState.status === "loading" ? (
                <CommitDetailStatus
                  message={t("history.details.loading")}
                  testId="history-details-loading"
                />
              ) : detailsState.status === "error" ? (
                <CommitDetailError
                  error={detailsState.error}
                  message={t("history.details.loadFailed")}
                  onRetry={() => {
                    setDetailsState({ status: "loading" });
                    setDetailsAttempt((value) => value + 1);
                  }}
                />
              ) : detailsState.value.files.length === 0 ? (
                <CommitDetailStatus
                  loading={false}
                  message={t("history.details.noChanges")}
                  testId="history-details-empty"
                />
              ) : (
                <>
                  <CommitChangedFilesList
                    activePath={activeFile?.path ?? null}
                    files={detailsState.value.files}
                    key={commit.id}
                    onSelect={(path) => {
                      setSelectedFile({ commitId: commit.id, path });
                    }}
                    truncated={detailsState.value.truncated}
                  />
                  <div className="flex min-w-0 p-4">
                    {activeFile && activeFileKey ? (
                      detailsRepositoryPath ? (
                        fileState.status === "loaded" &&
                        fileState.key === activeFileKey ? (
                          <DiffViewer
                            content={fileState.content}
                            payload={fileState.payload}
                            source="commitDetails"
                          />
                        ) : fileState.status === "error" &&
                          fileState.key === activeFileKey ? (
                          <CommitDetailError
                            compact
                            error={fileState.error}
                            message={t("history.details.fileLoadFailed")}
                            onRetry={() => {
                              setFileState({ status: "idle" });
                              setFileAttempt((value) => value + 1);
                            }}
                          />
                        ) : (
                          <CommitDetailStatus
                            compact
                            message={t("history.details.fileLoading")}
                            testId="history-file-detail-loading"
                          />
                        )
                      ) : (
                        <DiffViewer
                          content={createFixtureCommitDiffContent(activeFile)}
                          payload={createCommitDiffPayload(activeFile)}
                          source="commitDetails"
                        />
                      )
                    ) : (
                      <div className="flex h-full items-center justify-center rounded-md border bg-background p-6 text-center text-sm text-muted-foreground">
                        {t("history.details.noFile")}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>
        <RevertCommitDialog
          busy={revertBusy}
          commit={activeRevertTarget}
          error={activeRevertTarget ? revertError : null}
          hasRemote={hasRemote}
          onConfirm={() => void runRevert()}
          onOpenChange={closeRevertDialog}
          pushAfterRevert={revertPushAfterRevert}
          setPushAfterRevert={setRevertPushAfterRevert}
          writeDisabled={writeDisabled}
        />
      </div>
    </DialogLayerContext.Provider>
  );
}

function CommitDetailStatus({
  compact = false,
  loading = true,
  message,
  testId,
}: {
  compact?: boolean;
  loading?: boolean;
  message: string;
  testId: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 items-center justify-center p-6 text-center text-sm text-muted-foreground",
        !compact && "col-span-2",
      )}
      data-testid={testId}
      role="status"
    >
      <span className="inline-flex items-center gap-2">
        {loading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : null}
        {message}
      </span>
    </div>
  );
}

function CommitDetailError({
  compact = false,
  error,
  message,
  onRetry,
}: {
  compact?: boolean;
  error: unknown;
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex min-h-0 items-center justify-center p-6",
        compact && "h-full w-full",
        !compact && "col-span-2",
      )}
      role="alert"
    >
      <div className="w-full max-w-md space-y-4 rounded-md border bg-background p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="mt-0.5 size-5 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("artistic-git:error", { detail: error }),
              );
            }}
            type="button"
            variant="ghost"
          >
            {t("history.viewErrorDetails")}
          </Button>
          <Button className="gap-2" onClick={onRetry} type="button">
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("history.retryLoad")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommitChangedFilesList({
  activePath,
  files,
  onSelect,
  truncated,
}: {
  activePath: string | null;
  files: HistoryCommit["changedFiles"];
  onSelect: (path: string) => void;
  truncated: boolean;
}) {
  const { t } = useTranslation();
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [viewportHeight, measureViewport] = useObservedViewportHeight(
    viewportRef,
    fallbackChangedFileViewportHeight,
  );
  const virtual = useVirtualWindow({
    count: files.length,
    estimateSize: changedFileRowHeight,
    viewportHeight,
  });

  return (
    <div className="flex min-h-0 flex-col border-r">
      {truncated ? (
        <p className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("history.details.filesTruncated", { count: files.length })}
        </p>
      ) : null}
      <OverlayScrollArea
        className="min-h-0 flex-1"
        data-testid="history-detail-changed-files"
        onScroll={(event) => {
          measureViewport(event.currentTarget);
          virtual.onScroll(event);
        }}
        ref={viewportRef}
      >
        <div className="relative" style={{ height: virtual.totalSize }}>
          {virtual.items.map((item) => {
            const file = files[item.index];
            const modeChanged =
              file.oldMode !== undefined &&
              file.newMode !== undefined &&
              file.oldMode !== file.newMode;
            const changeSummary = modeChanged
              ? t("history.details.linesAndPermissionsChanged", {
                  additions: file.additions,
                  deletions: file.deletions,
                  newMode: file.newMode,
                  oldMode: file.oldMode,
                })
              : `+${file.additions} -${file.deletions}`;
            return (
              <button
                aria-current={activePath === file.path ? "true" : undefined}
                className={cn(
                  "absolute inset-x-0 flex w-full items-center gap-2 border-b px-4 text-left text-sm hover:bg-accent",
                  activePath === file.path && "bg-accent",
                )}
                data-testid="history-detail-changed-file"
                key={file.path}
                onClick={() => onSelect(file.path)}
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
                type="button"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <TruncatedText text={file.path} />
                  <TruncatedText
                    className="mt-0.5 text-xs text-muted-foreground"
                    text={changeSummary}
                  />
                </span>
              </button>
            );
          })}
        </div>
      </OverlayScrollArea>
    </div>
  );
}

function useObservedViewportHeight<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  fallbackHeight: number,
): [number, (element: T) => void] {
  const [height, setHeight] = React.useState(fallbackHeight);
  const measure = React.useCallback((element: T) => {
    const nextHeight = element.clientHeight;
    if (nextHeight > 0) {
      setHeight((current) => (current === nextHeight ? current : nextHeight));
    }
  }, []);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    measure(element);
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const nextHeight = entry?.contentRect.height ?? 0;
      if (nextHeight > 0) {
        setHeight((current) => (current === nextHeight ? current : nextHeight));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, ref]);

  return [height, measure];
}

function RevertActionButton({
  busy,
  commit,
  disabled,
  onClick,
  repositoryPath,
}: {
  busy: boolean;
  commit: HistoryCommit;
  disabled: boolean;
  onClick: () => void;
  repositoryPath: string | null;
}) {
  const { t } = useTranslation();
  const reason = getRevertUnavailableReason(commit, repositoryPath);
  const button = (describedBy?: string) => (
    <Button
      aria-describedby={describedBy}
      className="gap-2"
      data-testid="history-revert-open"
      disabled={busy || disabled || reason !== null}
      onClick={onClick}
      type="button"
      variant="secondary"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : null}
      {busy ? t("history.revert.busy") : t("history.details.revert")}
    </Button>
  );

  if (!reason) {
    return button();
  }

  return (
    <Tooltip content={t(`history.revert.disabled.${reason}`)}>
      {({ describedBy }) => button(describedBy)}
    </Tooltip>
  );
}

function RevertCommitDialog({
  busy,
  commit,
  error,
  hasRemote,
  onConfirm,
  onOpenChange,
  pushAfterRevert,
  setPushAfterRevert,
  writeDisabled,
}: {
  busy: boolean;
  commit: HistoryCommit | null;
  error: string | null;
  hasRemote: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  pushAfterRevert: boolean;
  setPushAfterRevert: (value: boolean) => void;
  writeDisabled: boolean;
}) {
  const { t } = useTranslation();

  if (!commit) {
    return null;
  }

  return (
    <DialogFrame
      description={t("history.revert.description", {
        message: commit.message,
        shortId: commit.shortId,
      })}
      dismissible={!busy}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="min-w-0 text-sm text-muted-foreground"
            data-testid="history-revert-status"
            role={busy ? "status" : undefined}
          >
            {busy ? t("history.revert.busy") : null}
          </span>
          <div className="flex items-center gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              className="gap-2"
              data-testid="history-revert-confirm"
              disabled={busy || writeDisabled}
              onClick={onConfirm}
              type="button"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {busy ? t("history.revert.busy") : t("history.revert.confirm")}
            </Button>
          </div>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("history.revert.title")}
    >
      <div className="flex gap-3 rounded-md border bg-background p-3 text-sm">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-2">
          <p>
            {t("history.revert.generatedMessage", {
              message: `Revert: ${commit.message}`,
            })}
          </p>
          <p className="text-muted-foreground">
            {t("history.revert.noRewrite")}
          </p>
        </div>
      </div>
      {hasRemote ? (
        <label className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <input
            checked={pushAfterRevert}
            className="size-4"
            data-testid="history-revert-push-immediately"
            disabled={busy || writeDisabled}
            onChange={(event) => {
              setPushAfterRevert(event.currentTarget.checked);
            }}
            type="checkbox"
          />
          <span>{t("history.revert.pushNow")}</span>
        </label>
      ) : null}
      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </DialogFrame>
  );
}

function mapLoadedCommitDetails(
  response: CommitDetailsResponse,
): LoadedCommitDetails {
  return {
    body: response.body,
    bodyTruncated: response.bodyTruncated,
    files: response.files.map(mapCommitChangedFile),
    truncated: response.truncated,
  };
}

function cancelHistoryReadOperation(
  operationId: string,
  operationName: string,
  summary: string,
): void {
  void cancelOperation({ operationId }).catch((error: unknown) => {
    window.dispatchEvent(
      new CustomEvent("artistic-git:error", {
        detail: { cause: error, operationName, summary },
      }),
    );
  });
}

function createFixtureCommitDiffContent(
  file: HistoryCommit["changedFiles"][number],
): DiffContent {
  if (
    file.changeKind === "renamed" &&
    file.additions === 0 &&
    file.deletions === 0
  ) {
    return { kind: "moved", message: null };
  }

  return {
    kind: "text",
    language: null,
    newText: file.changeKind === "deleted" ? null : (file.preview ?? file.path),
    oldText:
      file.changeKind === "added" ? null : (file.oldPath ?? file.preview ?? ""),
  };
}

function createCommitDiffPayload(
  file: HistoryCommit["changedFiles"][number],
): DiffPayload {
  return {
    changeKind: file.changeKind,
    fileKind: "text",
    lfsLock: null,
    metadata: {
      additions: String(file.additions),
      deletions: String(file.deletions),
      contentChanged:
        file.changeKind === "renamed" &&
        file.additions === 0 &&
        file.deletions === 0
          ? "false"
          : "true",
    },
    newPath: file.path,
    oldPath: file.oldPath ?? null,
  };
}

function getRevertUnavailableReason(
  commit: HistoryCommit,
  repositoryPath: string | null,
): RevertUnavailableReason | null {
  if (!repositoryPath) {
    return "missingRepository";
  }

  if (commit.parents.length > 1) {
    return "mergeCommit";
  }

  return null;
}

function laneX(lane: number): number {
  return graphLeftPadding + lane * graphLaneWidth;
}

function anchorY(anchor: GraphAnchor): number {
  if (anchor === "top") {
    return 0;
  }
  if (anchor === "middle") {
    return rowHeight / 2;
  }
  return rowHeight;
}
