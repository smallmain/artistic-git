import {
  AlertTriangle,
  Archive,
  FileText,
  History,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BranchListItem,
  RepositorySidebar,
  type RepositorySummary,
  type StashListItem,
  type SyncFeedback,
} from "@/components/sidebar/RepositorySidebar";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import {
  ConflictResolutionOverlay,
  type ConflictResolutionApi,
} from "@/features/conflicts";
import { HistoryWorkbench } from "@/features/history/HistoryWorkbench";
import {
  demoLocalChanges,
  LocalChangesPanel,
  type LocalChangeItem,
} from "@/features/local-changes";
import { useLocalizedFormatters } from "@/i18n/format";
import {
  acceptRemoteHistory,
  checkoutBranch,
  cancelPendingWindowExit,
  cancelConflictResolution,
  cancelStashRestore,
  closeCurrentWindow,
  commitChanges,
  completeConflictResolution,
  conflictDetail,
  createBranch,
  createStash,
  deleteBranch,
  deleteSafetyBackup,
  deleteStash,
  dismissReviewModeRecovery,
  exitReviewMode,
  fetchRepository,
  listBranches,
  listConflicts,
  listLocalChanges,
  listSafetyBackups,
  listStashes,
  loadProjectSettings,
  previewRenormalize,
  restoreChanges,
  restoreStash,
  recoverReviewModeStash,
  repositorySummary,
  reviewModeRecovery,
  saveProjectSettings,
  saveWindowGeometry,
  saveConflictResolution,
  selectConflictSide,
  setWindowCloseGuard,
  stashDetails,
  startReviewMode,
  syncAllBranches,
  syncBranch,
  syncReviewMode,
  validateBranchName,
} from "@/lib/ipc/commands";
import type {
  BranchOperationResponse,
  BranchNameValidationResponse,
  BranchSummary,
  CheckoutLocalChangesMode,
  FetchStateEvent,
  LargeFileWarning,
  LocalChange,
  LocalChangesViewMode,
  ReviewModeState,
  RemoteHistoryChange,
  SyncAllBranchesResponse,
  SyncBranchResponse,
  SafetyBackupSummary,
  SidebarLayoutSettings,
  StashEntry,
  StashDetailsResponse,
  StashRecoveryPoint,
} from "@/lib/ipc/generated";
import { repoQueryKeys } from "@/lib/realtime/query-keys";
import { cn } from "@/lib/utils";
import { useWindowStore } from "@/store/window-store";
import {
  normalizeAppSettings,
  normalizeProjectSettings,
  validateFetchIntervalSeconds,
} from "@/features/settings/settings-model";
import { ReviewModeOverlay } from "@/features/review/ReviewModeOverlay";

type MainTab = "history" | "localChanges";
type StashScope = "all" | "selected";
type WindowCloseBlockedReason = "closeWindow" | "quit";
type SyncStatusTranslator = (
  key: string,
  options?: Record<string, unknown>,
) => string;

