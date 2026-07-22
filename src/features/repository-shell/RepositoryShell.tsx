import {
  AlertTriangle,
  Archive,
  ChevronLeft,
  ChevronRight,
  FileText,
  History,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BranchListItem,
  RepositorySidebar,
  type RepositorySummary,
  type StashListItem,
} from "@/components/sidebar/RepositorySidebar";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { DetailsDialog } from "@/components/dialogs/DetailsDialog";
import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import { BranchSelect } from "@/components/ui/branch-select";
import { IconButton } from "@/components/ui/icon-button";
import { OverlayScrollArea } from "@/components/ui/overlay-scroll-area";
import {
  ConflictResolutionOverlay,
  type ConflictResolutionApi,
} from "@/features/conflicts";
import { DiffViewer } from "@/features/diff";
import { HistoryWorkbench } from "@/features/history/HistoryWorkbench";
import {
  isDeferredLocalChange,
  LocalChangesPanel,
  type LocalChangeItem,
} from "@/features/local-changes";
import { useLocalizedFormatters } from "@/i18n/format";
import {
  acceptRemoteHistory,
  checkoutBranch,
  cancelConflictResolution,
  cancelOperation,
  cancelStashRestore,
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
  localChangeDetail,
  listSafetyBackups,
  listStashes,
  loadProjectSettings,
  previewRenormalize,
  restoreChanges,
  restoreStash,
  recoverReviewModeStash,
  repositorySummary,
  resetBisect,
  reviewModeRecovery,
  saveProjectSettings,
  saveWindowGeometry,
  saveConflictResolution,
  selectConflictSide,
  stashDetails,
  stashFileDetail,
  startReviewMode,
  syncAllBranches,
  syncBranch,
  syncReviewMode,
  validateBranchName,
} from "@/lib/ipc/commands";
import type {
  AppError,
  BranchOperationResponse,
  BranchNameValidationResponse,
  BranchSummary,
  CheckoutLocalChangesMode,
  FetchStateEvent,
  LargeFileWarning,
  LocalChange,
  LocalChangesViewMode,
  ReviewModeState,
  RepositoryHealth,
  RepositoryMiddleStateKind,
  RemoteHistoryChange,
  SyncAllBranchesResponse,
  SyncBranchResponse,
  SafetyBackupSummary,
  SidebarLayoutSettings,
  StashEntry,
  StashChangedFile,
  StashDetailsResponse,
  StashFileDetailResponse,
  StashRecoveryPoint,
} from "@/lib/ipc/generated";
import { emitAppEvent } from "@/lib/ipc/events";
import { hasOpenModalLayer } from "@/lib/dialog-layer";
import { repoQueryKeys } from "@/lib/realtime/query-keys";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useWindowStore } from "@/store/window-store";
import {
  type NormalizedProjectSettings,
  normalizeAppSettings,
  normalizeProjectSettings,
  validateFetchIntervalSeconds,
} from "@/features/settings/settings-model";
import { ReviewModeOverlay } from "@/features/review/ReviewModeOverlay";
import { WindowCloseGuard } from "@/features/window-close-guard/WindowCloseGuard";

type MainTab = "history" | "localChanges";
type ReviewBusyAction = "exit" | "recover" | "start" | "sync";
type SafetyBackupBusyAction = "delete" | "load";
type StashBusyAction = "apply" | "create" | "delete";
type StashScope = "all" | "selected";
type ExistingGitOperationRecoveryStatus =
  | { error: unknown | null; state: "failed" }
  | { error: null; state: "checking" };
type SyncStatusTranslator = (
  key: string,
  options?: Record<string, unknown>,
) => string;
const stashDetailsFilePageSize = 200;
const safetyBackupPageSize = 100;
const largeFileWarningPageSize = 100;

interface RepositoryShellProps {
  repositoryPath: string;
}

interface RepositoryReadError {
  error: unknown;
  id: "branches" | "projectSettings" | "stashes" | "summary";
  message: string;
  retry: () => void;
  retrying: boolean;
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
  const [commitConflictOperationId, setCommitConflictOperationId] =
    React.useState<string | null>(null);
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
    React.useState<{ key: string; message: string } | null>(null);
  const [restoreIds, setRestoreIds] = React.useState<string[] | null>(null);
  const [restoreBusy, setRestoreBusy] = React.useState(false);
  const [branchActionBusy, setBranchActionBusy] = React.useState(false);
  const [fetchBusy, setFetchBusy] = React.useState(false);
  const [syncBusy, setSyncBusy] = React.useState(false);
  const [historyWriteBusy, setHistoryWriteBusy] = React.useState(false);
  const [historyInitialLoading, setHistoryInitialLoading] =
    React.useState(true);
  const [existingGitOperationRecovery, setExistingGitOperationRecovery] =
    React.useState<ExistingGitOperationRecoveryStatus | null>(null);
  const [existingGitOperationRetry, setExistingGitOperationRetry] =
    React.useState(0);
  const [repositoryHealthDetailsOpen, setRepositoryHealthDetailsOpen] =
    React.useState(false);
  const [repositoryHealthRecheckBusy, setRepositoryHealthRecheckBusy] =
    React.useState(false);
  const [bisectResetConfirmOpen, setBisectResetConfirmOpen] =
    React.useState(false);
  const [bisectResetBusy, setBisectResetBusy] = React.useState(false);
  const [safetyBackupBusyAction, setSafetyBackupBusyAction] =
    React.useState<SafetyBackupBusyAction | null>(null);
  const safetyBackupBusy = safetyBackupBusyAction !== null;
  const [reviewBusyAction, setReviewBusyAction] =
    React.useState<ReviewBusyAction | null>(null);
  const reviewBusy = reviewBusyAction !== null;
  const [remoteHistoryChange, setRemoteHistoryChange] =
    React.useState<RemoteHistoryChange | null>(null);
  const [safetyBackupsOpen, setSafetyBackupsOpen] = React.useState(false);
  const [safetyBackups, setSafetyBackups] = React.useState<
    SafetyBackupSummary[]
  >([]);
  const [safetyBackupsTruncated, setSafetyBackupsTruncated] =
    React.useState(false);
  const [safetyBackupToDelete, setSafetyBackupToDelete] =
    React.useState<SafetyBackupSummary | null>(null);
  const [reviewModeState, setReviewModeState] =
    React.useState<ReviewModeState | null>(null);
  const reviewReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const [reviewRecoveryPrompt, setReviewRecoveryPrompt] = React.useState(false);
  const fetchInFlightRef = React.useRef<Promise<void> | null>(null);
  const initialFetchRepositoryRef = React.useRef<string | null>(null);
  const suppressAutoFetchRef = React.useRef(false);
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
  const [branchNameChecking, setBranchNameChecking] = React.useState(false);
  const [branchToDelete, setBranchToDelete] =
    React.useState<BranchListItem | null>(null);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = React.useState(false);
  const [stashBusyAction, setStashBusyAction] =
    React.useState<StashBusyAction | null>(null);
  const stashActionBusy = stashBusyAction !== null;
  const [localChangesViewModeOverride, setLocalChangesViewModeOverride] =
    React.useState<LocalChangesViewMode | null>(null);
  const [cancellingOperationId, setCancellingOperationId] = React.useState<
    string | null
  >(null);
  const cancellingOperationRef = React.useRef<string | null>(null);
  const [stashIds, setStashIds] = React.useState<string[] | null>(null);
  const [stashMessage, setStashMessage] = React.useState("");
  const [stashScope, setStashScope] = React.useState<StashScope>("all");
  const [stashToDelete, setStashToDelete] =
    React.useState<StashListItem | null>(null);
  const [stashDetailEntry, setStashDetailEntry] =
    React.useState<StashEntry | null>(null);
  const [stashRecoveryByOperation, setStashRecoveryByOperation] =
    React.useState<Record<string, StashRecoveryPoint>>({});
  const [revertAutoStashByOperation, setRevertAutoStashByOperation] =
    React.useState<Record<string, StashEntry>>({});
  const [localChangeCheckedIds, setLocalChangeCheckedIds] = React.useState<
    string[]
  >([]);
  const [selectedLocalChange, setSelectedLocalChange] =
    React.useState<LocalChangeItem | null>(null);
  const projectPreferencesDraftRef =
    React.useRef<NormalizedProjectSettings | null>(null);
  const projectPreferencesLastSavedRef =
    React.useRef<NormalizedProjectSettings | null>(null);
  const pendingProjectPreferencesRef =
    React.useRef<NormalizedProjectSettings | null>(null);
  const projectPreferencesSaveInFlightRef = React.useRef(false);
  const [focusedBranch, setFocusedBranch] =
    React.useState<BranchListItem | null>(null);
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
  const stashDetailsQuery = useQuery({
    enabled: stashDetailEntry !== null,
    queryFn: () => {
      if (!stashDetailEntry) {
        return Promise.reject(new Error("No stash selected."));
      }
      return stashDetails({
        repositoryPath,
        selector: stashDetailEntry.oid,
      });
    },
    queryKey: [
      "repository",
      repositoryPath,
      "stashDetails",
      stashDetailEntry?.oid ?? null,
    ] as const,
    retry: false,
  });
  const localChangesQuery = useQuery({
    queryFn: () => listLocalChanges({ repositoryPath }),
    queryKey: repoQueryKeys.localChanges(repositoryPath),
    retry: false,
  });
  const refetchLocalChanges = localChangesQuery.refetch;
  const showHistoryTab = React.useCallback(() => {
    setActiveTab("history");
  }, []);
  const showLocalChangesTab = React.useCallback(() => {
    setActiveTab("localChanges");
    void refetchLocalChanges();
  }, [refetchLocalChanges]);
  const projectSettingsQuery = useQuery({
    queryFn: () => loadProjectSettings({ repositoryPath }),
    queryKey: ["repository", repositoryPath, "projectSettings"] as const,
    retry: false,
  });
  const repositoryReadErrors: RepositoryReadError[] = [];
  if (summaryQuery.error !== null) {
    repositoryReadErrors.push({
      error: summaryQuery.error,
      id: "summary",
      message: t("repository.summaryLoadError"),
      retry: () => void summaryQuery.refetch(),
      retrying: summaryQuery.isFetching,
    });
  }
  if (branchesQuery.error !== null) {
    repositoryReadErrors.push({
      error: branchesQuery.error,
      id: "branches",
      message: t("repository.branchesLoadError"),
      retry: () => void branchesQuery.refetch(),
      retrying: branchesQuery.isFetching,
    });
  }
  if (stashesQuery.error !== null) {
    repositoryReadErrors.push({
      error: stashesQuery.error,
      id: "stashes",
      message: t("repository.stashesLoadError"),
      retry: () => void stashesQuery.refetch(),
      retrying: stashesQuery.isFetching,
    });
  }
  if (projectSettingsQuery.error !== null) {
    repositoryReadErrors.push({
      error: projectSettingsQuery.error,
      id: "projectSettings",
      message: t("repository.projectSettingsLoadError"),
      retry: () => void projectSettingsQuery.refetch(),
      retrying: projectSettingsQuery.isFetching,
    });
  }
  const branches = React.useMemo(
    () => branchesQuery.data?.branches.map(mapBranchSummaryToItem) ?? [],
    [branchesQuery.data],
  );
  const historyBranches = React.useMemo(
    () =>
      (branchesQuery.data?.branches ?? []).map((branch) => {
        const shortName = branch.shortName || branch.name;
        return {
          current: branch.current,
          name: shortName,
          remoteRevision:
            branch.existence === "localOnly"
              ? undefined
              : `refs/remotes/origin/${shortName}`,
          revision:
            branch.existence === "remoteOnly"
              ? `refs/remotes/origin/${shortName}`
              : `refs/heads/${shortName}`,
        };
      }),
    [branchesQuery.data],
  );
  const historyScopeReady = !summaryQuery.isPending && !branchesQuery.isPending;
  const historyBranchesForWorkbench = React.useMemo(() => {
    if (historyBranches.length > 0) {
      return historyBranches;
    }
    const branchName = summaryQuery.data?.currentBranch;
    return branchName
      ? [
          {
            current: true,
            name: branchName,
            revision: `refs/heads/${branchName}`,
          },
        ]
      : [];
  }, [historyBranches, summaryQuery.data?.currentBranch]);
  const stashes = React.useMemo(
    () =>
      stashesQuery.data?.stashes.map((stash) =>
        mapStashEntryToItem(stash, formatters.formatRelativeTime, t),
      ) ?? [],
    [formatters.formatRelativeTime, stashesQuery.data, t],
  );
  const localChanges = React.useMemo(
    () => localChangesQuery.data?.changes.map(mapLocalChangeToItem) ?? [],
    [localChangesQuery.data],
  );
  const deferredDetailRequest =
    activeTab === "localChanges" &&
    !localChangesQuery.isFetching &&
    !localChangesQuery.error &&
    isDeferredLocalChange(selectedLocalChange)
      ? selectedLocalChange
      : null;
  const localChangeDetailQuery = useQuery({
    enabled: deferredDetailRequest !== null,
    queryFn: ({ signal }) => {
      if (!deferredDetailRequest) {
        return Promise.reject(new Error("No local change preview selected."));
      }

      return runCancellableLocalChangeDetail(
        signal,
        repositoryPath,
        deferredDetailRequest,
      );
    },
    queryKey: [
      "repository",
      repositoryPath,
      "localChangeDetail",
      localChangesQuery.dataUpdatedAt,
      deferredDetailRequest?.id ?? null,
      deferredDetailRequest?.payload.newPath ?? null,
      deferredDetailRequest?.submodule?.path ?? null,
    ] as const,
    retry: false,
  });
  const loadedLocalChangeDetail = React.useMemo(
    () =>
      localChangeDetailQuery.data
        ? mapLocalChangeToItem(localChangeDetailQuery.data)
        : null,
    [localChangeDetailQuery.data],
  );
  const localChangeDetailState = isDeferredLocalChange(selectedLocalChange)
    ? {
        change: loadedLocalChangeDetail,
        error: localChangeDetailQuery.error,
        loading:
          deferredDetailRequest === null ||
          localChangeDetailQuery.isPending ||
          localChangeDetailQuery.isFetching,
        selectedId: selectedLocalChange.id,
      }
    : undefined;
  const renormalizeSuggestion =
    localChangesQuery.data?.renormalizeSuggestion ?? null;
  const renormalizeSuggestionKey = renormalizeSuggestion
    ? [
        renormalizeSuggestion.totalChanges,
        renormalizeSuggestion.modifiedChanges,
        ...renormalizeSuggestion.samplePaths,
      ].join("\0")
    : null;
  const visibleRenormalizePreviewStatus =
    renormalizePreviewStatus?.key === renormalizeSuggestionKey
      ? renormalizePreviewStatus.message
      : null;

