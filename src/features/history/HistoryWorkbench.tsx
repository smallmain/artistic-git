import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  Search,
  Tag,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/truncated-text";
import { DiffViewer } from "@/features/diff";
import { useLocalizedFormatters } from "@/i18n/format";
import { logPage, revertCommit, searchLog } from "@/lib/ipc/commands";
import type {
  ConflictEnteredEvent,
  CommitSummary,
  DiffPayload,
  LogPageResponse,
  RevertDisabledReason,
  StashEntry,
  StashRecoveryPoint,
} from "@/lib/ipc/generated";
import { repoQueryKeys } from "@/lib/realtime/query-keys";
import { cn } from "@/lib/utils";
import { useWindowStore } from "@/store/window-store";

import { resolveAvatarPresentation } from "./avatar";
import {
  attachGraphRows,
  mapCommitSummaryToHistoryCommit,
  mergeHistoryCommits,
} from "./history-data";
import {
  createMockHistorySearchSource,
  type HistorySearchSource,
} from "./history-search";
import { mockHistoryBranches, mockHistoryRows } from "./fixtures";
import type {
  BranchFilterMode,
  GraphAnchor,
  HistoryBranch,
  HistoryCommit,
  HistoryGraphSegment,
  HistoryRow,
  HistorySearchMatch,
} from "./types";
import { useVirtualWindow } from "./useVirtualWindow";

const rowHeight = 72;
const viewportHeight = 504;
const graphLaneWidth = 18;
const graphLeftPadding = 14;
const historyPageSize = 200;
const loadMoreThresholdPx = rowHeight * 4;
type RevertUnavailableReason = RevertDisabledReason | "missingRepository";

