import {
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudOff,
  GitBranch,
  GitFork,
  History,
  Layers,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  UploadCloud,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/truncated-text";
import type { FetchStateEvent } from "@/lib/ipc/generated";
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
  latestCommitId: string;
  name: string;
  remoteOnly?: boolean;
}

export interface StashListItem {
  id: string;
  name: string;
  timeLabel: string;
}

interface RepositorySidebarProps {
  branchActionsDisabledReason?: string;
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
  onShowStashDetails?: (stash: StashListItem) => void;
  repository: RepositorySummary;
  stashes: StashListItem[];
}

const minSidebarWidth = 260;
const maxSidebarWidth = 460;
const minBranchRatio = 35;
const maxBranchRatio = 78;

export function RepositorySidebar({
  branchActionsDisabledReason,
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
  onShowStashDetails,
  repository,
  stashes,
}: RepositorySidebarProps) {
  const { t } = useTranslation();
  const sidebarLayout = useWindowStore((state) => state.sidebarLayout);
  const setSidebarLayout = useWindowStore((state) => state.setSidebarLayout);
  const [branchQuery, setBranchQuery] = React.useState("");
  const [stashQuery, setStashQuery] = React.useState("");

  const filteredBranches = React.useMemo(
    () =>
      branches.filter((branch) =>
        branch.name.toLowerCase().includes(branchQuery.toLowerCase()),
      ),
    [branchQuery, branches],
  );
  const filteredStashes = React.useMemo(
    () =>
      stashes.filter((stash) =>
        stash.name.toLowerCase().includes(stashQuery.toLowerCase()),
      ),
    [stashQuery, stashes],
  );

  const startSidebarResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const startX = event.clientX;
      const startWidth = sidebarLayout.widthPx;

      event.currentTarget.setPointerCapture?.(event.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setSidebarLayout({
          widthPx: clamp(
            startWidth + moveEvent.clientX - startX,
            minSidebarWidth,
            maxSidebarWidth,
          ),
        });
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [setSidebarLayout, sidebarLayout.widthPx],
  );

  const startSectionResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = event.currentTarget.parentElement;

      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();

      event.currentTarget.setPointerCapture?.(event.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const ratio = ((moveEvent.clientY - rect.top) / rect.height) * 100;

        setSidebarLayout({
          branchSectionRatioPercent: clamp(
            Math.round(ratio),
            minBranchRatio,
            maxBranchRatio,
          ),
        });
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [setSidebarLayout],
  );

  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col border-r bg-card text-card-foreground"
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
          />
          <IconButton
            disabled={busy || !repository.hasRemote || !onFetch}
            label={t("repository.sync")}
            onClick={onFetch}
            tooltip={
              busy
                ? t("repository.busyTooltip")
                : repository.hasRemote
                  ? t("repository.sync")
                  : t("repository.noRemote")
            }
            type="button"
            variant="ghost"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      </section>

      <section className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <button
          className="flex h-9 flex-1 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          disabled
          title={t("repository.reviewModePlaceholder")}
          type="button"
        >
          <History className="size-4" aria-hidden="true" />
          {t("repository.reviewMode")}
        </button>
        <IconButton
          label={t("actions.openSettings")}
          onClick={onOpenSettings}
          tooltip={t("repository.moreActions")}
          type="button"
          variant="ghost"
        >
          <Settings className="size-4" aria-hidden="true" />
        </IconButton>
      </section>

      <div className="flex min-h-0 flex-1 flex-col">
        <SidebarSection
          collapsed={sidebarLayout.branchesCollapsed}
          emptyLabel={t("repository.noSearchResults")}
          filteredCount={filteredBranches.length}
          icon={<GitBranch className="size-4" aria-hidden="true" />}
          maxHeight={`${sidebarLayout.branchSectionRatioPercent}%`}
          onCollapseChange={(branchesCollapsed) => {
            setSidebarLayout({ branchesCollapsed });
          }}
          onQueryChange={setBranchQuery}
          query={branchQuery}
          searchLabel={t("repository.searchBranches")}
          title={t("repository.branches")}
        >
          <ul className="space-y-1">
            {filteredBranches.map((branch) => (
              <BranchRow
                branch={branch}
                branchActionsDisabledReason={branchActionsDisabledReason}
                busy={busy}
                key={branch.name}
                onCheckout={onCheckoutBranch}
                onCreateFromBase={onCreateBranchFromBase}
                onDelete={onDeleteBranch}
                onFocus={onBranchFocus}
              />
            ))}
          </ul>
        </SidebarSection>

        <div
          aria-label={t("repository.resizeSections")}
          className="h-1 cursor-row-resize bg-border hover:bg-ring"
          onPointerDown={startSectionResize}
          role="separator"
        />

        <SidebarSection
          collapsed={sidebarLayout.stashesCollapsed}
          emptyLabel={t("repository.noSearchResults")}
          filteredCount={filteredStashes.length}
          icon={<Layers className="size-4" aria-hidden="true" />}
          maxHeight={`${100 - sidebarLayout.branchSectionRatioPercent}%`}
          onCollapseChange={(stashesCollapsed) => {
            setSidebarLayout({ stashesCollapsed });
          }}
          onQueryChange={setStashQuery}
          query={stashQuery}
          searchLabel={t("repository.searchStashes")}
          title={t("repository.stashes")}
        >
          <ul className="space-y-1">
            {filteredStashes.map((stash) => (
              <StashRow
                busy={busy}
                key={stash.id}
                onApply={onApplyStash}
                onDelete={onDeleteStash}
                onDetails={onShowStashDetails}
                stash={stash}
              />
            ))}
          </ul>
        </SidebarSection>
      </div>

      <div
        aria-label={t("repository.resizeSidebar")}
        className="absolute right-[-3px] top-0 h-full w-1.5 cursor-col-resize"
        onPointerDown={startSidebarResize}
        role="separator"
      />
    </aside>
  );
}

