import {
  CircleAlert,
  CircleCheck,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  GitBranchPlus,
  GraduationCap,
  LoaderCircle,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { ErrorDetailsDialog } from "@/components/dialogs/ErrorDetailsDialog";
import { Button } from "@/components/ui/button";
import { BranchSelect } from "@/components/ui/branch-select";
import { IconButton } from "@/components/ui/icon-button";
import { OverlayScrollArea } from "@/components/ui/overlay-scroll-area";
import { TruncatedText } from "@/components/ui/truncated-text";
import {
  cancelCloneRepository,
  cancelOperation,
  clearRecentProjects as clearPersistedRecentProjects,
  cloneRepository,
  forgetRecentProject,
  openRepository,
  openRepositoryWindow,
  probeRemoteRepository,
  saveAppSettings,
} from "@/lib/ipc/commands";
import { isOperationCancelledError } from "@/lib/ipc/errors";
import { listenAppEvent } from "@/lib/ipc/events";
import type {
  AppSettings,
  AppError,
  OperationProgressEvent,
  ProgressState,
} from "@/lib/ipc/generated";
import { cn } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import { dispatchErrorGroup } from "@/lib/runtime-errors";
import { normalizeAppSettings } from "@/features/settings/settings-model";
import { recentProjectLimit, useWindowStore } from "@/store/window-store";
import { WindowCloseGuard } from "@/features/window-close-guard/WindowCloseGuard";

const cloneParentStorageKey = "artistic-git:last-clone-parent-dir";
const cloneProbeDebounceMs = 400;

type CloneRemoteState =
  | { kind: "idle" }
  | { kind: "checking"; url: string }
  | {
      kind: "ready";
      branches: string[];
      defaultBranch: string | null;
      isEmpty: boolean;
      truncated: boolean;
      url: string;
    }
  | {
      kind: "error";
      error: AppError | Error | string;
      message: string;
      url: string;
    };

export function StartScreen() {
  const { t } = useTranslation();
  const recentProjects = useWindowStore((state) => state.recentProjects);
  const recentProjectsRuntime = useWindowStore(
    (state) => state.recentProjectsRuntime,
  );
  const retryRecentProjects = useWindowStore(
    (state) => state.retryRecentProjects,
  );
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
  const setNavigationLocked = useWindowStore(
    (state) => state.setNavigationLocked,
  );
  const setOnboarded = useWindowStore((state) => state.setOnboarded);
  const [missingProject, setMissingProject] = React.useState<string | null>(
    null,
  );
  const [isChoosingOpenRepository, setIsChoosingOpenRepository] =
    React.useState(false);
  const choosingOpenRepositoryRef = React.useRef(false);
  const openingRepositoryRef = React.useRef(false);
  const [openingPath, setOpeningPath] = React.useState<string | null>(null);
  const [openOperationId, setOpenOperationId] = React.useState<string | null>(
    null,
  );
  const [openCancelling, setOpenCancelling] = React.useState(false);
  const [openRouteFailure, setOpenRouteFailure] = React.useState<{
    error: unknown;
    path: string;
  } | null>(null);
  const [recentMutation, setRecentMutation] = React.useState<string | null>(
    null,
  );
  const [cloneDialogOpen, setCloneDialogOpen] = React.useState(false);
  const cloneDialogOpenRef = React.useRef(false);
  const [cloneUrl, setCloneUrl] = React.useState("");
  const [cloneParentDirectory, setCloneParentDirectory] = React.useState(() =>
    initialCloneParentDirectory(appSettings),
  );
  const [cloneDirectoryName, setCloneDirectoryName] = React.useState("");
  const [cloneDirectoryNameTouched, setCloneDirectoryNameTouched] =
    React.useState(false);
  const [cloneBranch, setCloneBranch] = React.useState("");
  const [cloneRemoteState, setCloneRemoteState] =
    React.useState<CloneRemoteState>({ kind: "idle" });
  const [cloneProbeAttempt, setCloneProbeAttempt] = React.useState(0);
  const [cloneProbeInteractive, setCloneProbeInteractive] =
    React.useState(false);
  const [cloneProbeDetails, setCloneProbeDetails] = React.useState<
    AppError | Error | string | null
  >(null);
  const cloneProbeDetailsTriggerRef = React.useRef<HTMLButtonElement | null>(
    null,
  );
  const restoreCloneProbeDetailsFocusRef = React.useRef(false);
  const [cloneError, setCloneError] = React.useState<string | null>(null);
  const [cloneCompletedPath, setCloneCompletedPath] = React.useState<
    string | null
  >(null);
  const [openingClonedProject, setOpeningClonedProject] = React.useState(false);
  const [isCloning, setIsCloning] = React.useState(false);
  const [cloneCancelling, setCloneCancelling] = React.useState(false);
  const [cloneCancelConfirmOpen, setCloneCancelConfirmOpen] =
    React.useState(false);
  const [cloneOperationId, setCloneOperationId] = React.useState<string | null>(
    null,
  );
  const [cloneProgress, setCloneProgress] =
    React.useState<OperationProgressEvent | null>(null);
  const [openProgress, setOpenProgress] =
    React.useState<OperationProgressEvent | null>(null);
  const visibleRecentProjects = React.useMemo(
    () => recentProjects.slice(0, recentProjectLimit(appSettings)),
    [appSettings, recentProjects],
  );
  const cloneOperationIdRef = React.useRef<string | null>(null);
  const openOperationIdRef = React.useRef<string | null>(null);
  const pageInteractionBusy =
    isChoosingOpenRepository || openingPath !== null || isCloning;
  React.useEffect(() => {
    setNavigationLocked(pageInteractionBusy);
    return () => setNavigationLocked(false);
  }, [pageInteractionBusy, setNavigationLocked]);
  React.useEffect(() => {
    if (
      cloneProbeDetails === null &&
      restoreCloneProbeDetailsFocusRef.current
    ) {
      restoreCloneProbeDetailsFocusRef.current = false;
      cloneProbeDetailsTriggerRef.current?.focus();
    }
  }, [cloneProbeDetails]);
  const activateRepository = React.useCallback(
    (repositoryPath: string) => {
      setActiveRepositoryPath(repositoryPath);
      setRecentProjects(
        [
          recentProjectFromPath(repositoryPath),
          ...recentProjects.filter(
            (project) => project.path !== repositoryPath,
          ),
        ].slice(0, recentProjectLimit(appSettings)),
      );
    },
    [appSettings, recentProjects, setActiveRepositoryPath, setRecentProjects],
  );
  const routeRepository = React.useCallback(
    async (repositoryPath: string) => {
      const windowResponse = await openRepositoryWindow({ repositoryPath });
      if (windowResponse.action === "useCurrent") {
        activateRepository(windowResponse.repositoryPath);
      }
    },
    [activateRepository],
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
        settings: nextSettings,
        validateIdentity: false,
      })
        .then(setAppSettings)
        .catch((error) => {
          dispatchErrorGroup([error], t("start.clonePreferenceSaveFailed"));
        });
    },
    [appSettings, setAppSettings, t],
  );
  const handleOpenRepository = React.useCallback(
    async (path: string) => {
      if (openingRepositoryRef.current) {
        return;
      }
      const operationId = createOperationId("open-repository");
      openingRepositoryRef.current = true;
      openOperationIdRef.current = operationId;
      setOpenOperationId(operationId);
      setOpenCancelling(false);
      setOpenRouteFailure(null);
      setOpeningPath(path);
      setOpenProgress({
        cancellable: true,
        label: "Opening repository",
        operationId,
        progress: { kind: "indeterminate" },
        repositoryPath: null,
        windowLabel: null,
      });
      try {
        const response = await openRepository({
          operationId,
          path,
        });
        reportNonFatalRepositoryErrors(
          response.nonFatalErrors,
          t("start.openedWithWarnings"),
        );
        try {
          await routeRepository(response.repositoryPath);
        } catch (error) {
          setOpenRouteFailure({ error, path: response.repositoryPath });
          dispatchErrorGroup([error], t("start.openRouteFailed"));
        }
      } catch (error) {
        if (!isOperationCancelledError(error)) {
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      } finally {
        openingRepositoryRef.current = false;
        openOperationIdRef.current = null;
        setOpenOperationId(null);
        setOpenCancelling(false);
        setOpeningPath(null);
        setOpenProgress(null);
      }
    },
    [appSettings, routeRepository, t],
  );
  const retryOpenRepositoryRoute = React.useCallback(async () => {
    if (!openRouteFailure) {
      return;
    }
    try {
      await routeRepository(openRouteFailure.path);
      setOpenRouteFailure(null);
    } catch (error) {
      setOpenRouteFailure((current) =>
        current ? { ...current, error } : current,
      );
      dispatchErrorGroup([error], t("start.openRouteFailed"));
    }
  }, [openRouteFailure, routeRepository, t]);
  const cancelOpenRepository = React.useCallback(async () => {
    if (!openOperationId || openCancelling) {
      return;
    }

    setOpenCancelling(true);
    try {
      const response = await cancelOperation({ operationId: openOperationId });
      if (!response.cancelled) {
        showToast({
          key: "open-cancel-result",
          message: t("start.openCancelUnavailable"),
          tone: "info",
        });
        setOpenCancelling(false);
      }
    } catch (error) {
      setOpenCancelling(false);
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    }
  }, [openCancelling, openOperationId, t]);
  const handleChooseOpenRepository = React.useCallback(async () => {
    if (
      choosingOpenRepositoryRef.current ||
      openingRepositoryRef.current ||
      isCloning ||
      cloneDialogOpenRef.current
    ) {
      return;
    }
    choosingOpenRepositoryRef.current = true;
    setIsChoosingOpenRepository(true);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t("start.openRepositoryDirectoryTitle"),
      });
      if (typeof selected === "string" && selected.trim()) {
        await handleOpenRepository(selected);
      }
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      choosingOpenRepositoryRef.current = false;
      setIsChoosingOpenRepository(false);
    }
  }, [handleOpenRepository, isCloning, t]);
  const handleCloneRepository = React.useCallback(async () => {
    const parentDirectory = cloneParentDirectory.trim();
    const operationId = createOperationId();
    setIsCloning(true);
    setCloneCancelling(false);
    setCloneError(null);
    setCloneCompletedPath(null);
    cloneOperationIdRef.current = operationId;
    setCloneOperationId(operationId);
    setCloneProgress({
      cancellable: false,
      label: "Cloning repository",
      operationId,
      progress: { kind: "indeterminate" },
      repositoryPath: null,
      windowLabel: null,
    });
    try {
      const response = await cloneRepository({
        directoryName: cloneDirectoryName.trim(),
        branchName:
          cloneRemoteState.kind === "ready" &&
          cloneRemoteState.url === cloneUrl.trim() &&
          !cloneRemoteState.isEmpty
            ? cloneBranch
            : null,
        operationId,
        targetParentDirectory: parentDirectory,
        url: cloneUrl.trim(),
      });
      reportNonFatalRepositoryErrors(
        response.repository.nonFatalErrors,
        t("start.openedWithWarnings"),
      );
      rememberCloneParentDirectory(parentDirectory);
      const clonedPath = response.repository.repositoryPath;
      setCloneCompletedPath(clonedPath);
      try {
        await routeRepository(clonedPath);
        cloneDialogOpenRef.current = false;
        setCloneDialogOpen(false);
        setCloneUrl("");
        setCloneBranch("");
        setCloneRemoteState({ kind: "idle" });
        setCloneProbeDetails(null);
        setCloneDirectoryName("");
        setCloneDirectoryNameTouched(false);
        setCloneCompletedPath(null);
      } catch (error) {
        setCloneError(t("start.cloneOpenFailed", { path: clonedPath }));
        dispatchErrorGroup([error], t("start.cloneOpenFailedSummary"));
      }
    } catch (error) {
      const cancelled = isOperationCancelledError(error);
      if (cancelled) {
        setCloneError(null);
        showToast({
          key: "clone-result",
          message: t("start.cloneCancelled"),
        });
      } else {
        setCloneError(t("start.cloneFailed"));
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      }
    } finally {
      setIsCloning(false);
      setCloneCancelling(false);
      setCloneCancelConfirmOpen(false);
      setCloneOperationId(null);
      setCloneProgress(null);
      if (cloneOperationIdRef.current === operationId) {
        cloneOperationIdRef.current = null;
      }
    }
  }, [
    appSettings,
    cloneBranch,
    cloneDirectoryName,
    cloneParentDirectory,
    cloneRemoteState,
    cloneUrl,
    rememberCloneParentDirectory,
    routeRepository,
    t,
  ]);
  const retryOpenClonedProject = React.useCallback(async () => {
    if (!cloneCompletedPath || openingClonedProject) {
      return;
    }
    setOpeningClonedProject(true);
    try {
      await routeRepository(cloneCompletedPath);
      cloneDialogOpenRef.current = false;
      setCloneDialogOpen(false);
      setCloneCompletedPath(null);
      setCloneError(null);
    } catch (error) {
      setCloneError(t("start.cloneOpenFailed", { path: cloneCompletedPath }));
      dispatchErrorGroup([error], t("start.cloneOpenFailedSummary"));
    } finally {
      setOpeningClonedProject(false);
    }
  }, [cloneCompletedPath, openingClonedProject, routeRepository, t]);
  const handleChooseCloneParentDirectory = React.useCallback(async () => {
    try {
      const selected = await openDialog({
        defaultPath: cloneParentDirectory.trim() || undefined,
        directory: true,
        multiple: false,
        title: t("start.cloneChooseParentDirectory"),
      });
      if (typeof selected === "string" && selected.trim()) {
        setCloneParentDirectory(selected);
        setCloneError(null);
      }
    } catch (error) {
      setCloneError(t("start.cloneChooseParentFailed"));
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    }
  }, [cloneParentDirectory, t]);
  const handleForgetRecentProject = React.useCallback(
    async (path: string) => {
      if (recentMutation !== null || pageInteractionBusy) {
        return;
      }
      setRecentMutation(path);
      try {
        await forgetRecentProject({ path });
        removeRecentProject(path);
        if (missingProject === path) {
          setMissingProject(null);
        }
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setRecentMutation(null);
      }
    },
    [missingProject, pageInteractionBusy, recentMutation, removeRecentProject],
  );
  const handleClearRecentProjects = React.useCallback(async () => {
    if (recentMutation !== null || pageInteractionBusy) {
      return;
    }
    setRecentMutation("*");
    try {
      await clearPersistedRecentProjects();
      clearRecentProjects();
      setMissingProject(null);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setRecentMutation(null);
    }
  }, [clearRecentProjects, pageInteractionBusy, recentMutation]);
  const handleCancelClone = React.useCallback(() => {
    if (!cloneOperationId) {
      return;
    }
    setCloneCancelConfirmOpen(true);
  }, [cloneOperationId]);

  const confirmCancelClone = React.useCallback(async () => {
    if (!cloneOperationId || !isCloning) {
      setCloneCancelConfirmOpen(false);
      return;
    }

    setCloneCancelling(true);
    setCloneCancelConfirmOpen(false);
    setCloneError(null);
    try {
      const response = await cancelCloneRepository({
        operationId: cloneOperationId,
      });
      if (!response.cancelled) {
        setCloneError(null);
        showToast({
          key: "clone-result",
          message: t("start.cloneCancelUnavailable"),
        });
        setCloneCancelling(false);
      }
    } catch (error) {
      setCloneError(t("start.cloneCancelFailed"));
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
      setCloneCancelling(false);
    }
  }, [cloneOperationId, isCloning, t]);
  const recoverCloneForWindowClose = React.useCallback(async () => {
    if (!cloneOperationId) {
      return;
    }

    setCloneCancelling(true);
    setCloneError(null);
    let response: Awaited<ReturnType<typeof cancelCloneRepository>>;
    try {
      response = await cancelCloneRepository({
        operationId: cloneOperationId,
      });
    } catch (error) {
      const message = t("start.cloneCancelFailed");
      setCloneError(message);
      setCloneCancelling(false);
      throw error;
    }

    if (!response.cancelled) {
      setCloneCancelling(false);
      const message = t("start.cloneCancelUnavailable");
      setCloneError(message);
      throw new Error(message);
    }
  }, [cloneOperationId, t]);
  const recoverOperationForWindowClose = React.useCallback(async () => {
    if (isCloning) {
      await recoverCloneForWindowClose();
      return;
    }
    if (!openOperationId) {
      return;
    }

    setOpenCancelling(true);
    const response = await cancelOperation({ operationId: openOperationId });
    if (!response.cancelled) {
      setOpenCancelling(false);
      throw new Error(t("start.openCancelUnavailable"));
    }
  }, [isCloning, openOperationId, recoverCloneForWindowClose, t]);
  const handleCloneUrlChange = React.useCallback(
    (url: string) => {
      setCloneUrl(url);
      setCloneError(null);
      setCloneBranch("");
      setCloneRemoteState(cloneRemoteStateForUrl(url));
      setCloneProbeDetails(null);
      setCloneProbeInteractive(false);
      if (!cloneDirectoryNameTouched) {
        setCloneDirectoryName(inferDirectoryNameFromUrl(url));
      }
    },
    [cloneDirectoryNameTouched],
  );
  React.useEffect(() => {
    const url = cloneUrl.trim();
    if (!cloneDialogOpen || !url) {
      return undefined;
    }

    let disposed = false;
    let operationId: string | null = null;

    const timer = window.setTimeout(() => {
      if (disposed) {
        return;
      }
      operationId = createOperationId("clone-probe");
      void probeRemoteRepository({
        interactive: cloneProbeInteractive,
        operationId,
        url,
      })
        .then((response) => {
          operationId = null;
          if (disposed) {
            return;
          }
          const selectedBranch =
            response.defaultBranch ?? response.branches[0] ?? "";
          setCloneBranch(selectedBranch);
          setCloneProbeDetails(null);
          setCloneRemoteState({
            branches: response.branches,
            defaultBranch: response.defaultBranch,
            isEmpty: response.isEmpty,
            kind: "ready",
            truncated: response.truncated,
            url,
          });
        })
        .catch((error) => {
          operationId = null;
          if (!disposed) {
            const details = errorDetails(error, t("start.cloneProbeFailed"));
            setCloneBranch("");
            setCloneRemoteState({
              error: details,
              kind: "error",
              message: t("start.cloneProbeFailed"),
              url,
            });
          }
        });
    }, cloneProbeDebounceMs);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (operationId) {
        void cancelOperation({ operationId }).catch(() => undefined);
      }
    };
  }, [cloneDialogOpen, cloneProbeAttempt, cloneProbeInteractive, cloneUrl, t]);
  React.useEffect(() => {
    let disposed = false;
    let unlistenProgress: (() => void) | null = null;
    void listenAppEvent("operation-progress", (event) => {
      if (
        !disposed &&
        event.payload.operationId === cloneOperationIdRef.current
      ) {
        setCloneProgress(event.payload);
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenProgress = unlisten;
        }
      })
      .catch((error) => {
        if (!disposed) {
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      });

    return () => {
      disposed = true;
      unlistenProgress?.();
    };
  }, []);

  React.useEffect(() => {
    if (!openOperationId) {
      return undefined;
    }

    let disposed = false;
    let unlistenProgress: (() => void) | null = null;
    void listenAppEvent("operation-progress", (event) => {
      if (
        !disposed &&
        event.payload.operationId === openOperationIdRef.current
      ) {
        setOpenProgress(event.payload);
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenProgress = unlisten;
        }
      })
      .catch((error) => {
        if (!disposed) {
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      });

    return () => {
      disposed = true;
      unlistenProgress?.();
    };
  }, [openOperationId]);

  React.useEffect(() => {
    const openProject = () => {
      void handleChooseOpenRepository();
    };
    const cloneProject = () => {
      if (
        cloneDialogOpenRef.current ||
        choosingOpenRepositoryRef.current ||
        openingRepositoryRef.current ||
        isCloning
      ) {
        return;
      }
      cloneDialogOpenRef.current = true;
      setCloneParentDirectory((current) =>
        current.trim() ? current : initialCloneParentDirectory(appSettings),
      );
      setCloneDialogOpen(true);
      setCloneError(null);
      setCloneBranch("");
      setCloneRemoteState(cloneRemoteStateForUrl(cloneUrl));
      setCloneProbeInteractive(false);
    };

    window.addEventListener("artistic-git:open-project", openProject);
    window.addEventListener("artistic-git:clone-project", cloneProject);

    return () => {
      window.removeEventListener("artistic-git:open-project", openProject);
      window.removeEventListener("artistic-git:clone-project", cloneProject);
    };
  }, [appSettings, cloneUrl, handleChooseOpenRepository, isCloning]);

  React.useEffect(() => {
    const action = new URLSearchParams(window.location.search).get("action");
    if (action !== "open" && action !== "clone") {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("action");
    window.history.replaceState(null, "", url);
    window.dispatchEvent(
      new CustomEvent(
        action === "clone"
          ? "artistic-git:clone-project"
          : "artistic-git:open-project",
      ),
    );
  }, []);

  return (
    <main
      className="flex min-h-screen bg-background text-foreground"
      data-testid="start-screen"
    >
      <div className="mx-auto grid min-h-screen w-full max-w-6xl grid-cols-1 gap-8 px-5 py-6 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] md:gap-10 md:px-8 md:py-10">
        <section className="flex min-w-0 flex-col justify-between gap-6">
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
                data-testid="start-open-project"
                disabled={
                  isChoosingOpenRepository || openingPath !== null || isCloning
                }
                onClick={() => void handleChooseOpenRepository()}
                size="lg"
                type="button"
              >
                <FolderOpen className="size-5" aria-hidden="true" />
                {t("actions.openProject")}
              </Button>
              <Button
                className="h-12 justify-start gap-3 px-4"
                data-testid="start-clone-project"
                disabled={
                  isChoosingOpenRepository || openingPath !== null || isCloning
                }
                onClick={() => {
                  cloneDialogOpenRef.current = true;
                  setCloneParentDirectory((current) =>
                    current.trim()
                      ? current
                      : initialCloneParentDirectory(appSettings),
                  );
                  setCloneDialogOpen(true);
                  setCloneError(null);
                  setCloneBranch("");
                  setCloneRemoteState(cloneRemoteStateForUrl(cloneUrl));
                  setCloneProbeInteractive(false);
                }}
                size="lg"
                type="button"
                variant="secondary"
              >
                <GitBranchPlus className="size-5" aria-hidden="true" />
                {t("actions.cloneProject")}
              </Button>
              {openingPath ? (
                <OpenProgressView
                  cancelling={openCancelling}
                  onCancel={() => void cancelOpenRepository()}
                  progress={openProgress}
                />
              ) : null}
              {!openingPath && openRouteFailure ? (
                <div
                  className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
                  role="alert"
                >
                  <p>
                    {t("start.openRouteFailedAt", {
                      path: openRouteFailure.path,
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent("artistic-git:error", {
                            detail: openRouteFailure.error,
                          }),
                        )
                      }
                      type="button"
                      variant="ghost"
                    >
                      {t("dialogs.error.showDetails")}
                    </Button>
                    <Button
                      onClick={() => void retryOpenRepositoryRoute()}
                      type="button"
                      variant="secondary"
                    >
                      {t("start.retryOpenProject")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <IconButton
              disabled={pageInteractionBusy}
              label={t("start.openOnboarding")}
              onClick={() => {
                setOnboarded(false);
              }}
              tooltip={t("start.openOnboardingTooltip")}
              type="button"
              variant="ghost"
            >
              <GraduationCap className="size-5" aria-hidden="true" />
            </IconButton>
            <IconButton
              disabled={pageInteractionBusy}
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

        <section className="flex min-w-0 flex-col pb-6 md:py-12">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-base font-medium">{t("app.recentProjects")}</h2>
            {recentProjectsRuntime.status === "ready" &&
            visibleRecentProjects.length > 0 ? (
              <button
                className="text-sm text-muted-foreground hover:text-foreground"
                disabled={pageInteractionBusy || recentMutation !== null}
                onClick={() => void handleClearRecentProjects()}
                type="button"
              >
                {recentMutation === "*"
                  ? t("start.clearingRecent")
                  : t("start.clearRecent")}
              </button>
            ) : null}
          </div>

          <OverlayScrollArea className="min-h-0 flex-1 rounded-md border bg-card">
            {recentProjectsRuntime.status === "loading" ? (
              <div
                aria-live="polite"
                className="flex h-full min-h-64 items-center justify-center gap-2 px-8 text-sm text-muted-foreground"
                role="status"
              >
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
                {t("start.loadingRecent")}
              </div>
            ) : recentProjectsRuntime.status === "failed" ? (
              <div
                className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-8 text-center"
                role="alert"
              >
                <CircleAlert
                  className="size-5 text-destructive"
                  aria-hidden="true"
                />
                <p className="text-sm text-muted-foreground">
                  {t("start.recentLoadFailed")}
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("artistic-git:error", {
                          detail: recentProjectsRuntime.error,
                        }),
                      )
                    }
                    type="button"
                    variant="ghost"
                  >
                    {t("dialogs.error.showDetails")}
                  </Button>
                  <Button
                    className="gap-2"
                    onClick={retryRecentProjects}
                    type="button"
                    variant="secondary"
                  >
                    <RefreshCw className="size-4" aria-hidden="true" />
                    {t("actions.retry")}
                  </Button>
                </div>
              </div>
            ) : visibleRecentProjects.length === 0 ? (
              <div className="flex h-full min-h-64 items-center justify-center px-8 text-center text-sm text-muted-foreground">
                {t("app.recentProjectsEmpty")}
              </div>
            ) : (
              <ul className="divide-y">
                {visibleRecentProjects.map((project) => (
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
                        disabled={
                          isChoosingOpenRepository ||
                          openingPath !== null ||
                          isCloning
                        }
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
                        aria-busy={recentMutation === project.path}
                        className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                        label={
                          recentMutation === project.path
                            ? t("start.removingRecent", {
                                name: project.displayName,
                              })
                            : t("start.removeRecent", {
                                name: project.displayName,
                              })
                        }
                        disabled={
                          pageInteractionBusy || recentMutation !== null
                        }
                        onClick={() =>
                          void handleForgetRecentProject(project.path)
                        }
                        tooltip={t("start.removeRecentTooltip")}
                        type="button"
                        variant="ghost"
                      >
                        {recentMutation === project.path ? (
                          <LoaderCircle
                            className="size-4 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 className="size-4" aria-hidden="true" />
                        )}
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </OverlayScrollArea>

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
                disabled={pageInteractionBusy || recentMutation !== null}
                onClick={() => void handleForgetRecentProject(missingProject)}
                type="button"
              >
                {t("start.removeFromList")}
              </button>
            </div>
          ) : null}
        </section>
      </div>
      {cloneDialogOpen && cloneProbeDetails === null ? (
        <CloneRepositoryDialog
          branch={cloneBranch}
          busy={isCloning}
          cancelling={cloneCancelling}
          completedPath={cloneCompletedPath}
          directoryName={cloneDirectoryName}
          error={cloneError}
          onCancelClone={() => void handleCancelClone()}
          onRetryOpen={() => void retryOpenClonedProject()}
          onBranchChange={setCloneBranch}
          onChooseParentDirectory={() =>
            void handleChooseCloneParentDirectory()
          }
          onDirectoryNameChange={(value) => {
            setCloneDirectoryName(value);
            setCloneDirectoryNameTouched(true);
            setCloneError(null);
          }}
          onOpenChange={(open) => {
            if (!isCloning) {
              cloneDialogOpenRef.current = open;
              setCloneDialogOpen(open);
              if (!open) {
                setCloneCompletedPath(null);
                setCloneError(null);
              }
            }
          }}
          onParentDirectoryChange={(value) => {
            setCloneParentDirectory(value);
            setCloneError(null);
          }}
          onRetryProbe={() => {
            const url = cloneUrl.trim();
            if (url) {
              setCloneRemoteState({ kind: "checking", url });
            }
            setCloneBranch("");
            setCloneProbeDetails(null);
            setCloneProbeInteractive(true);
            setCloneProbeAttempt((attempt) => attempt + 1);
          }}
          onSubmit={() => void handleCloneRepository()}
          onUrlChange={handleCloneUrlChange}
          parentDirectory={cloneParentDirectory}
          progress={cloneProgress}
          probeDetailsTriggerRef={cloneProbeDetailsTriggerRef}
          remoteState={cloneRemoteState}
          retryingOpen={openingClonedProject}
          onShowProbeDetails={setCloneProbeDetails}
          url={cloneUrl}
        />
      ) : null}
      <ConfirmDialog
        confirmLabel={t("start.cloneCancel")}
        description={t("start.cloneCancelConfirm")}
        onConfirm={() => void confirmCancelClone()}
        onOpenChange={setCloneCancelConfirmOpen}
        open={cloneCancelConfirmOpen && isCloning}
        title={t("start.cloneCancelTitle")}
        variant="danger"
      />
      <ErrorDetailsDialog
        error={cloneProbeDetails ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            restoreCloneProbeDetailsFocusRef.current = true;
            setCloneProbeDetails(null);
          }
        }}
        open={cloneProbeDetails !== null}
      />
      <WindowCloseGuard
        active={isCloning || openingPath !== null}
        canRecover={
          (isCloning &&
            cloneOperationId !== null &&
            cloneProgress?.cancellable === true &&
            !cloneCancelling) ||
          (openingPath !== null &&
            openOperationId !== null &&
            openProgress?.cancellable === true &&
            !openCancelling)
        }
        confirmLabel={isCloning ? undefined : t("start.openCloseGuardConfirm")}
        description={
          isCloning ? undefined : t("start.openCloseGuardDescription")
        }
        onRecover={recoverOperationForWindowClose}
        recoveryBusyLabel={
          isCloning ? undefined : t("start.openCloseGuardCancelling")
        }
      />
    </main>
  );
}

interface CloneRepositoryDialogProps {
  branch: string;
  busy: boolean;
  cancelling: boolean;
  completedPath: string | null;
  directoryName: string;
  error: string | null;
  onBranchChange: (value: string) => void;
  onCancelClone: () => void;
  onRetryOpen: () => void;
  onChooseParentDirectory: () => void;
  onDirectoryNameChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onParentDirectoryChange: (value: string) => void;
  onRetryProbe: () => void;
  onShowProbeDetails: (error: AppError | Error | string) => void;
  onSubmit: () => void;
  onUrlChange: (value: string) => void;
  parentDirectory: string;
  progress: OperationProgressEvent | null;
  probeDetailsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  remoteState: CloneRemoteState;
  retryingOpen: boolean;
  url: string;
}

function CloneRepositoryDialog({
  branch,
  busy,
  cancelling,
  completedPath,
  directoryName,
  error,
  onBranchChange,
  onCancelClone,
  onRetryOpen,
  onChooseParentDirectory,
  onDirectoryNameChange,
  onOpenChange,
  onParentDirectoryChange,
  onRetryProbe,
  onShowProbeDetails,
  onSubmit,
  onUrlChange,
  parentDirectory,
  progress,
  probeDetailsTriggerRef,
  remoteState,
  retryingOpen,
  url,
}: CloneRepositoryDialogProps) {
  const { t } = useTranslation();
  const urlId = React.useId();
  const urlInputRef = React.useRef<HTMLInputElement | null>(null);
  const branchId = React.useId();
  const parentId = React.useId();
  const directoryNameId = React.useId();
  const remoteReady =
    remoteState.kind === "ready" &&
    remoteState.url === url.trim() &&
    (remoteState.isEmpty || branch.trim().length > 0);
  const canSubmit =
    url.trim().length > 0 &&
    parentDirectory.trim().length > 0 &&
    directoryName.trim().length > 0 &&
    remoteReady &&
    !busy;
  const branchOptions = React.useMemo(
    () =>
      remoteState.kind === "ready"
        ? remoteState.branches.map((candidate) => ({
            label:
              candidate === remoteState.defaultBranch
                ? t("start.cloneDefaultBranchOption", {
                    branch: candidate,
                  })
                : candidate,
            value: candidate,
          }))
        : [],
    [remoteState, t],
  );

  return (
    <DialogFrame
      closeOnEscape={!busy}
      description={t("start.cloneDescription")}
      hideCloseButton={busy}
      onOpenChange={onOpenChange}
      title={t("actions.cloneProject")}
      footer={
        <div className="flex justify-end gap-2">
          {busy ? (
            <Button
              disabled={cancelling || progress?.cancellable !== true}
              onClick={onCancelClone}
              type="button"
              variant="ghost"
            >
              {cancelling ? t("start.cloneCancelling") : t("start.cloneCancel")}
            </Button>
          ) : completedPath ? (
            <>
              <Button
                disabled={retryingOpen}
                onClick={() => onOpenChange(false)}
                type="button"
                variant="ghost"
              >
                {t("actions.close")}
              </Button>
              <Button
                className="gap-2"
                disabled={retryingOpen}
                onClick={onRetryOpen}
                type="button"
              >
                {retryingOpen ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <FolderOpen className="size-4" aria-hidden="true" />
                )}
                {retryingOpen
                  ? t("start.retryingOpenProject")
                  : t("start.retryOpenProject")}
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={() => onOpenChange(false)}
                type="button"
                variant="ghost"
              >
                {t("actions.cancel")}
              </Button>
              <Button
                data-testid="clone-submit"
                disabled={!canSubmit}
                type="submit"
                form="clone-repository"
              >
                {t("actions.cloneProject")}
              </Button>
            </>
          )}
        </div>
      }
    >
      {busy ? (
        <CloneProgressView
          cancelling={cancelling}
          error={error}
          progress={progress}
        />
      ) : completedPath ? (
        <div className="space-y-3" role="status" aria-live="polite">
          <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm">
            <CircleCheck
              className="mt-0.5 size-4 shrink-0 text-success"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{t("start.cloneCompleted")}</p>
              <TruncatedText
                className="block text-xs text-muted-foreground"
                normalizePath
                text={completedPath}
              />
            </div>
          </div>
          {error ? (
            <div
              className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
              role="alert"
            >
              {error}
            </div>
          ) : null}
        </div>
      ) : (
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
              data-testid="clone-url-input"
              id={urlId}
              onChange={(event) => onUrlChange(event.currentTarget.value)}
              placeholder={t("start.cloneUrlPlaceholder")}
              ref={urlInputRef}
              type="text"
              value={url}
            />
          </label>
          <CloneRemoteStatus
            onRetry={() => {
              onRetryProbe();
              urlInputRef.current?.focus();
            }}
            onShowDetails={onShowProbeDetails}
            showDetailsTriggerRef={probeDetailsTriggerRef}
            state={remoteState}
          />
          {remoteState.kind === "ready" && !remoteState.isEmpty ? (
            <BranchSelect
              data-testid="clone-branch-select"
              id={branchId}
              label={t("start.cloneBranch")}
              noResultsLabel={t("repository.noSearchResults")}
              onChange={onBranchChange}
              options={branchOptions}
              searchLabel={t("repository.searchBranches")}
              value={branch}
            />
          ) : null}
          <label
            className="flex flex-col gap-2 text-sm font-medium"
            htmlFor={parentId}
          >
            {t("start.cloneParentDirectory")}
            <span className="grid grid-cols-[1fr_auto] gap-2">
              <input
                className="h-9 min-w-0 rounded-md border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="clone-parent-directory-input"
                id={parentId}
                onChange={(event) =>
                  onParentDirectoryChange(event.currentTarget.value)
                }
                placeholder={t("start.cloneParentDirectoryPlaceholder")}
                readOnly
                type="text"
                value={parentDirectory}
              />
              <Button
                className="gap-2"
                onClick={onChooseParentDirectory}
                type="button"
                variant="secondary"
              >
                <FolderSearch className="size-4" aria-hidden="true" />
                {t("start.cloneBrowse")}
              </Button>
            </span>
          </label>
          <label
            className="flex flex-col gap-2 text-sm font-medium"
            htmlFor={directoryNameId}
          >
            {t("start.cloneDirectoryName")}
            <input
              className="h-9 rounded-md border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="clone-directory-name-input"
              id={directoryNameId}
              onChange={(event) =>
                onDirectoryNameChange(event.currentTarget.value)
              }
              placeholder={t("start.cloneDirectoryNamePlaceholder")}
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
      )}
    </DialogFrame>
  );
}

function CloneRemoteStatus({
  onRetry,
  onShowDetails,
  showDetailsTriggerRef,
  state,
}: {
  onRetry: () => void;
  onShowDetails: (error: AppError | Error | string) => void;
  showDetailsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  state: CloneRemoteState;
}) {
  const { t } = useTranslation();

  if (state.kind === "idle") {
    return null;
  }
  if (state.kind === "checking") {
    return (
      <div
        aria-live="polite"
        className="flex items-center gap-2 bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        {t("start.cloneProbeChecking")}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        className="flex items-start justify-between gap-3 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        role="alert"
      >
        <span className="flex min-w-0 items-start gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{state.message}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            className="h-8 px-2"
            onClick={() => onShowDetails(state.error)}
            ref={showDetailsTriggerRef}
            type="button"
            variant="ghost"
          >
            {t("dialogs.error.showDetails")}
          </Button>
          <Button
            className="h-8 gap-2 px-2"
            onClick={onRetry}
            type="button"
            variant="ghost"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("start.cloneProbeRetry")}
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2 bg-success/10 px-3 py-2 text-sm"
      role="status"
    >
      <CircleCheck
        className="size-4 shrink-0 text-success"
        aria-hidden="true"
      />
      {state.isEmpty
        ? t("start.cloneProbeEmpty")
        : t(
            state.truncated
              ? "start.cloneBranchesFoundTruncated"
              : "start.cloneBranchesFound",
            {
              count: state.branches.length,
            },
          )}
    </div>
  );
}

interface CloneProgressViewProps {
  cancelling: boolean;
  error: string | null;
  progress: OperationProgressEvent | null;
}

function CloneProgressView({
  cancelling,
  error,
  progress,
}: CloneProgressViewProps) {
  const { t } = useTranslation();
  const percent = progressPercent(progress?.progress);
  const label = cancelling
    ? t("start.cloneCancelling")
    : cloneProgressLabel(progress?.label, t);

  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        {percent !== null ? (
          <span className="tabular-nums text-muted-foreground">
            {Math.round(percent)}%
          </span>
        ) : null}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-primary transition-all",
            percent === null && "w-1/2 animate-pulse",
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

function OpenProgressView({
  cancelling,
  onCancel,
  progress,
}: {
  cancelling: boolean;
  onCancel: () => void;
  progress: OperationProgressEvent | null;
}) {
  const { t } = useTranslation();
  const percent = progressPercent(progress?.progress);
  const label = openProgressLabel(progress?.label, t);

  return (
    <div
      className="rounded-md border bg-card px-3 py-2"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{label}</span>
        {percent !== null ? (
          <span className="tabular-nums text-muted-foreground">
            {Math.round(percent)}%
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex justify-end">
        <Button
          disabled={cancelling || progress?.cancellable !== true}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          {cancelling ? t("actions.cancelling") : t("actions.cancel")}
        </Button>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-primary transition-all",
            percent === null && "w-1/2 animate-pulse",
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
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

function reportNonFatalRepositoryErrors(
  errors: AppError[] | undefined,
  summary: string,
) {
  if (!errors?.length) {
    return;
  }
  dispatchErrorGroup(errors, summary);
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

function createOperationId(prefix = "clone"): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function cloneRemoteStateForUrl(url: string): CloneRemoteState {
  const trimmedUrl = url.trim();
  return trimmedUrl ? { kind: "checking", url: trimmedUrl } : { kind: "idle" };
}

function progressPercent(progress: ProgressState | undefined): number | null {
  if (!progress || progress.kind !== "percent" || progress.value === null) {
    return null;
  }

  return Math.max(0, Math.min(100, progress.value));
}

function cloneProgressLabel(
  label: string | undefined,
  t: (key: string) => string,
): string {
  switch (label) {
    case "Downloading LFS objects":
      return t("start.cloneProgressLfs");
    case "Checking out files":
      return t("start.cloneProgressCheckout");
    case "Cloning submodules":
      return t("start.cloneProgressSubmodules");
    case "Clone complete":
      return t("start.cloneProgressFinalizing");
    case "Cloning repository":
    default:
      return t("start.cloneProgressClone");
  }
}

function openProgressLabel(
  label: string | undefined,
  t: (key: string) => string,
): string {
  switch (label) {
    case "Updating submodules":
      return t("repository.updatingSubmodules");
    case "Downloading submodule LFS objects":
      return t("repository.downloadingSubmoduleLfs");
    case "Submodules ready":
      return t("start.openProgressFinalizing");
    case "Opening repository":
    default:
      return t("start.openingRepository");
  }
}

function errorDetails(
  error: unknown,
  fallback: string,
): AppError | Error | string {
  if (
    typeof error === "string" ||
    error instanceof Error ||
    isAppError(error)
  ) {
    return error;
  }

  return fallback;
}

function isAppError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    "summary" in error &&
    "context" in error
  );
}