interface WindowCloseBlockedEvent {
  reason?: WindowCloseBlockedReason;
}

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
    name: "concept-pass",
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
  const formatters = useLocalizedFormatters();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = React.useState<MainTab>("history");
  const [commitIds, setCommitIds] = React.useState<string[] | null>(null);
  const [commitMessage, setCommitMessage] = React.useState("");
  const [commitPushImmediately, setCommitPushImmediately] =
    React.useState(true);
  const [commitBusy, setCommitBusy] = React.useState(false);
  const [commitStatus, setCommitStatus] = React.useState<string | null>(null);
  const [gpgFailure, setGpgFailure] = React.useState<{
    stderr: string;
    summary: string;
  } | null>(null);
  const [largeFileWarning, setLargeFileWarning] = React.useState<{
    files: LargeFileWarning[];
    thresholdMb: number;
  } | null>(null);
  const [renormalizePreviewBusy, setRenormalizePreviewBusy] =
    React.useState(false);
  const [renormalizePreviewStatus, setRenormalizePreviewStatus] =
    React.useState<string | null>(null);
  const [restoreIds, setRestoreIds] = React.useState<string[] | null>(null);
  const [restoreBusy, setRestoreBusy] = React.useState(false);
  const [branchActionBusy, setBranchActionBusy] = React.useState(false);
  const [fetchBusy, setFetchBusy] = React.useState(false);
  const [syncBusy, setSyncBusy] = React.useState(false);
  const [syncFeedback, setSyncFeedback] = React.useState<SyncFeedback | null>(
    null,
  );
  const [syncStatus, setSyncStatus] = React.useState<string | null>(null);
  const [historyWriteBusy, setHistoryWriteBusy] = React.useState(false);
  const [safetyBackupBusy, setSafetyBackupBusy] = React.useState(false);
  const [reviewBusy, setReviewBusy] = React.useState(false);
  const [remoteHistoryChange, setRemoteHistoryChange] =
    React.useState<RemoteHistoryChange | null>(null);
  const [safetyBackupsOpen, setSafetyBackupsOpen] = React.useState(false);
  const [safetyBackups, setSafetyBackups] = React.useState<
    SafetyBackupSummary[]
  >([]);
  const [safetyBackupToDelete, setSafetyBackupToDelete] =
    React.useState<SafetyBackupSummary | null>(null);
  const [reviewModeState, setReviewModeState] =
    React.useState<ReviewModeState | null>(null);
  const [reviewRecoveryPrompt, setReviewRecoveryPrompt] = React.useState(false);
  const [closeRequest, setCloseRequest] = React.useState<{
    reason: WindowCloseBlockedReason;
  } | null>(null);
  const [closeRecoveryBusy, setCloseRecoveryBusy] = React.useState(false);
  const [liveFetchState, setLiveFetchState] =
    React.useState<FetchStateEvent | null>(null);
  const fetchInFlightRef = React.useRef(false);
  const initialFetchRepositoryRef = React.useRef<string | null>(null);
  const [branchToCheckout, setBranchToCheckout] =
    React.useState<BranchListItem | null>(null);
  const [checkoutMode, setCheckoutMode] =
    React.useState<CheckoutLocalChangesMode>("autoStash");
  const [branchCreateBase, setBranchCreateBase] =
    React.useState<BranchListItem | null>(null);
  const [newBranchName, setNewBranchName] = React.useState("");
  const [newBranchCheckout, setNewBranchCheckout] = React.useState(true);
  const [newBranchCreateRemote, setNewBranchCreateRemote] =
    React.useState(false);
  const [branchNameValidation, setBranchNameValidation] =
    React.useState<BranchNameValidationResponse | null>(null);
  const [branchToDelete, setBranchToDelete] =
    React.useState<BranchListItem | null>(null);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = React.useState(false);
  const [stashActionBusy, setStashActionBusy] = React.useState(false);
  const [stashIds, setStashIds] = React.useState<string[] | null>(null);
  const [stashMessage, setStashMessage] = React.useState("");
  const [stashScope, setStashScope] = React.useState<StashScope>("all");
  const [stashToDelete, setStashToDelete] =
    React.useState<StashListItem | null>(null);
  const [stashDetail, setStashDetail] =
    React.useState<StashDetailsResponse | null>(null);
  const [stashRecoveryByOperation, setStashRecoveryByOperation] =
    React.useState<Record<string, StashRecoveryPoint>>({});
  const [revertAutoStashByOperation, setRevertAutoStashByOperation] =
    React.useState<Record<string, StashEntry>>({});
  const [localChangeCheckedIds, setLocalChangeCheckedIds] = React.useState<
    string[]
  >([]);
  const [focusedBranch, setFocusedBranch] = React.useState<BranchListItem>(
    demoBranches[0],
  );
  const summaryQuery = useQuery({
    queryFn: () => repositorySummary({ repositoryPath }),
    queryKey: repoQueryKeys.summary(repositoryPath),
    retry: false,
  });
  const branchesQuery = useQuery({
    queryFn: () => listBranches({ repositoryPath }),
    queryKey: repoQueryKeys.branches(repositoryPath),
    retry: false,
  });
  const stashesQuery = useQuery({
    queryFn: () => listStashes({ repositoryPath }),
    queryKey: repoQueryKeys.stashes(repositoryPath),
    retry: false,
  });
  const localChangesQuery = useQuery({
    queryFn: () => listLocalChanges({ repositoryPath }),
    queryKey: repoQueryKeys.localChanges(repositoryPath),
    retry: false,
  });
  const projectSettingsQuery = useQuery({
    queryFn: () => loadProjectSettings({ repositoryPath }),
    queryKey: ["repository", repositoryPath, "projectSettings"] as const,
    retry: false,
  });
  const branches = React.useMemo(
    () =>
      branchesQuery.data?.branches.map(mapBranchSummaryToItem) ?? demoBranches,
    [branchesQuery.data],
  );
  const historyBranches = React.useMemo(
    () =>
      branches.map((branch) => ({
        current: branch.current,
        name: branch.name,
      })),
    [branches],
  );
  const stashes = React.useMemo(
    () =>
      stashesQuery.data?.stashes.map((stash) =>
        mapStashEntryToItem(stash, formatters.formatRelativeTime),
      ) ?? demoStashes,
    [formatters.formatRelativeTime, stashesQuery.data],
  );
  const localChanges = React.useMemo(
    () =>
      localChangesQuery.data?.changes.map(mapLocalChangeToItem) ??
      demoLocalChanges,
    [localChangesQuery.data],
  );

  React.useEffect(() => {
    setRenormalizePreviewStatus(null);
  }, [localChangesQuery.data?.renormalizeSuggestion?.totalChanges]);

  const currentBranch = React.useMemo(
    () => branches.find((branch) => branch.current) ?? branches[0],
    [branches],
  );
  const effectiveFocusedBranch = React.useMemo(
    () =>
      branches.some((branch) => branch.name === focusedBranch.name)
        ? focusedBranch
        : (currentBranch ?? focusedBranch),
    [branches, currentBranch, focusedBranch],
  );
  const operations = useWindowStore((state) => state.operationsById);
  const appSettings = useWindowStore((state) => state.appSettings);
  const projectSettings = useWindowStore(
    (state) => state.projectSettingsByRepository[repositoryPath] ?? null,
  );
  const setProjectSettings = useWindowStore(
    (state) => state.setProjectSettings,
  );
  const setSidebarLayout = useWindowStore((state) => state.setSidebarLayout);
  const storedFetchState = useWindowStore(
    (state) => state.fetchStatesByRepository[repositoryPath] ?? null,
  );
  const openSettings = useWindowStore((state) => state.openSettings);
  const conflict = useWindowStore(
    (state) => state.conflictsByRepository[repositoryPath] ?? null,
  );
  const clearConflict = useWindowStore((state) => state.clearConflict);
  const setConflictEntered = useWindowStore(
    (state) => state.setConflictEntered,
  );
  const activeOperation = React.useMemo(
    () => Object.values(operations).at(-1) ?? null,
    [operations],
  );
  const fetchState = liveFetchState ?? storedFetchState;
  const effectiveProjectSettings = React.useMemo(
    () =>
      normalizeProjectSettings(
        projectSettings ??
          projectSettingsQuery.data ?? { path: repositoryPath },
      ),
    [projectSettings, projectSettingsQuery.data, repositoryPath],
  );

  React.useEffect(() => {
    const handleFetchState = (event: Event) => {
      const payload = (event as CustomEvent<FetchStateEvent>).detail;
      if (payload?.repositoryPath === repositoryPath) {
        setLiveFetchState(payload);
      }
    };

    window.addEventListener("artistic-git:fetch-state", handleFetchState);
    return () => {
      window.removeEventListener("artistic-git:fetch-state", handleFetchState);
    };
  }, [repositoryPath]);

  React.useEffect(() => {
    const handleViewTab = (event: Event) => {
      const tab = (event as CustomEvent<MainTab>).detail;
      if (tab === "history" || tab === "localChanges") {
        setActiveTab(tab);
      }
    };

    window.addEventListener("artistic-git:view-tab", handleViewTab);
    return () => {
      window.removeEventListener("artistic-git:view-tab", handleViewTab);
    };
  }, []);

  React.useEffect(() => {
    const persistGeometry = () => {
      void saveWindowGeometry({ repositoryPath }).catch(() => undefined);
    };

    window.addEventListener("beforeunload", persistGeometry);
    return () => {
      persistGeometry();
      window.removeEventListener("beforeunload", persistGeometry);
    };
  }, [repositoryPath]);

  React.useEffect(() => {
    if (!projectSettingsQuery.data) {
      return;
    }

    const normalizedProject = normalizeProjectSettings(
      projectSettingsQuery.data,
    );
    setProjectSettings(repositoryPath, normalizedProject);
    setSidebarLayout(normalizedProject.sidebar);
  }, [
    projectSettingsQuery.data,
    repositoryPath,
    setProjectSettings,
    setSidebarLayout,
  ]);

  React.useEffect(() => {
    const name = newBranchName.trim();

    if (!branchCreateBase || name.length === 0) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void validateBranchName({ name, repositoryPath })
        .then((validation) => {
          if (!cancelled) {
            setBranchNameValidation(validation);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setBranchNameValidation({
              exists: false,
              message:
                error instanceof Error
                  ? error.message
                  : t("repository.branchNameInvalid"),
              name,
              valid: false,
            });
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [branchCreateBase, newBranchName, repositoryPath, t]);

  const repository = React.useMemo<RepositorySummary>(
    () => ({
      branchName:
        summaryQuery.data?.currentBranch ??
        currentBranch?.name ??
        effectiveFocusedBranch.name,
      hasRemote: summaryQuery.data?.hasOrigin ?? false,
      path: repositoryPath,
      projectName:
        repositoryPath.split(/[\\/]/).filter(Boolean).at(-1) ??
        t("repository.untitledProject"),
    }),
    [
      currentBranch?.name,
      effectiveFocusedBranch.name,
      repositoryPath,
      summaryQuery.data,
      t,
    ],
  );
  const localChangeCount = localChanges.length;
  const branchActionsDisabledReason = summaryQuery.data?.isUnborn
    ? t("repository.unbornBranchActionsDisabled")
    : undefined;
  const activeOperationBusy = activeOperation !== null;
  const busy =
    activeOperationBusy ||
    fetchBusy ||
    syncBusy ||
    commitBusy ||
    restoreBusy ||
    branchActionBusy ||
    safetyBackupBusy ||
    stashActionBusy ||
    historyWriteBusy ||
    reviewBusy;
  const reviewActive = reviewModeState !== null;
  const writeOperationBusy =
    activeOperationBusy ||
    syncBusy ||
    commitBusy ||
    restoreBusy ||
    branchActionBusy ||
    safetyBackupBusy ||
    stashActionBusy ||
    historyWriteBusy ||
    reviewBusy;
  const closeGuardActive =
    writeOperationBusy ||
    conflict !== null ||
    reviewActive ||
    reviewRecoveryPrompt;
  const interactionBusy = busy || reviewActive;
  const busyLabel = activeOperation
    ? operationLabel(activeOperation.label, t)
    : fetchBusy
      ? t("repository.sync")
      : syncBusy
        ? t("repository.sync")
        : syncStatus
          ? syncStatus
          : commitBusy
            ? t("localChanges.commitBusy")
            : restoreBusy
              ? t("localChanges.restoreBusy")
              : branchActionBusy
                ? t("repository.branchBusy")
                : safetyBackupBusy
                  ? t("repository.safetyBackupBusy")
                  : stashActionBusy
                    ? t("repository.stashBusy")
                    : historyWriteBusy
                      ? t("history.revert.busy")
                      : reviewBusy
                        ? t("review.busy")
                        : t("repository.ready");
  const selectedCommitPaths = React.useMemo(
    () => pathsForChangeIds(commitIds ?? [], localChanges),
    [commitIds, localChanges],
  );
  const selectedRestorePaths = React.useMemo(
    () => pathsForChangeIds(restoreIds ?? [], localChanges),
    [restoreIds, localChanges],
  );
  const selectedStashPaths = React.useMemo(
    () => pathsForChangeIds(stashIds ?? [], localChanges),
    [stashIds, localChanges],
  );
  const shouldFetchBeforeCurrentBranchWrite =
    repository.hasRemote && Boolean(currentBranch?.upstream);
  const defaultStashMessage = React.useCallback(
    () =>
      t("localChanges.defaultStashName", {
        date: formatters.formatDate(new Date(), {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      }),
    [formatters, t],
  );

  const fetchPreferences = normalizeAppSettings(appSettings).git;
  const fetchInterval = validateFetchIntervalSeconds(
    fetchPreferences?.fetchIntervalSeconds,
  );
  const persistProjectPreferences = React.useCallback(
    async (updates: {
      localChangesViewMode?: LocalChangesViewMode;
      sidebar?: Required<SidebarLayoutSettings>;
    }) => {
      const nextProject = {
        ...effectiveProjectSettings,
        localChangesViewMode:
          updates.localChangesViewMode ??
          effectiveProjectSettings.localChangesViewMode,
        sidebar: updates.sidebar ?? effectiveProjectSettings.sidebar,
      };

      setProjectSettings(repositoryPath, nextProject);
      if (updates.sidebar) {
        setSidebarLayout(updates.sidebar);
      }

      try {
        const saved = await saveProjectSettings({
          autoTrackingRules: nextProject.autoTrackingRules,
          largeFileCheck: nextProject.largeFileCheck,
          localChangesViewMode: nextProject.localChangesViewMode,
          repositoryPath,
          sidebar: nextProject.sidebar,
        });
        setProjectSettings(repositoryPath, normalizeProjectSettings(saved));
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      }
    },
    [
      effectiveProjectSettings,
      repositoryPath,
      setProjectSettings,
      setSidebarLayout,
    ],
  );

  const runFetch = React.useCallback(async () => {
    if (fetchInFlightRef.current || !repository.hasRemote) {
      return;
    }

    fetchInFlightRef.current = true;
    setFetchBusy(true);
    try {
      const response = await fetchRepository({ repositoryPath });
      setLiveFetchState(response.event);
      if (!response.skipped && response.event.state === "idle") {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: repoQueryKeys.summary(repositoryPath),
          }),
          queryClient.invalidateQueries({
            queryKey: repoQueryKeys.branches(repositoryPath),
          }),
          queryClient.invalidateQueries({
            queryKey: repoQueryKeys.history(repositoryPath),
          }),
        ]);
      }
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      fetchInFlightRef.current = false;
      setFetchBusy(false);
    }
  }, [queryClient, repository.hasRemote, repositoryPath]);

  const handleSyncAllResponse = React.useCallback(
    (response: SyncAllBranchesResponse) => {
      if (response.remoteHistoryChange) {
        setRemoteHistoryChange(response.remoteHistoryChange);
      }
      const { conflict, stashRecovery } = response;
      if (conflict) {
        if (stashRecovery) {
          setStashRecoveryByOperation((current) => ({
            ...current,
            [conflict.operationId]: stashRecovery,
          }));
        }
        setConflictEntered(conflict);
      }
      setSyncStatus(formatSyncAllStatus(response, t));
      setSyncFeedback(response.allUpToDate ? { kind: "all" } : null);
    },
    [setConflictEntered, t],
  );

  const handleSyncBranchResponse = React.useCallback(
    (response: SyncBranchResponse) => {
      if (
        response.status === "remoteHistoryChanged" &&
        response.remoteHistoryChange
      ) {
        setRemoteHistoryChange(response.remoteHistoryChange);
      }
      if (response.status === "alreadyUpToDate") {
        setSyncFeedback({ branchName: response.branchName, kind: "branch" });
      } else {
        setSyncFeedback(null);
      }
      const { conflict, stashRecovery } = response;
      if (conflict) {
        if (stashRecovery) {
          setStashRecoveryByOperation((current) => ({
            ...current,
            [conflict.operationId]: stashRecovery,
          }));
        }
        setConflictEntered(conflict);
      }
      setSyncStatus(formatSyncBranchStatus(response, t));
    },
    [setConflictEntered, t],
  );

  const runSyncAllBranches = React.useCallback(async () => {
    if (syncBusy || !repository.hasRemote) {
      return;
    }

    setSyncBusy(true);
    setSyncFeedback(null);
    setSyncStatus(null);
    try {
      const response = await syncAllBranches({
        operationId: null,
        repositoryPath,
      });
      handleSyncAllResponse(response);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: repoQueryKeys.summary(repositoryPath),
        }),
        queryClient.invalidateQueries({
          queryKey: repoQueryKeys.branches(repositoryPath),
        }),
        queryClient.invalidateQueries({
          queryKey: repoQueryKeys.history(repositoryPath),
        }),
        queryClient.invalidateQueries({
          queryKey: repoQueryKeys.localChanges(repositoryPath),
        }),
      ]);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSyncBusy(false);
    }
  }, [
    queryClient,
    handleSyncAllResponse,
    repository.hasRemote,
    repositoryPath,
    syncBusy,
  ]);

  const runSyncBranch = React.useCallback(
    async (branch: BranchListItem) => {
      if (syncBusy || !repository.hasRemote) {
        return;
      }

      setSyncBusy(true);
      setSyncFeedback(null);
      setSyncStatus(null);
      try {
        const response = await syncBranch({
          branchName: branch.name,
          operationId: null,
          repositoryPath,
        });
        handleSyncBranchResponse(response);
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: repoQueryKeys.summary(repositoryPath),
          }),
          queryClient.invalidateQueries({
            queryKey: repoQueryKeys.branches(repositoryPath),
          }),
          queryClient.invalidateQueries({
            queryKey: repoQueryKeys.history(repositoryPath),
          }),
          queryClient.invalidateQueries({
            queryKey: repoQueryKeys.localChanges(repositoryPath),
          }),
        ]);
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setSyncBusy(false);
      }
    },
    [
      handleSyncBranchResponse,
      queryClient,
      repository.hasRemote,
      repositoryPath,
      syncBusy,
    ],
  );

  const runAcceptRemoteHistory = React.useCallback(async () => {
    if (!remoteHistoryChange) {
      return;
    }

    setSyncBusy(true);
    try {
      const response = await acceptRemoteHistory({
        branchName: remoteHistoryChange.branchName,
        operationId: null,
        repositoryPath,
      });
      if (response.conflict) {
        if (response.stashRecovery) {
          setStashRecoveryByOperation((current) => ({
            ...current,
            [response.conflict!.operationId]: response.stashRecovery!,
          }));
        }
        setConflictEntered(response.conflict);
      }
      setRemoteHistoryChange(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: repoQueryKeys.summary(repositoryPath),
        }),
        queryClient.invalidateQueries({
          queryKey: repoQueryKeys.branches(repositoryPath),
        }),
        queryClient.invalidateQueries({
          queryKey: repoQueryKeys.history(repositoryPath),
        }),
        queryClient.invalidateQueries({
          queryKey: repoQueryKeys.localChanges(repositoryPath),
        }),
      ]);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSyncBusy(false);
    }
  }, [queryClient, remoteHistoryChange, repositoryPath, setConflictEntered]);

  const refreshSafetyBackups = React.useCallback(async () => {
    setSafetyBackupBusy(true);
    try {
      const response = await listSafetyBackups({ repositoryPath });
      setSafetyBackups(response.backups);
      setSafetyBackupsOpen(true);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSafetyBackupBusy(false);
    }
  }, [repositoryPath]);

  const runDeleteSafetyBackup = React.useCallback(async () => {
    if (!safetyBackupToDelete) {
      return;
    }

    setSafetyBackupBusy(true);
    try {
      await deleteSafetyBackup({
        backupBranch: safetyBackupToDelete.name,
        repositoryPath,
      });
      setSafetyBackupToDelete(null);
      const response = await listSafetyBackups({ repositoryPath });
      setSafetyBackups(response.backups);
      await queryClient.invalidateQueries({
        queryKey: repoQueryKeys.branches(repositoryPath),
      });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSafetyBackupBusy(false);
    }
  }, [queryClient, repositoryPath, safetyBackupToDelete]);

  const invalidateReviewQueries = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: repoQueryKeys.summary(repositoryPath),
      }),
      queryClient.invalidateQueries({
        queryKey: repoQueryKeys.branches(repositoryPath),
      }),
      queryClient.invalidateQueries({
        queryKey: repoQueryKeys.history(repositoryPath),
      }),
      queryClient.invalidateQueries({
        queryKey: repoQueryKeys.localChanges(repositoryPath),
      }),
      queryClient.invalidateQueries({
        queryKey: repoQueryKeys.stashes(repositoryPath),
      }),
    ]);
  }, [queryClient, repositoryPath]);

  const handleReviewExitResponse = React.useCallback(
    async (response: Awaited<ReturnType<typeof exitReviewMode>>) => {
      if (response.status === "conflicts" && response.conflict) {
        if (response.stashRecovery) {
          setStashRecoveryByOperation((current) => ({
            ...current,
            [response.conflict!.operationId]: response.stashRecovery!,
          }));
        }
        setConflictEntered(response.conflict);
      }
      setReviewModeState(null);
      setReviewRecoveryPrompt(false);
      await invalidateReviewQueries();
    },
    [invalidateReviewQueries, setConflictEntered],
  );

  const runStartReviewMode = React.useCallback(async () => {
    if (reviewBusy || reviewModeState) {
      return;
    }

    setReviewBusy(true);
    try {
      const response = await startReviewMode({
        operationId: null,
        repositoryPath,
      });
      setReviewModeState(response.state);
      await invalidateReviewQueries();
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setReviewBusy(false);
    }
  }, [invalidateReviewQueries, repositoryPath, reviewBusy, reviewModeState]);

  const runSyncReviewMode = React.useCallback(async () => {
    if (reviewBusy || !reviewModeState) {
      return;
    }

    setReviewBusy(true);
    try {
      const response = await syncReviewMode({ repositoryPath });
      setReviewModeState(response.state);
      await invalidateReviewQueries();
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setReviewBusy(false);
    }
  }, [invalidateReviewQueries, repositoryPath, reviewBusy, reviewModeState]);

  const runExitReviewMode = React.useCallback(async () => {
    if (reviewBusy || !reviewModeState) {
      return;
    }

    setReviewBusy(true);
    try {
      const response = await exitReviewMode({ repositoryPath });
      await handleReviewExitResponse(response);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setReviewBusy(false);
    }
  }, [handleReviewExitResponse, repositoryPath, reviewBusy, reviewModeState]);

  const runRecoverReviewMode = React.useCallback(async () => {
    if (reviewBusy) {
      return;
    }

    setReviewBusy(true);
    try {
      const response = await recoverReviewModeStash({ repositoryPath });
      await handleReviewExitResponse(response);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setReviewBusy(false);
    }
  }, [handleReviewExitResponse, repositoryPath, reviewBusy]);

  const dismissReviewRecovery = React.useCallback(async () => {
    setReviewRecoveryPrompt(false);
    try {
      await dismissReviewModeRecovery({ repositoryPath });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    }
  }, [repositoryPath]);

  React.useEffect(() => {
    let cancelled = false;
    void reviewModeRecovery({ repositoryPath })
      .then((response) => {
        if (!cancelled && response.shouldPrompt) {
          setReviewRecoveryPrompt(true);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [repositoryPath]);

  React.useEffect(() => {
    if (!closeGuardActive) {
      void setWindowCloseGuard({ active: false }).catch(() => undefined);
      return;
    }

    void setWindowCloseGuard({ active: true }).catch((error) => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    });

    const blockClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", blockClose);
    return () => {
      void setWindowCloseGuard({ active: false }).catch(() => undefined);
      window.removeEventListener("beforeunload", blockClose);
    };
  }, [closeGuardActive]);

  React.useEffect(() => {
    if (!syncFeedback) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSyncFeedback(null);
    }, 1600);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [syncFeedback]);

  React.useEffect(() => {
    if (
      repository.hasRemote &&
      initialFetchRepositoryRef.current !== repositoryPath
    ) {
      initialFetchRepositoryRef.current = repositoryPath;
      void runFetch();
    }
  }, [repository.hasRemote, repositoryPath, runFetch]);

  React.useEffect(() => {
    const triggerFocusedFetch = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void runFetch();
    };

    window.addEventListener("focus", triggerFocusedFetch);
    document.addEventListener("visibilitychange", triggerFocusedFetch);

    return () => {
      window.removeEventListener("focus", triggerFocusedFetch);
      document.removeEventListener("visibilitychange", triggerFocusedFetch);
    };
  }, [runFetch]);

  React.useEffect(() => {
    if (
      !fetchPreferences?.autoFetch ||
      !fetchInterval.valid ||
      !repository.hasRemote
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void runFetch();
    }, fetchInterval.value * 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    fetchInterval.valid,
    fetchInterval.value,
    fetchPreferences?.autoFetch,
    repository.hasRemote,
    runFetch,
  ]);

  const handleBranchCompleted = React.useCallback(
    (branchName: string) => {
      const branch =
        branches.find((candidate) => candidate.name === branchName) ??
        branches.find((candidate) => candidate.name.endsWith(`/${branchName}`));

      if (branch) {
        setFocusedBranch(branch);
      }
      setActiveTab("history");
    },
    [branches],
  );

  const openCreateBranchDialog = React.useCallback(
    (base: BranchListItem) => {
      setBranchCreateBase(base);
      setNewBranchName("");
      setNewBranchCheckout(true);
      setNewBranchCreateRemote(Boolean(summaryQuery.data?.hasOrigin));
      setBranchNameValidation(null);
      setCheckoutMode("autoStash");
    },
    [summaryQuery.data?.hasOrigin],
  );

  const openCreateStashDialog = React.useCallback(
    (ids: string[]) => {
      setStashIds(ids);
      setStashScope("all");
      setStashMessage(defaultStashMessage());
    },
    [defaultStashMessage],
  );

  const updateNewBranchName = React.useCallback((name: string) => {
    setNewBranchName(name);
    setBranchNameValidation(null);
  }, []);

  const rememberBranchStashRecovery = React.useCallback(
    (response: BranchOperationResponse) => {
      if (response.status !== "conflicts" || !response.stashRecovery) {
        return;
      }

      setStashRecoveryByOperation((current) => ({
        ...current,
        [response.conflict.operationId]: response.stashRecovery!,
      }));
    },
    [],
  );

  const runCheckoutBranch = React.useCallback(async () => {
    if (!branchToCheckout) {
      return;
    }

    setBranchActionBusy(true);
    try {
      const response = await checkoutBranch({
        branchName: branchToCheckout.name,
        localChangesMode: checkoutMode,
        operationId: null,
        repositoryPath,
      });

      if (response.status === "conflicts") {
        rememberBranchStashRecovery(response);
        setConflictEntered(response.conflict);
      } else {
        handleBranchCompleted(response.branchName);
      }
      setBranchToCheckout(null);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setBranchActionBusy(false);
    }
  }, [
    branchToCheckout,
    checkoutMode,
    handleBranchCompleted,
    rememberBranchStashRecovery,
    repositoryPath,
    setConflictEntered,
  ]);

  const runCreateBranch = React.useCallback(async () => {
    const name = newBranchName.trim();

    if (
      !branchCreateBase ||
      name.length === 0 ||
      branchNameValidation?.valid !== true
    ) {
      return;
    }

    setBranchActionBusy(true);
    try {
      const response = await createBranch({
        baseBranch: branchCreateBase.name,
        checkoutImmediately: newBranchCheckout,
        createRemote: newBranchCreateRemote,
        localChangesMode: checkoutMode,
        name,
        operationId: null,
        repositoryPath,
      });

      if (response.status === "conflicts") {
        rememberBranchStashRecovery(response);
        setConflictEntered(response.conflict);
      } else {
        handleBranchCompleted(response.branchName);
      }
      setBranchCreateBase(null);
      setNewBranchName("");
      setNewBranchCreateRemote(false);
      setBranchNameValidation(null);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setBranchActionBusy(false);
    }
  }, [
    branchCreateBase,
    branchNameValidation?.valid,
    checkoutMode,
    handleBranchCompleted,
    rememberBranchStashRecovery,
    newBranchCheckout,
    newBranchCreateRemote,
    newBranchName,
    repositoryPath,
    setConflictEntered,
  ]);

  const runDeleteBranch = React.useCallback(async () => {
    if (!branchToDelete || branchToDelete.current) {
      return;
    }

    setBranchActionBusy(true);
    try {
      const response = await deleteBranch({
        branchName: branchToDelete.name,
        deleteRemote: Boolean(branchToDelete.remoteOnly) || deleteRemoteBranch,
        forceRemoteOnly: Boolean(branchToDelete.remoteOnly),
        repositoryPath,
      });

      if (response.status === "conflicts") {
        setConflictEntered(response.conflict);
      } else {
        handleBranchCompleted(response.branchName);
      }
      setBranchToDelete(null);
      setDeleteRemoteBranch(false);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setBranchActionBusy(false);
    }
  }, [
    branchToDelete,
    deleteRemoteBranch,
    handleBranchCompleted,
    repositoryPath,
    setConflictEntered,
  ]);

  const closeCommitDialog = React.useCallback(() => {
    if (commitBusy) {
      return;
    }
    setCommitIds(null);
    setCommitMessage("");
    setCommitPushImmediately(true);
    setCommitStatus(null);
    setGpgFailure(null);
    setLargeFileWarning(null);
  }, [commitBusy]);

  const runPreviewRenormalize = React.useCallback(async () => {
    if (renormalizePreviewBusy) {
      return;
    }

    setRenormalizePreviewBusy(true);
    setRenormalizePreviewStatus(null);
    try {
      const response = await previewRenormalize({
        repositoryPath,
        sampleLimit: 8,
      });
      if (response.totalPaths === 0) {
        setRenormalizePreviewStatus(t("localChanges.renormalizePreviewEmpty"));
      } else {
        setRenormalizePreviewStatus(
          t("localChanges.renormalizePreviewResult", {
            count: response.totalPaths,
            sample: response.samplePaths.join(", "),
            truncated: response.truncated
              ? t("localChanges.renormalizePreviewTruncated")
              : "",
          }),
        );
      }
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setRenormalizePreviewBusy(false);
    }
  }, [renormalizePreviewBusy, repositoryPath, t]);

  const runCommit = React.useCallback(
    async (
      largeFileDecision:
        "prompt" | "trackWithLfs" | "commitNormally" = "prompt",
      disableRepositoryGpgsign = false,
    ) => {
      if (!commitIds || selectedCommitPaths.length === 0) {
        return;
      }

      setCommitBusy(true);
      setCommitStatus(null);
      setGpgFailure(null);
      setLargeFileWarning(null);
      try {
        const response = await commitChanges({
          disableRepositoryGpgsign,
          largeFileDecision,
          largeFileThresholdMb: null,
          message: commitMessage,
          paths: selectedCommitPaths,
          pushImmediately: commitPushImmediately,
          repositoryPath,
        });

        if (response.status === "committed") {
          setCommitStatus(t("localChanges.commitCommitted"));
          setCommitIds(null);
          setCommitMessage("");
          setCommitPushImmediately(true);
        } else if (response.status === "largeFilesNeedDecision") {
          setLargeFileWarning({
            files: response.largeFiles,
            thresholdMb: response.thresholdMb,
          });
        } else if (response.status === "gpgSignFailed") {
          setGpgFailure({
            stderr: response.stderr,
            summary: response.summary,
          });
        } else if (response.status === "conflicts") {
          if (response.recovery) {
            setStashRecoveryByOperation((current) => ({
              ...current,
              [response.conflict.operationId]: response.recovery!,
            }));
          }
          setCommitStatus(t("localChanges.commitConflict"));
          setConflictEntered(response.conflict);
        } else {
          setCommitStatus(t("localChanges.nothingToCommit"));
        }
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setCommitBusy(false);
      }
    },
    [
      commitIds,
      commitMessage,
      commitPushImmediately,
      repositoryPath,
      selectedCommitPaths,
      setConflictEntered,
      t,
    ],
  );

  const fetchBeforeCurrentBranchWrite = React.useCallback(async () => {
    if (shouldFetchBeforeCurrentBranchWrite) {
      await runFetch();
    }
  }, [runFetch, shouldFetchBeforeCurrentBranchWrite]);

  const runRestore = React.useCallback(async () => {
    if (!restoreIds || selectedRestorePaths.length === 0) {
      return;
    }

    setRestoreBusy(true);
    try {
      await restoreChanges({
        paths: selectedRestorePaths,
        repositoryPath,
      });
      setRestoreIds(null);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setRestoreBusy(false);
    }
  }, [repositoryPath, restoreIds, selectedRestorePaths]);

  const applyStash = React.useCallback(
    async (stash: StashListItem) => {
      setStashActionBusy(true);
      try {
        const response = await restoreStash({
          dropOnSuccess: false,
          operationName: null,
          repositoryPath,
          selector: stash.id,
        });
        const outcome = response.outcome;
        if (outcome.status === "conflicts") {
          setStashRecoveryByOperation((current) => ({
            ...current,
            [outcome.conflict.operationId]: response.recovery,
          }));
          setConflictEntered(outcome.conflict);
        }
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setStashActionBusy(false);
      }
    },
    [repositoryPath, setConflictEntered],
  );

  const createStashFromDialog = React.useCallback(async () => {
    if (!stashIds) {
      return;
    }

    const paths = stashScope === "selected" ? selectedStashPaths : [];
    if (
      (stashScope === "selected" && paths.length === 0) ||
      (stashScope === "all" && localChanges.length === 0)
    ) {
      return;
    }

    setStashActionBusy(true);
    try {
      await createStash({
        includeUntracked: true,
        message: stashMessage.trim() || defaultStashMessage(),
        paths,
        repositoryPath,
      });
      setStashIds(null);
      setStashMessage("");
      setStashScope("all");
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setStashActionBusy(false);
    }
  }, [
    defaultStashMessage,
    localChanges.length,
    repositoryPath,
    selectedStashPaths,
    stashIds,
    stashMessage,
    stashScope,
  ]);

  const confirmDeleteStash = React.useCallback(async () => {
    if (!stashToDelete) {
      return;
    }
    setStashActionBusy(true);
    try {
      await deleteStash({
        repositoryPath,
        selector: stashToDelete.id,
      });
      setStashToDelete(null);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setStashActionBusy(false);
    }
  }, [repositoryPath, stashToDelete]);

  const showStashDetails = React.useCallback(
    async (stash: StashListItem) => {
      setStashActionBusy(true);
      try {
        const response = await stashDetails({
          repositoryPath,
          selector: stash.id,
        });
        setStashDetail(response);
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setStashActionBusy(false);
      }
    },
    [repositoryPath],
  );

  const conflictApi = React.useMemo<ConflictResolutionApi>(
    () => ({
      cancelConflictResolution: async (request) => {
        const recovery = stashRecoveryByOperation[request.operationId];

        if (recovery) {
          await cancelStashRestore({
            recovery,
            repositoryPath: request.repositoryPath,
          });
          setStashRecoveryByOperation((current) => {
            const next = { ...current };
            delete next[request.operationId];
            return next;
          });

          return { aborted: "merge" };
        }

        const response = await cancelConflictResolution(request);
        const revertAutoStash = revertAutoStashByOperation[request.operationId];
        if (revertAutoStash) {
          await restoreStash({
            dropOnSuccess: true,
            operationName: "revertCommit:restoreStash",
            repositoryPath: request.repositoryPath,
            selector: revertAutoStash.selector,
          });
          setRevertAutoStashByOperation((current) => {
            const next = { ...current };
            delete next[request.operationId];
            return next;
          });
        }
        return response;
      },
      completeConflictResolution: async (request) => {
        const response = await completeConflictResolution(request);
        const revertAutoStash = revertAutoStashByOperation[request.operationId];
        if (revertAutoStash) {
          await restoreStash({
            dropOnSuccess: true,
            operationName: "revertCommit:restoreStash",
            repositoryPath: request.repositoryPath,
            selector: revertAutoStash.selector,
          });
          setRevertAutoStashByOperation((current) => {
            const next = { ...current };
            delete next[request.operationId];
            return next;
          });
        }
        return response;
      },
      conflictDetail,
      listConflicts,
      saveConflictResolution,
      selectConflictSide,
    }),
    [revertAutoStashByOperation, stashRecoveryByOperation],
  );

  const closeConflictOverlay = React.useCallback(
    (conflictRepositoryPath: string) => {
      if (conflict) {
        setRevertAutoStashByOperation((current) => {
          if (!current[conflict.operationId]) {
            return current;
          }
          const next = { ...current };
          delete next[conflict.operationId];
          return next;
        });
        setStashRecoveryByOperation((current) => {
          if (!current[conflict.operationId]) {
            return current;
          }
          const next = { ...current };
          delete next[conflict.operationId];
          return next;
        });
      }
      clearConflict(conflictRepositoryPath);
    },
    [clearConflict, conflict],
  );

  const cancelPendingQuit = React.useCallback(() => {
    void cancelPendingWindowExit().catch((error) => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    });
  }, []);

  const recoverCloseGuardedState = React.useCallback(async () => {
    if (writeOperationBusy) {
      throw new Error(t("repository.closeGuardBusyBlocked"));
    }

    if (conflict) {
      await conflictApi.cancelConflictResolution({
        operationId: conflict.operationId,
        repositoryPath: conflict.repositoryPath,
      });
      closeConflictOverlay(conflict.repositoryPath);
    }

    if (reviewRecoveryPrompt && !reviewModeState) {
      setReviewBusy(true);
      try {
        const response = await recoverReviewModeStash({ repositoryPath });
        await handleReviewExitResponse(response);
        if (response.status === "conflicts") {
          throw new Error(t("repository.closeGuardRecoveryConflict"));
        }
      } finally {
        setReviewBusy(false);
      }
    } else if (reviewModeState) {
      setReviewBusy(true);
      try {
        const response = await exitReviewMode({ repositoryPath });
        await handleReviewExitResponse(response);
        if (response.status === "conflicts") {
          throw new Error(t("repository.closeGuardRecoveryConflict"));
        }
      } finally {
        setReviewBusy(false);
      }
    }
  }, [
    closeConflictOverlay,
    conflict,
    conflictApi,
    handleReviewExitResponse,
    repositoryPath,
    reviewModeState,
    reviewRecoveryPrompt,
    t,
    writeOperationBusy,
  ]);

  const performGuardedClose = React.useCallback(
    async (reason: WindowCloseBlockedReason) => {
      setCloseRecoveryBusy(true);
      try {
        await recoverCloseGuardedState();
        setCloseRequest(null);
        await setWindowCloseGuard({ active: false });
        await closeCurrentWindow();
      } catch (error) {
        if (reason === "quit") {
          cancelPendingQuit();
        }
        setCloseRequest(null);
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setCloseRecoveryBusy(false);
      }
    },
    [cancelPendingQuit, recoverCloseGuardedState],
  );

  const handleCloseRequestOpenChange = React.useCallback(
    (open: boolean) => {
      if (open || closeRecoveryBusy) {
        return;
      }
      if (closeRequest?.reason === "quit") {
        cancelPendingQuit();
      }
      setCloseRequest(null);
    },
    [cancelPendingQuit, closeRecoveryBusy, closeRequest?.reason],
  );

  React.useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void listen<WindowCloseBlockedEvent | WindowCloseBlockedReason>(
      "window-close-blocked",
      (event) => {
        if (!active) {
          return;
        }

        const reason = closeBlockedReasonFromPayload(event.payload);
        if (!closeGuardActive) {
          void setWindowCloseGuard({ active: false })
            .then(() => closeCurrentWindow())
            .catch((error) => {
              window.dispatchEvent(
                new CustomEvent("artistic-git:error", { detail: error }),
              );
            });
          return;
        }

        setCloseRequest({ reason });
      },
    ).then((resolvedUnlisten) => {
      if (active) {
        unlisten = resolvedUnlisten;
      } else {
        resolvedUnlisten();
      }
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [closeGuardActive]);

  return (
    <main className="flex h-screen min-h-0 bg-background text-foreground">
      <RepositorySidebar
        branchActionsDisabledReason={branchActionsDisabledReason}
        branches={branches}
        busy={interactionBusy}
        fetchState={fetchState}
        onApplyStash={(stash) => void applyStash(stash)}
        onBranchFocus={(branch) => {
          setFocusedBranch(branch);
          setActiveTab("history");
        }}
        onCheckoutBranch={(branch) => {
          setCheckoutMode("autoStash");
          setBranchToCheckout(branch);
        }}
        onCreateBranchFromBase={openCreateBranchDialog}
        onDeleteBranch={(branch) => {
          setBranchToDelete(branch);
          setDeleteRemoteBranch(Boolean(branch.remoteOnly));
        }}
        onDeleteStash={setStashToDelete}
        onFetch={() => void runSyncAllBranches()}
        onOpenSettings={() => openSettings("general")}
        onReviewMode={() => void runStartReviewMode()}
        onSidebarLayoutChange={(layout) => {
          void persistProjectPreferences({ sidebar: layout });
        }}
        onShowSafetyBackups={() => void refreshSafetyBackups()}
        onShowStashDetails={(stash) => void showStashDetails(stash)}
        onSyncBranch={(branch) => void runSyncBranch(branch)}
        repository={repository}
        stashes={stashes}
        syncFeedback={syncFeedback}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        {activeOperation ? (
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
            {busyLabel}
          </div>
        </header>

        {!repository.hasRemote ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-warning/10 px-4 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{t("repository.noRemote")}</span>
            </span>
            <Button
              onClick={() => openSettings("project")}
              size="default"
              type="button"
              variant="ghost"
            >
              {t("repository.openProjectSettings")}
            </Button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {activeTab === "history" ? (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="shrink-0 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
                {t("repository.focusedBranch", {
                  branch: effectiveFocusedBranch.name,
                  commit: effectiveFocusedBranch.latestCommitId,
                })}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <HistoryWorkbench
                  branches={historyBranches}
                  hasRemote={repository.hasRemote}
                  historyRepositoryPath={repositoryPath}
                  onBeforeRevert={fetchBeforeCurrentBranchWrite}
                  onRevertAutoStash={(operationId, stash) => {
                    setRevertAutoStashByOperation((current) => ({
                      ...current,
                      [operationId]: stash,
                    }));
                  }}
                  onRevertStashRecovery={(operationId, recovery) => {
                    setStashRecoveryByOperation((current) => ({
                      ...current,
                      [operationId]: recovery,
                    }));
                  }}
                  onWriteBusyChange={setHistoryWriteBusy}
                />
              </div>
            </div>
          ) : (
            <LocalChangesPanel
              busy={interactionBusy}
              changes={localChanges}
              initialCheckedIds={localChangeCheckedIds}
              onCheckedChange={setLocalChangeCheckedIds}
              onCommit={setCommitIds}
              onPreviewRenormalize={runPreviewRenormalize}
              onRestore={setRestoreIds}
              onStash={openCreateStashDialog}
              onViewModeChange={(viewMode) => {
                void persistProjectPreferences({
                  localChangesViewMode: viewMode,
                });
              }}
              renormalizePreviewBusy={renormalizePreviewBusy}
              renormalizePreviewStatus={renormalizePreviewStatus}
              renormalizeSuggestion={
                localChangesQuery.data?.renormalizeSuggestion ?? null
              }
              viewMode={effectiveProjectSettings.localChangesViewMode}
            />
          )}
        </div>
      </section>
      {conflict ? (
        <ConflictResolutionOverlay
          api={conflictApi}
          event={conflict}
          onClose={closeConflictOverlay}
        />
      ) : null}
      {reviewModeState ? (
        <ReviewModeOverlay
          busy={reviewBusy}
          onExit={() => void runExitReviewMode()}
          onSync={() => void runSyncReviewMode()}
          state={reviewModeState}
        />
      ) : null}
      <ConfirmDialog
        confirmLabel={t("review.recover")}
        description={t("review.recoveryDescription")}
        onConfirm={() => void runRecoverReviewMode()}
        onOpenChange={(open) => {
          if (!open && reviewRecoveryPrompt) {
            void dismissReviewRecovery();
          }
        }}
        open={reviewRecoveryPrompt}
        title={t("review.recoveryTitle")}
      />
      <RemoteHistoryChangedDialog
        busy={syncBusy}
        change={remoteHistoryChange}
        onAccept={() => void runAcceptRemoteHistory()}
        onOpenChange={(open) => {
          if (!open && !syncBusy) {
            setRemoteHistoryChange(null);
          }
        }}
      />
      <SafetyBackupsDialog
        backups={safetyBackups}
        busy={safetyBackupBusy}
        formatDate={formatters.formatDate}
        onDelete={setSafetyBackupToDelete}
        onOpenChange={(open) => {
          if (!open && !safetyBackupBusy) {
            setSafetyBackupsOpen(false);
          }
        }}
        open={safetyBackupsOpen}
      />
      <ConfirmDialog
        confirmLabel={t("repository.deleteSafetyBackup")}
        description={t("repository.deleteSafetyBackupDescription", {
          name: safetyBackupToDelete?.name ?? "",
        })}
        onConfirm={() => void runDeleteSafetyBackup()}
        onOpenChange={(open) => {
          if (!open && !safetyBackupBusy) {
            setSafetyBackupToDelete(null);
          }
        }}
        open={safetyBackupToDelete !== null}
        title={t("repository.deleteSafetyBackupTitle")}
        variant="danger"
      />
      <ConfirmDialog
        busy={closeRecoveryBusy}
        confirmLabel={t("repository.closeGuardConfirm")}
        description={t("repository.closeGuardDescription")}
        onConfirm={() => {
          if (closeRequest) {
            void performGuardedClose(closeRequest.reason);
          }
        }}
        onOpenChange={handleCloseRequestOpenChange}
        open={closeRequest !== null}
        title={t("repository.closeGuardTitle")}
        variant="danger"
      />
      <CreateBranchDialog
        baseBranch={branchCreateBase}
        baseBranches={branches}
        busy={branchActionBusy}
        checkoutImmediately={newBranchCheckout}
        createRemote={newBranchCreateRemote}
        hasRemote={repository.hasRemote}
        localChangesMode={checkoutMode}
        name={newBranchName}
        onCheckoutImmediatelyChange={setNewBranchCheckout}
        onCreate={() => void runCreateBranch()}
        onBaseBranchChange={(baseBranch) => {
          setBranchCreateBase(baseBranch);
          setBranchNameValidation(null);
        }}
        onCreateRemoteChange={setNewBranchCreateRemote}
        onLocalChangesModeChange={setCheckoutMode}
        onNameChange={updateNewBranchName}
        onOpenChange={(open) => {
          if (!open && !branchActionBusy) {
            setBranchCreateBase(null);
            setNewBranchName("");
            setNewBranchCreateRemote(false);
            setBranchNameValidation(null);
          }
        }}
        validation={branchNameValidation}
      />
      <CheckoutBranchDialog
        branch={branchToCheckout}
        busy={branchActionBusy}
        localChangesMode={checkoutMode}
        onConfirm={() => void runCheckoutBranch()}
        onLocalChangesModeChange={setCheckoutMode}
        onOpenChange={(open) => {
          if (!open && !branchActionBusy) {
            setBranchToCheckout(null);
          }
        }}
      />
      <DeleteBranchDialog
        branch={branchToDelete}
        busy={branchActionBusy}
        deleteRemote={deleteRemoteBranch}
        onConfirm={() => void runDeleteBranch()}
        onDeleteRemoteChange={setDeleteRemoteBranch}
        onOpenChange={(open) => {
          if (!open && !branchActionBusy) {
            setBranchToDelete(null);
            setDeleteRemoteBranch(false);
          }
        }}
      />
      <CommitChangesDialog
        busy={commitBusy}
        fileCount={selectedCommitPaths.length}
        gpgFailure={gpgFailure}
        hasRemote={repository.hasRemote}
        largeFileWarning={largeFileWarning}
        message={commitMessage}
        onCommit={() => void runCommit()}
        onCommitNormally={() => void runCommit("commitNormally")}
        onDisableSigningAndRetry={() => void runCommit("prompt", true)}
        onMessageChange={setCommitMessage}
        onOpenChange={(open) => {
          if (!open) {
            closeCommitDialog();
          }
        }}
        onPushImmediatelyChange={setCommitPushImmediately}
        onTrackWithLfs={() => void runCommit("trackWithLfs")}
        open={commitIds !== null}
        pushImmediately={commitPushImmediately}
        status={commitStatus}
      />
      <RestoreChangesDialog
        busy={restoreBusy}
        count={selectedRestorePaths.length}
        onConfirm={() => void runRestore()}
        onOpenChange={(open) => {
          if (!open && !restoreBusy) {
            setRestoreIds(null);
          }
        }}
        open={restoreIds !== null}
      />
      <ConfirmDialog
        confirmLabel={t("repository.deleteStash")}
        description={t("repository.deleteStashDescription", {
          name: stashToDelete?.name ?? "",
        })}
        onConfirm={() => void confirmDeleteStash()}
        onOpenChange={(open) => {
          if (!open && !stashActionBusy) {
            setStashToDelete(null);
          }
        }}
        open={stashToDelete !== null}
        title={t("repository.deleteStashTitle")}
        variant="danger"
      />
      <CreateStashDialog
        busy={stashActionBusy}
        defaultMessage={defaultStashMessage()}
        message={stashMessage}
        onCreate={() => void createStashFromDialog()}
        onMessageChange={setStashMessage}
        onOpenChange={(open) => {
          if (!open && !stashActionBusy) {
            setStashIds(null);
            setStashMessage("");
            setStashScope("all");
          }
        }}
        onScopeChange={setStashScope}
        open={stashIds !== null}
        scope={stashScope}
        selectedCount={selectedStashPaths.length}
        totalCount={localChanges.length}
      />
      <StashDetailsDialog
        details={stashDetail}
        onOpenChange={(open) => {
          if (!open) {
            setStashDetail(null);
          }
        }}
      />
    </main>
  );
}

function pathsForChangeIds(
  ids: string[],
  changes: LocalChangeItem[],
): string[] {
  const byId = new Map(changes.map((change) => [change.id, change]));
  return ids
    .map((id) => byId.get(id)?.payload.newPath)
    .filter((path): path is string => Boolean(path));
}

function closeBlockedReasonFromPayload(
  payload: WindowCloseBlockedEvent | WindowCloseBlockedReason | unknown,
): WindowCloseBlockedReason {
  if (payload === "quit") {
    return "quit";
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "reason" in payload &&
    (payload as WindowCloseBlockedEvent).reason === "quit"
  ) {
    return "quit";
  }

  return "closeWindow";
}

function operationLabel(label: string, t: (key: string) => string): string {
  switch (label) {
    case "Updating submodules":
      return t("repository.updatingSubmodules");
    case "Downloading submodule LFS objects":
      return t("repository.downloadingSubmoduleLfs");
    case "Submodules ready":
      return t("repository.submodulesReady");
    case "Downloading LFS objects":
      return t("start.cloneProgressLfs");
    case "Checking out files":
      return t("start.cloneProgressCheckout");
    case "Cloning submodules":
      return t("start.cloneProgressSubmodules");
    case "Clone complete":
      return t("start.cloneProgressComplete");
    case "Cloning repository":
      return t("start.cloneProgressClone");
    default:
      return label;
  }
}

function formatSyncAllStatus(
  response: SyncAllBranchesResponse,
  t: SyncStatusTranslator,
): string {
  if (response.allUpToDate) {
    return t("repository.syncAllUpToDate");
  }

  const parts = [
    ...response.branches.map((branch) => formatSyncBranchStatus(branch, t)),
    ...response.autoTracking.map((rule) => formatSyncRuleStatus(rule, t)),
  ];

  return parts.length > 0 ? parts.join(" · ") : t("repository.syncAllUpToDate");
}

function formatSyncBranchStatus(
  response: SyncBranchResponse,
  t: SyncStatusTranslator,
): string {
  const message = syncMessageSuffix(response.message);
  switch (response.status) {
    case "alreadyUpToDate":
      return t("repository.syncBranchResultUpToDate", {
        branch: response.branchName,
      });
    case "published":
      return t("repository.syncBranchResultPublished", {
        branch: response.branchName,
      });
    case "failed":
      return t("repository.syncBranchResultFailed", {
        branch: response.branchName,
        message,
      });
    case "conflicts":
    case "remoteHistoryChanged":
      return t("repository.syncBranchResultNeedsAttention", {
        branch: response.branchName,
        message,
      });
    default:
      return t("repository.syncBranchResultSuccess", {
        branch: response.branchName,
      });
  }
}

function formatSyncRuleStatus(
  response: SyncAllBranchesResponse["autoTracking"][number],
  t: SyncStatusTranslator,
): string {
  const message = syncMessageSuffix(response.message);
  const source = response.sourceBranch;
  const target = response.targetBranch;
  switch (response.status) {
    case "alreadyUpToDate":
      return t("repository.syncRuleResultUpToDate", { source, target });
    case "applied":
      return t("repository.syncRuleResultSuccess", { source, target });
    case "failed":
      return t("repository.syncRuleResultFailed", { source, target, message });
    case "conflicts":
    case "invalid":
      return t("repository.syncRuleResultNeedsAttention", {
        source,
        target,
        message,
      });
  }
}

function syncMessageSuffix(message: string | null | undefined): string {
  return message ? ` (${message})` : "";
}

function mapBranchSummaryToItem(branch: BranchSummary): BranchListItem {
  return {
    ahead: branch.ahead,
    behind: branch.behind,
    current: branch.current,
    existence: branch.existence,
    latestCommitId: branch.headOid?.slice(0, 7) ?? "",
    name: branch.shortName || branch.name,
    remoteOnly: branch.existence === "remoteOnly",
    upstream: branch.upstream,
  };
}

function mapStashEntryToItem(
  stash: StashEntry,
  formatRelativeTime: (value: Date | number | string) => string,
): StashListItem {
  return {
    id: stash.selector,
    name: stash.message,
    timeLabel: stash.createdAtUnixSeconds
      ? formatRelativeTime(Number(stash.createdAtUnixSeconds) * 1000)
      : "",
  };
}

function mapLocalChangeToItem(change: LocalChange): LocalChangeItem {
  const path = change.path;
  const oldPath = change.oldPath;

  return {
    diff: change.diff,
    id: `${path}:${oldPath ?? ""}:${change.indexStatus}:${change.worktreeStatus}`,
    payload: change.payload,
    searchableText: [
      path,
      oldPath,
      change.indexStatus,
      change.worktreeStatus,
      change.payload.fileKind,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function RemoteHistoryChangedDialog({
  busy,
  change,
  onAccept,
  onOpenChange,
}: {
  busy: boolean;
  change: RemoteHistoryChange | null;
  onAccept: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  if (!change) {
    return null;
  }

  return (
    <DialogFrame
      description={t("repository.remoteHistoryChangedDescription", {
        branch: change.branchName,
      })}
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
          <Button disabled={busy} onClick={onAccept} type="button">
            {t("repository.acceptRemoteHistory")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("repository.remoteHistoryChangedTitle")}
    >
      <div className="flex gap-3 rounded-md border bg-warning/10 p-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="grid gap-2">
          <p>
            {t("repository.remoteHistoryChangedBody", {
              branch: change.branchName,
            })}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <dt>{t("repository.remoteHistoryUpstream")}</dt>
            <dd className="truncate text-foreground">{change.upstream}</dd>
            <dt>{t("repository.remoteHistoryLocal")}</dt>
            <dd className="text-numeric text-foreground">
              {shortOid(change.localHead)}
            </dd>
            <dt>{t("repository.remoteHistoryRemote")}</dt>
            <dd className="text-numeric text-foreground">
              {shortOid(change.remoteHead)}
            </dd>
          </dl>
        </div>
      </div>
    </DialogFrame>
  );
}

function SafetyBackupsDialog({
  backups,
  busy,
  formatDate,
  onDelete,
  onOpenChange,
  open,
}: {
  backups: SafetyBackupSummary[];
  busy: boolean;
  formatDate: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  onDelete: (backup: SafetyBackupSummary) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useTranslation();

  if (!open) {
    return null;
  }

  return (
    <DialogFrame
      description={t("repository.safetyBackupsDescription")}
      footer={
        <div className="flex justify-end">
          <Button
            disabled={busy}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            {t("actions.close")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("repository.safetyBackupsTitle")}
    >
      {backups.length === 0 ? (
        <p className="rounded-md border bg-background p-4 text-sm text-muted-foreground">
          {t("repository.noSafetyBackups")}
        </p>
      ) : (
        <ul className="grid gap-2">
          {backups.map((backup) => (
            <li
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border bg-background p-3"
              key={backup.refName}
            >
              <Archive className="size-4 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {backup.originalBranch ?? backup.refName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {backup.createdAtUnixMillis
                    ? formatDate(Number(backup.createdAtUnixMillis), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : backup.refName}
                  {backup.headOid ? ` · ${shortOid(backup.headOid)}` : ""}
                </p>
              </div>
              <Button
                disabled={busy}
                onClick={() => onDelete(backup)}
                size="icon"
                title={t("repository.deleteSafetyBackup")}
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </DialogFrame>
  );
}

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

function DeleteBranchDialog({
  branch,
  busy,
  deleteRemote,
  onConfirm,
  onDeleteRemoteChange,
  onOpenChange,
}: {
  branch: BranchListItem | null;
  busy: boolean;
  deleteRemote: boolean;
  onConfirm: () => void;
  onDeleteRemoteChange: (deleteRemote: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  if (!branch) {
    return null;
  }

  const description = branch.remoteOnly
    ? t("repository.deleteRemoteOnlyBranchDescription", { name: branch.name })
    : t("repository.deleteBranchDescription", { name: branch.name });
  const hasUnmergedCommits = !branch.remoteOnly && branch.ahead > 0;
  const canDelete = !branch.current && !busy;

  return (
    <DialogFrame
      description={description}
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
          <Button
            disabled={!canDelete}
            onClick={onConfirm}
            type="button"
            variant="destructive"
          >
            {t("repository.deleteBranch")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("repository.deleteBranchTitle")}
    >
      <div className="flex gap-3 rounded-md border bg-background p-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="grid gap-2">
          <p>{description}</p>
          <p className="text-muted-foreground">
            {t("repository.deleteBranchProtectionDescription")}
          </p>
        </div>
      </div>

      {hasUnmergedCommits ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive">
          {t("repository.deleteBranchUnmergedWarning", {
            count: branch.ahead,
          })}
        </p>
      ) : null}

      <div className="grid gap-2 rounded-md border bg-background p-3 text-sm">
        <label className="flex items-center gap-2">
          <input
            checked={branch.remoteOnly || deleteRemote}
            className="size-4"
            disabled={busy || Boolean(branch.remoteOnly)}
            onChange={(event) => onDeleteRemoteChange(event.target.checked)}
            type="checkbox"
          />
          <span>{t("repository.deleteRemoteBranch")}</span>
        </label>
        <p className="text-muted-foreground">
          {branch.remoteOnly
            ? t("repository.deleteRemoteOnlyBranchRequired")
            : t("repository.deleteRemoteBranchUnavailable", {
                name: branch.name,
              })}
        </p>
      </div>
    </DialogFrame>
  );
}

function CreateBranchDialog({
  baseBranch,
  baseBranches,
  busy,
  checkoutImmediately,
  createRemote,
  hasRemote,
  localChangesMode,
  name,
  onBaseBranchChange,
  onCheckoutImmediatelyChange,
  onCreate,
  onCreateRemoteChange,
  onLocalChangesModeChange,
  onNameChange,
  onOpenChange,
  validation,
}: {
  baseBranch: BranchListItem | null;
  baseBranches: BranchListItem[];
  busy: boolean;
  checkoutImmediately: boolean;
  createRemote: boolean;
  hasRemote: boolean;
  localChangesMode: CheckoutLocalChangesMode;
  name: string;
  onBaseBranchChange: (baseBranch: BranchListItem) => void;
  onCheckoutImmediatelyChange: (checkoutImmediately: boolean) => void;
  onCreate: () => void;
  onCreateRemoteChange: (createRemote: boolean) => void;
  onLocalChangesModeChange: (mode: CheckoutLocalChangesMode) => void;
  onNameChange: (name: string) => void;
  onOpenChange: (open: boolean) => void;
  validation: BranchNameValidationResponse | null;
}) {
  const { t } = useTranslation();

  if (!baseBranch) {
    return null;
  }

  const trimmedName = name.trim();
  const validationMessage =
    validation?.message ??
    (validation?.exists ? t("repository.branchNameExists") : null);
  const canCreate =
    trimmedName.length > 0 && validation?.valid === true && !busy;

  return (
    <DialogFrame
      description={t("repository.createBranchDescription", {
        branch: baseBranch.name,
      })}
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
          <Button disabled={!canCreate} onClick={onCreate} type="button">
            {t("repository.createBranch")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("repository.createBranchTitle")}
    >
      <label className="grid gap-2 text-sm">
        <span className="font-medium">{t("repository.branchBase")}</span>
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={busy}
          onChange={(event) => {
            const nextBase = baseBranches.find(
              (branch) => branch.name === event.target.value,
            );
            if (nextBase) {
              onBaseBranchChange(nextBase);
            }
          }}
          value={baseBranch.name}
        >
          {baseBranches.map((branch) => (
            <option key={branch.name} value={branch.name}>
              {branch.name}
            </option>
          ))}
        </select>
        {baseBranch.remoteOnly ? (
          <span className="text-xs text-muted-foreground">
            {t("repository.branchBaseRemoteOnly")}
          </span>
        ) : null}
      </label>

      <label className="grid gap-2 text-sm">
        <span className="font-medium">{t("repository.branchName")}</span>
        <input
          autoFocus
          className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={t("repository.branchNamePlaceholder")}
          value={name}
        />
      </label>

      {trimmedName.length > 0 ? (
        <p
          className={cn(
            "text-sm",
            validation?.valid ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {validation?.valid
            ? t("repository.branchNameAvailable")
            : (validationMessage ?? t("repository.branchNameInvalid"))}
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          checked={checkoutImmediately}
          className="size-4"
          onChange={(event) =>
            onCheckoutImmediatelyChange(event.target.checked)
          }
          type="checkbox"
        />
        <span>{t("repository.checkoutImmediately")}</span>
      </label>

      {hasRemote ? (
        <label className="flex items-start gap-2 text-sm text-muted-foreground">
          <input
            checked={createRemote}
            className="mt-0.5 size-4"
            disabled={busy}
            onChange={(event) => onCreateRemoteChange(event.target.checked)}
            type="checkbox"
          />
          <span>{t("repository.createRemoteBranchDisabled")}</span>
        </label>
      ) : null}

      {checkoutImmediately ? (
        <LocalChangesModePicker
          disabled={busy}
          mode={localChangesMode}
          onModeChange={onLocalChangesModeChange}
        />
      ) : null}
    </DialogFrame>
  );
}

function CheckoutBranchDialog({
  branch,
  busy,
  localChangesMode,
  onConfirm,
  onLocalChangesModeChange,
  onOpenChange,
}: {
  branch: BranchListItem | null;
  busy: boolean;
  localChangesMode: CheckoutLocalChangesMode;
  onConfirm: () => void;
  onLocalChangesModeChange: (mode: CheckoutLocalChangesMode) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  if (!branch) {
    return null;
  }

  return (
    <DialogFrame
      description={t("repository.checkoutBranchDescription", {
        branch: branch.name,
      })}
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
          <Button disabled={busy} onClick={onConfirm} type="button">
            {t("repository.checkout")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("repository.checkoutBranchTitle")}
    >
      <LocalChangesModePicker
        disabled={busy}
        mode={localChangesMode}
        onModeChange={onLocalChangesModeChange}
      />
    </DialogFrame>
  );
}

function LocalChangesModePicker({
  disabled,
  mode,
  onModeChange,
}: {
  disabled: boolean;
  mode: CheckoutLocalChangesMode;
  onModeChange: (mode: CheckoutLocalChangesMode) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{
    description: string;
    label: string;
    value: CheckoutLocalChangesMode;
  }> = [
    {
      description: t("repository.checkoutAutoStashDescription"),
      label: t("repository.checkoutAutoStash"),
      value: "autoStash",
    },
    {
      description: t("repository.checkoutDiscardDescription"),
      label: t("repository.checkoutDiscard"),
      value: "discard",
    },
  ];

  return (
    <fieldset className="grid gap-2 text-sm">
      <legend className="font-medium">
        {t("repository.checkoutLocalChangesMode")}
      </legend>
      {options.map((option) => (
        <label
          className="flex items-start gap-2 rounded-md border bg-background p-3"
          key={option.value}
        >
          <input
            checked={mode === option.value}
            className="mt-0.5 size-4"
            disabled={disabled}
            onChange={() => onModeChange(option.value)}
            type="radio"
          />
          <span className="grid gap-1">
            <span className="font-medium">{option.label}</span>
            <span className="text-muted-foreground">{option.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function CommitChangesDialog({
  busy,
  fileCount,
  gpgFailure,
  hasRemote,
  largeFileWarning,
  message,
  onCommit,
  onCommitNormally,
  onDisableSigningAndRetry,
  onMessageChange,
  onOpenChange,
  onPushImmediatelyChange,
  onTrackWithLfs,
  open,
  pushImmediately,
  status,
}: {
  busy: boolean;
  fileCount: number;
  gpgFailure: { stderr: string; summary: string } | null;
  hasRemote: boolean;
  largeFileWarning: { files: LargeFileWarning[]; thresholdMb: number } | null;
  message: string;
  onCommit: () => void;
  onCommitNormally: () => void;
  onDisableSigningAndRetry: () => void;
  onMessageChange: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  onPushImmediatelyChange: (pushImmediately: boolean) => void;
  onTrackWithLfs: () => void;
  open: boolean;
  pushImmediately: boolean;
  status: string | null;
}) {
  const { t } = useTranslation();

  if (!open) {
    return null;
  }

  const canCommit = message.trim().length > 0 && fileCount > 0 && !busy;

  return (
    <DialogFrame
      description={t("localChanges.commitDescription", { count: fileCount })}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="min-w-0 text-sm text-muted-foreground">
            {busy ? t("localChanges.commitBusy") : status}
          </span>
          <div className="flex items-center gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
            <Button disabled={!canCommit} onClick={onCommit} type="button">
              {t("localChanges.commit")}
            </Button>
          </div>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("localChanges.commitTitle")}
    >
      <label className="grid gap-2 text-sm">
        <span className="font-medium">{t("localChanges.commitMessage")}</span>
        <textarea
          className="min-h-28 resize-y rounded-md border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              if (canCommit) {
                onCommit();
              }
            }
          }}
          placeholder={t("localChanges.commitPlaceholder")}
          value={message}
        />
      </label>

      {hasRemote ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            checked={pushImmediately}
            className="size-4"
            disabled={busy}
            onChange={(event) => onPushImmediatelyChange(event.target.checked)}
            type="checkbox"
          />
          <span>{t("localChanges.pushImmediately")}</span>
        </label>
      ) : null}

      {largeFileWarning ? (
        <div className="space-y-3 rounded-md border bg-warning/10 p-3 text-sm">
          <p className="font-medium">
            {t("localChanges.largeFilesTitle", {
              threshold: largeFileWarning.thresholdMb,
            })}
          </p>
          <ul className="max-h-32 overflow-auto text-muted-foreground">
            {largeFileWarning.files.map((file) => (
              <li className="truncate" key={file.path}>
                {file.path}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onTrackWithLfs} type="button" variant="secondary">
              {t("localChanges.trackWithLfs")}
            </Button>
            <Button
              onClick={onCommitNormally}
              type="button"
              variant="secondary"
            >
              {t("localChanges.commitNormally")}
            </Button>
          </div>
        </div>
      ) : null}

      {gpgFailure ? (
        <div className="space-y-3 rounded-md border bg-destructive/10 p-3 text-sm">
          <p className="font-medium">{gpgFailure.summary}</p>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {gpgFailure.stderr}
          </pre>
          <Button
            onClick={onDisableSigningAndRetry}
            type="button"
            variant="secondary"
          >
            {t("localChanges.disableSigningAndRetry")}
          </Button>
        </div>
      ) : null}
    </DialogFrame>
  );
}

function RestoreChangesDialog({
  busy,
  count,
  onConfirm,
  onOpenChange,
  open,
}: {
  busy: boolean;
  count: number;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useTranslation();

  if (!open) {
    return null;
  }

  const description = t("localChanges.restoreDescription", { count });

  return (
    <DialogFrame
      description={description}
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
          <Button
            disabled={busy}
            onClick={onConfirm}
            type="button"
            variant="destructive"
          >
            {t("localChanges.restoreConfirm")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("localChanges.restoreTitle")}
    >
      <div
        className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        role="alert"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p className="font-medium">
          {t("localChanges.restoreIrreversibleWarning")}
        </p>
      </div>
      <p className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
        {description}
      </p>
    </DialogFrame>
  );
}

function StashDetailsDialog({
  details,
  onOpenChange,
}: {
  details: StashDetailsResponse | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();

  if (!details) {
    return null;
  }

  const createdAt = details.entry.createdAtUnixSeconds
    ? formatters.formatDate(Number(details.entry.createdAtUnixSeconds) * 1000, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : t("repository.stashUnknownTime");

  return (
    <DialogFrame
      className="max-w-4xl"
      description={details.entry.selector}
      footer={
        <div className="flex justify-end">
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="secondary"
          >
            {t("actions.close")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={details.entry.message}
    >
      <div className="grid gap-3">
        <dl className="grid gap-3 rounded-md border bg-background p-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="font-medium">{t("repository.stashSelector")}</dt>
            <dd className="truncate text-muted-foreground">
              {details.entry.selector}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="font-medium">{t("repository.stashCreatedAt")}</dt>
            <dd className="truncate text-muted-foreground">{createdAt}</dd>
          </div>
        </dl>

        {details.entry.isAutoStash ? (
          <div className="rounded-md border bg-secondary px-3 py-2 text-sm">
            {t("repository.autoStashOrigin", {
              origin:
                details.entry.origin ?? t("repository.autoStashUnknownOrigin"),
            })}
          </div>
        ) : null}
      </div>
      <div className="mt-4 grid min-h-0 gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
        <div className="min-h-0 rounded-md border bg-background">
          <div className="border-b px-3 py-2 text-sm font-medium">
            {t("repository.stashFiles", { count: details.files.length })}
          </div>
          <ul className="max-h-80 overflow-auto p-1 text-sm">
            {details.files.map((file) => (
              <li className="rounded px-2 py-1" key={file.path}>
                <span className="block truncate">{file.path}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`diff.changeKind.${file.changeKind}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <pre className="max-h-80 overflow-auto rounded-md border bg-background p-3 text-xs">
          {details.rawDiff || t("repository.stashNoDiff")}
        </pre>
      </div>
    </DialogFrame>
  );
}

function CreateStashDialog({
  busy,
  defaultMessage,
  message,
  onCreate,
  onMessageChange,
  onOpenChange,
  onScopeChange,
  open,
  scope,
  selectedCount,
  totalCount,
}: {
  busy: boolean;
  defaultMessage: string;
  message: string;
  onCreate: () => void;
  onMessageChange: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  onScopeChange: (scope: StashScope) => void;
  open: boolean;
  scope: StashScope;
  selectedCount: number;
  totalCount: number;
}) {
  const { t } = useTranslation();

  if (!open) {
    return null;
  }

  const canCreate =
    !busy && (scope === "all" ? totalCount > 0 : selectedCount > 0);
  const description =
    scope === "all"
      ? t("localChanges.stashDescriptionAll", { count: totalCount })
      : t("localChanges.stashDescriptionSelected", { count: selectedCount });

  return (
    <DialogFrame
      description={description}
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
          <Button disabled={!canCreate} onClick={onCreate} type="button">
            {t("localChanges.createStash")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("localChanges.createStashTitle")}
    >
      <label className="grid gap-2 text-sm">
        <span className="font-medium">{t("localChanges.stashName")}</span>
        <input
          className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder={defaultMessage}
          value={message}
        />
      </label>

      <fieldset className="grid gap-2 text-sm">
        <legend className="font-medium">{t("localChanges.stashScope")}</legend>
        <label className="flex items-start gap-2 rounded-md border bg-background p-3">
          <input
            checked={scope === "all"}
            className="mt-0.5 size-4"
            disabled={busy}
            onChange={() => onScopeChange("all")}
            type="radio"
          />
          <span className="grid gap-1">
            <span className="font-medium">
              {t("localChanges.stashAllChanges")}
            </span>
            <span className="text-muted-foreground">
              {t("localChanges.stashAllChangesDescription", {
                count: totalCount,
              })}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 rounded-md border bg-background p-3">
          <input
            checked={scope === "selected"}
            className="mt-0.5 size-4"
            disabled={busy}
            onChange={() => onScopeChange("selected")}
            type="radio"
          />
          <span className="grid gap-1">
            <span className="font-medium">
              {t("localChanges.stashSelectedChanges")}
            </span>
            <span className="text-muted-foreground">
              {t("localChanges.stashSelectedChangesDescription", {
                count: selectedCount,
              })}
            </span>
          </span>
        </label>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input checked className="size-4" disabled readOnly type="checkbox" />
        <span>{t("localChanges.stashIncludeUntracked")}</span>
      </label>
    </DialogFrame>
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