  const currentBranch = React.useMemo(
    () => branches.find((branch) => branch.current) ?? null,
    [branches],
  );
  const effectiveFocusedBranch = React.useMemo(
    () =>
      branches.find((branch) => branch.name === focusedBranch?.name) ??
      currentBranch,
    [branches, currentBranch, focusedBranch],
  );
  const effectiveHistoryBranchName =
    effectiveFocusedBranch?.name ?? summaryQuery.data?.currentBranch ?? null;
  const operations = useWindowStore((state) => state.operationsById);
  const windowLabel = useWindowStore((state) => state.windowLabel);
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
  const setFetchState = useWindowStore((state) => state.setFetchState);
  const openSettings = useWindowStore((state) => state.openSettings);
  const conflict = useWindowStore(
    (state) => state.conflictsByRepository[repositoryPath] ?? null,
  );
  const clearConflict = useWindowStore((state) => state.clearConflict);
  const setConflictEntered = useWindowStore(
    (state) => state.setConflictEntered,
  );
  const setNavigationLocked = useWindowStore(
    (state) => state.setNavigationLocked,
  );
  const activeOperation = React.useMemo(
    () =>
      Object.values(operations)
        .filter((operation) =>
          isRepositoryShellOperation(operation, repositoryPath, windowLabel),
        )
        .at(-1) ?? null,
    [operations, repositoryPath, windowLabel],
  );

  React.useEffect(() => {
    if (
      cancellingOperationRef.current &&
      cancellingOperationRef.current !== activeOperation?.operationId
    ) {
      cancellingOperationRef.current = null;
      setCancellingOperationId(null);
    }
  }, [activeOperation?.operationId]);
  const fetchState = storedFetchState;
  const persistableProjectSettings = React.useMemo(
    () =>
      projectSettingsQuery.isSuccess
        ? (projectSettingsQuery.data ?? projectSettings)
        : null,
    [
      projectSettings,
      projectSettingsQuery.data,
      projectSettingsQuery.isSuccess,
    ],
  );
  const effectiveProjectSettings = React.useMemo(() => {
    const normalized = normalizeProjectSettings(
      persistableProjectSettings ?? { path: repositoryPath },
    );
    return localChangesViewModeOverride
      ? { ...normalized, localChangesViewMode: localChangesViewModeOverride }
      : normalized;
  }, [
    localChangesViewModeOverride,
    persistableProjectSettings,
    repositoryPath,
  ]);

  React.useEffect(() => {
    const handleFetchState = (event: Event) => {
      const payload = (event as CustomEvent<FetchStateEvent>).detail;
      if (payload?.repositoryPath === repositoryPath) {
        setFetchState(payload);
      }
    };

    window.addEventListener("artistic-git:fetch-state", handleFetchState);
    return () => {
      window.removeEventListener("artistic-git:fetch-state", handleFetchState);
    };
  }, [repositoryPath, setFetchState]);

  React.useEffect(() => {
    const handleViewTab = (event: Event) => {
      if (hasOpenModalLayer()) {
        return;
      }
      const tab = (event as CustomEvent<MainTab>).detail;
      if (tab === "history") {
        showHistoryTab();
      } else if (tab === "localChanges") {
        showLocalChangesTab();
      }
    };

    window.addEventListener("artistic-git:view-tab", handleViewTab);
    return () => {
      window.removeEventListener("artistic-git:view-tab", handleViewTab);
    };
  }, [showHistoryTab, showLocalChangesTab]);

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

