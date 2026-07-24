import {
  Archive,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudOff,
  GitBranch,
  GitFork,
  Layers,
  RefreshCw,
  ScanEye,
  Settings,
  TriangleAlert,
  Trash2,
  UploadCloud,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ExpandableSearch } from "@/components/ui/expandable-search";
import { IconButton } from "@/components/ui/icon-button";
import { OverlayScrollArea } from "@/components/ui/overlay-scroll-area";
import {
  FloatingPanel,
  type FloatingPanelAnchor,
} from "@/components/ui/floating-panel";
import { Tooltip } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/truncated-text";
import { useLocalizedFormatters } from "@/i18n/format";
import type {
  FetchStateEvent,
  SidebarLayoutSettings,
} from "@/lib/ipc/generated";
import { cn } from "@/lib/utils";
import { useWindowStore } from "@/store/window-store";

export interface RepositorySummary {
  branchName: string;
  hasRemote: boolean;
  path: string;
  projectName: string;
}

export interface BranchListItem {
  ahead: number;
  behind: number;
  current?: boolean;
  existence?: "localOnly" | "remoteOnly" | "localAndRemote";
  latestCommitId: string;
  name: string;
  remoteOnly?: boolean;
  upstream?: string | null;
}

export interface StashListItem {
  id: string;
  name: string;
  timeLabel: string;
}

interface RepositorySidebarProps {
  branchActionsDisabledReason?: string;
  branchesTruncated?: boolean;
  branchesLoading?: boolean;
  branchesUnavailable?: boolean;
  branches: BranchListItem[];
  busy: boolean;
  fetchState?: FetchStateEvent | null;
  onApplyStash?: (stash: StashListItem) => void;
  onBranchFocus: (branch: BranchListItem) => void;
  onCheckoutBranch?: (branch: BranchListItem) => void;
  onCreateBranchFromBase?: (branch: BranchListItem) => void;
  onDeleteBranch?: (branch: BranchListItem) => void;
  onDeleteStash?: (stash: StashListItem) => void;
  onFetch?: () => void;
  onOpenSettings?: () => void;
  onReviewMode?: (trigger: HTMLButtonElement) => void;
  onShowStashDetails?: (stash: StashListItem) => void;
  onShowSafetyBackups?: () => void;
  onSidebarLayoutChange?: (layout: Required<SidebarLayoutSettings>) => void;
  onSyncBranch?: (branch: BranchListItem) => void;
  remoteStateKnown?: boolean;
  repository: RepositorySummary;
  stashesTruncated?: boolean;
  stashesLoading?: boolean;
  stashesUnavailable?: boolean;
  stashes: StashListItem[];
}

const minSidebarWidth = 260;
const maxSidebarWidth = 460;
const minBranchRatio = 35;
const maxBranchRatio = 78;
const branchRowHeight = 40;
const branchVirtualOverscan = 6;
const defaultBranchViewportHeight = 720;
const stashRowHeight = 40;
const stashVirtualOverscan = 6;
/** Shared edge-fade hover action cluster for list rows. */
const hoverActionGroupClassName =
  "hover-action-group-fade absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 items-center gap-0.5 py-0.5 pr-0.5 pl-[22px] group-hover:flex group-focus-within:flex";

function fallbackBranchViewportHeight() {
  return Math.max(defaultBranchViewportHeight, window.innerHeight);
}

