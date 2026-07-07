import { AlertTriangle, FileText, GitBranch, History } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  type BranchListItem,
  RepositorySidebar,
  type RepositorySummary,
  type StashListItem,
} from "@/components/sidebar/RepositorySidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWindowStore } from "@/store/window-store";

type MainTab = "history" | "localChanges";

const demoBranches: BranchListItem[] = [
  {
    ahead: 2,
    behind: 0,
    current: true,
    latestCommitId: "d8f31aa",
    name: "main",
  },
  {
    ahead: 0,
    behind: 3,
    latestCommitId: "2a8bb32",
    name: "feature/material-library",
  },
  {
    ahead: 1,
    behind: 1,
    latestCommitId: "78d02ef",
    name: "review/shot-014-lighting",
  },
  {
    ahead: 0,
    behind: 2,
    latestCommitId: "893ab14",
    name: "origin/concept-pass",
    remoteOnly: true,
  },
];

const demoStashes: StashListItem[] = [
  {
    id: "stash@{0}",
    name: "Auto Stash before review",
    timeLabel: "2h",
  },
  {
    id: "stash@{1}",
    name: "WIP material polish",
    timeLabel: "1d",
  },
];

interface RepositoryShellProps {
  repositoryPath: string;
}

export function RepositoryShell({ repositoryPath }: RepositoryShellProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = React.useState<MainTab>("history");
  const [focusedBranch, setFocusedBranch] = React.useState<BranchListItem>(
    demoBranches[0],
  );
  const operations = useWindowStore((state) => state.operationsById);
  const activeOperation = React.useMemo(
    () => Object.values(operations).at(-1) ?? null,
    [operations],
  );
  const repository = React.useMemo<RepositorySummary>(
    () => ({
      branchName: focusedBranch.name,
      hasRemote: false,
      path: repositoryPath,
      projectName:
        repositoryPath.split(/[\\/]/).filter(Boolean).at(-1) ??
        t("repository.untitledProject"),
    }),
    [focusedBranch.name, repositoryPath, t],
  );
  const localChangeCount = 4;
  const busy = activeOperation !== null;

  return (
    <main className="flex h-screen min-h-0 bg-background text-foreground">
      <RepositorySidebar
        branches={demoBranches}
        busy={busy}
        onBranchFocus={(branch) => {
          setFocusedBranch(branch);
          setActiveTab("history");
        }}
        repository={repository}
        stashes={demoStashes}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        {busy ? (
          <div className="h-1 shrink-0 bg-secondary">
            <div
              className="h-full bg-primary transition-[width]"
              style={{
                width:
                  activeOperation.progress.kind === "percent" &&
                  activeOperation.progress.value !== null
                    ? `${activeOperation.progress.value}%`
                    : "42%",
              }}
            />
          </div>
        ) : null}

        <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <nav
            className="flex items-center gap-1"
            aria-label={t("repository.tabs")}
          >
            <TabButton
              active={activeTab === "history"}
              icon={<History className="size-4" aria-hidden="true" />}
              label={t("repository.history")}
              onClick={() => {
                setActiveTab("history");
              }}
            />
            <TabButton
              active={activeTab === "localChanges"}
              badge={localChangeCount}
              icon={<FileText className="size-4" aria-hidden="true" />}
              label={t("repository.localChanges")}
              onClick={() => {
                setActiveTab("localChanges");
              }}
            />
          </nav>
          <div className="min-w-0 text-numeric text-sm text-muted-foreground">
            {busy ? activeOperation.label : t("repository.ready")}
          </div>
        </header>

        {!repository.hasRemote ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-warning/10 px-4 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{t("repository.noRemote")}</span>
            </span>
            <Button size="default" type="button" variant="ghost">
              {t("repository.openProjectSettings")}
            </Button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {activeTab === "history" ? (
            <HistoryPlaceholder branch={focusedBranch} />
          ) : (
            <LocalChangesPlaceholder changeCount={localChangeCount} />
          )}
        </div>
      </section>
    </main>
  );
}

interface TabButtonProps {
  active: boolean;
  badge?: number;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

function TabButton({
  active,
  badge = 0,
  icon,
  label,
  onClick,
}: TabButtonProps) {
  return (
    <button
      className={cn(
        "flex h-9 items-center gap-2 rounded-md px-3 text-sm",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
      {badge > 0 ? (
        <span className="text-numeric rounded bg-background px-1.5 py-0.5 text-xs">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function HistoryPlaceholder({ branch }: { branch: BranchListItem }) {
  const { t } = useTranslation();

  return (
    <section className="flex h-full min-h-96 flex-col items-center justify-center gap-3 px-8 text-center">
      <GitBranch className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="text-lg font-medium">
          {t("repository.historyPlaceholder")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("repository.focusedBranch", {
            branch: branch.name,
            commit: branch.latestCommitId,
          })}
        </p>
      </div>
    </section>
  );
}

function LocalChangesPlaceholder({ changeCount }: { changeCount: number }) {
  const { t } = useTranslation();

  return (
    <section className="flex h-full min-h-96 flex-col items-center justify-center gap-3 px-8 text-center">
      <FileText className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="text-lg font-medium">
          {t("repository.localChangesPlaceholder")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("repository.localChangesCount", { count: changeCount })}
        </p>
      </div>
    </section>
  );
}