function RepositoryRemoteStatus({
  fetchState,
  hasRemote,
}: {
  fetchState?: FetchStateEvent | null;
  hasRemote: boolean;
}) {
  const { t } = useTranslation();
  if (!hasRemote) {
    return (
      <Tooltip content={t("repository.noRemote")}>
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
    fetchState.message ??
    (fetchState.state === "offline"
      ? t("repository.fetchOffline")
      : t("repository.fetchFailed"));
  const lastSuccess = fetchState.lastSuccessAt
    ? ` ${t("repository.fetchLastSuccess", {
        timestamp: fetchState.lastSuccessAt,
      })}`
    : "";

  return (
    <Tooltip content={`${message}.${lastSuccess}`}>
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
          <CloudOff className="size-4" aria-hidden="true" />
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
  query: string;
  searchLabel: string;
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
  query,
  searchLabel,
  title,
}: SidebarSectionProps) {
  return (
    <section
      className="flex min-h-0 flex-col px-3 py-3"
      style={{ flexBasis: collapsed ? "auto" : maxHeight }}
    >
      <button
        className="flex h-8 items-center gap-2 text-sm font-medium"
        onClick={() => {
          onCollapseChange(!collapsed);
        }}
        type="button"
      >
        {collapsed ? (
          <ChevronRight className="size-4" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-4" aria-hidden="true" />
        )}
        {icon}
        {title}
      </button>
      {collapsed ? null : (
        <>
          <label className="relative my-2 block">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label={searchLabel}
              className="h-8 w-full rounded-md border bg-background pl-8 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                onQueryChange(event.target.value);
              }}
              value={query}
            />
          </label>
          <div className="min-h-0 flex-1 overflow-auto">
            {filteredCount === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                {emptyLabel}
              </p>
            ) : (
              children
            )}
          </div>
        </>
      )}
    </section>
  );
}

interface BranchRowProps {
  branch: BranchListItem;
  branchActionsDisabledReason?: string;
  busy: boolean;
  onCheckout?: (branch: BranchListItem) => void;
  onCreateFromBase?: (branch: BranchListItem) => void;
  onDelete?: (branch: BranchListItem) => void;
  onFocus: (branch: BranchListItem) => void;
}

function BranchRow({
  branch,
  branchActionsDisabledReason,
  busy,
  onCheckout,
  onCreateFromBase,
  onDelete,
  onFocus,
}: BranchRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = React.useState(false);
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

  return (
    <li
      className="group relative"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button
        className="grid h-10 w-full grid-cols-[14px_auto_1fr_auto] items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
        onClick={() => {
          onFocus(branch);
        }}
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
        {branch.ahead > 0 || branch.behind > 0 ? (
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
      <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded bg-card group-hover:flex group-focus-within:flex">
        <DisabledActionButton
          busy={busy}
          icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
          label={t("repository.sync")}
        />
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
      {menuOpen ? (
        <div
          className="absolute left-8 top-8 z-30 w-56 rounded-md border bg-card p-1 text-sm shadow-floating"
          role="menu"
        >
          <MenuButton disabled label={t("repository.sync")} />
          <MenuButton
            disabled={!canCheckout || busy}
            label={t("repository.checkout")}
            onClick={() => {
              setMenuOpen(false);
              onCheckout?.(branch);
            }}
          />
          <MenuButton
            disabled={!canCreateFromBase || busy}
            label={t("repository.createFromBase")}
            onClick={() => {
              setMenuOpen(false);
              onCreateFromBase?.(branch);
            }}
          />
          <MenuButton
            disabled={!canDelete || busy}
            label={t("repository.deleteBranch")}
            onClick={() => {
              setMenuOpen(false);
              onDelete?.(branch);
            }}
          />
          <button
            className="mt-1 block h-8 w-full rounded px-2 text-left hover:bg-accent"
            onClick={() => {
              setMenuOpen(false);
            }}
            type="button"
          >
            {t("actions.close")}
          </button>
        </div>
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
  busy,
  onApply,
  onDelete,
  onDetails,
  stash,
}: {
  busy: boolean;
  onApply?: (stash: StashListItem) => void;
  onDelete?: (stash: StashListItem) => void;
  onDetails?: (stash: StashListItem) => void;
  stash: StashListItem;
}) {
  const { t } = useTranslation();

  return (
    <li className="group relative">
      <button
        className="grid h-10 w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
        type="button"
      >
        <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">{stash.name}</span>
        <span className="text-xs text-muted-foreground">{stash.timeLabel}</span>
      </button>
      <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded bg-card group-hover:flex group-focus-within:flex">
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
        <OptionalActionButton
          busy={busy}
          icon={<MoreHorizontal className="size-3.5" aria-hidden="true" />}
          label={t("repository.stashDetails")}
          onClick={onDetails ? () => onDetails(stash) : undefined}
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
      disabled={busy || !onClick}
      label={label}
      onClick={onClick}
      tooltip={
        busy
          ? t("repository.busyTooltip")
          : onClick
            ? label
            : (disabledTooltip ?? t("repository.disabledWrite"))
      }
      type="button"
      variant="ghost"
    >
      {icon}
    </IconButton>
  );
}

function DisabledActionButton({
  busy,
  icon,
  label,
}: {
  busy: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  const { t } = useTranslation();

  return (
    <IconButton
      disabled
      label={label}
      tooltip={
        busy ? t("repository.busyTooltip") : t("repository.disabledWrite")
      }
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
