import {
  CheckSquare,
  ChevronRight,
  FolderTree,
  GitCommit,
  List,
  MoreHorizontal,
  RefreshCw,
  Search,
  Square,
  Undo2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { DiffViewer } from "@/features/diff";
import { cn } from "@/lib/utils";

import {
  buildChangeTree,
  collectTreeItemIds,
  filterChanges,
  formatChangePath,
  getCheckState,
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

export function LocalChangesPanel({
  busy = false,
  changes,
  initialCheckedIds = [],
  onCheckedChange,
  onCommit,
  onSelectedChange,
  onPreviewRenormalize,
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
    ids: string[];
    x: number;
    y: number;
  } | null>(null);

  const effectiveSelectedId = selectedId ?? internalSelectedId;
  const effectiveViewMode = viewMode ?? internalViewMode;
  const filteredChanges = React.useMemo(
    () => filterChanges(changes, searchTerm),
    [changes, searchTerm],
  );
  const selectedChange =
    filteredChanges.find((change) => change.id === effectiveSelectedId) ??
    filteredChanges[0] ??
    null;
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
    const selectedIds = Array.from(checkedIds);
    setContextMenu({
      ids: selectedIds.length > 0 ? selectedIds : fallbackIds,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <section className="grid h-full min-h-0 grid-cols-[360px_minmax(0,1fr)] overflow-hidden border bg-background">
      <aside className="flex min-h-0 flex-col border-r bg-card">
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
                variant={effectiveViewMode === "flat" ? "secondary" : "ghost"}
              >
                <List className="size-4" aria-hidden="true" />
              </IconButton>
              <IconButton
                aria-pressed={effectiveViewMode === "tree"}
                label={t("localChanges.treeView")}
                onClick={() => updateViewMode("tree")}
                tooltip={t("localChanges.treeView")}
                variant={effectiveViewMode === "tree" ? "secondary" : "ghost"}
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

        <div className="min-h-0 flex-1 overflow-auto">
          {filteredChanges.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              {t("localChanges.empty")}
            </div>
          ) : effectiveViewMode === "flat" ? (
            <FlatChangeList
              changes={filteredChanges}
              checkedIds={checkedIds}
              onContextMenu={openContextMenu}
              onSelect={setInternalSelectedId}
              onToggle={toggleIds}
              selectedId={selectedChange?.id ?? null}
            />
          ) : (
            <TreeChangeList
              changes={filteredChanges}
              checkedIds={checkedIds}
              onContextMenu={openContextMenu}
              onSelect={setInternalSelectedId}
              onToggle={toggleIds}
              selectedId={selectedChange?.id ?? null}
            />
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t p-3">
          <span className="text-sm text-muted-foreground">
            {t("localChanges.selectedCount", { count: checkedIds.size })}
          </span>
          <Button
            className="gap-2"
            disabled={busy || checkedIds.size === 0}
            onClick={() => onCommit?.(Array.from(checkedIds))}
          >
            <GitCommit className="size-4" aria-hidden="true" />
            {t("localChanges.commit")}
          </Button>
        </footer>
      </aside>

      <div className="min-h-0 min-w-0">
        {selectedChange?.diff ? (
          <DiffViewer
            content={selectedChange.diff}
            payload={selectedChange.payload}
            source="localChanges"
          />
        ) : selectedChange ? (
          <DiffViewer
            content={{
              kind: mapFileKindToCard(selectedChange.payload.fileKind),
            }}
            payload={selectedChange.payload}
            source="localChanges"
          />
        ) : (
          <div className="flex min-h-full items-center justify-center p-6 text-sm text-muted-foreground">
            {t("localChanges.noSelection")}
          </div>
        )}
      </div>

      {contextMenu ? (
        <ContextMenu
          ids={contextMenu.ids}
          onClose={() => setContextMenu(null)}
          onRestore={onRestore}
          onStash={onStash}
          onToggle={(checked) => toggleIds(contextMenu.ids, checked)}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}
    </section>
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
  ids,
  onClose,
  onRestore,
  onStash,
  onToggle,
  x,
  y,
}: {
  ids: string[];
  onClose: () => void;
  onRestore?: (ids: string[]) => void;
  onStash?: (ids: string[]) => void;
  onToggle: (checked: boolean) => void;
  x: number;
  y: number;
}) {
  const { t } = useTranslation();

  React.useEffect(() => {
    window.addEventListener("click", onClose);
    return () => window.removeEventListener("click", onClose);
  }, [onClose]);

  return (
    <div
      className="fixed z-50 w-56 rounded-md border bg-card p-1 text-sm shadow-floating"
      style={{ left: x, top: y }}
    >
      <button
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => {
          onToggle(true);
          onClose();
        }}
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
        type="button"
      >
        <Square className="size-4" aria-hidden="true" />
        {t("localChanges.uncheckSelected", { count: ids.length })}
      </button>
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent",
          !onStash && "text-muted-foreground",
        )}
        disabled={!onStash}
        onClick={() => {
          onStash?.(ids);
          onClose();
        }}
        type="button"
      >
        <GitCommit className="size-4" aria-hidden="true" />
        {onStash
          ? t("localChanges.stashSelected", { count: ids.length })
          : t("localChanges.stashPlaceholder")}
      </button>
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent",
          !onRestore && "text-muted-foreground",
        )}
        disabled={!onRestore}
        onClick={() => {
          onRestore?.(ids);
          onClose();
        }}
        type="button"
      >
        <Undo2 className="size-4" aria-hidden="true" />
        {onRestore
          ? t("localChanges.restoreSelected", { count: ids.length })
          : t("localChanges.revertPlaceholder")}
      </button>
    </div>
  );
}

function readViewMode(storageKey: string): LocalChangesViewMode {
  const value = window.localStorage.getItem(storageKey);
  return value === "tree" ? "tree" : "flat";
}

function mapFileKindToCard(
  fileKind: LocalChangeItem["payload"]["fileKind"],
): "binary" | "oversizedText" | "lfsPointer" | "moved" {
  if (fileKind === "oversizedText") {
    return "oversizedText";
  }

  if (fileKind === "lfsPointer") {
    return "lfsPointer";
  }

  return "binary";
}