interface HistoryWorkbenchProps {
  branches?: HistoryBranch[];
  gravatarEnabled?: boolean;
  hasRemote?: boolean;
  historyRepositoryPath?: string | null;
  now?: string;
  onBeforeRevert?: () => Promise<void> | void;
  onRevertAutoStash?: (operationId: string, stash: StashEntry) => void;
  onRevertStashRecovery?: (
    operationId: string,
    recovery: StashRecoveryPoint,
  ) => void;
  onWriteBusyChange?: (busy: boolean) => void;
  rows?: HistoryRow[];
  searchSource?: HistorySearchSource;
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
}: {
  cursor: BackendSearchCursor;
  limit: number;
  query: string;
  repositoryPath: string;
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

      return searchLog({
        ...spec.request,
        after: spec.after,
        limit,
        repositoryPath,
      });
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
  branches = mockHistoryBranches,
  gravatarEnabled = false,
  hasRemote = true,
  historyRepositoryPath = null,
  now = "2026-07-07T06:30:00Z",
  onBeforeRevert,
  onRevertAutoStash,
  onRevertStashRecovery,
  onWriteBusyChange,
  rows = mockHistoryRows,
  searchSource,
}: HistoryWorkbenchProps) {
  const { t } = useTranslation();
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
    getNextPageParam: (lastPage) => lastPage.nextAfter ?? undefined,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      logPage({
        after: pageParam,
        limit: historyPageSize,
        repositoryPath: historyRepositoryPath ?? "",
      }),
    queryKey: [
      ...repoQueryKeys.history(historyRepositoryPath ?? "__none__"),
      "pages",
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
    getNextPageParam: (lastPage: BackendSearchPage) =>
      lastPage.nextCursor ?? undefined,
    initialPageParam: {
      author: null,
      authorDone: false,
      content: null,
      contentDone: false,
      message: null,
      messageDone: false,
    } satisfies BackendSearchCursor,
    queryFn: ({ pageParam }) =>
      loadBackendSearchPage({
        cursor: pageParam,
        limit: historyPageSize,
        query: effectiveSearchTerm,
        repositoryPath: historyRepositoryPath ?? "",
      }),
    queryKey: [
      ...repoQueryKeys.history(historyRepositoryPath ?? "__none__"),
      "search",
      effectiveSearchTerm,
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

  const backendRows = React.useMemo(() => {
    if (!backendHistoryEnabled || !historyQuery.data) {
      return null;
    }

    return attachGraphRows(
      historyQuery.data.pages
        .flatMap((page) => page.commits)
        .map((commit) => mapCommitSummaryToHistoryCommit(commit)),
    );
  }, [backendHistoryEnabled, historyQuery.data]);

  const backendSearchRows = React.useMemo(() => {
    if (!backendHistoryEnabled || !backendSearchQuery.data) {
      return null;
    }

    return attachGraphRows(
      mergeHistoryCommits(
        backendSearchQuery.data.pages.flatMap((page) => page.commits),
      ),
    );
  }, [backendHistoryEnabled, backendSearchQuery.data]);

  const effectiveRows = backendRows ?? rows;
  const activeSearchRows = React.useMemo(() => {
    if (backendHistoryEnabled) {
      return effectiveSearchTerm ? (backendSearchRows ?? []) : null;
    }

    if (activeSearchResults === null) {
      return null;
    }

    const searchedIds = new Map(
      activeSearchResults.map((commit) => [commit.id, commit]),
    );
    return rows
      .map((row) => {
        const commit = searchedIds.get(row.commit.id);
        return commit ? { ...row, commit } : null;
      })
      .filter((row): row is HistoryRow => Boolean(row));
  }, [
    activeSearchResults,
    backendHistoryEnabled,
    backendSearchRows,
    effectiveSearchTerm,
    rows,
  ]);

  const visibleRows = React.useMemo(() => {
    const sourceRows = activeSearchRows ?? effectiveRows;
    return sourceRows.filter((row) =>
      matchesBranchFilter(row.commit, branchMode, selectedBranches),
    );
  }, [activeSearchRows, branchMode, effectiveRows, selectedBranches]);

  const virtual = useVirtualWindow({
    count: visibleRows.length,
    estimateSize: rowHeight,
    viewportHeight,
  });
  const canLoadMore = backendHistoryEnabled
    ? effectiveSearchTerm
      ? backendSearchQuery.hasNextPage
      : historyQuery.hasNextPage
    : false;
  const isFetchingNextPage = backendHistoryEnabled
    ? effectiveSearchTerm
      ? backendSearchQuery.isFetchingNextPage
      : historyQuery.isFetchingNextPage
    : false;
  const isInitialHistoryLoading =
    backendHistoryEnabled &&
    (effectiveSearchTerm
      ? backendSearchQuery.isLoading
      : historyQuery.isLoading);
  const historyLoadError =
    backendHistoryEnabled &&
    (effectiveSearchTerm ? backendSearchQuery.isError : historyQuery.isError);
  const fetchNextPage = effectiveSearchTerm
    ? backendSearchQuery.fetchNextPage
    : historyQuery.fetchNextPage;
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const maybeLoadNextPage = React.useCallback(
    (element: HTMLElement) => {
      if (!backendHistoryEnabled || !canLoadMore || isFetchingNextPage) {
        return;
      }

      const remaining =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      if (remaining <= loadMoreThresholdPx) {
        void fetchNextPage();
      }
    },
    [backendHistoryEnabled, canLoadMore, fetchNextPage, isFetchingNextPage],
  );
  const handleScroll = React.useCallback<React.UIEventHandler<HTMLDivElement>>(
    (event) => {
      virtual.onScroll(event);
      maybeLoadNextPage(event.currentTarget);
    },
    [maybeLoadNextPage, virtual],
  );
  React.useEffect(() => {
    const element = scrollContainerRef.current;
    if (element) {
      maybeLoadNextPage(element);
    }
  }, [maybeLoadNextPage, visibleRows.length]);
  const selectedCommit =
    [...(activeSearchRows ?? []), ...effectiveRows].find(
      (row) => row.commit.id === selectedCommitId,
    )?.commit ?? null;

  return (
    <section
      aria-label={t("history.title")}
      className="flex min-h-[660px] min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
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
            branches={branches}
            mode={branchMode}
            onModeChange={setBranchMode}
            onSelectedBranchesChange={setSelectedBranches}
            selectedBranches={selectedBranches}
          />
          <label className="relative flex min-w-[240px] max-w-sm flex-1 items-center">
            <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
            <input
              aria-label={t("history.search.label")}
              className="h-9 w-full rounded-md border bg-background pl-9 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-app-search="current"
              onChange={(event) => {
                const nextQuery = event.target.value;
                setQuery(nextQuery);
                if (!nextQuery.trim()) {
                  setDebouncedQuery("");
                  setSearchResults(null);
                }
              }}
              placeholder={t("history.search.placeholder")}
              value={query}
            />
            {isSearching ? (
              <Loader2 className="absolute right-3 size-4 animate-spin text-muted-foreground" />
            ) : query ? (
              <IconButton
                className="absolute right-1 size-7"
                label={t("history.search.clear")}
                onClick={() => {
                  setQuery("");
                  setDebouncedQuery("");
                  setSearchResults(null);
                }}
                tooltip={t("history.search.clear")}
                variant="ghost"
              >
                <X className="size-4" />
              </IconButton>
            ) : null}
          </label>
        </div>
      </header>

      <div className="grid border-b bg-muted/35 px-4 py-2 text-xs font-medium text-muted-foreground [grid-template-columns:112px_minmax(0,1fr)_180px_140px]">
        <span>{t("history.columns.graph")}</span>
        <span>{t("history.columns.commit")}</span>
        <span>{t("history.columns.author")}</span>
        <span>{t("history.columns.time")}</span>
      </div>

      <div
        className="relative flex-1 overflow-auto"
        data-testid="history-scroll-viewport"
        onScroll={handleScroll}
        ref={scrollContainerRef}
        style={{ height: viewportHeight }}
      >
        <div className="relative" style={{ height: virtual.totalSize }}>
          {virtual.items.map((item) => {
            const row = visibleRows[item.index];
            return (
              <HistoryCommitRow
                gravatarEnabled={gravatarEnabled}
                key={row.commit.id}
                now={now}
                onSelect={setSelectedCommitId}
                row={row}
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
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
        {visibleRows.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {historyLoadError
              ? t("history.loadError")
              : isInitialHistoryLoading
                ? t("history.loading")
                : t("history.empty")}
          </div>
        ) : null}
      </div>

      <CommitDetailPanel
        commit={selectedCommit}
        gravatarEnabled={gravatarEnabled}
        hasRemote={hasRemote}
        now={now}
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
        setConflictEntered={setConflictEntered}
      />
    </section>
  );
}

function BranchFilter({
  branches,
  mode,
  onModeChange,
  onSelectedBranchesChange,
  selectedBranches,
}: {
  branches: HistoryBranch[];
  mode: BranchFilterMode;
  onModeChange: (mode: BranchFilterMode) => void;
  onSelectedBranchesChange: (selected: Set<string>) => void;
  selectedBranches: Set<string>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const label =
    mode === "all"
      ? t("history.filters.all")
      : mode === "auto"
        ? t("history.filters.auto")
        : t("history.filters.custom", { count: selectedBranches.size });

  return (
    <div className="relative">
      <Button
        className="gap-2"
        onClick={() => {
          setOpen((value) => !value);
        }}
        type="button"
        variant="secondary"
      >
        <GitBranch className="size-4" />
        {label}
        <ChevronDown className="size-4" />
      </Button>
      {open ? (
        <div className="absolute left-0 top-11 z-20 w-72 rounded-md border bg-card p-2 shadow-floating">
          <FilterOption
            checked={mode === "auto"}
            label={t("history.filters.auto")}
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
          {branches.map((branch) => (
            <FilterOption
              checked={selectedBranches.has(branch.name)}
              key={branch.name}
              label={
                branch.current
                  ? `${branch.name} • ${t("history.filters.current")}`
                  : branch.name
              }
              onSelect={() => {
                const next = new Set(selectedBranches);
                if (next.has(branch.name)) {
                  next.delete(branch.name);
                } else {
                  next.add(branch.name);
                }
                onSelectedBranchesChange(next);
                onModeChange(next.size === 0 ? "auto" : "custom");
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterOption({
  checked,
  label,
  onSelect,
}: {
  checked: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
      onClick={onSelect}
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
}: {
  gravatarEnabled: boolean;
  now: string;
  onSelect: (commitId: string) => void;
  row: HistoryRow;
  style: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const { commit } = row;

  return (
    <button
      className="absolute left-0 right-0 grid border-b bg-card px-4 text-left transition-colors hover:bg-accent/45 [grid-template-columns:112px_minmax(0,1fr)_180px_140px]"
      onClick={() => {
        onSelect(commit.id);
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
            {commit.refs.map((ref) => (
              <RefBadge key={`${ref.type}:${ref.name}`} refItem={ref} />
            ))}
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

function RefBadge({ refItem }: { refItem: HistoryCommit["refs"][number] }) {
  const isTag = refItem.type === "tag";
  return (
    <span
      className={cn(
        "inline-flex max-w-44 items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
        isTag ? "bg-warning/20 text-foreground" : "bg-sync/15 text-foreground",
      )}
    >
      {isTag ? (
        <Tag className="size-3 shrink-0" />
      ) : (
        <GitBranch className="size-3 shrink-0" />
      )}
      <span className="truncate">{refItem.name}</span>
    </span>
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
  const height = rows.length * rowHeight;

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-4 top-0"
      height={height}
      width={width}
    >
      {virtualItems.flatMap((item) =>
        rows[item.index].graph.segments.map((segment, segmentIndex) => (
          <GraphSegmentLine
            key={`${rows[item.index].commit.id}-${segmentIndex}`}
            rowStart={item.start}
            segment={segment}
          />
        )),
      )}
      {virtualItems.map((item) => {
        const row = rows[item.index];
        return (
          <circle
            cx={laneX(row.graph.node.lane)}
            cy={item.start + rowHeight / 2}
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

function CommitDetailPanel({
  commit,
  gravatarEnabled,
  hasRemote,
  now,
  onBeforeRevert,
  onOpenChange,
  onRevertAutoStash,
  onRevertStashRecovery,
  onWriteBusyChange,
  repositoryPath,
  setConflictEntered,
}: {
  commit: HistoryCommit | null;
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
  setConflictEntered: (event: ConflictEnteredEvent) => void;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
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
  const [revertStatus, setRevertStatus] = React.useState<string | null>(null);
  const activeRevertTarget =
    revertTarget && revertTarget.id === commit?.id ? revertTarget : null;

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
        setRevertStatus(null);
      }
    },
    [revertBusy],
  );

  const runRevert = React.useCallback(async () => {
    if (!activeRevertTarget || !repositoryPath) {
      return;
    }

    setRevertBusy(true);
    setRevertError(null);
    setRevertStatus(null);

    try {
      await onBeforeRevert?.();

      const response = await revertCommit({
        oid: activeRevertTarget.id,
        pushAfterRevert: hasRemote && revertPushAfterRevert,
        repositoryPath,
      });

      if (response.status === "reverted") {
        setRevertStatus(
          t(
            response.pushed
              ? "history.revert.revertedAndPushed"
              : "history.revert.reverted",
            {
              message: response.message,
              shortId: response.oid.slice(0, 7),
            },
          ),
        );
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
      setRevertError(getErrorSummary(error));
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
  ]);

  if (!commit) {
    return null;
  }

  const selectedPath =
    selectedFile?.commitId === commit.id ? selectedFile.path : null;
  const activeFile =
    commit.changedFiles.find((file) => file.path === selectedPath) ??
    commit.changedFiles[0] ??
    null;

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/35">
      <button
        aria-label={t("history.details.close")}
        className="absolute inset-0 cursor-default"
        onClick={() => {
          onOpenChange(false);
        }}
        type="button"
      />
      <aside className="relative z-10 h-[68vh] w-full border-t bg-card shadow-floating">
        <div className="flex h-full flex-col">
          <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div className="flex min-w-0 items-start gap-3">
              <Avatar
                author={commit.author}
                gravatarEnabled={gravatarEnabled}
              />
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold">
                  {commit.message}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {commit.author.name} ·{" "}
                  <time dateTime={commit.authoredAt}>
                    {formatters.formatDate(commit.authoredAt, {
                      dateStyle: "full",
                      timeStyle: "long",
                    })}
                  </time>{" "}
                  · {formatters.formatRelativeTime(commit.authoredAt, now)}
                </p>
                {commit.body ? (
                  <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                    {commit.body}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <RevertActionButton
                busy={revertBusy}
                commit={commit}
                onClick={() => {
                  setRevertTarget(commit);
                  setRevertError(null);
                  setRevertPushAfterRevert(true);
                  setRevertStatus(null);
                }}
                repositoryPath={repositoryPath}
              />
              <Button
                className="gap-2"
                onClick={() => void navigator.clipboard?.writeText(commit.id)}
                variant="secondary"
              >
                <Copy className="size-4" />
                {t("history.details.copyHash")}
              </Button>
              <IconButton
                label={t("history.details.close")}
                onClick={() => {
                  onOpenChange(false);
                }}
                variant="ghost"
              >
                <X className="size-5" />
              </IconButton>
            </div>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
            <div className="min-h-0 overflow-auto border-r">
              {commit.changedFiles.map((file) => (
                <button
                  className={cn(
                    "flex w-full items-center gap-2 border-b px-4 py-3 text-left text-sm hover:bg-accent",
                    activeFile?.path === file.path && "bg-accent",
                  )}
                  key={file.path}
                  onClick={() => {
                    setSelectedFile({ commitId: commit.id, path: file.path });
                  }}
                  type="button"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <TruncatedText text={file.path} />
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      +{file.additions} -{file.deletions}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <div className="min-w-0 p-4">
              {activeFile ? (
                <DiffViewer
                  content={{
                    kind:
                      activeFile.changeKind === "renamed" &&
                      activeFile.additions === 0 &&
                      activeFile.deletions === 0
                        ? "moved"
                        : "text",
                    newText: activeFile.preview ?? activeFile.path,
                    oldText: activeFile.oldPath ?? activeFile.preview ?? "",
                  }}
                  payload={createCommitDiffPayload(activeFile)}
                  source="commitDetails"
                />
              ) : (
                <div className="flex h-full items-center justify-center rounded-md border bg-background p-6 text-center text-sm text-muted-foreground">
                  {t("history.details.noFile")}
                </div>
              )}
            </div>
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
        status={activeRevertTarget ? revertStatus : null}
      />
    </div>
  );
}

function RevertActionButton({
  busy,
  commit,
  onClick,
  repositoryPath,
}: {
  busy: boolean;
  commit: HistoryCommit;
  onClick: () => void;
  repositoryPath: string | null;
}) {
  const { t } = useTranslation();
  const reason = getRevertUnavailableReason(commit, repositoryPath);
  const button = (describedBy?: string) => (
    <Button
      aria-describedby={describedBy}
      className="gap-2"
      disabled={busy || reason !== null}
      onClick={onClick}
      type="button"
      variant="secondary"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : null}
      {t("history.details.revert")}
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
  status,
}: {
  busy: boolean;
  commit: HistoryCommit | null;
  error: string | null;
  hasRemote: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  pushAfterRevert: boolean;
  setPushAfterRevert: (value: boolean) => void;
  status: string | null;
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
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="min-w-0 text-sm text-muted-foreground">
            {busy ? t("history.revert.busy") : status}
          </span>
          <div className="flex items-center gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {status ? t("actions.close") : t("actions.cancel")}
            </Button>
            <Button
              className="gap-2"
              disabled={busy || status !== null}
              onClick={onConfirm}
              type="button"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("history.revert.confirm")}
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
            disabled={busy || status !== null}
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

function getErrorSummary(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "summary" in error &&
    typeof error.summary === "string"
  ) {
    return error.summary;
  }

  return "Unknown error";
}

function matchesBranchFilter(
  commit: HistoryCommit,
  mode: BranchFilterMode,
  selectedBranches: Set<string>,
): boolean {
  if (mode === "all") {
    return true;
  }

  const branchRefs = commit.refs
    .filter((ref) => ref.type === "branch")
    .map((ref) => ref.name);

  if (mode === "auto") {
    return (
      branchRefs.length === 0 || branchRefs.some((name) => name === "main")
    );
  }

  return branchRefs.some((name) => selectedBranches.has(name));
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
