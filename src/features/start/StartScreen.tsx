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

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { TruncatedText } from "@/components/ui/truncated-text";
import {
  cloneRepository,
  openRepository,
  saveAppSettings,
} from "@/lib/ipc/commands";
import type { AppSettings } from "@/lib/ipc/generated";
import { cn } from "@/lib/utils";
import {
  normalizeAppSettings,
  toolIdentityFromSettings,
} from "@/features/settings/settings-model";
import { useWindowStore } from "@/store/window-store";

const pickerFallbackPath = "/Users/artist/Projects/Environment Art";
const cloneParentStorageKey = "artistic-git:last-clone-parent-dir";

export function StartScreen() {
  const { t } = useTranslation();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const recentProjects = useWindowStore((state) => state.recentProjects);
  const appSettings = useWindowStore((state) => state.appSettings);
  const openSettings = useWindowStore((state) => state.openSettings);
  const setAppSettings = useWindowStore((state) => state.setAppSettings);
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
  const [cloneDialogOpen, setCloneDialogOpen] = React.useState(false);
  const [cloneUrl, setCloneUrl] = React.useState("");
  const [cloneParentDirectory, setCloneParentDirectory] = React.useState(() =>
    initialCloneParentDirectory(appSettings),
  );
  const [cloneDirectoryName, setCloneDirectoryName] = React.useState("");
  const [cloneDirectoryNameTouched, setCloneDirectoryNameTouched] =
    React.useState(false);
  const [cloneError, setCloneError] = React.useState<string | null>(null);
  const [isCloning, setIsCloning] = React.useState(false);
  const activateRepository = React.useCallback(
    (repositoryPath: string) => {
      setActiveRepositoryPath(repositoryPath);
      setRecentProjects([
        recentProjectFromPath(repositoryPath),
        ...recentProjects.filter((project) => project.path !== repositoryPath),
      ]);
    },
    [recentProjects, setActiveRepositoryPath, setRecentProjects],
  );
  const rememberCloneParentDirectory = React.useCallback(
    (parentDirectory: string) => {
      const trimmed = parentDirectory.trim();
      writeStoredCloneParentDirectory(trimmed);

      if (!appSettings) {
        return;
      }

      const current = normalizeAppSettings(appSettings);
      const nextSettings: AppSettings = {
        ...current,
        paths: {
          ...(current.paths ?? {}),
          lastCloneParentDir: trimmed,
        },
      };
      setAppSettings(nextSettings);
      void saveAppSettings({
        openRepositoryPaths: [],
        settings: nextSettings,
        validateIdentity: false,
      })
        .then(setAppSettings)
        .catch(() => undefined);
    },
    [appSettings, setAppSettings],
  );
  const handleOpenRepository = React.useCallback(
    async (path: string) => {
      setOpeningPath(path);
      try {
        const response = await openRepository({
          path,
          toolIdentity: toolIdentityFromSettings(appSettings),
        });
        activateRepository(response.repositoryPath);
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setOpeningPath(null);
      }
    },
    [activateRepository, appSettings],
  );
  const handleCloneRepository = React.useCallback(async () => {
    const parentDirectory = cloneParentDirectory.trim();
    setIsCloning(true);
    setCloneError(null);
    try {
      const response = await cloneRepository({
        directoryName: cloneDirectoryName.trim(),
        targetParentDirectory: parentDirectory,
        toolIdentity: toolIdentityFromSettings(appSettings),
        url: cloneUrl.trim(),
      });
      rememberCloneParentDirectory(parentDirectory);
      activateRepository(response.repository.repositoryPath);
      setCloneDialogOpen(false);
      setCloneUrl("");
      setCloneDirectoryName("");
      setCloneDirectoryNameTouched(false);
    } catch (error) {
      setCloneError(errorSummary(error, t("start.cloneFailed")));
    } finally {
      setIsCloning(false);
    }
  }, [
    activateRepository,
    appSettings,
    cloneDirectoryName,
    cloneParentDirectory,
    cloneUrl,
    rememberCloneParentDirectory,
    t,
  ]);
  const handleCloneUrlChange = React.useCallback(
    (url: string) => {
      setCloneUrl(url);
      setCloneError(null);
      if (!cloneDirectoryNameTouched) {
        setCloneDirectoryName(inferDirectoryNameFromUrl(url));
      }
    },
    [cloneDirectoryNameTouched],
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
                disabled={openingPath !== null || isCloning}
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
                disabled={openingPath !== null || isCloning}
                onClick={() => {
                  setCloneParentDirectory((current) =>
                    current.trim()
                      ? current
                      : initialCloneParentDirectory(appSettings),
                  );
                  setCloneDialogOpen(true);
                  setCloneError(null);
                }}
                size="lg"
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
                        disabled={openingPath !== null || isCloning}
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
      {cloneDialogOpen ? (
        <CloneRepositoryDialog
          busy={isCloning}
          directoryName={cloneDirectoryName}
          error={cloneError}
          onDirectoryNameChange={(value) => {
            setCloneDirectoryName(value);
            setCloneDirectoryNameTouched(true);
            setCloneError(null);
          }}
          onOpenChange={(open) => {
            if (!isCloning) {
              setCloneDialogOpen(open);
            }
          }}
          onParentDirectoryChange={(value) => {
            setCloneParentDirectory(value);
            setCloneError(null);
          }}
          onSubmit={() => void handleCloneRepository()}
          onUrlChange={handleCloneUrlChange}
          parentDirectory={cloneParentDirectory}
          url={cloneUrl}
        />
      ) : null}
    </main>
  );
}

