import {
  FolderGit2,
  FolderOpen,
  GitBranchPlus,
  GraduationCap,
  Settings,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { TruncatedText } from "@/components/ui/truncated-text";
import { openRepository } from "@/lib/ipc/commands";
import { cn } from "@/lib/utils";
import { toolIdentityFromSettings } from "@/features/settings/settings-model";
import { useWindowStore } from "@/store/window-store";

const pickerFallbackPath = "/Users/artist/Projects/Environment Art";

export function StartScreen() {
  const { t } = useTranslation();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const recentProjects = useWindowStore((state) => state.recentProjects);
  const appSettings = useWindowStore((state) => state.appSettings);
  const openSettings = useWindowStore((state) => state.openSettings);
  const setActiveRepositoryPath = useWindowStore(
    (state) => state.setActiveRepositoryPath,
  );
  const setRecentProjects = useWindowStore((state) => state.setRecentProjects);
  const removeRecentProject = useWindowStore(
    (state) => state.removeRecentProject,
  );
  const clearRecentProjects = useWindowStore(
    (state) => state.clearRecentProjects,
  );
  const setOnboarded = useWindowStore((state) => state.setOnboarded);
  const [missingProject, setMissingProject] = React.useState<string | null>(
    null,
  );
  const [openingPath, setOpeningPath] = React.useState<string | null>(null);
  const handleOpenRepository = React.useCallback(
    async (path: string) => {
      setOpeningPath(path);
      try {
        const response = await openRepository({
          path,
          toolIdentity: toolIdentityFromSettings(appSettings),
        });
        const repositoryPath = response.repositoryPath;
        setActiveRepositoryPath(repositoryPath);
        setRecentProjects([
          {
            displayName: displayNameFromPath(repositoryPath),
            lastOpenedAt: new Date().toISOString(),
            path: repositoryPath,
          },
          ...recentProjects.filter(
            (project) => project.path !== repositoryPath,
          ),
        ]);
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setOpeningPath(null);
      }
    },
    [appSettings, recentProjects, setActiveRepositoryPath, setRecentProjects],
  );

  return (
    <main className="flex min-h-screen bg-background text-foreground">
      <input
        aria-hidden="true"
        className="hidden"
        onChange={(event) => {
          const firstFile = event.currentTarget.files?.[0];
          const relativePath =
            firstFile &&
            "webkitRelativePath" in firstFile &&
            typeof firstFile.webkitRelativePath === "string"
              ? firstFile.webkitRelativePath
              : "";
          const directoryName = relativePath.split("/")[0];

          void handleOpenRepository(
            directoryName ? `/selected/${directoryName}` : pickerFallbackPath,
          );
        }}
        ref={fileInputRef}
        type="file"
      />

      <div className="mx-auto grid min-h-screen w-full max-w-6xl grid-cols-[320px_1fr] gap-10 px-8 py-10">
        <section className="flex min-w-0 flex-col justify-between">
          <div>
            <div className="mb-10 flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-card">
                <FolderGit2 className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold">
                  {t("app.name")}
                </h1>
                <p className="truncate text-sm text-muted-foreground">
                  {t("app.tagline")}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button
                className="h-12 justify-start gap-3 px-4"
                disabled={openingPath !== null}
                onClick={() => {
                  fileInputRef.current?.click();
                }}
                size="lg"
                type="button"
              >
                <FolderOpen className="size-5" aria-hidden="true" />
                {t("actions.openProject")}
              </Button>
              <Button
                className="h-12 justify-start gap-3 px-4"
                disabled
                size="lg"
                title={t("start.clonePlaceholder")}
                type="button"
                variant="secondary"
              >
                <GitBranchPlus className="size-5" aria-hidden="true" />
                {t("actions.cloneProject")}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <IconButton
              label={t("start.openOnboarding")}
              onClick={() => {
                setOnboarded(false);
              }}
              tooltip={t("start.openOnboardingPlaceholder")}
              type="button"
              variant="ghost"
            >
              <GraduationCap className="size-5" aria-hidden="true" />
            </IconButton>
            <IconButton
              label={t("actions.openSettings")}
              onClick={() => {
                openSettings("general");
              }}
              tooltip={t("actions.openSettings")}
              type="button"
              variant="ghost"
            >
              <Settings className="size-5" aria-hidden="true" />
            </IconButton>
          </div>
        </section>

        <section className="flex min-w-0 flex-col py-12">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-base font-medium">{t("app.recentProjects")}</h2>
            {recentProjects.length > 0 ? (
              <button
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={clearRecentProjects}
                type="button"
              >
                {t("start.clearRecent")}
              </button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card">
            {recentProjects.length === 0 ? (
              <div className="flex h-full min-h-64 items-center justify-center px-8 text-center text-sm text-muted-foreground">
                {t("app.recentProjectsEmpty")}
              </div>
            ) : (
              <ul className="divide-y">
                {recentProjects.map((project) => (
                  <li key={project.path}>
                    <div
                      className={cn(
                        "group grid grid-cols-[1fr_auto] items-center gap-2 px-4 py-2 hover:bg-accent",
                        project.missing && "text-muted-foreground",
                      )}
                    >
                      <button
                        className="grid min-w-0 grid-cols-[auto_1fr] items-center gap-3 py-1 text-left"
                        onClick={() => {
                          if (project.missing) {
                            setMissingProject(project.path);
                            return;
                          }

                          void handleOpenRepository(project.path);
                        }}
                        disabled={openingPath !== null}
                        type="button"
                      >
                        <FolderGit2
                          className="size-5 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {project.displayName}
                          </span>
                          <TruncatedText
                            className="block text-xs text-muted-foreground"
                            normalizePath
                            text={project.path}
                          />
                        </span>
                      </button>
                      <IconButton
                        className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                        label={t("start.removeRecent", {
                          name: project.displayName,
                        })}
                        onClick={() => {
                          removeRecentProject(project.path);
                        }}
                        tooltip={t("start.removeRecentTooltip")}
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {missingProject ? (
            <div
              className="mt-3 flex items-center justify-between gap-3 rounded-md border bg-warning/10 px-3 py-2 text-sm"
              role="alert"
            >
              <span className="min-w-0 truncate">
                {t("start.missingProject", { path: missingProject })}
              </span>
              <button
                className="shrink-0 font-medium text-foreground underline-offset-4 hover:underline"
                onClick={() => {
                  removeRecentProject(missingProject);
                  setMissingProject(null);
                }}
                type="button"
              >
                {t("start.removeFromList")}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function displayNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