export function RepositorySidebar({
  branchActionsDisabledReason,
  branchesTruncated = false,
  branchesLoading = false,
  branchesUnavailable = false,
  branches,
  busy,
  fetchState,
  onApplyStash,
  onBranchFocus,
  onCheckoutBranch,
  onCreateBranchFromBase,
  onDeleteBranch,
  onDeleteStash,
  onFetch,
  onOpenSettings,
  onReviewMode,
  onShowStashDetails,
  onShowSafetyBackups,
  onSidebarLayoutChange,
  onSyncBranch,
  remoteStateKnown = true,
  repository,
  stashesTruncated = false,
  stashesLoading = false,
  stashesUnavailable = false,
  stashes,
}: RepositorySidebarProps) {
  const { t } = useTranslation();
  const sidebarLayout = useWindowStore((state) => state.sidebarLayout);
  const setSidebarLayout = useWindowStore((state) => state.setSidebarLayout);
  const [branchQuery, setBranchQuery] = React.useState("");
  const [stashQuery, setStashQuery] = React.useState("");
  const deferredBranchQuery = React.useDeferredValue(branchQuery);
  const deferredStashQuery = React.useDeferredValue(stashQuery);
  const branchViewportRef = React.useRef<HTMLDivElement>(null);
  const stashViewportRef = React.useRef<HTMLDivElement>(null);
  const [branchViewport, setBranchViewport] = React.useState({
    height: fallbackBranchViewportHeight(),
    scrollTop: 0,
  });
  const resetBranchScroll = React.useCallback(() => {
    if (branchViewportRef.current) {
      branchViewportRef.current.scrollTop = 0;
    }
    setBranchViewport((current) =>
      current.scrollTop === 0 ? current : { ...current, scrollTop: 0 },
    );
  }, []);
  const [stashViewport, setStashViewport] = React.useState({
    height: fallbackBranchViewportHeight(),
    scrollTop: 0,
  });
  const resetStashScroll = React.useCallback(() => {
    if (stashViewportRef.current) {
      stashViewportRef.current.scrollTop = 0;
    }
    setStashViewport((current) =>
      current.scrollTop === 0 ? current : { ...current, scrollTop: 0 },
    );
  }, []);

  const filteredBranches = React.useMemo(
    () =>
      branches.filter((branch) =>
        branch.name.toLowerCase().includes(deferredBranchQuery.toLowerCase()),
      ),
    [branches, deferredBranchQuery],
  );
  const filteredStashes = React.useMemo(
    () =>
      stashes.filter((stash) =>
        stash.name.toLowerCase().includes(deferredStashQuery.toLowerCase()),
      ),
    [deferredStashQuery, stashes],
  );
  const hasPendingSync = React.useMemo(
    () =>
      repository.hasRemote &&
      branches.some(
        (branch) =>
          !branch.remoteOnly &&
          (branch.existence === "localAndRemote" || Boolean(branch.upstream)) &&
          (branch.ahead > 0 || branch.behind > 0),
      ),
    [branches, repository.hasRemote],
  );
  const virtualBranches = React.useMemo(() => {
    const visibleCount =
      Math.ceil(branchViewport.height / branchRowHeight) +
      branchVirtualOverscan * 2;
    const requestedStart =
      Math.floor(branchViewport.scrollTop / branchRowHeight) -
      branchVirtualOverscan;
    const start = Math.min(
      Math.max(0, requestedStart),
      Math.max(0, filteredBranches.length - visibleCount),
    );
    const end = Math.min(filteredBranches.length, start + visibleCount);

    return filteredBranches.slice(start, end).map((branch, offset) => ({
      branch,
      index: start + offset,
    }));
  }, [branchViewport, filteredBranches]);
  const virtualStashes = React.useMemo(() => {
    const visibleCount =
      Math.ceil(stashViewport.height / stashRowHeight) +
      stashVirtualOverscan * 2;
    const requestedStart =
      Math.floor(stashViewport.scrollTop / stashRowHeight) -
      stashVirtualOverscan;
    const start = Math.min(
      Math.max(0, requestedStart),
      Math.max(0, filteredStashes.length - visibleCount),
    );
    const end = Math.min(filteredStashes.length, start + visibleCount);

    return filteredStashes.slice(start, end).map((stash, offset) => ({
      index: start + offset,
      stash,
    }));
  }, [filteredStashes, stashViewport]);
  React.useEffect(() => {
    const viewport = branchViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.contentRect.height ?? 0;
      if (height > 0) {
        setBranchViewport((current) =>
          current.height === height ? current : { ...current, height },
        );
      }
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [sidebarLayout.branchesCollapsed]);
  React.useEffect(() => {
    const viewport = stashViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.contentRect.height ?? 0;
      if (height > 0) {
        setStashViewport((current) =>
          current.height === height ? current : { ...current, height },
        );
      }
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [sidebarLayout.stashesCollapsed]);
  const finishActiveResizeRef = React.useRef<(() => void) | null>(null);
  React.useEffect(
    () => () => {
      finishActiveResizeRef.current?.();
    },
    [],
  );
  const updateSidebarLayout = React.useCallback(
    (layout: Partial<SidebarLayoutSettings>) => {
      const nextLayout = {
        ...sidebarLayout,
        ...layout,
      };
      setSidebarLayout(nextLayout);
      onSidebarLayoutChange?.(nextLayout);
    },
    [onSidebarLayoutChange, setSidebarLayout, sidebarLayout],
  );

  const startSidebarResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishActiveResizeRef.current?.();
      const startX = event.clientX;
      const startWidth = sidebarLayout.widthPx;
      let nextLayout = sidebarLayout;

      event.currentTarget.setPointerCapture?.(event.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        nextLayout = {
          ...nextLayout,
          widthPx: clamp(
            startWidth + moveEvent.clientX - startX,
            minSidebarWidth,
            maxSidebarWidth,
          ),
        };
        setSidebarLayout(nextLayout);
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
        if (finishActiveResizeRef.current === finishResize) {
          finishActiveResizeRef.current = null;
        }
        onSidebarLayoutChange?.(nextLayout);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finishResize);
      window.addEventListener("pointercancel", finishResize);
      window.addEventListener("blur", finishResize);
      finishActiveResizeRef.current = finishResize;
    },
    [onSidebarLayoutChange, setSidebarLayout, sidebarLayout],
  );

  const startSectionResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishActiveResizeRef.current?.();
      const container = event.currentTarget.parentElement;

      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      let nextLayout = sidebarLayout;

      event.currentTarget.setPointerCapture?.(event.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const ratio = ((moveEvent.clientY - rect.top) / rect.height) * 100;

        nextLayout = {
          ...nextLayout,
          branchSectionRatioPercent: clamp(
            Math.round(ratio),
            minBranchRatio,
            maxBranchRatio,
          ),
        };
        setSidebarLayout(nextLayout);
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
        if (finishActiveResizeRef.current === finishResize) {
          finishActiveResizeRef.current = null;
        }
        onSidebarLayoutChange?.(nextLayout);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finishResize);
      window.addEventListener("pointercancel", finishResize);
      window.addEventListener("blur", finishResize);
      finishActiveResizeRef.current = finishResize;
    },
    [onSidebarLayoutChange, setSidebarLayout, sidebarLayout],
  );

  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col overflow-hidden bg-card text-card-foreground"
      style={{ width: sidebarLayout.widthPx }}
    >
      <section className="flex h-20 shrink-0 items-center gap-3 border-b px-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background">
          <GitFork className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {repository.projectName}
          </p>
          <TruncatedText
            className="block text-xs text-muted-foreground"
            normalizePath
            text={repository.path}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RepositoryRemoteStatus
            fetchState={fetchState}
            hasRemote={repository.hasRemote}
            remoteStateKnown={remoteStateKnown}
          />
          {repository.hasRemote ? (
            <IconButton
              className={
                hasPendingSync ? "text-warning hover:bg-warning/10" : undefined
              }
              data-testid="repository-sync-all"
              disabled={busy || !onFetch}
              label={t("repository.sync")}
              onClick={onFetch}
              tooltip={
                busy ? t("repository.busyTooltip") : t("repository.sync")
              }
              type="button"
              variant="ghost"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      </section>

      <div className="flex min-h-0 flex-1 flex-col">
        <SidebarSection
          collapsed={sidebarLayout.branchesCollapsed}
          emptyLabel={
            branchesUnavailable
              ? t("repository.branchesLoadError")
              : branchesLoading
                ? t("repository.branchesLoading")
                : branchQuery.trim()
                  ? t("repository.noSearchResults")
                  : t("repository.noBranches")
          }
          filteredCount={filteredBranches.length}
          icon={<GitBranch className="size-4" aria-hidden="true" />}
          maxHeight={`${sidebarLayout.branchSectionRatioPercent}%`}
          onCollapseChange={(branchesCollapsed) => {
            resetBranchScroll();
            updateSidebarLayout({ branchesCollapsed });
          }}
          onQueryChange={(query) => {
            setBranchQuery(query);
            resetBranchScroll();
          }}
          onScroll={(event) => {
            const { clientHeight, scrollTop } = event.currentTarget;
            setBranchViewport({
              height: clientHeight || fallbackBranchViewportHeight(),
              scrollTop,
            });
          }}
          query={branchQuery}
          searchLabel={t("repository.searchBranches")}
          scrollTestId="sidebar-branches-scroll"
          scrollViewportRef={branchViewportRef}
          title={
            branchesTruncated
              ? t("repository.branchesTruncated", { count: branches.length })
              : t("repository.branches")
          }
        >
          <ul
            className="relative"
            style={{ height: filteredBranches.length * branchRowHeight }}
          >
            {virtualBranches.map(({ branch, index }) => (
              <BranchRow
                ariaPosInSet={index + 1}
                ariaSetSize={filteredBranches.length}
                branch={branch}
                branchActionsDisabledReason={branchActionsDisabledReason}
                busy={busy}
                hasRemote={repository.hasRemote}
                key={branch.name}
                onCheckout={onCheckoutBranch}
                onCreateFromBase={onCreateBranchFromBase}
                onDelete={onDeleteBranch}
                onFocus={onBranchFocus}
                onSync={onSyncBranch}
                style={{
                  height: branchRowHeight,
                  left: 0,
                  position: "absolute",
                  right: 0,
                  top: index * branchRowHeight,
                }}
              />
            ))}
          </ul>
        </SidebarSection>

        <div
          aria-label={t("repository.resizeSections")}
          className="group relative h-2 shrink-0 cursor-ns-resize"
          onPointerDown={startSectionResize}
          role="separator"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-[height,background-color] group-hover:h-0.5 group-hover:bg-ring group-active:h-0.5 group-active:bg-ring"
          />
        </div>

        <SidebarSection
          collapsed={sidebarLayout.stashesCollapsed}
          emptyLabel={
            stashesUnavailable
              ? t("repository.stashesLoadError")
              : stashesLoading
                ? t("repository.stashesLoading")
                : stashQuery.trim()
                  ? t("repository.noSearchResults")
                  : t("repository.noStashes")
          }
          filteredCount={filteredStashes.length}
          icon={<Layers className="size-4" aria-hidden="true" />}
          maxHeight={`${100 - sidebarLayout.branchSectionRatioPercent}%`}
          onCollapseChange={(stashesCollapsed) => {
            resetStashScroll();
            updateSidebarLayout({ stashesCollapsed });
          }}
          onQueryChange={(query) => {
            setStashQuery(query);
            resetStashScroll();
          }}
          onScroll={(event) => {
            const { clientHeight, scrollTop } = event.currentTarget;
            setStashViewport({
              height: clientHeight || fallbackBranchViewportHeight(),
              scrollTop,
            });
          }}
          query={stashQuery}
          searchLabel={t("repository.searchStashes")}
          scrollTestId="sidebar-stashes-scroll"
          scrollViewportRef={stashViewportRef}
          title={
            stashesTruncated
              ? t("repository.stashesTruncated", { count: stashes.length })
              : t("repository.stashes")
          }
        >
          <ul
            className="relative"
            style={{ height: filteredStashes.length * stashRowHeight }}
          >
            {virtualStashes.map(({ index, stash }) => (
              <StashRow
                ariaPosInSet={index + 1}
                ariaSetSize={filteredStashes.length}
                busy={busy}
                key={stash.id}
                onApply={onApplyStash}
                onDelete={onDeleteStash}
                onDetails={onShowStashDetails}
                stash={stash}
                style={{
                  height: stashRowHeight,
                  left: 0,
                  position: "absolute",
                  right: 0,
                  top: index * stashRowHeight,
                }}
              />
            ))}
          </ul>
        </SidebarSection>
      </div>

      <section
        className="shrink-0 border-t px-3 py-2"
        data-testid="sidebar-review-action"
      >
        <button
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-review px-3 text-sm font-medium text-review-foreground transition-colors hover:bg-review/90 active:bg-review/85 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busy || !onReviewMode}
          onClick={(event) => onReviewMode?.(event.currentTarget)}
          title={
            busy ? t("repository.busyTooltip") : t("repository.reviewMode")
          }
          type="button"
        >
          <ScanEye className="size-4" aria-hidden="true" />
          {t("repository.reviewMode")}
        </button>
      </section>

      <section
        className="flex shrink-0 items-center gap-1 border-t px-3 py-2"
        data-testid="sidebar-settings-action"
      >
        <IconButton
          className="size-9"
          label={t("actions.openSettings")}
          onClick={onOpenSettings}
          tooltip={t("actions.openSettings")}
          tooltipPlacement="vertical"
          type="button"
          variant="ghost"
        >
          <Settings className="size-4" aria-hidden="true" />
        </IconButton>
        {onShowSafetyBackups ? (
          <IconButton
            className="size-9"
            disabled={busy}
            label={t("repository.safetyBackups")}
            onClick={onShowSafetyBackups}
            tooltip={
              busy ? t("repository.busyTooltip") : t("repository.safetyBackups")
            }
            tooltipPlacement="vertical"
            type="button"
            variant="ghost"
          >
            <Archive className="size-4" aria-hidden="true" />
          </IconButton>
        ) : null}
      </section>

      <div
        aria-label={t("repository.resizeSidebar")}
        className="group absolute inset-y-0 right-0 z-0 w-2 cursor-ew-resize"
        onPointerDown={startSidebarResize}
        role="separator"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-[width,background-color] group-hover:w-0.5 group-hover:bg-ring group-active:w-0.5 group-active:bg-ring"
        />
      </div>
    </aside>
  );
}