interface CloneRepositoryDialogProps {
  busy: boolean;
  directoryName: string;
  error: string | null;
  onDirectoryNameChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onParentDirectoryChange: (value: string) => void;
  onSubmit: () => void;
  onUrlChange: (value: string) => void;
  parentDirectory: string;
  url: string;
}

function CloneRepositoryDialog({
  busy,
  directoryName,
  error,
  onDirectoryNameChange,
  onOpenChange,
  onParentDirectoryChange,
  onSubmit,
  onUrlChange,
  parentDirectory,
  url,
}: CloneRepositoryDialogProps) {
  const { t } = useTranslation();
  const urlId = React.useId();
  const parentId = React.useId();
  const directoryNameId = React.useId();
  const canSubmit =
    url.trim().length > 0 &&
    parentDirectory.trim().length > 0 &&
    directoryName.trim().length > 0 &&
    !busy;

  return (
    <DialogFrame
      closeOnEscape={!busy}
      description={t("start.cloneDescription")}
      hideCloseButton={busy}
      onOpenChange={onOpenChange}
      title={t("actions.cloneProject")}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            disabled={busy}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            {t("actions.cancel")}
          </Button>
          <Button disabled={!canSubmit} type="submit" form="clone-repository">
            {busy ? t("start.cloneBusy") : t("actions.cloneProject")}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        id="clone-repository"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            onSubmit();
          }
        }}
      >
        <label
          className="flex flex-col gap-2 text-sm font-medium"
          htmlFor={urlId}
        >
          {t("start.cloneUrl")}
          <input
            autoFocus
            className="h-9 rounded-md border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={busy}
            id={urlId}
            onChange={(event) => onUrlChange(event.currentTarget.value)}
            placeholder="https://github.com/studio/art.git"
            type="text"
            value={url}
          />
        </label>
        <label
          className="flex flex-col gap-2 text-sm font-medium"
          htmlFor={parentId}
        >
          {t("start.cloneParentDirectory")}
          <input
            className="h-9 rounded-md border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={busy}
            id={parentId}
            onChange={(event) =>
              onParentDirectoryChange(event.currentTarget.value)
            }
            placeholder="/Users/artist/Projects"
            type="text"
            value={parentDirectory}
          />
        </label>
        <label
          className="flex flex-col gap-2 text-sm font-medium"
          htmlFor={directoryNameId}
        >
          {t("start.cloneDirectoryName")}
          <input
            className="h-9 rounded-md border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={busy}
            id={directoryNameId}
            onChange={(event) =>
              onDirectoryNameChange(event.currentTarget.value)
            }
            placeholder="art"
            type="text"
            value={directoryName}
          />
        </label>
        {error ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        ) : null}
      </form>
    </DialogFrame>
  );
}

function displayNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function recentProjectFromPath(path: string) {
  return {
    displayName: displayNameFromPath(path),
    lastOpenedAt: new Date().toISOString(),
    path,
  };
}

function inferDirectoryNameFromUrl(url: string): string {
  const withoutQuery = url
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/[\\/]+$/, "");
  const candidate =
    withoutQuery
      .split(/[/:\\]/)
      .filter(Boolean)
      .at(-1) ?? "";
  return candidate.replace(/\.git$/i, "").trim();
}

function initialCloneParentDirectory(
  settings: AppSettings | null | undefined,
): string {
  return (
    settings?.paths?.lastCloneParentDir ?? readStoredCloneParentDirectory()
  );
}

function readStoredCloneParentDirectory(): string {
  try {
    return window.localStorage.getItem(cloneParentStorageKey) ?? "";
  } catch {
    return "";
  }
}

function writeStoredCloneParentDirectory(path: string): void {
  try {
    window.localStorage.setItem(cloneParentStorageKey, path);
  } catch {
    // Settings persistence is best-effort in browser-only test environments.
  }
}

function errorSummary(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "summary" in error &&
    typeof error.summary === "string"
  ) {
    return error.summary;
  }

  return error instanceof Error ? error.message : fallback;
}
