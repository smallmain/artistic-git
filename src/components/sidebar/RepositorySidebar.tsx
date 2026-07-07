import {
  ChevronDown,
  ChevronRight,
  Cloud,
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
  branches: BranchListItem[];
  busy: boolean;
  onBranchFocus: (branch: BranchListItem) => void;
  repository: RepositorySummary;
  stashes: StashListItem[];
}

const minSidebarWidth = 260;
const maxSidebarWidth = 460;
const minBranchRatio = 35;
const maxBranchRatio = 78;

export function RepositorySidebar({
  branches,
  busy,
  onBranchFocus,
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
        <DisabledActionButton
          busy={busy}
          icon={<RefreshCw className="size-4" aria-hidden="true" />}
          label={t("repository.sync")}
        />
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
                busy={busy}
                key={branch.name}
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
              <StashRow busy={busy} key={stash.id} stash={stash} />
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
  busy: boolean;
  onFocus: (branch: BranchListItem) => void;
}

function BranchRow({ branch, busy, onFocus }: BranchRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const syncLabel = t("repository.syncBadge", {
    ahead: branch.ahead,
    behind: branch.behind,
  });

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
        <DisabledActionButton
          busy={busy}
          icon={<UploadCloud className="size-3.5" aria-hidden="true" />}
          label={t("repository.checkout")}
        />
        <DisabledActionButton
          busy={busy}
          icon={<Trash2 className="size-3.5" aria-hidden="true" />}
          label={t("repository.deleteBranch")}
        />
      </div>
      {menuOpen ? (
        <div
          className="absolute left-8 top-8 z-30 w-56 rounded-md border bg-card p-1 text-sm shadow-floating"
          role="menu"
        >
          {[
            t("repository.sync"),
            t("repository.checkout"),
            t("repository.createFromBase"),
            t("repository.deleteBranch"),
          ].map((label) => (
            <button
              className="block h-8 w-full rounded px-2 text-left text-muted-foreground hover:bg-accent"
              disabled
              key={label}
              role="menuitem"
              type="button"
            >
              {label}
            </button>
          ))}
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

function StashRow({ busy, stash }: { busy: boolean; stash: StashListItem }) {
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
        <DisabledActionButton
          busy={busy}
          icon={<UploadCloud className="size-3.5" aria-hidden="true" />}
          label={t("repository.applyStash")}
        />
        <DisabledActionButton
          busy={busy}
          icon={<Trash2 className="size-3.5" aria-hidden="true" />}
          label={t("repository.deleteStash")}
        />
        <DisabledActionButton
          busy={busy}
          icon={<MoreHorizontal className="size-3.5" aria-hidden="true" />}
          label={t("repository.stashDetails")}
        />
      </div>
    </li>
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
