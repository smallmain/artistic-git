import {
  AlertTriangle,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  GitCommit,
  List,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Square,
  Undo2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { IconButton } from "@/components/ui/icon-button";
import { OverlayScrollArea } from "@/components/ui/overlay-scroll-area";
import { DiffViewer } from "@/features/diff";
import { cn } from "@/lib/utils";

import {
  buildChangeTree,
  collectTreeItemIds,
  filterChanges,
  formatChangePath,
  getCheckState,
  isDeferredLocalChange,
  parentPath,
  type CheckState,
  type TreeNode,
} from "./local-change-utils";
import type {
  LocalChangeItem,
  LocalChangesPanelProps,
  LocalChangesViewMode,
} from "./types";

const defaultStorageKey = "artistic-git.local-changes.view-mode";
const changeRenderPageSize = 250;

export function LocalChangesPanel({
  busy = false,
  changes,
  detailState,
  error,
  initialCheckedIds = [],
  loadDeferredDetails = false,
  loading = false,
  onCheckedChange,
  onCommit,
  onSelectedChange,
  onPreviewRenormalize,
  onRetry,
  onRetryDetail,
  onRestore,
  onStash,
  onViewModeChange,
  renormalizePreviewBusy = false,
  renormalizePreviewStatus = null,
  renormalizeSuggestion = null,
  selectedId,
  storageKey = defaultStorageKey,
  viewMode,
}: LocalChangesPanelProps) {
  const { t } = useTranslation();
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(
    () => new Set(initialCheckedIds),
  );
  const [internalSelectedId, setInternalSelectedId] = React.useState<
    string | null
  >(selectedId ?? changes[0]?.id ?? null);
  const [searchTerm, setSearchTerm] = React.useState("");
  const [internalViewMode, setInternalViewMode] =
    React.useState<LocalChangesViewMode>(
      () => viewMode ?? readViewMode(storageKey),
    );
  const [contextMenu, setContextMenu] = React.useState<{
    busyEpoch: object;
    ids: string[];
    returnFocusTo: HTMLElement;
    x: number;
    y: number;
  } | null>(null);
  const [renderPage, setRenderPage] = React.useState<{
    changes: LocalChangeItem[];
    pageIndex: number;
    searchTerm: string;
    viewMode: LocalChangesViewMode;
  } | null>(null);
  const changeListRef = React.useRef<HTMLDivElement>(null);
  const contextMenuBusyEpoch = React.useMemo(() => ({ busy }), [busy]);
  const hasError = error !== null && error !== undefined;

  const effectiveSelectedId = selectedId ?? internalSelectedId;
  const effectiveViewMode = viewMode ?? internalViewMode;
  const filteredChanges = React.useMemo(
    () => filterChanges(changes, searchTerm),
    [changes, searchTerm],
  );
  const renderPageMatches =
    renderPage?.changes === changes &&
    renderPage.searchTerm === searchTerm &&
    renderPage.viewMode === effectiveViewMode;
  const renderPageCount = Math.max(
    1,
    Math.ceil(filteredChanges.length / changeRenderPageSize),
  );
  const renderPageIndex = renderPageMatches
    ? Math.min(renderPage.pageIndex, renderPageCount - 1)
    : 0;
  const renderPageStart = renderPageIndex * changeRenderPageSize;
  const renderedChanges = filteredChanges.slice(
    renderPageStart,
    renderPageStart + changeRenderPageSize,
  );
  const selectedChange =
    filteredChanges.find((change) => change.id === effectiveSelectedId) ??
    filteredChanges[0] ??
    null;
  const loadSelectedDetail =
    loadDeferredDetails && isDeferredLocalChange(selectedChange);
  const detailMatchesSelection = detailState?.selectedId === selectedChange?.id;
  const detailLoading =
    loadSelectedDetail &&
    (!detailMatchesSelection || detailState?.loading === true);
  const detailError =
    loadSelectedDetail && detailMatchesSelection
      ? (detailState?.error ?? null)
      : null;
  const loadedDetailChange =
    loadSelectedDetail && detailMatchesSelection
      ? (detailState?.change ?? null)
      : null;
  const previewChange = loadedDetailChange ?? selectedChange;
  const visibleIds = filteredChanges.map((change) => change.id);
  const allCheckState = getCheckState(visibleIds, checkedIds);

  React.useEffect(() => {
    onCheckedChange?.(Array.from(checkedIds));
  }, [checkedIds, onCheckedChange]);

  React.useEffect(() => {
    onSelectedChange?.(selectedChange);
  }, [onSelectedChange, selectedChange]);

  const updateViewMode = (mode: LocalChangesViewMode) => {
    if (viewMode === undefined) {
      setInternalViewMode(mode);
      window.localStorage.setItem(storageKey, mode);
    }
    onViewModeChange?.(mode);
  };

  const toggleIds = (ids: string[], checked: boolean) => {
    setCheckedIds((current) => {
      const next = new Set(current);

      for (const id of ids) {
        if (checked) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }

      return next;
    });
  };

  const openContextMenu = (event: React.MouseEvent, fallbackIds: string[]) => {
    event.preventDefault();
    if (busy) {
      setContextMenu(null);
      return;
    }

    const selectedIds = Array.from(checkedIds);
    setContextMenu({
      busyEpoch: contextMenuBusyEpoch,
      ids: selectedIds.length > 0 ? selectedIds : fallbackIds,
      returnFocusTo:
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget
          : document.body,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const showErrorDetails = () => {
    window.dispatchEvent(
      new CustomEvent("artistic-git:error", { detail: error }),
    );
  };

  return (
    <section
      aria-busy={loading}
      className="relative grid h-full min-h-0 grid-cols-[360px_minmax(0,1fr)] overflow-hidden border bg-background"
      data-testid="local-changes-panel"
    >
      {hasError ? (
        <div
          className="col-span-2 flex min-h-0 items-center justify-center p-6"
          role="alert"
        >
          <div className="w-full max-w-md space-y-4 rounded-md border bg-card p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="mt-0.5 size-5 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">
                  {t("localChanges.loadFailedTitle")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("localChanges.loadFailedDescription")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={showErrorDetails} type="button" variant="ghost">
                {t("localChanges.viewErrorDetails")}
              </Button>
              <Button className="gap-2" onClick={onRetry} type="button">
                <RefreshCw className="size-4" aria-hidden="true" />
                {t("localChanges.retryLoading")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <aside
            className="flex min-h-0 flex-col border-r bg-card"
            inert={loading}
          >
            <header className="space-y-3 border-b p-3">
              <div className="flex items-center justify-between gap-2">
                <TriStateCheckbox
                  ariaLabel={t("localChanges.selectAll")}
                  checkState={allCheckState}
                  onChange={(checked) => toggleIds(visibleIds, checked)}
                />
                <div className="flex items-center gap-1">
                  <IconButton
                    aria-pressed={effectiveViewMode === "flat"}
                    label={t("localChanges.flatView")}
                    onClick={() => updateViewMode("flat")}
                    tooltip={t("localChanges.flatView")}
                    variant={
                      effectiveViewMode === "flat" ? "secondary" : "ghost"
                    }
                  >
                    <List className="size-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    aria-pressed={effectiveViewMode === "tree"}
                    label={t("localChanges.treeView")}
                    onClick={() => updateViewMode("tree")}
                    tooltip={t("localChanges.treeView")}
                    variant={
                      effectiveViewMode === "tree" ? "secondary" : "ghost"
                    }
                  >
                    <FolderTree className="size-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
              <label className="flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm">
                <Search
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  aria-label={t("localChanges.search")}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  data-app-search="current"
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={t("localChanges.search")}
                  value={searchTerm}
                />
              </label>
              {renormalizeSuggestion ? (
                <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  <div className="space-y-1">
                    <p className="font-medium text-warning">
                      {t("localChanges.renormalizeTitle")}
                    </p>
                    <p className="text-muted-foreground">
                      {t("localChanges.renormalizeDescription", {
                        count: renormalizeSuggestion.totalChanges,
                      })}
                    </p>
                  </div>
                  {renormalizeSuggestion.samplePaths.length > 0 ? (
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {renormalizeSuggestion.samplePaths.join(", ")}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      className="gap-2"
                      disabled={busy || renormalizePreviewBusy}
                      onClick={onPreviewRenormalize}
                      type="button"
                      variant="secondary"
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      {renormalizePreviewBusy
                        ? t("localChanges.renormalizePreviewBusy")
                        : t("localChanges.renormalizePreview")}
                    </Button>
                    {renormalizePreviewStatus ? (
                      <span className="text-xs text-muted-foreground">
                        {renormalizePreviewStatus}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </header>

            <OverlayScrollArea className="min-h-0 flex-1" ref={changeListRef}>
              {filteredChanges.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {t("localChanges.empty")}
                </div>
              ) : effectiveViewMode === "flat" ? (
                <FlatChangeList
                  changes={renderedChanges}
                  checkedIds={checkedIds}
                  onContextMenu={openContextMenu}
                  onSelect={setInternalSelectedId}
                  onToggle={toggleIds}
                  selectedId={selectedChange?.id ?? null}
                />
              ) : (
                <TreeChangeList
                  changes={renderedChanges}
                  checkedIds={checkedIds}
                  onContextMenu={openContextMenu}
                  onSelect={setInternalSelectedId}
                  onToggle={toggleIds}
                  selectedId={selectedChange?.id ?? null}
                />
              )}
              {renderPageCount > 1 ? (
                <div className="flex items-center justify-between gap-2 border-t p-2">
                  <Button
                    aria-label={t("localChanges.previousPage")}
                    disabled={renderPageIndex === 0}
                    onClick={() => {
                      setRenderPage({
                        changes,
                        pageIndex: Math.max(0, renderPageIndex - 1),
                        searchTerm,
                        viewMode: effectiveViewMode,
                      });
                      if (changeListRef.current) {
                        changeListRef.current.scrollTop = 0;
                      }
                    }}
                    size="icon"
                    title={t("localChanges.previousPage")}
                    type="button"
                    variant="ghost"
                  >
                    <ChevronLeft className="size-4" aria-hidden="true" />
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t("localChanges.page", {
                      page: renderPageIndex + 1,
                      total: renderPageCount,
                    })}
                  </span>
                  <Button
                    aria-label={t("localChanges.nextPage")}
                    disabled={renderPageIndex >= renderPageCount - 1}
                    onClick={() => {
                      setRenderPage({
                        changes,
                        pageIndex: Math.min(
                          renderPageCount - 1,
                          renderPageIndex + 1,
                        ),
                        searchTerm,
                        viewMode: effectiveViewMode,
                      });
                      if (changeListRef.current) {
                        changeListRef.current.scrollTop = 0;
                      }
                    }}
                    size="icon"
                    title={t("localChanges.nextPage")}
                    type="button"
                    variant="ghost"
                  >
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </OverlayScrollArea>

            <footer className="flex items-center justify-between gap-3 border-t p-3">
              <span className="text-sm text-muted-foreground">
                {t("localChanges.selectedCount", { count: checkedIds.size })}
              </span>
              <Button
                className="gap-2"
                data-testid="local-changes-commit"
                disabled={busy || checkedIds.size === 0}
                onClick={() => onCommit?.(Array.from(checkedIds))}
              >
                <GitCommit className="size-4" aria-hidden="true" />
                {t("localChanges.commit")}
              </Button>
            </footer>
          </aside>

          <div
            aria-busy={detailLoading}
            className="min-h-0 min-w-0"
            inert={loading}
          >
            {detailLoading ? (
              <LocalChangeDetailLoading />
            ) : detailError !== null && detailError !== undefined ? (
              <LocalChangeDetailError
                error={detailError}
                onRetry={onRetryDetail}
              />
            ) : previewChange?.diff ? (
              <DiffViewer
                content={previewChange.diff}
                payload={previewChange.payload}
                source="localChanges"
              />
            ) : previewChange ? (
              <DiffViewer
                content={{
                  kind: mapFileKindToCard(previewChange.payload.fileKind),
                }}
                payload={previewChange.payload}
                source="localChanges"
              />
            ) : (
              <div className="flex min-h-full items-center justify-center p-6 text-sm text-muted-foreground">
                {t("localChanges.noSelection")}
              </div>
            )}
          </div>
        </>
      )}

      {loading ? (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-card/80 text-sm font-medium"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("localChanges.loading")}
        </div>
      ) : null}

      {contextMenu &&
      !busy &&
      contextMenu.busyEpoch === contextMenuBusyEpoch ? (
        <ContextMenu
          ids={contextMenu.ids}
          busy={busy}
          onClose={() => setContextMenu(null)}
          onRestore={onRestore}
          onStash={onStash}
          onToggle={(checked) => toggleIds(contextMenu.ids, checked)}
          returnFocusTo={contextMenu.returnFocusTo}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}
    </section>
  );
}

function LocalChangeDetailLoading() {
  const { t } = useTranslation();

  return (
    <div
      className="flex min-h-full items-center justify-center gap-2 p-6 text-sm font-medium text-muted-foreground"
      role="status"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {t("localChanges.previewLoading")}
    </div>
  );
}

function LocalChangeDetailError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex min-h-full items-center justify-center p-6"
      role="alert"
    >
      <div className="w-full max-w-md space-y-4 rounded-md border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="mt-0.5 size-5 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">
              {t("localChanges.previewLoadFailedTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("localChanges.previewLoadFailedDescription")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("artistic-git:error", { detail: error }),
              )
            }
            type="button"
            variant="ghost"
          >
            {t("localChanges.viewErrorDetails")}
          </Button>
          <Button className="gap-2" onClick={onRetry} type="button">
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("localChanges.retryPreview")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FlatChangeList({
  changes,
  checkedIds,
  onContextMenu,
  onSelect,
  onToggle,
  selectedId,
}: {
  changes: LocalChangeItem[];
  checkedIds: Set<string>;
  onContextMenu: (event: React.MouseEvent, ids: string[]) => void;
  onSelect: (id: string) => void;
  onToggle: (ids: string[], checked: boolean) => void;
  selectedId: string | null;
}) {
  return (
    <ul>
      {changes.map((change) => (
        <li key={change.id}>
          <ChangeRow
            change={change}
            checked={checkedIds.has(change.id)}
            onContextMenu={(event) => onContextMenu(event, [change.id])}
            onSelect={() => onSelect(change.id)}
            onToggle={(checked) => onToggle([change.id], checked)}
            selected={selectedId === change.id}
          />
        </li>
      ))}
    </ul>
  );
}

function TreeChangeList({
  changes,
  checkedIds,
  onContextMenu,
  onSelect,
  onToggle,
  selectedId,
}: {
  changes: LocalChangeItem[];
  checkedIds: Set<string>;
  onContextMenu: (event: React.MouseEvent, ids: string[]) => void;
  onSelect: (id: string) => void;
  onToggle: (ids: string[], checked: boolean) => void;
  selectedId: string | null;
}) {
  const root = React.useMemo(() => buildChangeTree(changes), [changes]);

  return (
    <ul className="py-1">
      {Array.from(root.children.values()).map((node) => (
        <TreeNodeRow
          checkedIds={checkedIds}
          key={node.path}
          node={node}
          onContextMenu={onContextMenu}
          onSelect={onSelect}
          onToggle={onToggle}
          selectedId={selectedId}
        />
      ))}
    </ul>
  );
}

function TreeNodeRow({
  checkedIds,
  node,
  onContextMenu,
  onSelect,
  onToggle,
  selectedId,
}: {
  checkedIds: Set<string>;
  node: TreeNode;
  onContextMenu: (event: React.MouseEvent, ids: string[]) => void;
  onSelect: (id: string) => void;
  onToggle: (ids: string[], checked: boolean) => void;
  selectedId: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(true);
  const itemIds = collectTreeItemIds(node);
  const checkState = getCheckState(itemIds, checkedIds);
  const toggleLabel = t(
    expanded ? "localChanges.collapseFolder" : "localChanges.expandFolder",
    { path: node.path },
  );

  if (node.item) {
    return (
      <li>
        <ChangeRow
          change={node.item}
          checked={checkedIds.has(node.item.id)}
          indent
          onContextMenu={(event) => onContextMenu(event, [node.item!.id])}
          onSelect={() => onSelect(node.item!.id)}
          onToggle={(checked) => onToggle([node.item!.id], checked)}
          selected={selectedId === node.item.id}
        />
      </li>
    );
  }

  return (
    <li>
      <div
        className="flex h-9 items-center gap-2 px-2 text-sm hover:bg-accent"
        onContextMenu={(event) => onContextMenu(event, itemIds)}
      >
        <button
          aria-expanded={expanded}
          aria-label={toggleLabel}
          className="flex size-6 items-center justify-center rounded-sm hover:bg-background"
          onClick={() => setExpanded((current) => !current)}
          title={toggleLabel}
          type="button"
        >
          <ChevronRight
            className={cn(
              "size-4 transition-transform",
              expanded ? "rotate-90" : "",
            )}
            aria-hidden="true"
          />
        </button>
        <TriStateCheckbox
          ariaLabel={node.path}
          checkState={checkState}
          onChange={(checked) => onToggle(itemIds, checked)}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
      </div>
      {expanded ? (
        <ul className="pl-5">
          {Array.from(node.children.values()).map((child) => (
            <TreeNodeRow
              checkedIds={checkedIds}
              key={child.path}
              node={child}
              onContextMenu={onContextMenu}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedId={selectedId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ChangeRow({
  change,
  checked,
  indent = false,
  onContextMenu,
  onSelect,
  onToggle,
  selected,
}: {
  change: LocalChangeItem;
  checked: boolean;
  indent?: boolean;
  onContextMenu: (event: React.MouseEvent) => void;
  onSelect: () => void;
  onToggle: (checked: boolean) => void;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const folder = parentPath(change.payload.newPath);

  return (
    <div
      className={cn(
        "grid min-h-14 grid-cols-[32px_minmax(0,1fr)_32px] items-center gap-2 border-b px-2 py-2 hover:bg-accent",
        indent ? "pl-6" : "",
        selected ? "bg-accent" : "",
      )}
      data-change-path={change.payload.newPath}
      data-testid="local-change-row"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <input
        aria-label={t("localChanges.toggleFile", {
          path: change.payload.newPath,
        })}
        checked={checked}
        className="size-4 accent-primary"
        data-testid="local-change-checkbox"
        onChange={(event) => onToggle(event.target.checked)}
        onClick={(event) => event.stopPropagation()}
        type="checkbox"
      />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <ChangeKindBadge change={change} />
          <span className="truncate text-sm font-medium">
            {formatChangePath(change)}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {folder || t("localChanges.repositoryRoot")}
          </p>
          {change.submodule ? (
            <span
              className="inline-flex max-w-full shrink rounded-sm border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-foreground"
              title={t("localChanges.submoduleBadge", {
                name: change.submodule.name,
              })}
            >
              <span className="truncate">
                {t("localChanges.submoduleBadge", {
                  name: change.submodule.name,
                })}
              </span>
            </span>
          ) : null}
        </div>
      </div>
      <IconButton
        label={t("localChanges.moreActions")}
        onClick={(event) => {
          event.stopPropagation();
          onContextMenu(event);
        }}
        tooltip={t("localChanges.moreActions")}
        variant="ghost"
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function ChangeKindBadge({ change }: { change: LocalChangeItem }) {
  const { t } = useTranslation();
  const tone = {
    added: "bg-success/15 text-success",
    copied: "bg-sync/15 text-sync",
    deleted: "bg-danger/15 text-danger",
    modified: "bg-warning/20 text-foreground",
    renamed: "bg-primary/10 text-foreground",
  }[change.payload.changeKind];

  return (
    <span
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
        tone,
      )}
      title={t(`diff.changeKind.${change.payload.changeKind}`)}
    >
      {change.payload.changeKind.slice(0, 1).toUpperCase()}
    </span>
  );
}

function TriStateCheckbox({
  ariaLabel,
  checkState,
  onChange,
}: {
  ariaLabel: string;
  checkState: CheckState;
  onChange: (checked: boolean) => void;
}) {
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = checkState === "mixed";
    }
  }, [checkState]);

  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input
        aria-label={ariaLabel}
        checked={checkState === "checked"}
        className="sr-only"
        onChange={(event) => onChange(event.target.checked)}
        ref={ref}
        type="checkbox"
      />
      <span className="flex size-5 items-center justify-center rounded border bg-background">
        {checkState === "checked" ? (
          <CheckSquare className="size-4" aria-hidden="true" />
        ) : checkState === "mixed" ? (
          <span className="h-0.5 w-2.5 bg-foreground" />
        ) : (
          <Square className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
      </span>
      <span>{ariaLabel}</span>
    </label>
  );
}

function ContextMenu({
  busy,
  ids,
  onClose,
  onRestore,
  onStash,
  onToggle,
  returnFocusTo,
  x,
  y,
}: {
  busy: boolean;
  ids: string[];
  onClose: () => void;
  onRestore?: (ids: string[]) => void;
  onStash?: (ids: string[]) => void;
  onToggle: (checked: boolean) => void;
  returnFocusTo: HTMLElement;
  x: number;
  y: number;
}) {
  const { t } = useTranslation();
  const anchor = React.useMemo(
    () => ({ returnFocusTo, x, y }),
    [returnFocusTo, x, y],
  );

  return (
    <FloatingPanel
      anchor={anchor}
      aria-label={t("localChanges.moreActions")}
      className="w-56 p-1 text-sm"
      onClose={onClose}
      role="menu"
    >
      <button
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => {
          onToggle(true);
          onClose();
        }}
        role="menuitem"
        type="button"
      >
        <CheckSquare className="size-4" aria-hidden="true" />
        {t("localChanges.checkSelected", { count: ids.length })}
      </button>
      <button
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => {
          onToggle(false);
          onClose();
        }}
        role="menuitem"
        type="button"
      >
        <Square className="size-4" aria-hidden="true" />
        {t("localChanges.uncheckSelected", { count: ids.length })}
      </button>
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent",
          (busy || !onStash) && "text-muted-foreground",
        )}
        disabled={busy || !onStash}
        onClick={() => {
          if (!busy) {
            onStash?.(ids);
          }
          onClose();
        }}
        role="menuitem"
        type="button"
      >
        <GitCommit className="size-4" aria-hidden="true" />
        {onStash
          ? t("localChanges.stashSelected", { count: ids.length })
          : t("localChanges.stashUnavailable")}
      </button>
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent",
          (busy || !onRestore) && "text-muted-foreground",
        )}
        disabled={busy || !onRestore}
        onClick={() => {
          if (!busy) {
            onRestore?.(ids);
          }
          onClose();
        }}
        role="menuitem"
        type="button"
      >
        <Undo2 className="size-4" aria-hidden="true" />
        {onRestore
          ? t("localChanges.restoreSelected", { count: ids.length })
          : t("localChanges.restoreUnavailable")}
      </button>
    </FloatingPanel>
  );
}

function readViewMode(storageKey: string): LocalChangesViewMode {
  const value = window.localStorage.getItem(storageKey);
  return value === "tree" ? "tree" : "flat";
}

function mapFileKindToCard(
  fileKind: LocalChangeItem["payload"]["fileKind"],
): "binary" | "deferred" | "oversizedText" | "lfsPointer" | "moved" {
  if (fileKind === "deferred") {
    return "deferred";
  }

  if (fileKind === "oversizedText") {
    return "oversizedText";
  }

  if (fileKind === "lfsPointer") {
    return "lfsPointer";
  }

  return "binary";
}