    let active = true;
    void Promise.resolve().then(() => {
      if (!active) {
        return;
      }
      const normalizedProject = normalizeProjectSettings(
        projectSettingsQuery.data,
      );
      setProjectSettings(repositoryPath, normalizedProject);
      setSidebarLayout(normalizedProject.sidebar);
      setLocalChangesViewModeOverride(null);
    });
    return () => {
      active = false;
    };
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
              message: null,
              name,
              valid: false,
            });
            window.dispatchEvent(
              new CustomEvent("artistic-git:error", { detail: error }),
            );
          }
        })
        .finally(() => {
          if (!cancelled) {
            setBranchNameChecking(false);
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [branchCreateBase, newBranchName, repositoryPath]);

  const repository = React.useMemo<RepositorySummary>(
    () => ({
      branchName: summaryQuery.data?.currentBranch ?? currentBranch?.name ?? "",
      // React Query retains successful data during a failed refresh, preserving
      // the last confirmed value. An initial unknown state stays conservative so
      // it cannot start remote operations before the summary has loaded.
      hasRemote: summaryQuery.data?.hasOrigin ?? false,
      path: repositoryPath,
      projectName:
        repositoryPath.split(/[\\/]/).filter(Boolean).at(-1) ??
        t("repository.untitledProject"),
    }),
    [currentBranch?.name, repositoryPath, summaryQuery.data, t],
  );
  const remoteStateKnown = summaryQuery.data !== undefined;
  const initialRepositoryLoading =
    summaryQuery.isPending ||
    branchesQuery.isPending ||
    stashesQuery.isPending ||
    localChangesQuery.isPending ||
    projectSettingsQuery.isPending ||
    (activeTab === "history" &&
      repositoryReadErrors.length === 0 &&
      historyInitialLoading);
  const localChangeCount = localChanges.length;
  const repositoryRefreshing = fetchBusy || fetchState?.state === "fetching";
  const repositoryInProgress = summaryQuery.data?.inProgress === true;
  const repositoryDetached = summaryQuery.data?.isDetached === true;
  const repositoryHealth = summaryQuery.data?.details?.health ?? null;
  const repositoryMiddleState = repositoryHealth?.middleStates[0] ?? null;
  const repositoryIndexLock = repositoryHealth?.indexLock ?? null;
  const repositoryIndexLocked = Boolean(repositoryIndexLock);
  const repositoryBisectActive = repositoryMiddleState?.kind === "bisect";
  const repositoryRemotes = summaryQuery.data?.details?.remotes ?? [];
  const additionalRemoteCount = repositoryRemotes.filter(
    (remote) => !remote.isOrigin,
  ).length;
  const repositoryHasOtherRemotes =
    summaryQuery.data?.hasOrigin === false && repositoryRemotes.length > 0;
  const repositoryAttentionLabel = repositoryMiddleState
    ? repositoryMiddleStateStatus(repositoryMiddleState.kind, t)
    : repositoryIndexLocked
      ? t("repository.indexLockPresent")
      : t("repository.inProgress");
  const repositoryWriteBlocked = repositoryInProgress || repositoryDetached;
  const branchActionsDisabledReason = repositoryInProgress
    ? repositoryIndexLocked && !repositoryMiddleState
      ? t("repository.indexLockActionsDisabled")
      : t("repository.inProgressActionsDisabled")
    : summaryQuery.data?.isUnborn
      ? t("repository.unbornBranchActionsDisabled")
      : undefined;
  const attemptedGitOperationRecoveryRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    let active = true;
    if (
      conflict ||
      !repositoryMiddleState ||
      repositoryMiddleState.kind === "bisect"
    ) {
      void Promise.resolve().then(() => {
        if (active) {
          setExistingGitOperationRecovery(null);
        }
      });
      return () => {
        active = false;
      };
    }

    const recoveryKey = [
      repositoryPath,
      repositoryMiddleState.kind,
      repositoryMiddleState.path,
      summaryQuery.dataUpdatedAt,
      existingGitOperationRetry,
    ].join(":");
    if (attemptedGitOperationRecoveryRef.current === recoveryKey) {
      return;
    }
    attemptedGitOperationRecoveryRef.current = recoveryKey;
    void Promise.resolve().then(() => {
      if (active) {
        setExistingGitOperationRecovery({ error: null, state: "checking" });
      }
    });

    void listConflicts({ repositoryPath })
      .then((response) => {
        if (!active) {
          return;
        }
        if (!response.operation) {
          attemptedGitOperationRecoveryRef.current = null;
          setExistingGitOperationRecovery({ error: null, state: "failed" });
          return;
        }
        setExistingGitOperationRecovery(null);
        setConflictEntered({
          files: response.files,
          operationId: createRepositoryOperationId(
            `existing-${response.operation.kind}`,
          ),
          operationName: response.operation.label,
          repositoryPath,
        });
      })
      .catch((error) => {
        if (active) {
          attemptedGitOperationRecoveryRef.current = null;
          setExistingGitOperationRecovery({ error, state: "failed" });
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      });

    return () => {
      active = false;
    };
  }, [
    conflict,
    existingGitOperationRetry,
    repositoryMiddleState,
    repositoryPath,
    setConflictEntered,
    summaryQuery.dataUpdatedAt,
  ]);
  React.useEffect(() => {
    if (!repositoryIndexLock && !repositoryBisectActive) {
      let active = true;
      void Promise.resolve().then(() => {
        if (active) {
          setRepositoryHealthDetailsOpen(false);
          setBisectResetConfirmOpen(false);
        }
      });
      return () => {
        active = false;
      };
    }
  }, [repositoryBisectActive, repositoryIndexLock]);

  const recheckRepositoryHealth = React.useCallback(async () => {
    if (repositoryHealthRecheckBusy) {
      return;
    }

    setRepositoryHealthRecheckBusy(true);
    try {
      const result = await summaryQuery.refetch();
      if (result.error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: result.error }),
        );
      }
    } finally {
      setRepositoryHealthRecheckBusy(false);
    }
  }, [repositoryHealthRecheckBusy, summaryQuery]);

  const runResetBisect = React.useCallback(async () => {
    if (bisectResetBusy || !repositoryBisectActive) {
      return;
    }

    setBisectResetBusy(true);
    try {
      const activeFetch = fetchInFlightRef.current;
      if (activeFetch) {
        await activeFetch.catch(() => undefined);
      }
      const summary = await resetBisect({ repositoryPath });
      queryClient.setQueryData(repoQueryKeys.summary(repositoryPath), summary);
      setBisectResetConfirmOpen(false);
      setRepositoryHealthDetailsOpen(false);
      showToast({
        key: "repository-bisect-reset",
        message: t("repository.bisectResetComplete"),
        tone: "success",
      });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setBisectResetBusy(false);
    }
  }, [bisectResetBusy, queryClient, repositoryBisectActive, repositoryPath, t]);
  const activeOperationBusy = activeOperation !== null;
  const busy =
    activeOperationBusy ||
    syncBusy ||
    commitBusy ||
    restoreBusy ||
    branchActionBusy ||
    safetyBackupBusy ||
    stashActionBusy ||
    historyWriteBusy ||
    reviewBusy ||
    bisectResetBusy;
  const reviewActive = reviewModeState !== null;
  const modalWorkflowActive = reviewActive || conflict !== null;
  React.useEffect(() => {
    setNavigationLocked(modalWorkflowActive);
    return () => setNavigationLocked(false);
  }, [modalWorkflowActive, setNavigationLocked]);
  const writeOperationBusy =
    activeOperationBusy ||
    syncBusy ||
    commitBusy ||
    restoreBusy ||
    branchActionBusy ||
    safetyBackupBusy ||
    stashActionBusy ||
    historyWriteBusy ||
    reviewBusy ||
    bisectResetBusy;
  const suppressAutoFetch =
    writeOperationBusy ||
    conflict !== null ||
    reviewModeState !== null ||
    reviewRecoveryPrompt ||
    remoteHistoryChange !== null;
  React.useEffect(() => {
    suppressAutoFetchRef.current = suppressAutoFetch;
  }, [suppressAutoFetch]);
  const closeGuardActiveOperation =
    activeOperation?.cancellable === true ? activeOperation : null;
  const closeGuardActive =
    writeOperationBusy ||
    conflict !== null ||
    reviewActive ||
    reviewRecoveryPrompt;
  const closeGuardNeedsRecovery =
    closeGuardActiveOperation !== null ||
    conflict !== null ||
    reviewActive ||
    reviewRecoveryPrompt;
  const closeGuardCanRecover =
    closeGuardActiveOperation !== null ||
    (closeGuardNeedsRecovery && !writeOperationBusy);
  const interactionBusy = busy || reviewActive || repositoryInProgress;
  const busyLabel = activeOperation
    ? operationLabel(activeOperation.label, t)
    : initialRepositoryLoading
      ? t("repository.loadingRepository")
      : syncBusy
        ? t("repository.syncBusy")
        : repositoryRefreshing
          ? t("repository.refreshing")
          : commitBusy
            ? t("localChanges.commitBusy")
            : restoreBusy
              ? t("localChanges.restoreBusy")
              : branchActionBusy
                ? t("repository.branchBusy")
                : bisectResetBusy
                  ? t("repository.resettingBisect")
                  : safetyBackupBusy
                    ? safetyBackupBusyAction === "load"
                      ? t("repository.loadingSafetyBackups")
                      : t("repository.deletingSafetyBackup")
                    : stashActionBusy
                      ? stashBusyAction === "apply"
                        ? t("repository.applyingStash")
                        : stashBusyAction === "create"
                          ? t("localChanges.creatingStash")
                          : t("repository.deletingStash")
                      : historyWriteBusy
                        ? t("history.revert.busy")
                        : reviewBusyAction === "sync"
                          ? t("review.syncing")
                          : reviewBusyAction === "exit"
                            ? t("review.exiting")
                            : reviewBusy
                              ? t("review.busy")
                              : repositoryInProgress
                                ? repositoryAttentionLabel
                                : repositoryDetached
                                  ? t("repository.detachedHead")
                                  : summaryQuery.data?.isUnborn
                                    ? t("repository.unbornHead")
                                    : repositoryReadErrors.length > 0
                                      ? t("repository.partialInfoUnavailable")
                                      : fetchState?.state === "offline"
                                        ? t("repository.fetchOffline")
                                        : fetchState?.state === "failed"
                                          ? t("repository.fetchFailed")
                                          : repositoryHasOtherRemotes
                                            ? t("repository.otherRemotesStatus")
                                            : additionalRemoteCount > 0
                                              ? t(
                                                  "repository.additionalRemotesStatus",
                                                  {
                                                    count:
                                                      additionalRemoteCount,
                                                  },
                                                )
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

  React.useEffect(() => {
    if (
      !persistableProjectSettings ||
      projectPreferencesSaveInFlightRef.current ||
      pendingProjectPreferencesRef.current
    ) {
      return;
    }
    const normalized = normalizeProjectSettings(persistableProjectSettings);
    projectPreferencesDraftRef.current = normalized;
    projectPreferencesLastSavedRef.current = normalized;
  }, [persistableProjectSettings]);

  const flushProjectPreferences = React.useCallback(async () => {
    if (projectPreferencesSaveInFlightRef.current) {
      return;
    }
    projectPreferencesSaveInFlightRef.current = true;
    try {
      while (pendingProjectPreferencesRef.current) {
        const nextProject = pendingProjectPreferencesRef.current;
        pendingProjectPreferencesRef.current = null;
        try {
          const saved = normalizeProjectSettings(
            await saveProjectSettings({
              autoTrackingRules: nextProject.autoTrackingRules,
              largeFileCheck: nextProject.largeFileCheck,
              localChangesViewMode: nextProject.localChangesViewMode,
              repositoryPath,
              sidebar: nextProject.sidebar,
            }),
          );
          projectPreferencesLastSavedRef.current = saved;
          if (!pendingProjectPreferencesRef.current) {
            projectPreferencesDraftRef.current = saved;
            setProjectSettings(repositoryPath, saved);
            setLocalChangesViewModeOverride(null);
          }
        } catch (error) {
          if (!pendingProjectPreferencesRef.current) {
            const rollback = projectPreferencesLastSavedRef.current;
            if (rollback) {
              projectPreferencesDraftRef.current = rollback;
              setProjectSettings(repositoryPath, rollback);
              setSidebarLayout(rollback.sidebar);
              setLocalChangesViewModeOverride(null);
            }
          }
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      }
    } finally {
      projectPreferencesSaveInFlightRef.current = false;
    }
  }, [repositoryPath, setProjectSettings, setSidebarLayout]);

  const persistProjectPreferences = React.useCallback(
    (updates: {
      localChangesViewMode?: LocalChangesViewMode;
      sidebar?: Required<SidebarLayoutSettings>;
    }) => {
      if (updates.sidebar) {
        setSidebarLayout(updates.sidebar);
      }
      if (updates.localChangesViewMode) {
        setLocalChangesViewModeOverride(updates.localChangesViewMode);
      }

      if (!persistableProjectSettings) {
        return;
      }

      const currentProject =
        projectPreferencesDraftRef.current ??
        normalizeProjectSettings(persistableProjectSettings);
      projectPreferencesLastSavedRef.current ??= currentProject;
      const nextProject = {
        ...currentProject,
        localChangesViewMode:
          updates.localChangesViewMode ?? currentProject.localChangesViewMode,
        sidebar: updates.sidebar ?? currentProject.sidebar,
      };

      projectPreferencesDraftRef.current = nextProject;
      pendingProjectPreferencesRef.current = nextProject;
      setProjectSettings(repositoryPath, nextProject);
      void flushProjectPreferences();
    },
    [
      flushProjectPreferences,
      persistableProjectSettings,
      repositoryPath,
      setProjectSettings,
      setSidebarLayout,
    ],
  );

  const waitForBackgroundFetch = React.useCallback(async () => {
    const existingRequest = fetchInFlightRef.current;
    if (!existingRequest) {
      return;
    }
    try {
      await existingRequest;
    } catch {
      // Background fetch failures must not block write operations.
    }
  }, []);

  const runFetch = React.useCallback(
    async (
      options: {
        reason?: "auto" | "manual" | "prewrite";
        throwOnError?: boolean;
      } = {},
    ) => {
      if (!repository.hasRemote) {
        return;
      }

      const reason = options.reason ?? "manual";
      if (reason === "auto" && suppressAutoFetchRef.current) {
        return;
      }

      const existingRequest = fetchInFlightRef.current;
      if (existingRequest) {
        try {
          await existingRequest;
        } catch (error) {
          if (options.throwOnError) {
            throw error;
          }
        }
        return;
      }

      setFetchBusy(true);
      setFetchState({
        lastSuccessAt: storedFetchState?.lastSuccessAt ?? null,
        message: null,
        repositoryPath,
        state: "fetching",
      });
      const request = (async () => {
        try {
          const response = await fetchRepository({ repositoryPath });
          setFetchState(response.event);
        } catch (error) {
          setFetchState({
            lastSuccessAt: storedFetchState?.lastSuccessAt ?? null,
            message: fetchErrorMessage(error),
            repositoryPath,
            state: "failed",
          });
          throw error;
        }
      })();
      fetchInFlightRef.current = request;

      try {
        await request;
      } catch (error) {
        if (options.throwOnError) {
          throw error;
        }
      } finally {
        if (fetchInFlightRef.current === request) {
          fetchInFlightRef.current = null;
          setFetchBusy(false);
        }
      }
    },
    [
      repository.hasRemote,
      repositoryPath,
      setFetchState,
      storedFetchState?.lastSuccessAt,
    ],
  );

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
      showToast({
        key: "repository-sync-result",
        message: formatSyncAllStatus(response, t),
        tone: syncAllToastTone(response),
      });
      if (syncAllHasFailure(response)) {
        reportResolvedOperationError({
          operationName: "syncAllBranches",
          repositoryPath,
          response,
          summary: t("repository.syncFailedDetails"),
        });
      }
    },
    [repositoryPath, setConflictEntered, t],
  );

  const handleSyncBranchResponse = React.useCallback(
    (response: SyncBranchResponse) => {
      if (
        response.status === "remoteHistoryChanged" &&
        response.remoteHistoryChange
      ) {
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
      showToast({
        key: "repository-sync-result",
        message: formatSyncBranchStatus(response, t),
        tone:
          response.status === "failed"
            ? "error"
            : response.status === "conflicts" ||
                response.status === "remoteHistoryChanged"
              ? "warning"
              : "success",
      });
      if (response.status === "failed") {
        reportResolvedOperationError({
          operationName: "syncBranch",
          repositoryPath,
          response,
          summary: t("repository.syncBranchFailedDetails", {
            branch: response.branchName,
          }),
        });
      }
    },
    [repositoryPath, setConflictEntered, t],
  );

  const runSyncAllBranches = React.useCallback(async () => {
    if (syncBusy || !repository.hasRemote) {
      return;
    }

    setSyncBusy(true);
    try {
      await waitForBackgroundFetch();
      const operationId = createRepositoryOperationId("sync-all");
      const response = await syncAllBranches({
        operationId,
        repositoryPath,
      });
      handleSyncAllResponse(response);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSyncBusy(false);
    }
  }, [
    handleSyncAllResponse,
    repository.hasRemote,
    repositoryPath,
    syncBusy,
    waitForBackgroundFetch,
  ]);

  const runSyncBranch = React.useCallback(
    async (branch: BranchListItem) => {
      if (syncBusy || !repository.hasRemote) {
        return;
      }

      setSyncBusy(true);
      try {
        await waitForBackgroundFetch();
        const operationId = createRepositoryOperationId("sync-branch");
        const response = await syncBranch({
          branchName: branch.name,
          operationId,
          repositoryPath,
        });
        handleSyncBranchResponse(response);
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
      repository.hasRemote,
      repositoryPath,
      syncBusy,
      waitForBackgroundFetch,
    ],
  );

  const runAcceptRemoteHistory = React.useCallback(async () => {
    if (!remoteHistoryChange) {
      return;
    }

    setSyncBusy(true);
    try {
      await waitForBackgroundFetch();
      const operationId = createRepositoryOperationId("accept-remote-history");
      const response = await acceptRemoteHistory({
        branchName: remoteHistoryChange.branchName,
        operationId,
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
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSyncBusy(false);
    }
  }, [
    remoteHistoryChange,
    repositoryPath,
    setConflictEntered,
    waitForBackgroundFetch,
  ]);

  const refreshSafetyBackups = React.useCallback(async () => {
    setSafetyBackupBusyAction("load");
    try {
      const response = await listSafetyBackups({ repositoryPath });
      setSafetyBackups(response.backups);
      setSafetyBackupsTruncated(response.truncated);
      setSafetyBackupsOpen(true);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSafetyBackupBusyAction(null);
    }
  }, [repositoryPath]);

  const runDeleteSafetyBackup = React.useCallback(async () => {
    if (!safetyBackupToDelete) {
      return;
    }

    setSafetyBackupBusyAction("delete");
    try {
      await deleteSafetyBackup({
        backupBranch: safetyBackupToDelete.name,
        operationId: createRepositoryOperationId("delete-safety-backup"),
        repositoryPath,
      });
      setSafetyBackupToDelete(null);
      const response = await listSafetyBackups({ repositoryPath });
      setSafetyBackups(response.backups);
      setSafetyBackupsTruncated(response.truncated);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSafetyBackupBusyAction(null);
    }
  }, [repositoryPath, safetyBackupToDelete]);

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
    },
    [setConflictEntered],
  );

  const runStartReviewMode = React.useCallback(
    async (returnFocusTarget?: HTMLElement) => {
      if (reviewBusy || reviewModeState) {
        return;
      }

      reviewReturnFocusRef.current =
        returnFocusTarget ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      setReviewBusyAction("start");
      try {
        const operationId = createRepositoryOperationId("review-start");
        const response = await startReviewMode({
          operationId,
          repositoryPath,
        });
        setReviewModeState(response.state);
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setReviewBusyAction(null);
      }
    },
    [repositoryPath, reviewBusy, reviewModeState],
  );

  const runSyncReviewMode = React.useCallback(async () => {
    if (reviewBusy || !reviewModeState) {
      return;
    }

    setReviewBusyAction("sync");
    try {
      const response = await syncReviewMode({
        operationId: createRepositoryOperationId("review-sync"),
        repositoryPath,
      });
      setReviewModeState(response.state);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setReviewBusyAction(null);
    }
  }, [repositoryPath, reviewBusy, reviewModeState]);

  const runExitReviewMode = React.useCallback(async () => {
    if (reviewBusy || !reviewModeState) {
      return;
    }

    setReviewBusyAction("exit");
    try {
      const response = await exitReviewMode({
        operationId: createRepositoryOperationId("review-exit"),
        repositoryPath,
      });
      await handleReviewExitResponse(response);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setReviewBusyAction(null);
    }
  }, [handleReviewExitResponse, repositoryPath, reviewBusy, reviewModeState]);

  const runRecoverReviewMode = React.useCallback(async () => {
    if (reviewBusy) {
      return;
    }

    setReviewBusyAction("recover");
    try {
      const response = await recoverReviewModeStash({
        operationId: createRepositoryOperationId("review-recover"),
        repositoryPath,
      });
      await handleReviewExitResponse(response);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setReviewBusyAction(null);
    }
  }, [handleReviewExitResponse, repositoryPath, reviewBusy]);

  const dismissReviewRecovery = React.useCallback(async () => {
    setReviewRecoveryPrompt(false);
    try {
      await dismissReviewModeRecovery({ operationId: null, repositoryPath });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    }
  }, [repositoryPath]);

  React.useEffect(() => {
    let cancelled = false;
    void reviewModeRecovery({ operationId: null, repositoryPath })
      .then((response) => {
        if (!cancelled && response.shouldPrompt) {
          setReviewRecoveryPrompt(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [repositoryPath]);

  React.useEffect(() => {
    if (
      !fetchPreferences?.autoFetch ||
      !repository.hasRemote ||
      initialFetchRepositoryRef.current === repositoryPath
    ) {
      return;
    }

    initialFetchRepositoryRef.current = repositoryPath;
    void runFetch({ reason: "auto" });
  }, [
    fetchPreferences?.autoFetch,
    repository.hasRemote,
    repositoryPath,
    runFetch,
  ]);

  React.useEffect(() => {
    if (!fetchPreferences?.autoFetch || !repository.hasRemote) {
      return;
    }

    const triggerFocusedFetch = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void runFetch({ reason: "auto" });
    };

    window.addEventListener("focus", triggerFocusedFetch);
    document.addEventListener("visibilitychange", triggerFocusedFetch);

    return () => {
      window.removeEventListener("focus", triggerFocusedFetch);
      document.removeEventListener("visibilitychange", triggerFocusedFetch);
    };
  }, [fetchPreferences?.autoFetch, repository.hasRemote, runFetch]);

  React.useEffect(() => {
    if (
      !fetchPreferences?.autoFetch ||
      !fetchInterval.valid ||
      !repository.hasRemote
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void runFetch({ reason: "auto" });
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
      setBranchNameChecking(false);
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
    setBranchNameChecking(name.trim().length > 0);
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
      const operationId = createRepositoryOperationId("checkout-branch");
      const response = await checkoutBranch({
        branchName: branchToCheckout.name,
        localChangesMode: checkoutMode,
        operationId,
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
      const operationId = createRepositoryOperationId("create-branch");
      const response = await createBranch({
        baseBranch: branchCreateBase.name,
        checkoutImmediately: newBranchCheckout,
        createRemote: newBranchCreateRemote,
        localChangesMode: checkoutMode,
        name,
        operationId,
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
        operationId: createRepositoryOperationId("delete-branch"),
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
    setCommitConflictOperationId(null);
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
        setRenormalizePreviewStatus({
          key: renormalizeSuggestionKey ?? "",
          message: t("localChanges.renormalizePreviewEmpty"),
        });
      } else {
        setRenormalizePreviewStatus({
          key: renormalizeSuggestionKey ?? "",
          message: t("localChanges.renormalizePreviewResult", {
            count: response.totalPaths,
            sample: response.samplePaths.join(", "),
            truncated: response.truncated
              ? t("localChanges.renormalizePreviewTruncated")
              : "",
          }),
        });
      }
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setRenormalizePreviewBusy(false);
    }
  }, [renormalizePreviewBusy, renormalizeSuggestionKey, repositoryPath, t]);

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
      setCommitConflictOperationId(null);
      setGpgFailure(null);
      setLargeFileWarning(null);
      try {
        const response = await commitChanges({
          disableRepositoryGpgsign,
          largeFileDecision,
          largeFileThresholdMb: null,
          message: commitMessage,
          operationId: createRepositoryOperationId("commit-changes"),
          paths: selectedCommitPaths,
          pushImmediately: commitPushImmediately,
          repositoryPath,
        });

        if (response.status === "committed") {
          showToast({
            key: "repository-action-result",
            message: t("localChanges.commitCommitted"),
            tone: "success",
          });
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
          setCommitConflictOperationId(response.conflict.operationId);
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
      await runFetch({ reason: "prewrite", throwOnError: true });
    }
  }, [runFetch, shouldFetchBeforeCurrentBranchWrite]);

  const runRestore = React.useCallback(async () => {
    if (!restoreIds || selectedRestorePaths.length === 0) {
      return;
    }

    setRestoreBusy(true);
    try {
      await restoreChanges({
        operationId: createRepositoryOperationId("restore-changes"),
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
      setStashBusyAction("apply");
      try {
        const response = await restoreStash({
          dropOnSuccess: false,
          operationId: createRepositoryOperationId("restore-stash"),
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
        } else {
          showToast({
            key: "repository-stash-result",
            message: t("repository.stashApplied"),
            tone: "success",
          });
        }
      } catch (error) {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setStashBusyAction(null);
      }
    },
    [repositoryPath, setConflictEntered, t],
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

    setStashBusyAction("create");
    try {
      const response = await createStash({
        includeUntracked: true,
        message: stashMessage.trim() || defaultStashMessage(),
        operationId: createRepositoryOperationId("create-stash"),
        paths,
        repositoryPath,
      });
      setStashIds(null);
      setStashMessage("");
      setStashScope("all");
      showToast({
        key: "repository-stash-result",
        message: t(
          response.created
            ? "repository.stashCreated"
            : "repository.stashNothingToCreate",
        ),
        tone: response.created ? "success" : "info",
      });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setStashBusyAction(null);
    }
  }, [
    defaultStashMessage,
    localChanges.length,
    repositoryPath,
    selectedStashPaths,
    stashIds,
    stashMessage,
    stashScope,
    t,
  ]);

  const confirmDeleteStash = React.useCallback(async () => {
    if (!stashToDelete) {
      return;
    }
    setStashBusyAction("delete");
    try {
      await deleteStash({
        operationId: createRepositoryOperationId("delete-stash"),
        repositoryPath,
        selector: stashToDelete.id,
      });
      setStashToDelete(null);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setStashBusyAction(null);
    }
  }, [repositoryPath, stashToDelete]);

  const showStashDetails = React.useCallback(
    (stash: StashListItem) => {
      const entry = stashesQuery.data?.stashes.find(
        (candidate) => candidate.selector === stash.id,
      );
      if (entry) {
        setStashDetailEntry(entry);
      }
    },
    [stashesQuery.data],
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
            operationId: createRepositoryOperationId(
              "revert-cancel-restore-stash",
            ),
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
      cancelOperation,
      completeConflictResolution: async (request) => {
        const response = await completeConflictResolution(request);
        const revertAutoStash = revertAutoStashByOperation[request.operationId];
        if (revertAutoStash) {
          await restoreStash({
            dropOnSuccess: true,
            operationId: createRepositoryOperationId(
              "revert-complete-restore-stash",
            ),
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
        if (conflict.operationId === commitConflictOperationId) {
          setCommitConflictOperationId(null);
          setCommitStatus(t("localChanges.commitConflictEnded"));
        }
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
      void Promise.resolve()
        .then(() =>
          emitAppEvent("conflict-cleared", {
            repositoryPath: conflictRepositoryPath,
          }),
        )
        .catch((error: unknown) => {
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", {
              detail: {
                cause: error,
                operationName: "broadcastConflictCleared",
                repositoryPath: conflictRepositoryPath,
                summary: t("conflicts.clearBroadcastFailed"),
              },
            }),
          );
        });
    },
    [clearConflict, commitConflictOperationId, conflict, t],
  );

  const recoverCloseGuardedState = React.useCallback(async () => {
    if (closeGuardActiveOperation) {
      const response = await cancelOperation({
        operationId: closeGuardActiveOperation.operationId,
      });
      if (!response.cancelled) {
        throw new Error(t("repository.closeGuardBusyBlocked"));
      }
      return;
    }

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
      setReviewBusyAction("recover");
      try {
        const response = await recoverReviewModeStash({
          operationId: createRepositoryOperationId("review-recover-close"),
          repositoryPath,
        });
        await handleReviewExitResponse(response);
        if (response.status === "conflicts") {
          throw new Error(t("repository.closeGuardRecoveryConflict"));
        }
      } finally {
        setReviewBusyAction(null);
      }
    } else if (reviewModeState) {
      setReviewBusyAction("exit");
      try {
        const response = await exitReviewMode({
          operationId: createRepositoryOperationId("review-exit-close"),
          repositoryPath,
        });
        await handleReviewExitResponse(response);
        if (response.status === "conflicts") {
          throw new Error(t("repository.closeGuardRecoveryConflict"));
        }
      } finally {
        setReviewBusyAction(null);
      }
    }
  }, [
    closeConflictOverlay,
    closeGuardActiveOperation,
    conflict,
    conflictApi,
    handleReviewExitResponse,
    repositoryPath,
    reviewModeState,
    reviewRecoveryPrompt,
    t,
    writeOperationBusy,
  ]);

  const cancelActiveOperation = React.useCallback(async () => {
    if (
      !activeOperation?.cancellable ||
      cancellingOperationRef.current !== null
    ) {
      return;
    }

    const operationId = activeOperation.operationId;
    cancellingOperationRef.current = operationId;
    setCancellingOperationId(operationId);
    try {
      const response = await cancelOperation({ operationId });
      if (
        !response.cancelled &&
        cancellingOperationRef.current === operationId
      ) {
        cancellingOperationRef.current = null;
        setCancellingOperationId(null);
      }
    } catch (error) {
      if (cancellingOperationRef.current === operationId) {
        cancellingOperationRef.current = null;
        setCancellingOperationId(null);
      }
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    }
  }, [activeOperation]);

  return (
    <main
      className="flex h-screen min-h-0 bg-background text-foreground"
      data-repository-path={repositoryPath}
      data-testid="repository-shell"
    >
      <RepositorySidebar
        branchActionsDisabledReason={branchActionsDisabledReason}
        branchesUnavailable={
          branchesQuery.error !== null && branchesQuery.data === undefined
        }
        branchesLoading={branchesQuery.isPending}
        branches={branches}
        branchesTruncated={branchesQuery.data?.truncated ?? false}
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
        onReviewMode={(trigger) => void runStartReviewMode(trigger)}
        onSidebarLayoutChange={(layout) => {
          void persistProjectPreferences({ sidebar: layout });
        }}
        onShowSafetyBackups={() => void refreshSafetyBackups()}
        onShowStashDetails={(stash) => void showStashDetails(stash)}
        onSyncBranch={(branch) => void runSyncBranch(branch)}
        remoteStateKnown={remoteStateKnown}
        repository={repository}
        stashesUnavailable={
          stashesQuery.error !== null && stashesQuery.data === undefined
        }
        stashesLoading={stashesQuery.isPending}
        stashes={stashes}
        stashesTruncated={stashesQuery.data?.truncated ?? false}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        {activeOperation ? (
          <div
            aria-label={busyLabel}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={
              activeOperation.progress.kind === "percent" &&
              activeOperation.progress.value !== null
                ? activeOperation.progress.value
                : undefined
            }
            className="h-1 shrink-0 overflow-hidden bg-secondary"
            role="progressbar"
          >
            <div
              className={cn(
                "h-full bg-primary",
                activeOperation.progress.kind === "percent" &&
                  activeOperation.progress.value !== null
                  ? "transition-[width]"
                  : "w-1/2 animate-pulse",
              )}
              style={{
                width:
                  activeOperation.progress.kind === "percent" &&
                  activeOperation.progress.value !== null
                    ? `${activeOperation.progress.value}%`
                    : undefined,
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
              onClick={showHistoryTab}
              testId="repository-tab-history"
            />
            <TabButton
              active={activeTab === "localChanges"}
              badge={localChangeCount}
              icon={<FileText className="size-4" aria-hidden="true" />}
              label={t("repository.localChanges")}
              onClick={showLocalChangesTab}
              testId="repository-tab-local-changes"
            />
          </nav>
          <div
            aria-live="polite"
            className="flex min-w-0 items-center gap-2 text-numeric text-sm text-muted-foreground"
          >
            <span className="truncate">
              {cancellingOperationId
                ? t("repository.operationCancelling")
                : busyLabel}
            </span>
            {activeOperation?.cancellable ? (
              <Button
                className="h-8 shrink-0 gap-1.5 px-2"
                disabled={cancellingOperationId !== null}
                onClick={() => void cancelActiveOperation()}
                type="button"
                variant="ghost"
              >
                {cancellingOperationId ? (
                  <Loader2
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <X className="size-3.5" aria-hidden="true" />
                )}
                {t("actions.cancel")}
              </Button>
            ) : null}
          </div>
        </header>

        {repositoryReadErrors.length > 0 ? (
          <RepositoryReadErrorStrip errors={repositoryReadErrors} />
        ) : null}

        {existingGitOperationRecovery ? (
          <div
            className="flex shrink-0 items-center justify-between gap-3 border-b bg-warning/10 px-4 py-2 text-sm"
            role={
              existingGitOperationRecovery.state === "failed"
                ? "alert"
                : "status"
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              {existingGitOperationRecovery.state === "checking" ? (
                <Loader2
                  className="size-4 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">
                {existingGitOperationRecovery.state === "checking"
                  ? t("repository.openingUnfinishedOperation")
                  : t("repository.openUnfinishedOperationFailed")}
              </span>
            </span>
            {existingGitOperationRecovery.state === "failed" ? (
              <div className="flex shrink-0 items-center gap-1">
                {existingGitOperationRecovery.error ? (
                  <Button
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent("artistic-git:error", {
                          detail: existingGitOperationRecovery.error,
                        }),
                      );
                    }}
                    type="button"
                    variant="ghost"
                  >
                    {t("repository.viewErrorDetails")}
                  </Button>
                ) : null}
                <Button
                  onClick={() =>
                    setExistingGitOperationRetry((current) => current + 1)
                  }
                  type="button"
                  variant="secondary"
                >
                  {t("repository.retryOpenUnfinishedOperation")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {repositoryIndexLock || repositoryBisectActive ? (
          <div
            className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-warning/10 px-4 py-2 text-sm"
            role="alert"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span>
                {repositoryBisectActive
                  ? t("repository.bisectActiveBanner")
                  : t("repository.indexLockBanner", {
                      duration: formatIndexLockAge(
                        repositoryIndexLock?.ageSeconds ?? 0,
                        t,
                      ),
                    })}
              </span>
            </span>
            <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
              <Button
                onClick={() => setRepositoryHealthDetailsOpen(true)}
                type="button"
                variant="ghost"
              >
                {t("repository.viewRepositoryHealthDetails")}
              </Button>
              <Button
                className="gap-2"
                disabled={repositoryHealthRecheckBusy || bisectResetBusy}
                onClick={() => void recheckRepositoryHealth()}
                type="button"
                variant="secondary"
              >
                {repositoryHealthRecheckBusy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {repositoryHealthRecheckBusy
                  ? t("repository.recheckingHealth")
                  : t("repository.recheckHealth")}
              </Button>
              {repositoryBisectActive ? (
                <Button
                  disabled={repositoryHealthRecheckBusy || bisectResetBusy}
                  onClick={() => setBisectResetConfirmOpen(true)}
                  type="button"
                  variant="destructive"
                >
                  {t("repository.resetBisect")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {remoteStateKnown &&
        (!repository.hasRemote || additionalRemoteCount > 0) ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-warning/10 px-4 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {!repository.hasRemote
                  ? repositoryHasOtherRemotes
                    ? t("repository.otherRemotesNotConnected")
                    : t("repository.noRemote")
                  : t("repository.additionalRemotesNotManaged", {
                      count: additionalRemoteCount,
                    })}
              </span>
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
              <div
                className="min-h-0 flex-1 overflow-hidden"
                data-testid="history-workbench-container"
              >
                <HistoryWorkbench
                  activeBranchName={effectiveHistoryBranchName}
                  branches={historyBranchesForWorkbench}
                  hasRemote={repository.hasRemote}
                  historyRepositoryPath={
                    historyScopeReady ? repositoryPath : null
                  }
                  key={effectiveHistoryBranchName ?? "all-history"}
                  onBeforeRevert={fetchBeforeCurrentBranchWrite}
                  onInitialLoadingChange={setHistoryInitialLoading}
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
                  writeDisabled={writeOperationBusy || repositoryWriteBlocked}
                />
              </div>
            </div>
          ) : (
            <LocalChangesPanel
              busy={interactionBusy || repositoryDetached}
              changes={localChanges}
              detailState={localChangeDetailState}
              error={localChangesQuery.error}
              initialCheckedIds={localChangeCheckedIds}
              loadDeferredDetails
              loading={localChangesQuery.isPending}
              onCheckedChange={setLocalChangeCheckedIds}
              onCommit={setCommitIds}
              onPreviewRenormalize={runPreviewRenormalize}
              onRetry={() => void localChangesQuery.refetch()}
              onRetryDetail={() => void localChangeDetailQuery.refetch()}
              onRestore={setRestoreIds}
              onSelectedChange={setSelectedLocalChange}
              onStash={openCreateStashDialog}
              onViewModeChange={(viewMode) => {
                void persistProjectPreferences({
                  localChangesViewMode: viewMode,
                });
              }}
              renormalizePreviewBusy={renormalizePreviewBusy}
              renormalizePreviewStatus={visibleRenormalizePreviewStatus}
              renormalizeSuggestion={renormalizeSuggestion}
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
          busyAction={
            reviewBusyAction === "sync" || reviewBusyAction === "exit"
              ? reviewBusyAction
              : null
          }
          onExit={() => void runExitReviewMode()}
          onSync={() => void runSyncReviewMode()}
          returnFocusRef={reviewReturnFocusRef}
          state={reviewModeState}
        />
      ) : null}
      <ConfirmDialog
        busy={reviewBusy}
        busyLabel={t("review.recovering")}
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
      <DetailsDialog
        description={
          repositoryBisectActive
            ? t("repository.bisectDetailsDescription")
            : t("repository.indexLockDetailsDescription")
        }
        details={formatRepositoryHealthDetails(repositoryHealth, t)}
        onOpenChange={setRepositoryHealthDetailsOpen}
        open={repositoryHealthDetailsOpen}
        summary={
          repositoryBisectActive
            ? t("repository.bisectActiveBanner")
            : t("repository.indexLockPresent")
        }
        title={t("repository.repositoryHealthDetailsTitle")}
      />
      <ConfirmDialog
        busy={bisectResetBusy}
        busyLabel={t("repository.resettingBisect")}
        confirmLabel={t("repository.resetBisect")}
        description={t("repository.resetBisectDescription")}
        onConfirm={() => void runResetBisect()}
        onOpenChange={(open) => {
          if (!bisectResetBusy) {
            setBisectResetConfirmOpen(open);
          }
        }}
        open={bisectResetConfirmOpen}
        title={t("repository.resetBisectTitle")}
        variant="danger"
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
        truncated={safetyBackupsTruncated}
      />
      <ConfirmDialog
        busy={safetyBackupBusy}
        busyLabel={t("repository.deletingSafetyBackup")}
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
      <WindowCloseGuard
        active={closeGuardActive}
        canRecover={closeGuardCanRecover}
        onRecover={recoverCloseGuardedState}
      />
      <CreateBranchDialog
        baseBranch={branchCreateBase}
        baseBranches={branches}
        busy={branchActionBusy}
        checkingName={branchNameChecking}
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
          setBranchNameChecking(newBranchName.trim().length > 0);
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
            setBranchNameChecking(false);
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
        canCancel={
          activeOperation?.label === "Restoring changes" &&
          activeOperation.cancellable
        }
        cancelling={cancellingOperationId !== null}
        count={selectedRestorePaths.length}
        onCancelOperation={() => void cancelActiveOperation()}
        onConfirm={() => void runRestore()}
        onOpenChange={(open) => {
          if (!open && !restoreBusy) {
            setRestoreIds(null);
          }
        }}
        open={restoreIds !== null}
      />
      <ConfirmDialog
        busy={stashActionBusy}
        busyLabel={t("repository.deletingStash")}
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
        details={stashDetailsQuery.data ?? null}
        entry={stashDetailEntry}
        error={stashDetailsQuery.error}
        loading={stashDetailsQuery.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setStashDetailEntry(null);
          }
        }}
        onRetry={() => void stashDetailsQuery.refetch()}
        repositoryPath={repositoryPath}
      />
    </main>
  );
}

async function runCancellableLocalChangeDetail(
  signal: AbortSignal,
  repositoryPath: string,
  change: LocalChangeItem,
): Promise<LocalChange> {
  throwIfPreviewAborted(signal);
  const operationId = createRepositoryOperationId("local-change-detail");
  const cancel = () => {
    void cancelOperation({ operationId }).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });

  try {
    const detail = await localChangeDetail({
      operationId,
      oldPath: change.payload.oldPath,
      path: change.payload.newPath,
      repositoryPath,
      submodule: change.submodule,
    });
    throwIfPreviewAborted(signal);
    return detail;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function runCancellableStashFileDetail(
  signal: AbortSignal,
  repositoryPath: string,
  selector: string,
  path: string,
): Promise<StashFileDetailResponse> {
  throwIfPreviewAborted(signal);
  const operationId = createRepositoryOperationId("stash-file-detail");
  const cancel = () => {
    void cancelOperation({ operationId }).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });

  try {
    const detail = await stashFileDetail({
      operationId,
      path,
      repositoryPath,
      selector,
    });
    throwIfPreviewAborted(signal);
    if (detail.file.path !== path) {
      throw new Error("Stash file response did not match the requested path.");
    }
    return detail;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function throwIfPreviewAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Preview was cancelled.", "AbortError");
  }
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

function isRepositoryShellOperation(
  operation: {
    repositoryPath: string | null;
    windowLabel: string | null;
  },
  repositoryPath: string,
  windowLabel: string | null,
): boolean {
  if (operation.repositoryPath !== repositoryPath) {
    return false;
  }

  return (
    windowLabel === null ||
    operation.windowLabel === null ||
    operation.windowLabel === windowLabel
  );
}

function operationLabel(label: string, t: (key: string) => string): string {
  switch (label) {
    case "Syncing":
      return t("repository.syncBusy");
    case "Accepting remote history":
      return t("repository.acceptingRemoteHistory");
    case "Syncing review mode":
      return t("review.syncing");
    case "Creating branch":
      return t("repository.creatingBranch");
    case "Switching branch":
      return t("repository.switchingBranch");
    case "Deleting branch":
      return t("repository.deletingBranch");
    case "Deleting safety backup":
      return t("repository.deletingSafetyBackup");
    case "Creating stash":
      return t("localChanges.creatingStash");
    case "Applying stash":
      return t("repository.applyingStash");
    case "Deleting stash":
      return t("repository.deletingStash");
    case "Applying conflict selection":
      return t("conflicts.applyingSelection");
    case "Starting review mode":
      return t("review.starting");
    case "Exiting review mode":
      return t("review.exiting");
    case "Recovering review mode":
      return t("review.recovering");
    case "Committing changes":
      return t("localChanges.commitBusy");
    case "Restoring changes":
      return t("localChanges.restoreBusy");
    case "Reverting commit":
      return t("history.revert.busy");
    case "Updating submodules":
      return t("repository.updatingSubmodules");
    case "Downloading submodule LFS objects":
      return t("repository.downloadingSubmoduleLfs");
    case "Submodules ready":
      return t("repository.operationFinishing");
    case "Downloading LFS objects":
      return t("start.cloneProgressLfs");
    case "Checking out files":
      return t("start.cloneProgressCheckout");
    case "Cloning submodules":
      return t("start.cloneProgressSubmodules");
    case "Clone complete":
      return t("repository.operationFinishing");
    case "Cloning repository":
      return t("start.cloneProgressClone");
    default:
      return t("repository.operationBusy");
  }
}

function repositoryMiddleStateStatus(
  kind: RepositoryMiddleStateKind,
  t: (key: string) => string,
): string {
  switch (kind) {
    case "merge":
      return t("repository.inProgressMerge");
    case "rebase":
      return t("repository.inProgressRebase");
    case "cherryPick":
      return t("repository.inProgressCherryPick");
    case "revert":
      return t("repository.inProgressRevert");
    case "bisect":
      return t("repository.inProgressBisect");
  }
}

function formatIndexLockAge(
  ageSeconds: number,
  t: SyncStatusTranslator,
): string {
  if (ageSeconds >= 3_600) {
    const count = Math.floor(ageSeconds / 3_600);
    return t(
      count === 1
        ? "repository.indexLockAgeHour"
        : "repository.indexLockAgeHours",
      { count },
    );
  }
  if (ageSeconds >= 60) {
    const count = Math.floor(ageSeconds / 60);
    return t(
      count === 1
        ? "repository.indexLockAgeMinute"
        : "repository.indexLockAgeMinutes",
      { count },
    );
  }

  const count = Math.max(0, Math.floor(ageSeconds));
  return t(
    count === 1
      ? "repository.indexLockAgeSecond"
      : "repository.indexLockAgeSeconds",
    { count },
  );
}

function formatRepositoryHealthDetails(
  health: RepositoryHealth | null,
  t: SyncStatusTranslator,
): string {
  return health
    ? JSON.stringify(health, null, 2)
    : t("repository.repositoryHealthDetailsUnavailable");
}

function createRepositoryOperationId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function localizedBranchNameValidation(
  validation: BranchNameValidationResponse,
  name: string,
  t: SyncStatusTranslator,
): string {
  if (validation.exists) {
    return t("repository.branchNameExists");
  }
  if (/\s/.test(name)) {
    return t("repository.branchNameNoSpaces");
  }
  return t("repository.branchNameInvalid");
}

function formatSyncAllStatus(
  response: SyncAllBranchesResponse,
  t: SyncStatusTranslator,
): string {
  if (response.allUpToDate) {
    return t("repository.syncAllUpToDate");
  }

  const statuses = [
    ...response.branches.map((branch) => branch.status),
    ...response.autoTracking.map((rule) => rule.status),
  ];
  const upToDate = statuses.filter(
    (status) => status === "alreadyUpToDate",
  ).length;
  const failed = statuses.filter((status) => status === "failed").length;
  const attention = statuses.filter(
    (status) =>
      status === "conflicts" ||
      status === "remoteHistoryChanged" ||
      status === "invalid",
  ).length;
  const synced = statuses.length - upToDate - failed - attention;

  return t("repository.syncBatchSummary", {
    attention,
    failed,
    synced,
    upToDate,
  });
}

function formatSyncBranchStatus(
  response: SyncBranchResponse,
  t: SyncStatusTranslator,
): string {
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
        message: "",
      });
    case "conflicts":
    case "remoteHistoryChanged":
      return t("repository.syncBranchResultNeedsAttention", {
        branch: response.branchName,
        message: "",
      });
    default:
      return t("repository.syncBranchResultSuccess", {
        branch: response.branchName,
      });
  }
}

function syncAllHasFailure(response: SyncAllBranchesResponse): boolean {
  return (
    response.branches.some((branch) => branch.status === "failed") ||
    response.autoTracking.some(
      (rule) => rule.status === "failed" || rule.status === "invalid",
    )
  );
}

function syncAllToastTone(
  response: SyncAllBranchesResponse,
): "error" | "success" | "warning" {
  if (syncAllHasFailure(response)) {
    return "error";
  }
  if (
    response.conflict ||
    response.remoteHistoryChange ||
    response.branches.some(
      (branch) =>
        branch.status === "conflicts" ||
        branch.status === "remoteHistoryChanged",
    ) ||
    response.autoTracking.some((rule) => rule.status === "conflicts")
  ) {
    return "warning";
  }
  return "success";
}

function reportResolvedOperationError({
  operationName,
  repositoryPath,
  response,
  summary,
}: {
  operationName: string;
  repositoryPath: string;
  response: unknown;
  summary: string;
}) {
  const error: AppError & { response: unknown } = {
    category: "expected",
    context: {
      operationId: null,
      operationName,
      repositoryPath,
      windowLabel: null,
    },
    git: null,
    response,
    summary,
  };
  window.dispatchEvent(
    new CustomEvent("artistic-git:error", { detail: error }),
  );
}

function fetchErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "summary" in error &&
    typeof error.summary === "string"
  ) {
    return error.summary;
  }
  return typeof error === "string" ? error : "remote check failed";
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
  t: SyncStatusTranslator,
): StashListItem {
  const origin = localizedAutoStashOrigin(stash.origin, t);
  return {
    id: stash.selector,
    name: stash.isAutoStash
      ? t("repository.autoStashName", { origin })
      : stash.message,
    timeLabel: stash.createdAtUnixSeconds
      ? formatRelativeTime(Number(stash.createdAtUnixSeconds) * 1000)
      : "",
  };
}

function localizedAutoStashOrigin(
  origin: string | null | undefined,
  t: SyncStatusTranslator,
): string {
  const switchMatch = origin?.match(/^before switching to (.+)$/);
  if (switchMatch) {
    return t("repository.autoStashOriginSwitchBranch", {
      branch: switchMatch[1],
    });
  }

  switch (origin) {
    case "switch branch":
      return t("repository.autoStashOriginSwitchBranches");
    case "before syncing current branch":
      return t("repository.autoStashOriginSync");
    case "before applying automatic tracking":
      return t("repository.autoStashOriginAutomaticTracking");
    case "before accepting remote history":
      return t("repository.autoStashOriginAcceptRemoteHistory");
    case "review mode":
      return t("repository.autoStashOriginReview");
    case "before reverting commit":
      return t("repository.autoStashOriginRevert");
    default:
      return origin?.startsWith("stash apply recovery")
        ? t("repository.autoStashOriginRecovery")
        : t("repository.autoStashUnknownOrigin");
  }
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
      change.submodule?.name,
      change.submodule?.path,
      change.indexStatus,
      change.worktreeStatus,
      change.payload.fileKind,
    ]
      .filter(Boolean)
      .join(" "),
    submodule: change.submodule,
  };
}

function DialogBusyStatus({ busy, label }: { busy: boolean; label: string }) {
  if (!busy) {
    return <span />;
  }

  return (
    <span
      className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
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
      dismissible={!busy}
      description={t("repository.remoteHistoryChangedDescription", {
        branch: change.branchName,
      })}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <DialogBusyStatus
            busy={busy}
            label={t("repository.acceptingRemoteHistory")}
          />
          <div className="ml-auto flex shrink-0 gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              className="gap-2"
              disabled={busy}
              onClick={onAccept}
              type="button"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {busy
                ? t("repository.acceptingRemoteHistory")
                : t("repository.acceptRemoteHistory")}
            </Button>
          </div>
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
  truncated,
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
  truncated: boolean;
}) {
  const { t } = useTranslation();
  const [pageState, setPageState] = React.useState<{
    backups: SafetyBackupSummary[];
    pageIndex: number;
  } | null>(null);
  const pageCount = Math.max(
    1,
    Math.ceil(backups.length / safetyBackupPageSize),
  );
  const pageIndex =
    pageState?.backups === backups
      ? Math.min(pageState.pageIndex, pageCount - 1)
      : 0;
  const visibleBackups = backups.slice(
    pageIndex * safetyBackupPageSize,
    (pageIndex + 1) * safetyBackupPageSize,
  );

  if (!open) {
    return null;
  }

  return (
    <DialogFrame
      description={t("repository.safetyBackupsDescription")}
      dismissible={!busy}
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
        <div className="space-y-3">
          {truncated ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("repository.safetyBackupsTruncated", {
                count: backups.length,
              })}
            </p>
          ) : null}
          <ul className="grid gap-2">
            {visibleBackups.map((backup) => (
              <li
                className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border bg-background p-3"
                data-testid="safety-backup-row"
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
                <IconButton
                  disabled={busy}
                  label={t("repository.deleteSafetyBackup")}
                  onClick={() => onDelete(backup)}
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
          {pageCount > 1 ? (
            <div className="flex items-center justify-between gap-2 border-t pt-2">
              <IconButton
                disabled={busy || pageIndex === 0}
                label={t("repository.previousSafetyBackupsPage")}
                onClick={() =>
                  setPageState({
                    backups,
                    pageIndex: Math.max(0, pageIndex - 1),
                  })
                }
                type="button"
                variant="ghost"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </IconButton>
              <span className="text-xs text-muted-foreground">
                {t("repository.safetyBackupsPage", {
                  page: pageIndex + 1,
                  total: pageCount,
                })}
              </span>
              <IconButton
                disabled={busy || pageIndex >= pageCount - 1}
                label={t("repository.nextSafetyBackupsPage")}
                onClick={() =>
                  setPageState({
                    backups,
                    pageIndex: Math.min(pageCount - 1, pageIndex + 1),
                  })
                }
                type="button"
                variant="ghost"
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </IconButton>
            </div>
          ) : null}
        </div>
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
      dismissible={!busy}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <DialogBusyStatus
            busy={busy}
            label={t("repository.deletingBranch")}
          />
          <div className="ml-auto flex shrink-0 gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              className="gap-2"
              disabled={!canDelete}
              onClick={onConfirm}
              type="button"
              variant="destructive"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {busy
                ? t("repository.deletingBranch")
                : t("repository.deleteBranch")}
            </Button>
          </div>
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
  checkingName,
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
  checkingName: boolean;
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
  const baseBranchOptions = React.useMemo(
    () =>
      baseBranches.map((branch) => ({
        label: branch.name,
        value: branch.name,
      })),
    [baseBranches],
  );

  if (!baseBranch) {
    return null;
  }

  const trimmedName = name.trim();
  const validationMessage = validation
    ? localizedBranchNameValidation(validation, name, t)
    : null;
  const canCreate =
    trimmedName.length > 0 && validation?.valid === true && !busy;

  return (
    <DialogFrame
      description={t("repository.createBranchDescription", {
        branch: baseBranch.name,
      })}
      dismissible={!busy}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <DialogBusyStatus
            busy={busy}
            label={t("repository.creatingBranch")}
          />
          <div className="ml-auto flex shrink-0 gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              className="gap-2"
              disabled={!canCreate}
              onClick={onCreate}
              type="button"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {busy
                ? t("repository.creatingBranch")
                : t("repository.createBranch")}
            </Button>
          </div>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("repository.createBranchTitle")}
    >
      <div className="grid gap-2 text-sm">
        <BranchSelect
          disabled={busy}
          label={t("repository.branchBase")}
          noResultsLabel={t("repository.noSearchResults")}
          onChange={(value) => {
            const nextBase = baseBranches.find(
              (branch) => branch.name === value,
            );
            if (nextBase) {
              onBaseBranchChange(nextBase);
            }
          }}
          options={baseBranchOptions}
          searchLabel={t("repository.searchBranches")}
          value={baseBranch.name}
        />
        {baseBranch.remoteOnly ? (
          <span className="text-xs text-muted-foreground">
            {t("repository.branchBaseRemoteOnly")}
          </span>
        ) : null}
      </div>

      <label className="grid gap-2 text-sm">
        <span className="font-medium">{t("repository.branchName")}</span>
        <input
          autoFocus
          className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={busy}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={t("repository.branchNamePlaceholder")}
          value={name}
        />
      </label>

      {trimmedName.length > 0 ? (
        <p
          className={cn(
            "text-sm",
            checkingName || validation?.valid
              ? "text-muted-foreground"
              : "text-destructive",
          )}
          role="status"
        >
          {checkingName
            ? t("repository.branchNameChecking")
            : validation?.valid
              ? t("repository.branchNameAvailable")
              : (validationMessage ?? t("repository.branchNameInvalid"))}
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          checked={checkoutImmediately}
          className="size-4"
          disabled={busy}
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
      dismissible={!busy}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <DialogBusyStatus
            busy={busy}
            label={t("repository.switchingBranch")}
          />
          <div className="ml-auto flex shrink-0 gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              className="gap-2"
              disabled={busy}
              onClick={onConfirm}
              type="button"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {busy
                ? t("repository.switchingBranch")
                : t("repository.checkout")}
            </Button>
          </div>
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
      dismissible={!busy}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="min-w-0 text-sm text-muted-foreground"
            data-testid="commit-dialog-status"
          >
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
            <Button
              data-testid="commit-dialog-submit"
              disabled={!canCommit}
              onClick={onCommit}
              type="button"
            >
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
          data-testid="commit-message-input"
          disabled={busy}
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
            data-testid="commit-push-immediately"
            disabled={busy}
            onChange={(event) => onPushImmediatelyChange(event.target.checked)}
            type="checkbox"
          />
          <span>{t("localChanges.pushImmediately")}</span>
        </label>
      ) : null}

      {largeFileWarning ? (
        <LargeFileWarningPanel
          busy={busy}
          files={largeFileWarning.files}
          onCommitNormally={onCommitNormally}
          onTrackWithLfs={onTrackWithLfs}
          thresholdMb={largeFileWarning.thresholdMb}
        />
      ) : null}

      {gpgFailure ? (
        <div className="space-y-3 rounded-md border bg-destructive/10 p-3 text-sm">
          <p className="font-medium">{gpgFailure.summary}</p>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {gpgFailure.stderr}
          </pre>
          <Button
            disabled={busy}
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

function LargeFileWarningPanel({
  busy,
  files,
  onCommitNormally,
  onTrackWithLfs,
  thresholdMb,
}: {
  busy: boolean;
  files: LargeFileWarning[];
  onCommitNormally: () => void;
  onTrackWithLfs: () => void;
  thresholdMb: number;
}) {
  const { t } = useTranslation();
  const [pageIndex, setPageIndex] = React.useState(0);
  const pageCount = Math.max(
    1,
    Math.ceil(files.length / largeFileWarningPageSize),
  );
  const currentPageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleFiles = files.slice(
    currentPageIndex * largeFileWarningPageSize,
    (currentPageIndex + 1) * largeFileWarningPageSize,
  );

  return (
    <div className="space-y-3 rounded-md border bg-warning/10 p-3 text-sm">
      <p className="font-medium">
        {t("localChanges.largeFilesTitle", { threshold: thresholdMb })}
      </p>
      <OverlayScrollArea className="max-h-32" viewportClassName="max-h-32">
        <ul className="text-muted-foreground">
          {visibleFiles.map((file) => (
            <li
              className="truncate"
              data-testid="large-file-warning-item"
              key={file.path}
            >
              {file.path}
            </li>
          ))}
        </ul>
      </OverlayScrollArea>
      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <IconButton
            disabled={busy || currentPageIndex === 0}
            label={t("localChanges.previousLargeFilesPage")}
            onClick={() => setPageIndex(Math.max(0, currentPageIndex - 1))}
            type="button"
            variant="ghost"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </IconButton>
          <span className="text-xs text-muted-foreground">
            {t("localChanges.largeFilesPage", {
              page: currentPageIndex + 1,
              total: pageCount,
            })}
          </span>
          <IconButton
            disabled={busy || currentPageIndex >= pageCount - 1}
            label={t("localChanges.nextLargeFilesPage")}
            onClick={() =>
              setPageIndex(Math.min(pageCount - 1, currentPageIndex + 1))
            }
            type="button"
            variant="ghost"
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={onTrackWithLfs}
          type="button"
          variant="secondary"
        >
          {t("localChanges.trackWithLfs")}
        </Button>
        <Button
          disabled={busy}
          onClick={onCommitNormally}
          type="button"
          variant="secondary"
        >
          {t("localChanges.commitNormally")}
        </Button>
      </div>
    </div>
  );
}

function RestoreChangesDialog({
  busy,
  canCancel,
  cancelling,
  count,
  onCancelOperation,
  onConfirm,
  onOpenChange,
  open,
}: {
  busy: boolean;
  canCancel: boolean;
  cancelling: boolean;
  count: number;
  onCancelOperation: () => void;
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
      closeOnEscape={!busy}
      description={description}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            disabled={busy && (!canCancel || cancelling)}
            onClick={busy ? onCancelOperation : () => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            {cancelling
              ? t("repository.operationCancelling")
              : t("actions.cancel")}
          </Button>
          {busy ? null : (
            <Button onClick={onConfirm} type="button" variant="destructive">
              {t("localChanges.restoreConfirm")}
            </Button>
          )}
        </div>
      }
      hideCloseButton={busy}
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
      {busy ? (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {cancelling
            ? t("repository.operationCancelling")
            : t("localChanges.restoreBusy")}
        </div>
      ) : null}
    </DialogFrame>
  );
}

function StashDetailsDialog({
  details,
  entry,
  error,
  loading,
  onOpenChange,
  onRetry,
  repositoryPath,
}: {
  details: StashDetailsResponse | null;
  entry: StashEntry | null;
  error: unknown;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  repositoryPath: string;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const activeFile =
    details?.files.find((file) => file.path === selectedPath) ??
    details?.files[0] ??
    null;
  const fileDetailQuery = useQuery({
    enabled: entry !== null && activeFile !== null,
    queryFn: ({ signal }) => {
      if (!entry || !activeFile) {
        return Promise.reject(new Error("No stash file selected."));
      }
      return runCancellableStashFileDetail(
        signal,
        repositoryPath,
        entry.oid,
        activeFile.path,
      );
    },
    queryKey: [
      "repository",
      repositoryPath,
      "stashFileDetail",
      entry?.oid ?? null,
      activeFile?.path ?? null,
    ] as const,
    retry: false,
  });

  if (!entry) {
    return null;
  }

  const displayEntry = details?.entry ?? entry;
  const createdAt = displayEntry.createdAtUnixSeconds
    ? formatters.formatDate(Number(displayEntry.createdAtUnixSeconds) * 1000, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : t("repository.stashUnknownTime");
  const autoStashOrigin = localizedAutoStashOrigin(displayEntry.origin, t);
  const title = displayEntry.isAutoStash
    ? t("repository.autoStashName", { origin: autoStashOrigin })
    : displayEntry.message;
  const loadedDetail =
    activeFile && fileDetailQuery.data?.file.path === activeFile.path
      ? fileDetailQuery.data
      : null;

  return (
    <DialogFrame
      className="h-[min(44rem,calc(100vh-3rem))] max-w-5xl"
      contentClassName="min-h-0 flex-1"
      contentViewportClassName="min-h-0 overflow-hidden"
      data-testid="stash-details-dialog"
      description={displayEntry.selector}
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
      title={title}
    >
      <div className="grid shrink-0 gap-3">
        <dl className="grid gap-3 rounded-md border bg-background p-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="font-medium">{t("repository.stashSelector")}</dt>
            <dd className="truncate text-muted-foreground">
              {displayEntry.selector}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="font-medium">{t("repository.stashCreatedAt")}</dt>
            <dd className="truncate text-muted-foreground">{createdAt}</dd>
          </div>
        </dl>

        {displayEntry.isAutoStash ? (
          <div className="rounded-md border bg-secondary px-3 py-2 text-sm">
            {t("repository.autoStashOrigin", {
              origin: autoStashOrigin,
            })}
          </div>
        ) : null}
      </div>
      {loading && !details ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center gap-2 rounded-md border bg-background text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("repository.stashDetailsBusy")}
        </div>
      ) : error && !details ? (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-md border bg-background p-6 text-center text-sm"
          role="alert"
        >
          <span className="text-muted-foreground">
            {t("repository.stashDetailsLoadFailed")}
          </span>
          <Button onClick={onRetry} type="button" variant="secondary">
            {t("actions.retry")}
          </Button>
        </div>
      ) : details ? (
        <div
          className="grid min-h-0 flex-1 gap-4 overflow-hidden md:grid-cols-[260px_minmax(0,1fr)]"
          data-testid="stash-detail-layout"
        >
          <div className="flex min-h-0 flex-col overflow-hidden rounded-md border bg-background">
            <div className="shrink-0 border-b px-3 py-2 text-sm font-medium">
              {t("repository.stashFiles", { count: details.files.length })}
            </div>
            <StashDetailsFileList
              activePath={activeFile?.path ?? null}
              files={details.files}
              onSelect={setSelectedPath}
            />
          </div>
          <div
            className="flex min-h-0 min-w-0 overflow-hidden"
            data-testid="stash-detail-diff-pane"
          >
            {!activeFile ? (
              <div className="flex flex-1 items-center justify-center rounded-md border bg-background p-6 text-center text-sm text-muted-foreground">
                {t("repository.stashNoDiff")}
              </div>
            ) : loadedDetail ? (
              <DiffViewer
                content={loadedDetail.diff}
                payload={loadedDetail.payload}
                source="stashDetails"
              />
            ) : fileDetailQuery.error ? (
              <div
                className="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border bg-background p-6 text-center text-sm"
                role="alert"
              >
                <span className="text-muted-foreground">
                  {t("repository.stashFileLoadFailed")}
                </span>
                <Button
                  onClick={() => void fileDetailQuery.refetch()}
                  type="button"
                  variant="secondary"
                >
                  {t("actions.retry")}
                </Button>
              </div>
            ) : (
              <div
                className="flex flex-1 items-center justify-center gap-2 rounded-md border bg-background text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("repository.stashFileLoading")}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </DialogFrame>
  );
}

function StashDetailsFileList({
  activePath,
  files,
  onSelect,
}: {
  activePath: string | null;
  files: StashChangedFile[];
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [pageIndex, setPageIndex] = React.useState(0);
  const pageCount = Math.max(
    1,
    Math.ceil(files.length / stashDetailsFilePageSize),
  );
  const currentPageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleFiles = files.slice(
    currentPageIndex * stashDetailsFilePageSize,
    (currentPageIndex + 1) * stashDetailsFilePageSize,
  );

  return (
    <>
      <OverlayScrollArea className="min-h-0 flex-1">
        <ul className="p-1 text-sm">
          {visibleFiles.map((file) => (
            <li key={`${file.oldPath ?? ""}\0${file.path}`}>
              <button
                aria-pressed={activePath === file.path}
                className={cn(
                  "w-full rounded px-2 py-1 text-left hover:bg-secondary",
                  activePath === file.path && "bg-secondary",
                )}
                data-testid="stash-detail-file"
                onClick={() => onSelect(file.path)}
                type="button"
              >
                <span className="block truncate">{file.path}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`diff.changeKind.${file.changeKind}`)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </OverlayScrollArea>
      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-2 border-t p-2">
          <IconButton
            disabled={currentPageIndex === 0}
            label={t("repository.previousStashFilesPage")}
            onClick={() => setPageIndex(Math.max(0, currentPageIndex - 1))}
            type="button"
            variant="ghost"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </IconButton>
          <span className="text-xs text-muted-foreground">
            {t("repository.stashFilesPage", {
              page: currentPageIndex + 1,
              total: pageCount,
            })}
          </span>
          <IconButton
            disabled={currentPageIndex >= pageCount - 1}
            label={t("repository.nextStashFilesPage")}
            onClick={() =>
              setPageIndex(Math.min(pageCount - 1, currentPageIndex + 1))
            }
            type="button"
            variant="ghost"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}
    </>
  );
}

function RepositoryReadErrorStrip({
  errors,
}: {
  errors: RepositoryReadError[];
}) {
  const { t } = useTranslation();

  return (
    <div
      aria-label={t("repository.readErrorsTitle")}
      className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-3"
      role="alert"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span>{t("repository.readErrorsTitle")}</span>
      </div>
      <ul className="grid gap-2">
        {errors.map((error) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 text-sm"
            data-testid={`repository-read-error-${error.id}`}
            key={error.id}
          >
            <span className="min-w-0 flex-1">{error.message}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                className="h-8 px-2"
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("artistic-git:error", {
                      detail: error.error,
                    }),
                  );
                }}
                type="button"
                variant="ghost"
              >
                {t("repository.viewErrorDetails")}
              </Button>
              <Button
                className="h-8 gap-1.5 px-2"
                disabled={error.retrying}
                onClick={error.retry}
                type="button"
                variant="secondary"
              >
                {error.retrying ? (
                  <Loader2
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {error.retrying
                  ? t("repository.retryingLoad")
                  : t("repository.retryLoad")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
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
      dismissible={!busy}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <DialogBusyStatus
            busy={busy}
            label={t("localChanges.creatingStash")}
          />
          <div className="ml-auto flex shrink-0 gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              className="gap-2"
              disabled={!canCreate}
              onClick={onCreate}
              type="button"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {busy
                ? t("localChanges.creatingStash")
                : t("localChanges.createStash")}
            </Button>
          </div>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("localChanges.createStashTitle")}
    >
      <label className="grid gap-2 text-sm">
        <span className="font-medium">{t("localChanges.stashName")}</span>
        <input
          className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={busy}
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
  testId?: string;
}

function TabButton({
  active,
  badge = 0,
  icon,
  label,
  onClick,
  testId,
}: TabButtonProps) {
  return (
    <button
      className={cn(
        "flex h-9 items-center gap-2 rounded-md px-3 text-sm",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      data-testid={testId}
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
