import {
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

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { TruncatedText } from "@/components/ui/truncated-text";
import { useLocalizedFormatters } from "@/i18n/format";
import { cn } from "@/lib/utils";

import { resolveAvatarPresentation } from "./avatar";
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
} from "./types";
import { useVirtualWindow } from "./useVirtualWindow";

const rowHeight = 72;
const viewportHeight = 504;
const graphLaneWidth = 18;
const graphLeftPadding = 14;

interface HistoryWorkbenchProps {
  branches?: HistoryBranch[];
  gravatarEnabled?: boolean;
  now?: string;
  rows?: HistoryRow[];
  searchSource?: HistorySearchSource;
}

interface SearchResultSnapshot {
  commits: HistoryCommit[];
  query: string;
}

export function HistoryWorkbench({
  branches = mockHistoryBranches,
  gravatarEnabled = false,
  now = "2026-07-07T06:30:00Z",
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
  const [searchingQuery, setSearchingQuery] = React.useState<string | null>(null);
  const [searchResults, setSearchResults] =
    React.useState<SearchResultSnapshot | null>(null);
  const [selectedCommitId, setSelectedCommitId] = React.useState<string | null>(
    null,
  );
  const source = React.useMemo(
    () =>
      searchSource ??
      createMockHistorySearchSource(rows.map((row) => row.commit)),
    [rows, searchSource],
  );

  React.useEffect(() => {
    if (!trimmedQuery) {
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setSearchingQuery(trimmedQuery);
      source(trimmedQuery, controller.signal)
        .then((result) => {
          setSearchResults({ commits: result.commits, query: trimmedQuery });
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            setSearchResults({ commits: [], query: trimmedQuery });
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSearchingQuery((current) =>
              current === trimmedQuery ? null : current,
            );
          }
        });
    }, 220);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [trimmedQuery, source]);

  const activeSearchResults =
    trimmedQuery && searchResults?.query === trimmedQuery
      ? searchResults.commits
      : null;
  const isSearching = Boolean(trimmedQuery) && searchingQuery === trimmedQuery;

  const visibleRows = React.useMemo(() => {
    const searchedIds =
      activeSearchResults === null
        ? null
        : new Map(activeSearchResults.map((commit) => [commit.id, commit]));
    const branchFilteredRows = rows.filter((row) =>
      matchesBranchFilter(row.commit, branchMode, selectedBranches),
    );

    if (!searchedIds) {
      return branchFilteredRows;
    }

    return branchFilteredRows
      .map((row) => {
        const commit = searchedIds.get(row.commit.id);
        return commit ? { ...row, commit } : null;
      })
      .filter((row): row is HistoryRow => Boolean(row));
  }, [activeSearchResults, branchMode, rows, selectedBranches]);

  const virtual = useVirtualWindow({
    count: visibleRows.length,
    estimateSize: rowHeight,
    viewportHeight,
  });
  const selectedCommit =
    rows.find((row) => row.commit.id === selectedCommitId)?.commit ?? null;

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
              onChange={(event) => {
                setQuery(event.target.value);
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
        onScroll={virtual.onScroll}
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
        {visibleRows.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {t("history.empty")}
          </div>
        ) : null}
      </div>

      <CommitDetailPanel
        commit={selectedCommit}
        gravatarEnabled={gravatarEnabled}
        now={now}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedCommitId(null);
          }
        }}
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
  now,
  onOpenChange,
}: {
  commit: HistoryCommit | null;
  gravatarEnabled: boolean;
  now: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const [selectedFile, setSelectedFile] = React.useState<{
    commitId: string;
    path: string | null;
  } | null>(null);

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
              <Button className="gap-2" disabled variant="secondary">
                {t("history.details.revert")}
              </Button>
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
              <div className="flex h-full flex-col rounded-md border bg-background">
                <div className="border-b px-4 py-3 text-sm font-medium">
                  {activeFile?.path ?? t("history.details.noFile")}
                </div>
                <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {t("history.details.diffPlaceholder")}
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
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