function RepositoryRemoteStatus({
  fetchState,
  hasRemote,
  remoteStateKnown,
}: {
  fetchState?: FetchStateEvent | null;
  hasRemote: boolean;
  remoteStateKnown: boolean;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  if (!remoteStateKnown) {
    return null;
  }

  if (!hasRemote) {
    return (
      <Tooltip content={t("repository.noRemote")} placement="vertical">
        {({ describedBy }) => (
          <span
            aria-describedby={describedBy}
            className="flex size-8 items-center justify-center text-muted-foreground"
          >
            <CloudOff className="size-4" aria-hidden="true" />
          </span>
        )}
      </Tooltip>
    );
  }

  if (fetchState?.state !== "offline" && fetchState?.state !== "failed") {
    return null;
  }

  const message =
    fetchState.state === "offline"
      ? t("repository.fetchOffline")
      : t("repository.fetchFailed");
  const lastSuccessUnixSeconds = fetchState.lastSuccessAt
    ? Number(fetchState.lastSuccessAt)
    : Number.NaN;
  const lastSuccess = Number.isFinite(lastSuccessUnixSeconds)
    ? t("repository.fetchLastSuccess", {
        timestamp: formatters.formatDate(lastSuccessUnixSeconds * 1000),
      })
    : null;

  return (
    <Tooltip
      content={
        <span className="grid gap-1">
          <span>
            {message}
            {lastSuccess ? ` · ${lastSuccess}` : ""}
          </span>
          {fetchState.message ? (
            <span className="text-muted-foreground">
              {t("repository.fetchTechnicalDetails", {
                message: fetchState.message,
              })}
            </span>
          ) : null}
        </span>
      }
      placement="vertical"
    >
      {({ describedBy }) => (
        <span
          aria-describedby={describedBy}
          className={cn(
            "flex size-8 items-center justify-center",
            fetchState.state === "offline"
              ? "text-warning"
              : "text-destructive",
          )}
        >
          {fetchState.state === "offline" ? (
            <CloudOff className="size-4" aria-hidden="true" />
          ) : (
            <TriangleAlert className="size-4" aria-hidden="true" />
          )}
        </span>
      )}
    </Tooltip>
  );
}

interface SidebarSectionProps {
  children: React.ReactNode;
  collapsed: boolean;
  emptyLabel: string;
  filteredCount: number;
  icon: React.ReactNode;
  maxHeight: string;
  onCollapseChange: (collapsed: boolean) => void;
  onQueryChange: (query: string) => void;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  query: string;
  searchLabel: string;
  scrollTestId?: string;
  scrollViewportRef?: React.Ref<HTMLDivElement>;
  title: string;
}

function SidebarSection({
  children,
  collapsed,
  emptyLabel,
  filteredCount,
  icon,
  maxHeight,
  onCollapseChange,
  onQueryChange,
  onScroll,
  query,
  searchLabel,
  scrollTestId,
  scrollViewportRef,
  title,
}: SidebarSectionProps) {
  const { t } = useTranslation();

  return (
    <section
      className="flex min-h-0 flex-col px-3 py-3"
      style={{ flexBasis: collapsed ? "auto" : maxHeight }}
    >
      <div className="flex h-8 items-center gap-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
          onClick={() => {
            onCollapseChange(!collapsed);
          }}
          type="button"
        >
          {collapsed ? (
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="shrink-0" aria-hidden="true">
            {icon}
          </span>
          <span className="min-w-0 truncate">{title}</span>
        </button>
        {collapsed ? null : (
          <ExpandableSearch
            clearLabel={t("history.search.clear")}
            expandedClassName="w-36 flex-none"
            label={searchLabel}
            onChange={onQueryChange}
            size="sm"
            value={query}
          />
        )}
      </div>
      {collapsed ? null : (
        <OverlayScrollArea
          className="mt-2 min-h-0 flex-1"
          data-testid={scrollTestId}
          onScroll={onScroll}
          ref={scrollViewportRef}
        >
          {filteredCount === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {emptyLabel}
            </p>
          ) : (
            children
          )}
        </OverlayScrollArea>
      )}
    </section>
  );
}

interface BranchRowProps {
  ariaPosInSet?: number;
  ariaSetSize?: number;
  branch: BranchListItem;
  branchActionsDisabledReason?: string;
  busy: boolean;
  hasRemote: boolean;
  onCheckout?: (branch: BranchListItem) => void;
  onCreateFromBase?: (branch: BranchListItem) => void;
  onDelete?: (branch: BranchListItem) => void;
  onFocus: (branch: BranchListItem) => void;
  onSync?: (branch: BranchListItem) => void;
  style?: React.CSSProperties;
}

function BranchRow({
  ariaPosInSet,
  ariaSetSize,
  branch,
  branchActionsDisabledReason,
  busy,
  hasRemote,
  onCheckout,
  onCreateFromBase,
  onDelete,
  onFocus,
  onSync,
  style,
}: BranchRowProps) {
  const { t } = useTranslation();
  const mainButtonRef = React.useRef<HTMLButtonElement>(null);
  const [menuAnchor, setMenuAnchor] =
    React.useState<FloatingPanelAnchor | null>(null);
  const syncLabel = t("repository.syncBadge", {
    ahead: branch.ahead,
    behind: branch.behind,
  });
  const branchActionsDisabled = Boolean(branchActionsDisabledReason);
  const canCheckout =
    !branch.current && !branchActionsDisabled && Boolean(onCheckout);
  const canCreateFromBase = !branchActionsDisabled && Boolean(onCreateFromBase);
  const canDelete =
    !branch.current && !branchActionsDisabled && Boolean(onDelete);
  const canSync =
    hasRemote &&
    !branch.remoteOnly &&
    !branchActionsDisabled &&
    Boolean(onSync);
  return (
    <li
      aria-posinset={ariaPosInSet}
      aria-setsize={ariaSetSize}
      className="group relative"
      data-testid="branch-row"
      onContextMenu={(event) => {
        event.preventDefault();
        const returnFocusTo = mainButtonRef.current ?? event.currentTarget;
        const anchorRect = returnFocusTo.getBoundingClientRect();
        setMenuAnchor({
          returnFocusTo,
          x: event.clientX || anchorRect.left + 16,
          y: event.clientY || anchorRect.top + 16,
        });
      }}
      style={style}
    >
      <button
        className="grid h-10 w-full grid-cols-[14px_auto_1fr_auto] items-center gap-2 rounded-md px-2 text-left text-sm transition-colors group-hover:bg-accent group-focus-within:bg-accent"
        onClick={() => {
          onFocus(branch);
        }}
        ref={mainButtonRef}
        type="button"
      >
        <span
          className={cn(
            "size-2 rounded-full",
            branch.current ? "bg-success" : "bg-transparent",
          )}
        />
        {branch.remoteOnly ? (
          <Cloud className="size-4 text-muted-foreground" aria-hidden="true" />
        ) : (
          <GitBranch
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 truncate">{branch.name}</span>
        {hasRemote && (branch.ahead > 0 || branch.behind > 0) ? (
          <Tooltip content={syncLabel}>
            {({ describedBy }) => (
              <span
                aria-describedby={describedBy}
                className="text-numeric rounded bg-secondary px-1.5 py-0.5 text-xs"
              >
                {branch.ahead > 0 ? `↑${branch.ahead}` : ""}
                {branch.behind > 0 ? ` ↓${branch.behind}` : ""}
              </span>
            )}
          </Tooltip>
        ) : null}
      </button>
      <div
        className={hoverActionGroupClassName}
        data-testid="branch-hover-actions"
      >
        {hasRemote ? (
          <OptionalActionButton
            busy={busy}
            disabledTooltip={
              branchActionsDisabledReason ??
              (branch.remoteOnly
                ? t("repository.syncRequiresLocalBranch")
                : undefined)
            }
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
            label={t("repository.sync")}
            onClick={canSync ? () => onSync?.(branch) : undefined}
          />
        ) : null}
        <OptionalActionButton
          busy={busy}
          icon={<UploadCloud className="size-3.5" aria-hidden="true" />}
          label={t("repository.checkout")}
          disabledTooltip={branchActionsDisabledReason}
          onClick={canCheckout ? () => onCheckout?.(branch) : undefined}
        />
        <OptionalActionButton
          busy={busy}
          disabledTooltip={
            branchActionsDisabledReason ??
            (branch.current
              ? t("repository.deleteCurrentBranchDisabled")
              : undefined)
          }
          icon={<Trash2 className="size-3.5" aria-hidden="true" />}
          label={t("repository.deleteBranch")}
          onClick={canDelete ? () => onDelete?.(branch) : undefined}
        />
      </div>
      {menuAnchor ? (
        <FloatingPanel
          anchor={menuAnchor}
          aria-label={t("repository.moreActions")}
          className="w-56 p-1 text-sm"
          onClose={() => setMenuAnchor(null)}
          role="menu"
        >
          {hasRemote ? (
            <MenuButton
              disabled={!canSync || busy}
              label={t("repository.sync")}
              onClick={() => {
                setMenuAnchor(null);
                onSync?.(branch);
              }}
            />
          ) : null}
          <MenuButton
            disabled={!canCheckout || busy}
            label={t("repository.checkout")}
            onClick={() => {
              setMenuAnchor(null);
              onCheckout?.(branch);
            }}
          />
          <MenuButton
            disabled={!canCreateFromBase || busy}
            label={t("repository.createFromBase")}
            onClick={() => {
              setMenuAnchor(null);
              onCreateFromBase?.(branch);
            }}
          />
          <MenuButton
            disabled={!canDelete || busy}
            label={t("repository.deleteBranch")}
            onClick={() => {
              setMenuAnchor(null);
              onDelete?.(branch);
            }}
          />
        </FloatingPanel>
      ) : null}
    </li>
  );
}

function MenuButton({
  disabled,
  label,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      className="block h-8 w-full rounded px-2 text-left text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      {label}
    </button>
  );
}

function StashRow({
  ariaPosInSet,
  ariaSetSize,
  busy,
  onApply,
  onDelete,
  onDetails,
  stash,
  style,
}: {
  ariaPosInSet?: number;
  ariaSetSize?: number;
  busy: boolean;
  onApply?: (stash: StashListItem) => void;
  onDelete?: (stash: StashListItem) => void;
  onDetails?: (stash: StashListItem) => void;
  stash: StashListItem;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();

  return (
    <li
      aria-posinset={ariaPosInSet}
      aria-setsize={ariaSetSize}
      className="group relative"
      data-testid="stash-row"
      style={style}
    >
      <button
        className="grid h-10 w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md px-2 text-left text-sm transition-colors group-hover:bg-accent group-focus-within:bg-accent"
        disabled={busy || !onDetails}
        onClick={onDetails ? () => onDetails(stash) : undefined}
        type="button"
      >
        <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">{stash.name}</span>
        <span className="text-xs text-muted-foreground">{stash.timeLabel}</span>
      </button>
      <div
        className={hoverActionGroupClassName}
        data-testid="stash-hover-actions"
      >
        <OptionalActionButton
          busy={busy}
          icon={<UploadCloud className="size-3.5" aria-hidden="true" />}
          label={t("repository.applyStash")}
          onClick={onApply ? () => onApply(stash) : undefined}
        />
        <OptionalActionButton
          busy={busy}
          icon={<Trash2 className="size-3.5" aria-hidden="true" />}
          label={t("repository.deleteStash")}
          onClick={onDelete ? () => onDelete(stash) : undefined}
        />
      </div>
    </li>
  );
}

function OptionalActionButton({
  busy,
  disabledTooltip,
  icon,
  label,
  onClick,
}: {
  busy: boolean;
  disabledTooltip?: string;
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <IconButton
      className="size-7 bg-card/40"
      disabled={busy || !onClick}
      label={label}
      onClick={onClick}
      tooltip={
        busy
          ? t("repository.busyTooltip")
          : onClick
            ? label
            : (disabledTooltip ?? t("repository.actionUnavailable"))
      }
      tooltipPlacement="vertical"
      type="button"
      variant="ghost"
    >
      {icon}
    </IconButton>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
