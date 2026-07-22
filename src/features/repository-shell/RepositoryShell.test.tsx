import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";
import { defaultAppSettings } from "@/features/settings/settings-model";
import type {
  ConflictEnteredEvent,
  DiffPayload,
  LocalChange,
  LocalChangesResponse,
  OperationProgressEvent,
} from "@/lib/ipc/generated";
import { useWindowStore, type WindowStoreState } from "@/store/window-store";

import { RepositoryShell } from "./RepositoryShell";

const commandMocks = vi.hoisted(() => ({
  acceptRemoteHistory: vi.fn(),
  cancelConflictResolution: vi.fn(),
  cancelOperation: vi.fn(),
  cancelPendingWindowExit: vi.fn(),
  cancelStashRestore: vi.fn(),
  checkoutBranch: vi.fn(),
  closeCurrentWindow: vi.fn(),
  commitDetails: vi.fn(),
  commitFileDetail: vi.fn(),
  commitChanges: vi.fn(),
  completeConflictResolution: vi.fn(),
  conflictDetail: vi.fn(),
  createBranch: vi.fn(),
  createStash: vi.fn(),
  deleteBranch: vi.fn(),
  deleteSafetyBackup: vi.fn(),
  deleteStash: vi.fn(),
  dismissReviewModeRecovery: vi.fn(),
  exitReviewMode: vi.fn(),
  fetchRepository: vi.fn(),
  listBranches: vi.fn(),
  listConflicts: vi.fn(),
  listLocalChanges: vi.fn(),
  listRecentProjects: vi.fn(),
  localChangeDetail: vi.fn(),
  listSafetyBackups: vi.fn(),
  listStashes: vi.fn(),
  logPage: vi.fn(),
  loadProjectSettings: vi.fn(),
  previewRenormalize: vi.fn(),
  repositorySummary: vi.fn(),
  resetBisect: vi.fn(),
  restoreChanges: vi.fn(),
  restoreStash: vi.fn(),
  recoverReviewModeStash: vi.fn(),
  saveProjectSettings: vi.fn(),
  saveAppSettings: vi.fn(),
  reviewModeRecovery: vi.fn(),
  revertCommit: vi.fn(),
  saveWindowGeometry: vi.fn(),
  saveConflictResolution: vi.fn(),
  selectConflictSide: vi.fn(),
  setWindowCloseGuard: vi.fn(),
  settingsSnapshot: vi.fn(),
  stashDetails: vi.fn(),
  stashFileDetail: vi.fn(),
  startReviewMode: vi.fn(),
  syncAllBranches: vi.fn(),
  syncBranch: vi.fn(),
  syncCurrentBranch: vi.fn(),
  syncReviewMode: vi.fn(),
  validateBranchName: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => commandMocks);

const appEventMocks = vi.hoisted(() => ({
  emitAppEvent: vi.fn(),
}));

vi.mock("@/lib/ipc/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc/events")>();
  return { ...actual, emitAppEvent: appEventMocks.emitAppEvent };
});

const tauriEventListeners = new Map<
  string,
  (event: { payload: unknown }) => void
>();

function renderWithProviders(
  ui: ReactElement,
  initialWindowState?: Partial<WindowStoreState>,
) {
  return render(
    <AppProviders
      i18n={createI18n("en")}
      initialLanguagePreference="en"
      initialThemePreference="light"
      initialWindowState={initialWindowState}
      queryClient={createAppQueryClient()}
    >
      {ui}
    </AppProviders>,
  );
}

function OperationSwitcher({
  operation,
}: {
  operation: OperationProgressEvent;
}) {
  const setOperationProgress = useWindowStore(
    (state) => state.setOperationProgress,
  );
  return (
    <button onClick={() => setOperationProgress(operation)} type="button">
      switch operation
    </button>
  );
}

function OperationLabelSwitcher({
  operations,
}: {
  operations: OperationProgressEvent[];
}) {
  const setOperationProgress = useWindowStore(
    (state) => state.setOperationProgress,
  );
  return operations.map((operation) => (
    <button
      key={operation.operationId}
      onClick={() => setOperationProgress(operation)}
      type="button"
    >
      {operation.operationId}
    </button>
  ));
}

function NavigationLockProbe() {
  const navigationLocked = useWindowStore((state) => state.navigationLocked);
  return (
    <output data-testid="navigation-lock">
      {navigationLocked ? "locked" : "unlocked"}
    </output>
  );
}

async function emitWindowCloseBlocked(payload: unknown) {
  await waitFor(() =>
    expect(tauriEventListeners.has("window-close-blocked")).toBe(true),
  );
  await act(async () => {
    tauriEventListeners.get("window-close-blocked")?.({ payload });
  });
}

function createLocalChange({
  changeKind,
  fileKind,
  indexStatus,
  newPath,
  newText,
  oldPath = null,
  oldText,
  worktreeStatus,
}: {
  changeKind: DiffPayload["changeKind"];
  fileKind: DiffPayload["fileKind"];
  indexStatus: string;
  newPath: string;
  newText?: string;
  oldPath?: string | null;
  oldText?: string;
  worktreeStatus: string;
}): LocalChange {
  const payload: DiffPayload = {
    changeKind,
    fileKind,
    lfsLock: null,
    metadata: {
      indexStatus,
      worktreeStatus,
    },
    newPath,
    oldPath,
  };

  return {
    changeKind,
    diff:
      fileKind === "text"
        ? {
            kind: "text",
            language: null,
            newText: newText ?? "",
            oldText: oldText ?? "",
          }
        : fileKind === "image"
          ? { kind: "image", newImage: null, oldImage: null }
          : fileKind === "lfsPointer"
            ? { kind: "lfsPointer", message: null, status: "missing" }
            : { kind: fileKind, message: null },
    indexStatus,
    oldPath,
    path: newPath,
    payload,
    worktreeStatus,
  };
}

function createDeferredLocalChange({
  metadataOnly = false,
  path,
  submodule = null,
}: {
  metadataOnly?: boolean;
  path: string;
  submodule?: LocalChange["submodule"];
}): LocalChange {
  const change = createLocalChange({
    changeKind: "modified",
    fileKind: metadataOnly ? "oversizedText" : "deferred",
    indexStatus: "M",
    newPath: path,
    worktreeStatus: "M",
  });

  return {
    ...change,
    payload: {
      ...change.payload,
      metadata: {
        ...change.payload.metadata,
        previewDeferred: "true",
      },
    },
    submodule,
  };
}

function createConflictEvent(): ConflictEnteredEvent {
  const file = {
    fileKind: "text" as const,
    path: "src/app.ts",
    status: "unresolved" as const,
  };
  commandMocks.listConflicts.mockResolvedValue({
    files: [file],
    operation: { kind: "merge", label: "Merge" },
  });
  commandMocks.conflictDetail.mockResolvedValue({
    detail: {
      currentText:
        "before\n<<<<<<< HEAD\nown\n=======\nother\n>>>>>>> branch\n",
      hunks: [],
      kind: "text",
      language: null,
      otherText: "other\n",
      ownText: "own\n",
    },
    file,
  });

  return {
    files: [file],
    operationId: "commit-conflict-test",
    operationName: "commitChanges",
    repositoryPath: "/repo/art",
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.resetAllMocks();
  appEventMocks.emitAppEvent.mockResolvedValue(undefined);
  tauriEventListeners.clear();
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    tauriEventListeners.set(
      event,
      handler as (event: { payload: unknown }) => void,
    );
    return () => undefined;
  });
  commandMocks.cancelPendingWindowExit.mockResolvedValue(undefined);
  commandMocks.closeCurrentWindow.mockResolvedValue(undefined);
  commandMocks.commitDetails.mockImplementation((request) =>
    Promise.resolve({
      body: null,
      bodyTruncated: false,
      files: [],
      oid: request.oid,
      repositoryPath: request.repositoryPath,
      truncated: false,
    }),
  );
  commandMocks.saveWindowGeometry.mockResolvedValue({});
  commandMocks.listRecentProjects.mockResolvedValue([]);
  commandMocks.saveAppSettings.mockImplementation(({ settings }) =>
    Promise.resolve(settings),
  );
  commandMocks.settingsSnapshot.mockResolvedValue({
    appVersion: "0.2.5",
    identitySourcesError: null,
    settings: defaultAppSettings,
    sshKeyError: null,
  });
  commandMocks.loadProjectSettings.mockResolvedValue({
    largeFileCheck: { enabled: true, thresholdMb: 50 },
    localChangesViewMode: "flat",
    path: "/repo/art",
    sidebar: {
      branchSectionRatioPercent: 60,
      branchesCollapsed: false,
      stashesCollapsed: false,
      widthPx: 280,
    },
  });
  commandMocks.saveProjectSettings.mockImplementation((request) =>
    Promise.resolve({
      largeFileCheck: request.largeFileCheck,
      localChangesViewMode: request.localChangesViewMode ?? "flat",
      path: request.repositoryPath,
      sidebar: request.sidebar ?? {
        branchSectionRatioPercent: 60,
        branchesCollapsed: false,
        stashesCollapsed: false,
        widthPx: 280,
      },
    }),
  );
  commandMocks.repositorySummary.mockResolvedValue({
    currentBranch: "main",
    hasOrigin: true,
    headOid: "abc1234",
    inProgress: false,
    isDetached: false,
    isUnborn: false,
    remoteMode: "origin",
    repositoryPath: "/repo/art",
  });
  commandMocks.resetBisect.mockResolvedValue({
    currentBranch: "main",
    details: {
      health: {
        head: { kind: "branch", name: "main", oid: "abc1234" },
        indexLock: null,
        middleStates: [],
      },
      remotes: [],
    },
    hasOrigin: false,
    headOid: "abc1234",
    inProgress: false,
    isDetached: false,
    isUnborn: false,
    remoteMode: "noRemote",
    repositoryPath: "/repo/art",
  });
  commandMocks.listBranches.mockResolvedValue({
    branches: [
      {
        ahead: 0,
        behind: 0,
        current: true,
        existence: "localOnly",
        headOid: "abc1234",
        latestCommitUnixSeconds: "1760000000",
        name: "refs/heads/main",
        shortName: "main",
        upstream: null,
      },
    ],
  });
  commandMocks.listLocalChanges.mockResolvedValue({
    changes: [
      createLocalChange({
        changeKind: "modified",
        fileKind: "text",
        indexStatus: "M",
        newPath: "src/app.ts",
        newText: "console.log('new')\n",
        oldText: "console.log('old')\n",
        worktreeStatus: "M",
      }),
      createLocalChange({
        changeKind: "added",
        fileKind: "image",
        indexStatus: "?",
        newPath: "assets/texture.png",
        worktreeStatus: "?",
      }),
    ],
    renormalizeSuggestion: null,
  });
  commandMocks.localChangeDetail.mockResolvedValue(
    createLocalChange({
      changeKind: "modified",
      fileKind: "text",
      indexStatus: "M",
      newPath: "src/app.ts",
      newText: "console.log('new')\n",
      oldText: "console.log('old')\n",
      worktreeStatus: "M",
    }),
  );
  commandMocks.previewRenormalize.mockResolvedValue({
    samplePaths: [],
    totalPaths: 0,
    truncated: false,
  });
  commandMocks.listStashes.mockResolvedValue({ stashes: [] });
  commandMocks.listConflicts.mockResolvedValue({
    files: [],
    operation: null,
  });
  commandMocks.logPage.mockResolvedValue({ commits: [], nextAfter: null });
  commandMocks.cancelConflictResolution.mockResolvedValue({
    aborted: "merge",
  });
  commandMocks.cancelStashRestore.mockResolvedValue({
    droppedRecoveryStash: false,
    restored: true,
  });
  commandMocks.commitChanges.mockResolvedValue({
    committedPaths: ["src/app.ts"],
    lfsTrackedPaths: [],
    oid: "abc123456789",
    status: "committed",
  });
  commandMocks.createStash.mockResolvedValue({
    created: true,
    stash: null,
    stdout: "",
  });
  commandMocks.syncCurrentBranch.mockResolvedValue({
    attempts: 1,
    branchName: "main",
    conflict: null,
    remoteHistoryChange: null,
    repositoryPath: "/repo/art",
    status: "alreadyUpToDate",
    stashRecovery: null,
    upstream: "origin/main",
  });
  commandMocks.syncAllBranches.mockResolvedValue({
    allUpToDate: true,
    autoTracking: [],
    branches: [
      {
        attempts: 1,
        branchName: "main",
        conflict: null,
        remoteHistoryChange: null,
        repositoryPath: "/repo/art",
        status: "alreadyUpToDate",
        stashRecovery: null,
        upstream: "origin/main",
      },
    ],
    conflict: null,
    remoteHistoryChange: null,
    repositoryPath: "/repo/art",
    stashRecovery: null,
  });
  commandMocks.syncBranch.mockResolvedValue({
    attempts: 1,
    branchName: "main",
    conflict: null,
    remoteHistoryChange: null,
    repositoryPath: "/repo/art",
    status: "alreadyUpToDate",
    stashRecovery: null,
    upstream: "origin/main",
  });
  commandMocks.acceptRemoteHistory.mockResolvedValue({
    backup: safetyBackupSummary(),
    branchName: "main",
    conflict: null,
    repositoryPath: "/repo/art",
    resetToOid: "remoteabcdef",
    stashRecovery: null,
    upstream: "origin/main",
  });
  commandMocks.listSafetyBackups.mockResolvedValue({ backups: [] });
  commandMocks.deleteSafetyBackup.mockResolvedValue({
    backupBranch: "backup/main-1760000000000",
    repositoryPath: "/repo/art",
  });
  commandMocks.reviewModeRecovery.mockResolvedValue({
    autoStash: null,
    repositoryPath: "/repo/art",
    shouldPrompt: false,
  });
  commandMocks.startReviewMode.mockResolvedValue({
    state: reviewModeState(),
  });
  commandMocks.syncReviewMode.mockResolvedValue({
    state: reviewModeState({ hasRemoteUpdate: false, subject: "Remote sync" }),
  });
  commandMocks.exitReviewMode.mockResolvedValue({
    conflict: null,
    repositoryPath: "/repo/art",
    stashRecovery: null,
    status: "applied",
  });
  commandMocks.recoverReviewModeStash.mockResolvedValue({
    conflict: null,
    repositoryPath: "/repo/art",
    stashRecovery: null,
    status: "applied",
  });
  commandMocks.dismissReviewModeRecovery.mockResolvedValue({
    autoStash: null,
    repositoryPath: "/repo/art",
    shouldPrompt: false,
  });
  commandMocks.cancelOperation.mockResolvedValue({ cancelled: true });
  commandMocks.revertCommit.mockResolvedValue({
    message: "Revert blocked history revert",
    oid: "reverted1234567890",
    pushed: false,
    status: "reverted",
  });
  commandMocks.setWindowCloseGuard.mockResolvedValue(undefined);
  commandMocks.restoreStash.mockResolvedValue({
    oid: "stashoid",
    outcome: { status: "applied", dropped: false },
    recovery: {
      headOid: "abc1234",
      id: "recovery-1",
      stashOid: null,
      stashSelector: null,
    },
    selector: "stash@{0}",
  });
  commandMocks.deleteStash.mockResolvedValue({
    deletedSelector: "stash@{0}",
    stdout: "",
  });
  commandMocks.stashDetails.mockResolvedValue({
    entry: stashEntry({
      message: "WIP material polish",
      selector: "stash@{0}",
    }),
    files: [],
  });
  commandMocks.stashFileDetail.mockImplementation((request) =>
    Promise.resolve({
      diff: {
        kind: "text",
        language: null,
        newText: "",
        oldText: "",
      },
      file: {
        changeKind: "modified",
        oldPath: null,
        path: request.path,
      },
      payload: {
        changeKind: "modified",
        fileKind: "text",
        lfsLock: null,
        metadata: {},
        newPath: request.path,
        oldPath: null,
      },
      selector: request.selector,
    }),
  );
  commandMocks.validateBranchName.mockResolvedValue({
    exists: false,
    message: null,
    name: "feature/new-art-pass",
    valid: true,
  });
  commandMocks.createBranch.mockResolvedValue({
    branchName: "feature/new-art-pass",
    repositoryPath: "/repo/art",
    status: "completed",
  });
  commandMocks.checkoutBranch.mockResolvedValue({
    branchName: "feature/lookdev",
    repositoryPath: "/repo/art",
    status: "completed",
  });
  commandMocks.deleteBranch.mockResolvedValue({
    branchName: "feature/lookdev",
    repositoryPath: "/repo/art",
    status: "completed",
  });
  commandMocks.fetchRepository.mockResolvedValue({
    event: {
      lastSuccessAt: "1760000000",
      message: null,
      repositoryPath: "/repo/art",
      state: "idle",
    },
    skipped: false,
  });
  commandMocks.restoreChanges.mockResolvedValue({
    backedUpPaths: ["assets/texture.png"],
    backupRoot: "/trash/backup",
    restoredPaths: ["assets/texture.png"],
  });
  commandMocks.settingsSnapshot.mockRejectedValue(new Error("No Tauri"));
});

afterEach(() => {
  cleanup();
});

describe("RepositoryShell loading state", () => {
  it("keeps scrolling inside the commit history frame", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() => {
      const container = screen.getByTestId("history-workbench-container");
      const frame = screen.getByTestId("history-frame");
      const viewport = screen.getByTestId("history-scroll-viewport");

      expect(container).toHaveClass("overflow-hidden");
      expect(container).not.toHaveClass("overflow-auto");
      expect(container).toContainElement(frame);
      expect(frame).toContainElement(viewport);
    });
  });

  it("does not show demo repository content while queries are pending", async () => {
    const pendingRequest = new Promise<never>(() => undefined);
    commandMocks.listBranches.mockReturnValue(pendingRequest);
    commandMocks.listLocalChanges.mockReturnValue(pendingRequest);
    commandMocks.listStashes.mockReturnValue(pendingRequest);
    commandMocks.logPage.mockReturnValue(pendingRequest);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() => {
      expect(commandMocks.listBranches).toHaveBeenCalled();
      expect(commandMocks.listLocalChanges).toHaveBeenCalled();
      expect(commandMocks.listStashes).toHaveBeenCalled();
    });
    expect(commandMocks.logPage).not.toHaveBeenCalled();

    expect(screen.queryByText("feature/material-library")).toBeNull();
    expect(screen.queryByText("WIP material polish")).toBeNull();
    expect(screen.queryByText("Merge color pipeline preview")).toBeNull();
    expect(screen.getByText("Loading repository information...")).toBeVisible();
    expect(screen.getByText("Loading branches...")).toBeVisible();
    expect(screen.getByText("Loading stashes...")).toBeVisible();
    expect(screen.queryByText("No matching items")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Local Changes/ }));

    expect(screen.queryByText("src/preview/render-preview.ts")).toBeNull();
    expect(screen.queryByLabelText("File comparison")).toBeNull();
  });

  it("keeps cached local changes interactive during a background refresh", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    await waitFor(() =>
      expect(commandMocks.listLocalChanges).toHaveBeenCalledTimes(1),
    );
    const pendingRefresh = createPendingResponse<LocalChangesResponse>({
      changes: [],
      renormalizeSuggestion: null,
    });
    commandMocks.listLocalChanges.mockReturnValueOnce(pendingRefresh.promise);

    fireEvent.click(screen.getByRole("button", { name: /Local Changes/ }));
    await waitFor(() =>
      expect(commandMocks.listLocalChanges).toHaveBeenCalledTimes(2),
    );

    expect(screen.getAllByText("src/app.ts").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("checkbox", { name: "Select or deselect src/app.ts" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("textbox", { name: "Search files and contents" }),
    ).toBeEnabled();

    await act(async () => pendingRefresh.resolve());
  });

  it("keeps the repository loading status until the initial history is ready", async () => {
    const pendingHistory = createPendingResponse({
      commits: [],
      nextAfter: null,
    });
    commandMocks.logPage.mockReturnValue(pendingHistory.promise);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() => {
      expect(commandMocks.repositorySummary).toHaveBeenCalled();
      expect(commandMocks.listBranches).toHaveBeenCalled();
      expect(commandMocks.listLocalChanges).toHaveBeenCalled();
      expect(commandMocks.listStashes).toHaveBeenCalled();
    });
    await screen.findByRole("button", { name: "main" });
    expect(screen.getByText("Loading repository information...")).toBeVisible();

    await act(async () => pendingHistory.resolve());
    await waitFor(() =>
      expect(
        screen.queryByText("Loading repository information..."),
      ).not.toBeInTheDocument(),
    );
  });

  it("filters history to the branch selected in the sidebar", async () => {
    commandMocks.listBranches.mockResolvedValue({
      branches: [
        {
          ahead: 0,
          behind: 0,
          current: true,
          existence: "localOnly",
          headOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          latestCommitUnixSeconds: "1760000000",
          name: "refs/heads/main",
          shortName: "main",
          upstream: null,
        },
        {
          ahead: 0,
          behind: 0,
          current: false,
          existence: "localOnly",
          headOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          latestCommitUnixSeconds: "1760000001",
          name: "refs/heads/feature/lookdev",
          shortName: "feature/lookdev",
          upstream: null,
        },
      ],
    });
    commandMocks.logPage.mockImplementation((request) =>
      Promise.resolve({
        commits: request.revisions.includes("refs/heads/feature/lookdev")
          ? [
              {
                authorEmail: "mira@example.test",
                authorName: "Mira Chen",
                authoredAtUnixSeconds: "1760000001",
                oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                parents: [],
                refs: ["feature/lookdev"],
                subject: "Feature branch commit",
              },
            ]
          : [
              {
                authorEmail: "mira@example.test",
                authorName: "Mira Chen",
                authoredAtUnixSeconds: "1760000000",
                oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                parents: [],
                refs: ["HEAD -> main"],
                subject: "Main branch commit",
              },
            ],
        nextAfter: null,
      }),
    );

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(await screen.findByText("Main branch commit")).toBeVisible();
    expect(screen.queryByText("Feature branch commit")).not.toBeInTheDocument();
    expect(commandMocks.logPage).toHaveBeenCalledWith(
      expect.objectContaining({ revisions: ["refs/heads/main"] }),
    );

    fireEvent.click(screen.getByRole("button", { name: "feature/lookdev" }));

    expect(
      await screen.findByRole("button", {
        name: "Current branch: feature/lookdev",
      }),
    ).toBeVisible();
    expect(await screen.findByText("Feature branch commit")).toBeVisible();
    expect(screen.queryByText("Main branch commit")).not.toBeInTheDocument();
    expect(commandMocks.logPage).toHaveBeenCalledWith(
      expect.objectContaining({ revisions: ["refs/heads/feature/lookdev"] }),
    );
  });

  it("shows local change query errors and retries without discarding details", async () => {
    const queryError = {
      operation: "git status --porcelain=v1 -z",
      repositoryPath: "/repo/art",
      stderr: "fatal: index file corrupt",
      summary: "Unable to list local changes",
    };
    commandMocks.listLocalChanges.mockRejectedValue(queryError);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() =>
      expect(commandMocks.listLocalChanges).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Couldn't load local changes",
      }),
    ).toBeVisible();
    expect(screen.queryByText("No matching changes")).not.toBeInTheDocument();

    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);

    try {
      fireEvent.click(
        screen.getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails).toEqual([queryError]);
      expect(receivedDetails[0]).toBe(queryError);

      commandMocks.listLocalChanges.mockResolvedValue({
        changes: [
          createLocalChange({
            changeKind: "added",
            fileKind: "text",
            indexStatus: "?",
            newPath: "recovered-local.txt",
            newText: "recovered\n",
            worktreeStatus: "?",
          }),
        ],
        renormalizeSuggestion: null,
      });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      expect(
        await screen.findAllByText("recovered-local.txt"),
      ).not.toHaveLength(0);
      expect(
        screen.queryByRole("heading", {
          name: "Couldn't load local changes",
        }),
      ).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("shows each repository read error with isolated retry and full details", async () => {
    const errors = {
      branches: {
        operation: "git for-each-ref",
        stderr: "fatal: packed-refs is corrupt",
        summary: "Unable to list branches",
      },
      projectSettings: {
        path: "/repo/art/.git/artistic-git.json",
        summary: "Unable to load project settings",
      },
      stashes: {
        operation: "git stash list",
        stderr: "fatal: bad stash ref",
        summary: "Unable to list stashes",
      },
      summary: {
        operation: "git status",
        stderr: "fatal: not a git repository",
        summary: "Unable to read repository status",
      },
    };
    commandMocks.repositorySummary.mockRejectedValue(errors.summary);
    commandMocks.listBranches.mockRejectedValue(errors.branches);
    commandMocks.listStashes.mockRejectedValue(errors.stashes);
    commandMocks.loadProjectSettings.mockRejectedValue(errors.projectSettings);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const summaryError = await screen.findByTestId(
      "repository-read-error-summary",
    );
    const branchesError = screen.getByTestId("repository-read-error-branches");
    const stashesError = screen.getByTestId("repository-read-error-stashes");
    const settingsError = screen.getByTestId(
      "repository-read-error-projectSettings",
    );
    expect(summaryError).toHaveTextContent(
      "Repository status could not be loaded.",
    );
    expect(branchesError).toHaveTextContent("Branches could not be loaded.");
    expect(stashesError).toHaveTextContent("Stashes could not be loaded.");
    expect(settingsError).toHaveTextContent(
      "Project settings could not be loaded.",
    );
    expect(screen.queryByText("No matching items")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No remote repository configured"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Some repository information is unavailable"),
    ).toBeVisible();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();

    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);

    try {
      for (const row of [
        summaryError,
        branchesError,
        stashesError,
        settingsError,
      ]) {
        fireEvent.click(
          within(row).getByRole("button", { name: "View error details" }),
        );
      }
      expect(receivedDetails).toEqual([
        errors.summary,
        errors.branches,
        errors.stashes,
        errors.projectSettings,
      ]);
      expect(receivedDetails[0]).toBe(errors.summary);
      expect(receivedDetails[1]).toBe(errors.branches);
      expect(receivedDetails[2]).toBe(errors.stashes);
      expect(receivedDetails[3]).toBe(errors.projectSettings);

      commandMocks.repositorySummary.mockResolvedValue({
        currentBranch: "main",
        hasOrigin: false,
        headOid: "abc1234",
        inProgress: false,
        isDetached: false,
        isUnborn: false,
        remoteMode: "noRemote",
        repositoryPath: "/repo/art",
      });
      fireEvent.click(
        within(summaryError).getByRole("button", { name: "Try again" }),
      );

      await waitFor(() => {
        expect(commandMocks.repositorySummary).toHaveBeenCalledTimes(2);
        expect(
          screen.queryByTestId("repository-read-error-summary"),
        ).not.toBeInTheDocument();
      });
      expect(commandMocks.listBranches).toHaveBeenCalledTimes(1);
      expect(commandMocks.listStashes).toHaveBeenCalledTimes(1);
      expect(commandMocks.loadProjectSettings).toHaveBeenCalledTimes(1);

      commandMocks.listBranches.mockResolvedValue({ branches: [] });
      commandMocks.listStashes.mockResolvedValue({ stashes: [] });
      commandMocks.loadProjectSettings.mockResolvedValue({
        largeFileCheck: { enabled: true, thresholdMb: 50 },
        localChangesViewMode: "flat",
        path: "/repo/art",
        sidebar: {
          branchSectionRatioPercent: 60,
          branchesCollapsed: false,
          stashesCollapsed: false,
          widthPx: 280,
        },
      });
      fireEvent.click(
        within(branchesError).getByRole("button", { name: "Try again" }),
      );
      fireEvent.click(
        within(stashesError).getByRole("button", { name: "Try again" }),
      );
      fireEvent.click(
        within(settingsError).getByRole("button", { name: "Try again" }),
      );

      await waitFor(() => {
        expect(commandMocks.listBranches).toHaveBeenCalledTimes(2);
        expect(commandMocks.listStashes).toHaveBeenCalledTimes(2);
        expect(commandMocks.loadProjectSettings).toHaveBeenCalledTimes(2);
        expect(
          screen.queryByLabelText(
            "Some repository information could not be loaded",
          ),
        ).not.toBeInTheDocument();
      });
      expect(await screen.findByText("Ready")).toBeVisible();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("shows detached HEAD without inventing a current branch", async () => {
    commandMocks.repositorySummary.mockResolvedValue({
      currentBranch: null,
      hasOrigin: true,
      headOid: "abc1234",
      inProgress: false,
      isDetached: true,
      isUnborn: false,
      remoteMode: "origin",
      repositoryPath: "/repo/art",
    });
    commandMocks.listBranches.mockResolvedValue({
      branches: [
        {
          ahead: 0,
          behind: 0,
          current: false,
          existence: "localOnly",
          headOid: "def5678",
          latestCommitUnixSeconds: "1760000000",
          name: "main",
          shortName: "main",
          upstream: null,
        },
      ],
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(await screen.findByText("Not on a branch")).toBeVisible();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Current branch: main" }),
    ).not.toBeInTheDocument();
    expect(commandMocks.logPage).toHaveBeenCalledWith(
      expect.objectContaining({ revisions: [] }),
    );
  });

  it("waits for the branch scope before loading backend history", async () => {
    const pendingSummary = createPendingResponse({
      currentBranch: "main",
      hasOrigin: true,
      headOid: "abc1234",
      inProgress: false,
      isDetached: false,
      isUnborn: false,
      remoteMode: "origin" as const,
      repositoryPath: "/repo/art",
    });
    const pendingBranches = createPendingResponse({
      branches: [
        branchSummary({
          current: true,
          existence: "localAndRemote",
          headOid: "abc1234",
          shortName: "main",
        }),
      ],
    });
    commandMocks.repositorySummary.mockReturnValue(pendingSummary.promise);
    commandMocks.listBranches.mockReturnValue(pendingBranches.promise);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(commandMocks.logPage).not.toHaveBeenCalled();
    await act(async () => pendingSummary.resolve());
    expect(commandMocks.logPage).not.toHaveBeenCalled();
    await act(async () => pendingBranches.resolve());

    await waitFor(() =>
      expect(commandMocks.logPage).toHaveBeenCalledWith(
        expect.objectContaining({
          revisions: ["refs/heads/main", "refs/remotes/origin/main"],
        }),
      ),
    );
    expect(commandMocks.logPage).toHaveBeenCalledTimes(1);
  });

  it("describes an index lock without claiming repository recovery is required", async () => {
    commandMocks.repositorySummary.mockResolvedValue({
      currentBranch: "main",
      details: {
        health: {
          head: { kind: "branch", name: "main", oid: "abc1234" },
          indexLock: {
            ageSeconds: 30,
            path: "/repo/art/.git/index.lock",
            warning: "raw index lock warning",
          },
          middleStates: [],
        },
        remotes: [
          {
            isOrigin: true,
            managed: true,
            name: "origin",
            url: "https://example.test/art.git",
          },
        ],
      },
      hasOrigin: true,
      headOid: "abc1234",
      inProgress: true,
      isDetached: false,
      isUnborn: false,
      remoteMode: "origin",
      repositoryPath: "/repo/art",
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(
      await screen.findByText(
        "The repository may be in use by another Git tool.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Git has been locked by another operation for 30 seconds. Close other Git tools, then recheck.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review Mode" })).toBeDisabled();
    expect(commandMocks.listConflicts).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const detailsDialog = screen.getByRole("dialog", {
      name: "Repository status details",
    });
    fireEvent.click(
      within(detailsDialog).getByRole("button", {
        name: "Show technical details",
      }),
    );
    expect(detailsDialog).toHaveTextContent("/repo/art/.git/index.lock");
    expect(detailsDialog).toHaveTextContent("raw index lock warning");
    fireEvent.click(
      within(detailsDialog).getByRole("button", { name: "Close" }),
    );

    commandMocks.repositorySummary.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() =>
      expect(commandMocks.repositorySummary).toHaveBeenCalledTimes(1),
    );
  });

  it("resets an existing Git bisect with write and close protection", async () => {
    const finishedSummary = {
      currentBranch: "main",
      details: {
        health: {
          head: { kind: "branch" as const, name: "main", oid: "abc1234" },
          indexLock: null,
          middleStates: [],
        },
        remotes: [],
      },
      hasOrigin: false,
      headOid: "abc1234",
      inProgress: false,
      isDetached: false,
      isUnborn: false,
      remoteMode: "noRemote" as const,
      repositoryPath: "/repo/art",
    };
    const pendingReset = createPendingResponse(finishedSummary);
    commandMocks.repositorySummary.mockResolvedValue({
      ...finishedSummary,
      details: {
        ...finishedSummary.details,
        health: {
          ...finishedSummary.details.health,
          middleStates: [
            {
              abortCommand: null,
              kind: "bisect",
              path: "/repo/art/.git/BISECT_LOG",
            },
          ],
        },
      },
      inProgress: true,
    });
    commandMocks.resetBisect.mockReturnValueOnce(pendingReset.promise);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(
      await screen.findByText(
        "This repository has an unfinished Git bisect session. Reset it to return to normal use.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reset Git bisect" }));
    const confirmDialog = screen.getByRole("dialog", {
      name: "Reset Git bisect?",
    });
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Reset Git bisect" }),
    );

    expect(
      (await screen.findAllByText("Resetting Git bisect...")).length,
    ).toBeGreaterThan(1);
    expect(commandMocks.resetBisect).toHaveBeenCalledWith({
      repositoryPath: "/repo/art",
    });
    await waitFor(() =>
      expect(commandMocks.setWindowCloseGuard).toHaveBeenLastCalledWith({
        active: true,
      }),
    );

    await act(async () => pendingReset.resolve());
    expect(await screen.findByTestId("app-toast")).toHaveTextContent(
      "Git bisect was reset.",
    );
    await waitFor(() =>
      expect(
        screen.queryByText(
          "This repository has an unfinished Git bisect session. Reset it to return to normal use.",
        ),
      ).not.toBeInTheDocument(),
    );
  });

  it("restores an unfinished merge in the conflict resolution view", async () => {
    commandMocks.repositorySummary.mockResolvedValue({
      currentBranch: "main",
      details: {
        health: {
          head: { kind: "branch", name: "main", oid: "abc1234" },
          indexLock: null,
          middleStates: [
            {
              abortCommand: ["git", "merge", "--abort"],
              kind: "merge",
              path: "/repo/art/.git/MERGE_HEAD",
            },
          ],
        },
        remotes: [],
      },
      hasOrigin: false,
      headOid: "abc1234",
      inProgress: true,
      isDetached: false,
      isUnborn: false,
      remoteMode: "noRemote",
      repositoryPath: "/repo/art",
    });
    commandMocks.listConflicts.mockResolvedValue({
      files: [],
      operation: { kind: "merge", label: "Merge" },
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await screen.findByRole("dialog", {
      name: "Resolve conflicts",
    });
    expect(
      within(dialog).getAllByText(
        "No conflicted files remain. Continue to finish the Git operation.",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole("button", { name: "Finish resolving" }),
    ).toBeEnabled();
  });

  it("offers a retry when an unfinished Git operation cannot be opened", async () => {
    const recoveryError = {
      operation: "listConflicts",
      stderr: "unable to inspect index",
      summary: "Conflict state could not be read",
    };
    commandMocks.repositorySummary.mockResolvedValue({
      currentBranch: "main",
      details: {
        health: {
          head: { kind: "branch", name: "main", oid: "abc1234" },
          indexLock: null,
          middleStates: [
            {
              abortCommand: ["git", "merge", "--abort"],
              kind: "merge",
              path: "/repo/art/.git/MERGE_HEAD",
            },
          ],
        },
        remotes: [],
      },
      hasOrigin: false,
      headOid: "abc1234",
      inProgress: true,
      isDetached: false,
      isUnborn: false,
      remoteMode: "noRemote",
      repositoryPath: "/repo/art",
    });
    commandMocks.listConflicts
      .mockRejectedValueOnce(recoveryError)
      .mockResolvedValue({
        files: [],
        operation: { kind: "merge", label: "Merge" },
      });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(
      await screen.findByText(
        "The unfinished Git operation could not be opened.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try opening again" }));

    expect(
      await screen.findByRole("dialog", { name: "Resolve conflicts" }),
    ).toBeInTheDocument();
    expect(commandMocks.listConflicts).toHaveBeenCalledTimes(3);
  });

  it("clears recovery failures when the Git operation ends externally", async () => {
    const unfinishedSummary = {
      currentBranch: "main",
      details: {
        health: {
          head: { kind: "branch" as const, name: "main", oid: "abc1234" },
          indexLock: null,
          middleStates: [
            {
              abortCommand: ["git", "merge", "--abort"],
              kind: "merge" as const,
              path: "/repo/art/.git/MERGE_HEAD",
            },
          ],
        },
        remotes: [],
      },
      hasOrigin: false,
      headOid: "abc1234",
      inProgress: true,
      isDetached: false,
      isUnborn: false,
      remoteMode: "noRemote" as const,
      repositoryPath: "/repo/art",
    };
    commandMocks.repositorySummary.mockResolvedValueOnce(unfinishedSummary);
    commandMocks.listConflicts.mockRejectedValue({
      operation: "listConflicts",
      summary: "Conflict state could not be read",
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(
      await screen.findByText(
        "The unfinished Git operation could not be opened.",
      ),
    ).toBeVisible();
    commandMocks.repositorySummary.mockResolvedValue({
      ...unfinishedSummary,
      details: {
        ...unfinishedSummary.details,
        health: {
          ...unfinishedSummary.details.health,
          middleStates: [],
        },
      },
      inProgress: false,
    });

    await act(async () => {
      tauriEventListeners.get("repo-changed")?.({
        payload: {
          changedQueries: ["summary"],
          repositoryPath: "/repo/art",
        },
      });
    });

    await waitFor(() =>
      expect(
        screen.queryByText("The unfinished Git operation could not be opened."),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Try opening again" }),
    ).not.toBeInTheDocument();
  });

  it("shows an unborn branch without an empty commit placeholder", async () => {
    commandMocks.repositorySummary.mockResolvedValue({
      currentBranch: "main",
      hasOrigin: false,
      headOid: null,
      inProgress: false,
      isDetached: false,
      isUnborn: true,
      remoteMode: "noRemote",
      repositoryPath: "/repo/art",
    });
    commandMocks.listBranches.mockResolvedValue({
      branches: [
        {
          ahead: 0,
          behind: 0,
          current: true,
          existence: "localOnly",
          headOid: null,
          latestCommitUnixSeconds: null,
          name: "main",
          shortName: "main",
          upstream: null,
        },
      ],
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(await screen.findByText("No commits yet")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Current branch: main" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/latest commit/i)).not.toBeInTheDocument();
  });
});

describe("RepositoryShell deferred local-change previews", () => {
  it("loads one deferred submodule preview without blocking the file list", async () => {
    const submodule = { name: "deps/lib", path: "deps/lib" };
    const deferred = createDeferredLocalChange({
      path: "deps/lib/art.ts",
      submodule,
    });
    const loaded = {
      ...createLocalChange({
        changeKind: "modified",
        fileKind: "text",
        indexStatus: "M",
        newPath: "deps/lib/art.ts",
        newText: "loaded-submodule-preview\n",
        oldText: "old\n",
        worktreeStatus: "M",
      }),
      submodule,
    };
    const pendingDetail = createPendingResponse(loaded);
    commandMocks.listLocalChanges.mockResolvedValue({
      changes: [deferred],
      renormalizeSuggestion: null,
    });
    commandMocks.localChangeDetail.mockReturnValue(pendingDetail.promise);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );

    expect(await screen.findByText("Loading file preview...")).toBeVisible();
    const deferredRow = screen.getByTestId("local-change-row");
    expect(deferredRow).toHaveAttribute("data-change-path", "deps/lib/art.ts");
    expect(deferredRow.closest("aside")).not.toHaveAttribute("inert");
    await waitFor(() =>
      expect(commandMocks.localChangeDetail).toHaveBeenCalledTimes(1),
    );
    expect(commandMocks.localChangeDetail).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^local-change-detail-/),
      oldPath: null,
      path: "deps/lib/art.ts",
      repositoryPath: "/repo/art",
      submodule,
    });

    await act(async () => pendingDetail.resolve());
    expect(await screen.findByText("loaded-submodule-preview")).toBeVisible();
    expect(screen.getAllByText("deps/lib/art.ts").length).toBeGreaterThan(0);
  });

  it("cancels an obsolete preview and never shows its late result", async () => {
    const firstDeferred = createDeferredLocalChange({ path: "first.ts" });
    const secondDeferred = createDeferredLocalChange({ path: "second.ts" });
    const firstPending = createPendingResponse(
      createLocalChange({
        changeKind: "modified",
        fileKind: "text",
        indexStatus: "M",
        newPath: "stale-first-result.ts",
        newText: "stale-first-preview\n",
        oldText: "old\n",
        worktreeStatus: "M",
      }),
    );
    const secondPending = createPendingResponse(
      createLocalChange({
        changeKind: "modified",
        fileKind: "text",
        indexStatus: "M",
        newPath: "loaded-second-result.ts",
        newText: "loaded-second-preview\n",
        oldText: "old\n",
        worktreeStatus: "M",
      }),
    );
    commandMocks.listLocalChanges.mockResolvedValue({
      changes: [firstDeferred, secondDeferred],
      renormalizeSuggestion: null,
    });
    commandMocks.localChangeDetail.mockImplementation(
      ({ path }: { path: string }) =>
        path === "first.ts" ? firstPending.promise : secondPending.promise,
    );

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );
    await waitFor(() =>
      expect(commandMocks.localChangeDetail).toHaveBeenCalledTimes(1),
    );
    const firstRequest = commandMocks.localChangeDetail.mock.calls[0][0] as {
      operationId: string;
    };

    const secondRow = screen
      .getAllByTestId("local-change-row")
      .find((row) => row.getAttribute("data-change-path") === "second.ts");
    expect(secondRow).toBeDefined();
    fireEvent.click(secondRow!);

    await waitFor(() =>
      expect(commandMocks.localChangeDetail).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(commandMocks.cancelOperation).toHaveBeenCalledWith({
        operationId: firstRequest.operationId,
      }),
    );
    expect(screen.getByText("Loading file preview...")).toBeVisible();

    await act(async () => firstPending.resolve());
    expect(screen.queryByText("stale-first-result.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("stale-first-preview")).not.toBeInTheDocument();
    expect(screen.getByText("Loading file preview...")).toBeVisible();

    await act(async () => secondPending.resolve());
    expect(await screen.findByText("loaded-second-result.ts")).toBeVisible();
    expect(screen.getByText("loaded-second-preview")).toBeVisible();
  });

  it("shows complete preview errors and retries metadata-deferred files", async () => {
    const deferred = createDeferredLocalChange({
      metadataOnly: true,
      path: "metadata-deferred.txt",
    });
    const detailError = {
      operation: "localChangeDetail",
      repositoryPath: "/repo/art",
      stderr: "fatal: cannot read metadata-deferred.txt",
      summary: "Unable to load local change preview",
    };
    commandMocks.listLocalChanges.mockResolvedValue({
      changes: [deferred],
      renormalizeSuggestion: null,
    });
    commandMocks.localChangeDetail.mockRejectedValue(detailError);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Couldn't load this preview",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("metadata-deferred.txt").length).toBeGreaterThan(
      0,
    );

    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);

    try {
      fireEvent.click(
        screen.getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails[0]).toBe(detailError);

      commandMocks.localChangeDetail.mockResolvedValue(
        createLocalChange({
          changeKind: "modified",
          fileKind: "text",
          indexStatus: "M",
          newPath: "metadata-deferred.txt",
          newText: "preview-recovered\n",
          oldText: "old\n",
          worktreeStatus: "M",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Try loading again" }),
      );

      expect(await screen.findByText("preview-recovered")).toBeVisible();
      expect(
        screen.queryByRole("heading", {
          name: "Couldn't load this preview",
        }),
      ).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });
});

describe("RepositoryShell session preferences", () => {
  it("does not save synthesized defaults when project settings fail to load", async () => {
    commandMocks.loadProjectSettings.mockRejectedValueOnce({
      path: "/repo/art/.git/artistic-git.json",
      summary: "Unable to load project settings",
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(
      await screen.findByTestId("repository-read-error-projectSettings"),
    ).toBeVisible();
    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Tree view" }));
    expect(screen.getByRole("button", { name: "Tree view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));

    await waitFor(() =>
      expect(commandMocks.saveProjectSettings).not.toHaveBeenCalled(),
    );
  });

  it("restores and saves the project local changes view mode", async () => {
    commandMocks.loadProjectSettings.mockResolvedValueOnce({
      largeFileCheck: { enabled: true, thresholdMb: 50 },
      localChangesViewMode: "tree",
      path: "/repo/art",
      sidebar: {
        branchSectionRatioPercent: 72,
        branchesCollapsed: false,
        stashesCollapsed: true,
        widthPx: 340,
      },
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Tree view" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Flat view" }));

    await waitFor(() =>
      expect(commandMocks.saveProjectSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          largeFileCheck: { enabled: true, thresholdMb: 50 },
          localChangesViewMode: "flat",
          repositoryPath: "/repo/art",
          sidebar: expect.objectContaining({
            branchSectionRatioPercent: 72,
            stashesCollapsed: true,
            widthPx: 340,
          }),
        }),
      ),
    );
  });

  it("persists sidebar layout changes to project settings", async () => {
    commandMocks.loadProjectSettings.mockResolvedValueOnce({
      largeFileCheck: { enabled: true, thresholdMb: 75 },
      localChangesViewMode: "flat",
      path: "/repo/art",
      sidebar: {
        branchSectionRatioPercent: 68,
        branchesCollapsed: true,
        stashesCollapsed: false,
        widthPx: 360,
      },
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() =>
      expect(
        screen.queryByLabelText("Search branches"),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));

    await waitFor(() =>
      expect(commandMocks.saveProjectSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          largeFileCheck: { enabled: true, thresholdMb: 75 },
          localChangesViewMode: "flat",
          repositoryPath: "/repo/art",
          sidebar: expect.objectContaining({
            branchesCollapsed: false,
            widthPx: 360,
          }),
        }),
      ),
    );
  });

  it("serializes rapid project preference saves and keeps the newest layout", async () => {
    let resolveFirst!: (value: unknown) => void;
    commandMocks.saveProjectSettings
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce((request) =>
        Promise.resolve({
          largeFileCheck: request.largeFileCheck,
          localChangesViewMode: request.localChangesViewMode,
          path: request.repositoryPath,
          sidebar: request.sidebar,
        }),
      );

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    await screen.findByLabelText("Search branches");
    await screen.findByText("Ready");
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    fireEvent.click(screen.getByRole("button", { name: "Stashes" }));

    await waitFor(() =>
      expect(commandMocks.saveProjectSettings).toHaveBeenCalledTimes(1),
    );
    await act(async () =>
      resolveFirst({
        largeFileCheck: { enabled: true, thresholdMb: 50 },
        localChangesViewMode: "flat",
        path: "/repo/art",
        sidebar: {
          branchSectionRatioPercent: 60,
          branchesCollapsed: true,
          stashesCollapsed: false,
          widthPx: 280,
        },
      }),
    );

    await waitFor(() =>
      expect(commandMocks.saveProjectSettings).toHaveBeenCalledTimes(2),
    );
    expect(commandMocks.saveProjectSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sidebar: expect.objectContaining({
          branchesCollapsed: true,
          stashesCollapsed: true,
        }),
      }),
    );
  });

  it("refetches local changes when opening the local changes tab", async () => {
    let resolveRefresh: ((value: LocalChangesResponse) => void) | undefined;
    commandMocks.listLocalChanges
      .mockResolvedValueOnce({
        changes: [
          createLocalChange({
            changeKind: "added",
            fileKind: "text",
            indexStatus: "?",
            newPath: "cached-local.txt",
            newText: "cached\n",
            worktreeStatus: "?",
          }),
        ],
        renormalizeSuggestion: null,
      })
      .mockImplementationOnce(
        () =>
          new Promise<LocalChangesResponse>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() =>
      expect(commandMocks.listLocalChanges).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );

    await waitFor(() =>
      expect(commandMocks.listLocalChanges).toHaveBeenCalledTimes(2),
    );
    expect(screen.getAllByText("cached-local.txt")).not.toHaveLength(0);
    expect(
      screen.queryByText("Loading local changes..."),
    ).not.toBeInTheDocument();

    resolveRefresh?.({
      changes: [
        createLocalChange({
          changeKind: "added",
          fileKind: "text",
          indexStatus: "?",
          newPath: "fresh-local.txt",
          newText: "fresh\n",
          worktreeStatus: "?",
        }),
      ],
      renormalizeSuggestion: null,
    });
    expect(await screen.findAllByText("fresh-local.txt")).not.toHaveLength(0);
  });

  it("previews renormalization from the large local changes prompt", async () => {
    commandMocks.listLocalChanges.mockResolvedValue({
      changes: [
        createLocalChange({
          changeKind: "modified",
          fileKind: "text",
          indexStatus: " ",
          newPath: "src/renormalized.ts",
          newText: "const value = 2;\n",
          oldText: "const value = 1;\n",
          worktreeStatus: "M",
        }),
      ],
      renormalizeSuggestion: {
        modifiedChanges: 1_000,
        samplePaths: ["src/renormalized.ts"],
        threshold: 1_000,
        totalChanges: 1_200,
      },
    });
    commandMocks.previewRenormalize.mockResolvedValueOnce({
      samplePaths: ["src/renormalized.ts"],
      totalPaths: 1,
      truncated: false,
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );
    expect(
      await screen.findByText("Many files changed unexpectedly"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Review affected files" }),
    );

    await waitFor(() =>
      expect(commandMocks.previewRenormalize).toHaveBeenCalledWith({
        repositoryPath: "/repo/art",
        sampleLimit: 8,
      }),
    );
    expect(
      await screen.findByText("Affected files: 1. src/renormalized.ts"),
    ).toBeInTheDocument();
  });
});

describe("RepositoryShell stash flow", () => {
  it("creates a stash for all local changes by default", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openStashDialog();

    const stashNameInput = within(dialog).getByLabelText(
      "Stash name",
    ) as HTMLInputElement;
    expect(stashNameInput.value).toMatch(/^Stash at /);
    expect(
      within(dialog).getByRole("radio", { name: /All local changes/ }),
    ).toBeChecked();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create stash" }),
    );

    await waitFor(() => expect(commandMocks.createStash).toHaveBeenCalled());
    expect(commandMocks.createStash).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntracked: true,
        operationId: expect.stringMatching(/^create-stash-/),
        paths: [],
        repositoryPath: "/repo/art",
      }),
    );
    expect(await screen.findByTestId("app-toast")).toHaveTextContent(
      "Stash created.",
    );
  });

  it("creates a stash for only checked files when selected", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openStashDialog();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: /Only checked files/ }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create stash" }),
    );

    await waitFor(() => expect(commandMocks.createStash).toHaveBeenCalled());
    expect(commandMocks.createStash).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntracked: true,
        operationId: expect.stringMatching(/^create-stash-/),
        paths: ["src/app.ts"],
        repositoryPath: "/repo/art",
      }),
    );
  });

  it("applies a stash without dropping it", async () => {
    commandMocks.listStashes.mockResolvedValue({
      stashes: [
        stashEntry({
          message: "WIP material polish",
          selector: "stash@{0}",
        }),
      ],
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: "Apply stash" }));

    await waitFor(() => expect(commandMocks.restoreStash).toHaveBeenCalled());
    expect(commandMocks.restoreStash).toHaveBeenCalledWith({
      dropOnSuccess: false,
      operationId: expect.stringMatching(/^restore-stash-/),
      operationName: null,
      repositoryPath: "/repo/art",
      selector: "stash@{0}",
    });
    expect(await screen.findByTestId("app-toast")).toHaveTextContent(
      "Stash applied. The saved copy is still available.",
    );
  });

  it("reports when no changes remain to create a stash", async () => {
    commandMocks.createStash.mockResolvedValueOnce({
      created: false,
      stash: null,
      stdout: "No local changes to save",
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openStashDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create stash" }),
    );

    expect(await screen.findByTestId("app-toast")).toHaveTextContent(
      "There are no changes left to stash.",
    );
    expect(dialog).not.toBeInTheDocument();
  });

  it("labels stash detail loading separately from stash updates", async () => {
    const pendingDetails = createPendingResponse({
      entry: stashEntry({
        message: "WIP material polish",
        selector: "stash@{0}",
      }),
      files: [],
    });
    commandMocks.listStashes.mockResolvedValue({
      stashes: [
        stashEntry({
          message: "WIP material polish",
          selector: "stash@{0}",
        }),
      ],
    });
    commandMocks.stashDetails.mockReturnValueOnce(pendingDetails.promise);
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: /WIP material polish/ }),
    );

    const dialog = screen.getByRole("dialog", { name: "WIP material polish" });
    expect(within(dialog).getByText("Loading stash details...")).toBeVisible();
    expect(
      within(dialog).getAllByRole("button", { name: "Close" }),
    ).not.toHaveLength(0);
    for (const closeButton of within(dialog).getAllByRole("button", {
      name: "Close",
    })) {
      expect(closeButton).toBeEnabled();
    }
    expect(screen.queryByText("Updating stash...")).not.toBeInTheDocument();
    await act(async () => pendingDetails.resolve());
    expect(dialog).toBeVisible();
  });

  it("requires confirmation before deleting a stash", async () => {
    const pendingDelete = createPendingResponse({
      deletedSelector: "stash@{0}",
      stdout: "",
    });
    commandMocks.deleteStash.mockReturnValueOnce(pendingDelete.promise);
    commandMocks.listStashes.mockResolvedValue({
      stashes: [
        stashEntry({
          message: "WIP material polish",
          selector: "stash@{0}",
        }),
      ],
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete stash" }),
    );
    expect(commandMocks.deleteStash).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", { name: "Delete stash?" });
    expect(dialog).toHaveTextContent(
      "Delete stash “WIP material polish”? This cannot be undone.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete stash" }),
    );

    await waitFor(() => expect(commandMocks.deleteStash).toHaveBeenCalled());
    expect(
      within(dialog).getByRole("button", { name: "Delete stash" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(dialog).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Deleting stash...",
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    expect(commandMocks.deleteStash).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^delete-stash-/),
      repositoryPath: "/repo/art",
      selector: "stash@{0}",
    });

    await act(async () => {
      pendingDelete.resolve();
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("shows stash details with creation time, files, diff, and Auto Stash origin", async () => {
    commandMocks.listStashes.mockResolvedValue({
      stashes: [
        stashEntry({
          isAutoStash: true,
          message: "Auto Stash: switch branch",
          origin: "switch branch",
          selector: "stash@{0}",
        }),
      ],
    });
    commandMocks.stashDetails.mockResolvedValue({
      entry: stashEntry({
        createdAtUnixSeconds: "1767268800",
        isAutoStash: true,
        message: "Auto Stash: switch branch",
        origin: "switch branch",
        selector: "stash@{0}",
      }),
      files: [
        {
          changeKind: "modified",
          oldPath: null,
          path: "src/app.ts",
        },
      ],
    });
    commandMocks.stashFileDetail.mockResolvedValue({
      diff: {
        kind: "text",
        language: null,
        newText: "new",
        oldText: "old",
      },
      file: {
        changeKind: "modified",
        oldPath: null,
        path: "src/app.ts",
      },
      payload: {
        changeKind: "modified",
        fileKind: "text",
        lfsLock: null,
        metadata: {},
        newPath: "src/app.ts",
        oldPath: null,
      },
      selector: "stash@{0}",
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Automatically saved changes: switching branches/,
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Automatically saved changes: switching branches",
    });
    await within(dialog).findByText("src/app.ts");
    expect(dialog).toHaveTextContent(
      "Created automatically for switching branches.",
    );
    expect(dialog).not.toHaveTextContent("Auto Stash: switch branch");
    expect(dialog).toHaveTextContent("Created");
    expect(await within(dialog).findByText(/2026/)).toBeVisible();
    expect(dialog).toHaveTextContent("src/app.ts");
    expect(dialog).toHaveTextContent("Modified");
    expect(dialog).toHaveClass("h-[min(44rem,calc(100vh-3rem))]");
    expect(within(dialog).getByTestId("stash-detail-layout")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-hidden",
    );
    expect(within(dialog).getByTestId("stash-detail-diff-pane")).toHaveClass(
      "min-h-0",
      "overflow-hidden",
    );
    const viewer = await within(dialog).findByLabelText("File comparison");
    expect(viewer).toHaveAttribute("data-diff-source", "stashDetails");
    expect(within(viewer).getByText("old")).toBeVisible();
    expect(within(viewer).getByText("new")).toBeVisible();
    expect(dialog).not.toHaveTextContent("diff --git");
    expect(commandMocks.stashDetails).toHaveBeenCalledWith({
      repositoryPath: "/repo/art",
      selector: "stashoid",
    });
    expect(commandMocks.stashFileDetail).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^stash-file-detail-/),
      path: "src/app.ts",
      repositoryPath: "/repo/art",
      selector: "stashoid",
    });
  });

  it("keeps its height while switching visual stash diffs and reuses cached previews", async () => {
    const entry = stashEntry({
      message: "Two file stash",
      selector: "stash@{0}",
    });
    commandMocks.listStashes.mockResolvedValue({ stashes: [entry] });
    commandMocks.stashDetails.mockResolvedValue({
      entry,
      files: ["src/first.ts", "assets/second.png"].map((path) => ({
        changeKind: "modified" as const,
        oldPath: null,
        path,
      })),
    });
    commandMocks.stashFileDetail.mockImplementation(async (request) => {
      const image = request.path === "assets/second.png";
      return {
        diff: image
          ? {
              kind: "image" as const,
              newImage: {
                alt: "new stash image",
                height: 1,
                mimeType: "image/png",
                sizeBytes: 1,
                src: "data:image/png;base64,",
                width: 1,
              },
              oldImage: {
                alt: "old stash image",
                height: 1,
                mimeType: "image/png",
                sizeBytes: 1,
                src: "data:image/png;base64,",
                width: 1,
              },
            }
          : {
              kind: "text" as const,
              language: "ts",
              newText: "new stash content",
              oldText: "old stash content",
            },
        file: {
          changeKind: "modified" as const,
          oldPath: null,
          path: request.path,
        },
        payload: {
          changeKind: "modified" as const,
          fileKind: image ? ("image" as const) : ("text" as const),
          lfsLock: null,
          metadata: {},
          newPath: request.path,
          oldPath: null,
        },
        selector: request.selector,
      };
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Two file stash/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Two file stash",
    });
    const first = await within(dialog).findByRole("button", {
      name: /src\/first\.ts/,
    });
    const second = within(dialog).getByRole("button", {
      name: /assets\/second\.png/,
    });
    await waitFor(() =>
      expect(commandMocks.stashFileDetail).toHaveBeenCalledTimes(1),
    );
    const fixedDialogClassName = dialog.className;

    fireEvent.click(second);
    await waitFor(() =>
      expect(commandMocks.stashFileDetail).toHaveBeenCalledTimes(2),
    );
    expect(
      await within(dialog).findByRole("button", {
        name: "Toggle linked image views",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByAltText("old stash image")).toBeVisible();
    expect(within(dialog).getByAltText("new stash image")).toBeVisible();
    expect(dialog.className).toBe(fixedDialogClassName);
    fireEvent.click(first);
    await waitFor(() => expect(first).toHaveAttribute("aria-pressed", "true"));
    expect(commandMocks.stashFileDetail).toHaveBeenCalledTimes(2);
    expect(dialog.className).toBe(fixedDialogClassName);
  });

  it("keeps large stash detail file lists on bounded pages", async () => {
    commandMocks.listStashes.mockResolvedValue({
      stashes: [stashEntry({ message: "Large stash", selector: "stash@{0}" })],
    });
    commandMocks.stashDetails.mockResolvedValue({
      entry: stashEntry({ message: "Large stash", selector: "stash@{0}" }),
      files: Array.from({ length: 205 }, (_, index) => ({
        changeKind: "modified" as const,
        oldPath: null,
        path: `generated/file-${index}.txt`,
      })),
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: /Large stash/ }));
    const dialog = await screen.findByRole("dialog");

    expect(
      await within(dialog).findAllByTestId("stash-detail-file"),
    ).toHaveLength(200);
    expect(within(dialog).getByText("Page 1 of 2")).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Next stash files page" }),
    );

    expect(within(dialog).getAllByTestId("stash-detail-file")).toHaveLength(5);
    expect(
      within(dialog).getByText("generated/file-200.txt"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Page 2 of 2")).toBeInTheDocument();
  });
});

describe("RepositoryShell review mode", () => {
  it("reports review recovery check failures with their original details", async () => {
    const recoveryError = new Error("review marker could not be read");
    commandMocks.reviewModeRecovery.mockRejectedValueOnce(recoveryError);
    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() => expect(handleError).toHaveBeenCalledTimes(1));
    expect((handleError.mock.calls[0]![0] as CustomEvent).detail).toBe(
      recoveryError,
    );
    window.removeEventListener("artistic-git:error", handleError);
  });

  it("starts review mode, blocks the shell, syncs remote updates, and exits", async () => {
    const pendingSync = createPendingResponse({
      state: reviewModeState({
        hasRemoteUpdate: false,
        subject: "Remote sync",
      }),
    });
    const pendingExit = createPendingResponse({
      conflict: null,
      repositoryPath: "/repo/art",
      stashRecovery: null,
      status: "applied" as const,
    });
    commandMocks.syncReviewMode.mockReturnValueOnce(pendingSync.promise);
    commandMocks.exitReviewMode.mockReturnValueOnce(pendingExit.promise);
    renderWithProviders(
      <>
        <RepositoryShell repositoryPath="/repo/art" />
        <NavigationLockProbe />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Review Mode" }));

    const overlay = await screen.findByRole("dialog", { name: "Review mode" });
    expect(commandMocks.startReviewMode).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^review-start-/),
      repositoryPath: "/repo/art",
    });
    expect(overlay).toHaveTextContent("Branch main");
    expect(overlay).toHaveTextContent("Latest remote work");
    expect(overlay).toHaveTextContent("New remote content is available.");
    expect(within(overlay).getByText("abc123456789")).toHaveClass(
      "select-text",
    );
    expect(screen.getByRole("button", { name: "Review Mode" })).toBeDisabled();
    expect(overlay).toHaveFocus();
    expect(screen.getByTestId("navigation-lock")).toHaveTextContent("locked");
    expect(commandMocks.setWindowCloseGuard).toHaveBeenCalledWith({
      active: true,
    });

    const syncButton = within(overlay).getByRole("button", { name: "Sync" });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(syncButton).toHaveFocus();
    screen.getByRole("button", { name: "Review Mode" }).focus();
    expect(syncButton).toHaveFocus();

    fireEvent.click(syncButton);

    await waitFor(() => expect(commandMocks.syncReviewMode).toHaveBeenCalled());
    expect(
      within(overlay).getByRole("button", { name: "Syncing review mode..." }),
    ).toBeDisabled();
    expect(
      within(overlay).getByRole("button", { name: "Exit review mode" }),
    ).toBeDisabled();
    expect(commandMocks.syncReviewMode).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^review-sync-/),
      repositoryPath: "/repo/art",
    });
    await act(async () => pendingSync.resolve());
    expect(await screen.findByText("Remote sync")).toBeInTheDocument();

    fireEvent.click(
      within(overlay).getByRole("button", { name: "Exit review mode" }),
    );

    await waitFor(() => expect(commandMocks.exitReviewMode).toHaveBeenCalled());
    expect(
      within(overlay).getByRole("button", { name: "Exiting..." }),
    ).toBeDisabled();
    expect(commandMocks.exitReviewMode).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^review-exit-/),
      repositoryPath: "/repo/art",
    });
    await act(async () => pendingExit.resolve());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Review mode" }),
      ).not.toBeInTheDocument(),
    );
    expect(commandMocks.setWindowCloseGuard).toHaveBeenLastCalledWith({
      active: false,
    });
    expect(screen.getByTestId("navigation-lock")).toHaveTextContent("unlocked");
    expect(screen.getByRole("button", { name: "Review Mode" })).toHaveFocus();
  });

  it("shows offline status inside review mode without dispatching a global error", async () => {
    commandMocks.startReviewMode.mockResolvedValueOnce({
      state: reviewModeState({
        hasRemoteUpdate: false,
        pullMessage: "could not resolve host",
        pullStatus: "offline",
      }),
    });
    const errorListener = vi.fn();
    window.addEventListener("artistic-git:error", errorListener);

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review Mode" }));

    const overlay = await screen.findByRole("dialog", { name: "Review mode" });
    expect(overlay).toHaveTextContent("Latest remote work");
    const tooltip = screen
      .getByText("Technical details: could not resolve host")
      .closest('[role="tooltip"]')!;
    expect(tooltip).toHaveTextContent(
      "Review mode is using local content because the remote could not be reached.",
    );
    expect(tooltip).toHaveTextContent(
      "Technical details: could not resolve host",
    );
    expect(errorListener).not.toHaveBeenCalled();

    window.removeEventListener("artistic-git:error", errorListener);
  });

  it("prompts to recover a previous review mode stash", async () => {
    const pendingRecovery = createPendingResponse({
      conflict: null,
      repositoryPath: "/repo/art",
      stashRecovery: null,
      status: "applied",
    });
    commandMocks.recoverReviewModeStash.mockReturnValueOnce(
      pendingRecovery.promise,
    );
    commandMocks.reviewModeRecovery.mockResolvedValueOnce({
      autoStash: stashEntry({
        isAutoStash: true,
        message: "Auto Stash: review mode",
        origin: "review mode",
        selector: "stash@{0}",
      }),
      repositoryPath: "/repo/art",
      shouldPrompt: true,
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await screen.findByRole("dialog", {
      name: "Restore review mode changes?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restore changes" }),
    );

    await waitFor(() =>
      expect(commandMocks.recoverReviewModeStash).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^review-recover-/),
        repositoryPath: "/repo/art",
      }),
    );
    expect(
      within(dialog).getByRole("button", { name: "Restore changes" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(dialog).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Restoring review mode changes...",
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).toBeInTheDocument();

    await act(async () => {
      pendingRecovery.resolve();
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
});

describe("RepositoryShell close guard", () => {
  it("shows exact user-facing labels for every emitted write operation", async () => {
    const cases = [
      ["Creating branch", "Creating branch..."],
      ["Switching branch", "Switching branch..."],
      ["Deleting branch", "Deleting branch..."],
      ["Deleting safety backup", "Deleting safety backup..."],
      ["Creating stash", "Creating stash..."],
      ["Applying stash", "Applying stash..."],
      ["Deleting stash", "Deleting stash..."],
      ["Applying conflict selection", "Applying selection..."],
    ] as const;
    const operations = cases.map(([label], index) => ({
      cancellable: false,
      label,
      operationId: `operation-label-${index}`,
      progress: { kind: "indeterminate" as const },
      repositoryPath: "/repo/art",
      windowLabel: null,
    }));
    renderWithProviders(
      <>
        <RepositoryShell repositoryPath="/repo/art" />
        <OperationLabelSwitcher operations={operations} />
      </>,
    );

    for (const [index, [, expectedLabel]] of cases.entries()) {
      fireEvent.click(
        screen.getByRole("button", { name: `operation-label-${index}` }),
      );
      expect(await screen.findByText(expectedLabel)).toBeVisible();
      expect(expectedLabel.endsWith("...")).toBe(true);
    }
  });

  it("passes the active write lock to history revert actions", async () => {
    commandMocks.logPage.mockResolvedValue({
      commits: [
        {
          authorEmail: "mira@example.test",
          authorName: "Mira Chen",
          authoredAtUnixSeconds: "1783488000",
          oid: "d4512aa7e8fb9ec3f93a545cb658f7de71f18291",
          parents: ["1111111111111111111111111111111111111111"],
          refs: ["HEAD -> main"],
          subject: "Blocked history revert",
        },
      ],
      nextAfter: null,
    });
    const activeOperation: OperationProgressEvent = {
      cancellable: true,
      label: "Syncing",
      operationId: "sync-blocks-revert",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      activeRepositoryPath: "/repo/art",
      operationsById: {
        [activeOperation.operationId]: activeOperation,
      },
    });

    const progress = screen.getByRole("progressbar");
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress.firstElementChild).toHaveClass("animate-pulse");
    expect(progress.firstElementChild).not.toHaveStyle({ width: "42%" });

    fireEvent.click(
      (await screen.findByText("Blocked history revert")).closest("button")!,
    );
    const revertButton = await screen.findByTestId("history-revert-open");
    expect(revertButton).toBeDisabled();
    fireEvent.click(revertButton);
    expect(commandMocks.revertCommit).not.toHaveBeenCalled();
  });

  it("offers one responsive cancel request for a running operation", async () => {
    const pendingCancel = createPendingResponse({ cancelled: false });
    commandMocks.cancelOperation.mockReturnValueOnce(pendingCancel.promise);
    const activeOperation: OperationProgressEvent = {
      cancellable: true,
      label: "sync",
      operationId: "sync-active",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      operationsById: {
        [activeOperation.operationId]: activeOperation,
      },
    });

    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButton);
    fireEvent.click(cancelButton);

    expect(commandMocks.cancelOperation).toHaveBeenCalledTimes(1);
    expect(commandMocks.cancelOperation).toHaveBeenCalledWith({
      operationId: "sync-active",
    });
    expect(cancelButton).toBeDisabled();
    expect(screen.getByText("Cancelling operation...")).toBeInTheDocument();

    await act(async () => {
      pendingCancel.resolve();
    });
    await waitFor(() => expect(cancelButton).toBeEnabled());
  });

  it("does not let a stale cancel response unlock the replacement operation", async () => {
    const pendingFirstCancel = createPendingResponse({ cancelled: false });
    const pendingSecondCancel = createPendingResponse({ cancelled: false });
    commandMocks.cancelOperation
      .mockReturnValueOnce(pendingFirstCancel.promise)
      .mockReturnValueOnce(pendingSecondCancel.promise);
    const firstOperation: OperationProgressEvent = {
      cancellable: true,
      label: "sync",
      operationId: "sync-first",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };
    const secondOperation: OperationProgressEvent = {
      ...firstOperation,
      operationId: "sync-second",
    };
    renderWithProviders(
      <>
        <RepositoryShell repositoryPath="/repo/art" />
        <OperationSwitcher operation={secondOperation} />
      </>,
      {
        operationsById: {
          [firstOperation.operationId]: firstOperation,
        },
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "switch operation" }));
    const replacementCancelButton = await screen.findByRole("button", {
      name: "Cancel",
    });
    await waitFor(() => expect(replacementCancelButton).toBeEnabled());
    fireEvent.click(replacementCancelButton);
    expect(commandMocks.cancelOperation).toHaveBeenCalledTimes(2);
    expect(replacementCancelButton).toBeDisabled();

    await act(async () => {
      pendingFirstCancel.resolve();
    });
    expect(replacementCancelButton).toBeDisabled();

    await act(async () => {
      pendingSecondCancel.resolve();
    });
    await waitFor(() => expect(replacementCancelButton).toBeEnabled());
  });

  it("guards non-cancellable active backend operations as wait-only", async () => {
    const errors: unknown[] = [];
    const handleError = (event: Event) => {
      errors.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener("artistic-git:error", handleError);
    const activeOperation: OperationProgressEvent = {
      cancellable: false,
      label: "sync",
      operationId: "sync-active",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };

    try {
      renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
        operationsById: {
          [activeOperation.operationId]: activeOperation,
        },
      });

      await waitFor(() =>
        expect(commandMocks.setWindowCloseGuard).toHaveBeenCalledWith({
          active: true,
        }),
      );

      await emitWindowCloseBlocked({ reason: "closeWindow" });
      const dialog = await screen.findByRole("dialog", {
        name: "Close window?",
      });
      expect(dialog).toHaveTextContent(
        "This operation cannot be safely canceled yet. Wait for it to finish, then close again.",
      );
      expect(
        within(dialog).queryByRole("button", { name: "Close and recover" }),
      ).not.toBeInTheDocument();

      fireEvent.click(
        within(dialog).getByRole("button", { name: "Keep waiting" }),
      );

      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Close window?" }),
        ).not.toBeInTheDocument(),
      );
      expect(errors).toHaveLength(0);
      expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("cancels a cancellable active backend operation before closing", async () => {
    const pendingCancel = createPendingResponse({ cancelled: true });
    commandMocks.cancelOperation.mockReturnValueOnce(pendingCancel.promise);
    const activeOperation: OperationProgressEvent = {
      cancellable: true,
      label: "sync",
      operationId: "sync-active",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      operationsById: {
        [activeOperation.operationId]: activeOperation,
      },
    });

    await emitWindowCloseBlocked({ reason: "closeWindow" });
    const dialog = await screen.findByRole("dialog", {
      name: "Close window?",
    });
    expect(dialog).toHaveTextContent(
      "An operation is in progress. Closing will cancel it and restore the pre-operation state.",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close and recover" }),
    );

    await waitFor(() =>
      expect(commandMocks.cancelOperation).toHaveBeenCalledWith({
        operationId: "sync-active",
      }),
    );
    expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();

    await act(async () => {
      pendingCancel.resolve();
    });
    expect(commandMocks.setWindowCloseGuard).toHaveBeenLastCalledWith({
      active: false,
    });
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it("keeps the window open and cancels pending app quit when cancel_operation fails", async () => {
    const errors: unknown[] = [];
    const handleError = (event: Event) => {
      errors.push((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener("artistic-git:error", handleError);
    commandMocks.cancelOperation.mockResolvedValueOnce({ cancelled: false });
    const activeOperation: OperationProgressEvent = {
      cancellable: true,
      label: "sync",
      operationId: "sync-active",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };

    try {
      renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
        operationsById: {
          [activeOperation.operationId]: activeOperation,
        },
      });

      await emitWindowCloseBlocked({ reason: "quit" });
      fireEvent.click(
        within(
          await screen.findByRole("dialog", { name: "Close window?" }),
        ).getByRole("button", { name: "Close and recover" }),
      );

      await waitFor(() =>
        expect(commandMocks.cancelOperation).toHaveBeenCalledWith({
          operationId: "sync-active",
        }),
      );
      await waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toEqual(
        new Error(
          "This operation cannot be safely canceled yet. Wait for it to finish, then close again.",
        ),
      );
      expect(commandMocks.cancelPendingWindowExit).toHaveBeenCalledTimes(1);
      expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();
      expect(commandMocks.setWindowCloseGuard).not.toHaveBeenLastCalledWith({
        active: false,
      });
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("cancels pending app quit when an active backend operation must keep waiting", async () => {
    const activeOperation: OperationProgressEvent = {
      cancellable: false,
      label: "sync",
      operationId: "sync-active",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      operationsById: {
        [activeOperation.operationId]: activeOperation,
      },
    });

    await emitWindowCloseBlocked({ reason: "quit" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Keep waiting" }),
    );

    expect(commandMocks.cancelPendingWindowExit).toHaveBeenCalledTimes(1);
    expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();
  });

  it("ignores backend operations owned by another repository and window when closing", async () => {
    const otherOperation: OperationProgressEvent = {
      cancellable: false,
      label: "sync",
      operationId: "sync-other",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/other",
      windowLabel: "repo-2",
    };
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      operationsById: {
        [otherOperation.operationId]: otherOperation,
      },
      windowLabel: "repo-1",
    });

    await waitFor(() =>
      expect(commandMocks.setWindowCloseGuard).toHaveBeenCalledWith({
        active: false,
      }),
    );

    await emitWindowCloseBlocked({ reason: "closeWindow" });

    await waitFor(() =>
      expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByRole("dialog", { name: "Close window?" }),
    ).not.toBeInTheDocument();
  });

  it("cancels unresolved conflicts before closing the guarded window", async () => {
    const conflict = createConflictEvent();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      conflictsByRepository: {
        "/repo/art": conflict,
      },
    });

    await waitFor(() =>
      expect(commandMocks.setWindowCloseGuard).toHaveBeenCalledWith({
        active: true,
      }),
    );

    await emitWindowCloseBlocked({ reason: "closeWindow" });

    const dialog = await screen.findByRole("dialog", {
      name: "Close window?",
    });
    expect(dialog).toHaveTextContent(
      "An operation is in progress. Closing will cancel it and restore the pre-operation state.",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close and recover" }),
    );

    await waitFor(() =>
      expect(commandMocks.cancelConflictResolution).toHaveBeenCalledWith({
        operationId: "commit-conflict-test",
        repositoryPath: "/repo/art",
      }),
    );
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it("cancels unresolved conflicts before completing a pending app quit", async () => {
    const conflict = createConflictEvent();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      conflictsByRepository: {
        "/repo/art": conflict,
      },
    });

    await emitWindowCloseBlocked({ reason: "quit" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Close and recover" }),
    );

    await waitFor(() =>
      expect(commandMocks.cancelConflictResolution).toHaveBeenCalledWith({
        operationId: "commit-conflict-test",
        repositoryPath: "/repo/art",
      }),
    );
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1);
    expect(commandMocks.cancelPendingWindowExit).not.toHaveBeenCalled();
  });

  it("cancels stash restore recovery before closing the guarded window", async () => {
    const conflict = createConflictEvent();
    const recovery = {
      headOid: "abc1234",
      id: "recovery-1",
      stashOid: null,
      stashSelector: null,
    };
    commandMocks.listStashes.mockResolvedValue({
      stashes: [
        stashEntry({
          message: "WIP material polish",
          selector: "stash@{0}",
        }),
      ],
    });
    commandMocks.restoreStash.mockResolvedValueOnce({
      oid: "stashoid",
      outcome: { status: "conflicts", conflict },
      recovery,
      selector: "stash@{0}",
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: "Apply stash" }));
    await waitFor(() =>
      expect(commandMocks.restoreStash).toHaveBeenCalledWith({
        dropOnSuccess: false,
        operationId: expect.stringMatching(/^restore-stash-/),
        operationName: null,
        repositoryPath: "/repo/art",
        selector: "stash@{0}",
      }),
    );

    await emitWindowCloseBlocked({ reason: "closeWindow" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Close and recover" }),
    );

    await waitFor(() =>
      expect(commandMocks.cancelStashRestore).toHaveBeenCalledWith({
        recovery,
        repositoryPath: "/repo/art",
      }),
    );
    expect(commandMocks.cancelConflictResolution).not.toHaveBeenCalled();
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it("exits review mode before closing the guarded window", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review Mode" }));
    await screen.findByRole("dialog", { name: "Review mode" });

    await emitWindowCloseBlocked({ reason: "closeWindow" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Close and recover" }),
    );

    await waitFor(() =>
      expect(commandMocks.exitReviewMode).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^review-exit-/),
        repositoryPath: "/repo/art",
      }),
    );
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1);
  });

  it("exits review mode before completing a pending app quit", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review Mode" }));
    await screen.findByRole("dialog", { name: "Review mode" });

    await emitWindowCloseBlocked({ reason: "quit" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Close and recover" }),
    );

    await waitFor(() =>
      expect(commandMocks.exitReviewMode).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^review-exit-/),
        repositoryPath: "/repo/art",
      }),
    );
    expect(commandMocks.closeCurrentWindow).toHaveBeenCalledTimes(1);
    expect(commandMocks.cancelPendingWindowExit).not.toHaveBeenCalled();
  });

  it("cancels pending app quit when a guarded close prompt is dismissed", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review Mode" }));
    await screen.findByRole("dialog", { name: "Review mode" });

    await emitWindowCloseBlocked({ reason: "quit" });
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Close window?" }),
      ).getByRole("button", { name: "Cancel" }),
    );

    expect(commandMocks.cancelPendingWindowExit).toHaveBeenCalledTimes(1);
    expect(commandMocks.closeCurrentWindow).not.toHaveBeenCalled();
  });
});

describe("RepositoryShell branch flow", () => {
  it("uses an explicit in-progress label for an active sync operation", async () => {
    const activeOperation: OperationProgressEvent = {
      cancellable: false,
      label: "Syncing",
      operationId: "sync-label-test",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      operationsById: {
        [activeOperation.operationId]: activeOperation,
      },
      windowLabel: "repo-1",
    });

    const header = screen
      .getByTestId("repository-shell")
      .querySelector("section > header");
    expect(header).not.toBeNull();
    expect(
      await within(header as HTMLElement).findByText("Syncing..."),
    ).toBeInTheDocument();
  });

  it("keeps repository controls responsive during a background fetch", async () => {
    commandMocks.fetchRepository.mockReturnValueOnce(
      new Promise(() => undefined),
    );

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText("Refreshing...")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Review Mode" }),
    ).toBeEnabled();
  });

  it("keeps an explicit sync status ahead of background refresh state", async () => {
    commandMocks.fetchRepository.mockReturnValueOnce(
      new Promise(() => undefined),
    );
    commandMocks.syncAllBranches.mockReturnValueOnce(
      new Promise(() => undefined),
    );

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(await screen.findByText("Refreshing...")).toBeInTheDocument();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sync" }))[0]!,
    );

    expect(await screen.findByText("Syncing...")).toBeInTheDocument();
  });

  it("keeps the last remote failure in the main status", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:fetch-state", {
          detail: {
            lastSuccessAt: "1760000000",
            message: "could not resolve host",
            repositoryPath: "/repo/art",
            state: "failed",
          },
        }),
      );
    });

    const header = screen
      .getByTestId("repository-shell")
      .querySelector("section > header");
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement).getByText("Last remote check failed"),
    ).toBeVisible();
    expect(within(header as HTMLElement).queryByText("Ready")).toBeNull();
  });

  it("keeps later background fetch failures authoritative without opening an error dialog", async () => {
    const fetchError = {
      operation: "fetchRepository",
      stderr: "authentication failed",
      summary: "Remote authentication failed",
    };
    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);

    try {
      renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
      await waitFor(() =>
        expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1),
      );
      await screen.findByText("Ready");
      commandMocks.fetchRepository.mockRejectedValueOnce(fetchError);

      window.dispatchEvent(new Event("focus"));

      expect(await screen.findByText("Last remote check failed")).toBeVisible();
      expect(handleError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("clears an old remote failure after an explicit sync succeeds", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:fetch-state", {
          detail: {
            lastSuccessAt: "1760000000",
            message: "could not resolve host",
            repositoryPath: "/repo/art",
            state: "failed",
          },
        }),
      );
    });
    expect(screen.getByText("Last remote check failed")).toBeVisible();

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sync" }))[0]!,
    );
    await waitFor(() =>
      expect(commandMocks.syncAllBranches).toHaveBeenCalledTimes(1),
    );
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:fetch-state", {
          detail: {
            lastSuccessAt: "1760000100",
            message: null,
            repositoryPath: "/repo/art",
            state: "idle",
          },
        }),
      );
    });

    expect(await screen.findByText("Ready")).toBeVisible();
    expect(
      screen.queryByText("Last remote check failed"),
    ).not.toBeInTheDocument();
  });

  it("waits for an in-flight background fetch before reverting", async () => {
    const pendingFetch = createPendingResponse({
      event: {
        lastSuccessAt: "1760000000",
        message: null,
        repositoryPath: "/repo/art",
        state: "idle" as const,
      },
      skipped: false,
    });
    commandMocks.fetchRepository.mockReturnValueOnce(pendingFetch.promise);
    commandMocks.listBranches.mockResolvedValue({
      branches: [
        branchSummary({
          current: true,
          existence: "localAndRemote",
          headOid: "abc1234",
          shortName: "main",
        }),
      ],
    });
    commandMocks.logPage.mockResolvedValue({
      commits: [
        {
          authorEmail: "mira@example.test",
          authorName: "Mira Chen",
          authoredAtUnixSeconds: "1783488000",
          oid: "d4512aa7e8fb9ec3f93a545cb658f7de71f18291",
          parents: ["1111111111111111111111111111111111111111"],
          refs: ["HEAD -> main"],
          subject: "Wait for remote refresh",
        },
      ],
      nextAfter: null,
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      activeRepositoryPath: "/repo/art",
    });
    fireEvent.click(
      (await screen.findByText("Wait for remote refresh")).closest("button")!,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Revert commit" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Revert this commit?" }),
      ).getByRole("button", { name: "Revert commit" }),
    );

    expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1);
    expect(commandMocks.revertCommit).not.toHaveBeenCalled();

    await act(async () => pendingFetch.resolve());
    await waitFor(() => expect(commandMocks.revertCommit).toHaveBeenCalled());
    expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1);
  });

  it("fetches when the repository opens and when the window regains focus", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1),
    );

    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(2),
    );
  });

  it("does not fetch on open or focus when automatic fetching is disabled", async () => {
    const settings = {
      ...defaultAppSettings,
      git: { ...defaultAppSettings.git, autoFetch: false },
    };
    commandMocks.settingsSnapshot.mockResolvedValue({
      appVersion: "0.2.5",
      identitySourcesError: null,
      settings,
      sshKeyError: null,
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
      appSettings: settings,
    });

    await screen.findByText("Ready");
    expect(commandMocks.fetchRepository).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);
    expect(commandMocks.fetchRepository).not.toHaveBeenCalled();
  });

  it("does not start automatic fetch while a write operation is running", async () => {
    commandMocks.fetchRepository.mockResolvedValue({
      event: {
        lastSuccessAt: "1760000000",
        message: null,
        repositoryPath: "/repo/art",
        state: "idle" as const,
      },
      skipped: false,
    });
    commandMocks.syncAllBranches.mockReturnValueOnce(
      new Promise(() => undefined),
    );

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sync" }))[0]!,
    );
    expect(await screen.findByText("Syncing...")).toBeInTheDocument();
    expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);

    expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1);
  });

  it("hides sync entrances and pending branch badges when the repository has no remote", async () => {
    commandMocks.repositorySummary.mockResolvedValue({
      currentBranch: "main",
      hasOrigin: false,
      headOid: "abc1234",
      inProgress: false,
      isDetached: false,
      isUnborn: false,
      remoteMode: "noRemote",
      repositoryPath: "/repo/art",
    });
    commandMocks.listBranches.mockResolvedValueOnce({
      branches: [
        branchSummary({
          ahead: 2,
          current: true,
          existence: "localOnly",
          headOid: "abc1234",
          shortName: "main",
        }),
      ],
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(
      (await screen.findAllByText("No remote repository configured")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Sync" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("↑2")).not.toBeInTheDocument();
    expect(commandMocks.fetchRepository).not.toHaveBeenCalled();
  });

  it("explains when existing remotes are not connected for syncing", async () => {
    commandMocks.repositorySummary.mockResolvedValue({
      currentBranch: "main",
      details: {
        health: {
          head: { kind: "branch", name: "main", oid: "abc1234" },
          indexLock: null,
          middleStates: [],
        },
        remotes: [
          {
            isOrigin: false,
            managed: false,
            name: "upstream",
            url: "https://example.test/upstream.git",
          },
        ],
      },
      hasOrigin: false,
      headOid: "abc1234",
      inProgress: false,
      isDetached: false,
      isUnborn: false,
      remoteMode: "noRemote",
      repositoryPath: "/repo/art",
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(
      await screen.findByText(
        "Remote repositories were found, but none is connected as the primary remote for syncing.",
      ),
    ).toBeVisible();
    expect(
      await screen.findByText("Primary remote setup required"),
    ).toBeVisible();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("explains that additional remotes are not displayed or synced", async () => {
    commandMocks.repositorySummary.mockResolvedValue({
      currentBranch: "main",
      details: {
        health: {
          head: { kind: "branch", name: "main", oid: "abc1234" },
          indexLock: null,
          middleStates: [],
        },
        remotes: [
          {
            isOrigin: true,
            managed: true,
            name: "origin",
            url: "https://example.test/origin.git",
          },
          {
            isOrigin: false,
            managed: false,
            name: "upstream",
            url: "https://example.test/upstream.git",
          },
        ],
      },
      hasOrigin: true,
      headOid: "abc1234",
      inProgress: false,
      isDetached: false,
      isUnborn: false,
      remoteMode: "origin",
      repositoryPath: "/repo/art",
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    expect(
      await screen.findByText(
        "This app shows and syncs only the primary remote. Other remote repositories not shown or synced: 1.",
      ),
    ).toBeVisible();
    expect(
      await screen.findByText("Other remote repositories not managed: 1"),
    ).toBeVisible();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("validates and creates a branch from the selected base with remote creation", async () => {
    mockBranchList();
    commandMocks.validateBranchName.mockResolvedValueOnce({
      exists: false,
      message: null,
      name: "feature/new-art-pass",
      valid: true,
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCreateBranchDialog("main");
    const baseSelect = within(dialog).getByLabelText("Starting branch");
    expect(baseSelect).toHaveValue("main");
    chooseBranch("Starting branch", "concept-pass");
    expect(baseSelect).toHaveValue("concept-pass");
    expect(dialog).toHaveTextContent(
      "This branch exists only on the remote. A local copy will be created automatically.",
    );

    fireEvent.change(within(dialog).getByLabelText("Branch name"), {
      target: { value: "feature/new-art-pass" },
    });

    expect(
      await within(dialog).findByText("Branch name is available."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("checkbox", {
        name: "Switch to the new branch immediately",
      }),
    ).toBeChecked();
    const remoteCheckbox = within(dialog).getByRole("checkbox", {
      name: "Create remote branch during sync",
    });
    expect(remoteCheckbox).toBeChecked();
    expect(remoteCheckbox).toBeEnabled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create branch" }),
    );

    await waitFor(() => expect(commandMocks.createBranch).toHaveBeenCalled());
    expect(commandMocks.createBranch).toHaveBeenCalledWith({
      baseBranch: "concept-pass",
      checkoutImmediately: true,
      createRemote: true,
      localChangesMode: "autoStash",
      name: "feature/new-art-pass",
      operationId: expect.stringMatching(/^create-branch-/),
      repositoryPath: "/repo/art",
    });
  });

  it("hides the create-remote checkbox when there is no remote", async () => {
    commandMocks.repositorySummary.mockResolvedValueOnce({
      currentBranch: "main",
      hasOrigin: false,
      headOid: "abc1234",
      inProgress: false,
      isDetached: false,
      isUnborn: false,
      remoteMode: "noRemote",
      repositoryPath: "/repo/art",
    });
    mockBranchList();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCreateBranchDialog("main", {
      waitForRemoteReady: false,
    });

    expect(
      within(dialog).queryByRole("checkbox", {
        name: "Create remote branch during sync",
      }),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "invalid names",
      {
        exists: false,
        message: "fatal: invalid ref name reported by git",
        name: "bad name",
        valid: false,
      },
      "bad name",
      "Branch names cannot contain spaces.",
    ],
    [
      "duplicate names",
      {
        exists: true,
        message: null,
        name: "feature/lookdev",
        valid: false,
      },
      "feature/lookdev",
      "A branch with this name already exists.",
    ],
  ])(
    "keeps the create branch action disabled for %s",
    async (_label, validation, name, expectedMessage) => {
      mockBranchList();
      commandMocks.validateBranchName.mockResolvedValueOnce(validation);
      renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

      const dialog = await openCreateBranchDialog("main");
      fireEvent.change(within(dialog).getByLabelText("Branch name"), {
        target: { value: name },
      });

      expect(await within(dialog).findByText(expectedMessage)).toBeVisible();
      expect(
        within(dialog).getByRole("button", { name: "Create branch" }),
      ).toBeDisabled();
    },
  );

  it("shows progress while a branch name is being checked", async () => {
    mockBranchList();
    const pendingValidation = createPendingResponse({
      exists: false,
      message: null,
      name: "feature/slow-check",
      valid: true,
    });
    commandMocks.validateBranchName.mockReturnValueOnce(
      pendingValidation.promise,
    );
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCreateBranchDialog("main");
    fireEvent.change(within(dialog).getByLabelText("Branch name"), {
      target: { value: "feature/slow-check" },
    });

    expect(
      await within(dialog).findByText("Checking branch name..."),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Create branch" }),
    ).toBeDisabled();

    await act(async () => pendingValidation.resolve());
    expect(
      await within(dialog).findByText("Branch name is available."),
    ).toBeVisible();
  });

  it("keeps branch validation diagnostics out of ordinary form copy", async () => {
    mockBranchList();
    const validationError = new Error("git check-ref-format crashed");
    commandMocks.validateBranchName.mockRejectedValueOnce(validationError);
    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCreateBranchDialog("main");
    fireEvent.change(within(dialog).getByLabelText("Branch name"), {
      target: { value: "feature/check-failed" },
    });

    expect(
      await within(dialog).findByText("Enter a valid branch name."),
    ).toBeVisible();
    expect(
      within(dialog).queryByText("git check-ref-format crashed"),
    ).not.toBeInTheDocument();
    expect(handleError).toHaveBeenCalledTimes(1);
    expect((handleError.mock.calls[0]![0] as CustomEvent).detail).toBe(
      validationError,
    );
    window.removeEventListener("artistic-git:error", handleError);
  });

  it("switches branches with the selected local-change handling mode", async () => {
    mockBranchList();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCheckoutBranchDialog("feature/lookdev");

    expect(
      within(dialog).getByRole("radio", {
        name: /Keep changes on the new branch/,
      }),
    ).toBeChecked();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: /Discard local changes/ }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Switch branch" }),
    );

    await waitFor(() => expect(commandMocks.checkoutBranch).toHaveBeenCalled());
    expect(commandMocks.checkoutBranch).toHaveBeenCalledWith({
      branchName: "feature/lookdev",
      localChangesMode: "discard",
      operationId: expect.stringMatching(/^checkout-branch-/),
      repositoryPath: "/repo/art",
    });
  });

  it("keeps checked local-change files after switching branches", async () => {
    mockBranchList();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Local Changes/ }),
    );
    await screen.findAllByText("src/app.ts");
    fireEvent.click(screen.getByLabelText("Select or deselect src/app.ts"));

    const checkoutDialog = await openCheckoutBranchDialog("feature/lookdev");
    fireEvent.click(
      within(checkoutDialog).getByRole("button", { name: "Switch branch" }),
    );
    await waitFor(() => expect(commandMocks.checkoutBranch).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Local Changes/ }));
    const commitButton = screen.getByRole("button", { name: "Commit" });
    await waitFor(() => expect(commitButton).toBeEnabled());
    fireEvent.click(commitButton);
    const commitDialog = screen.getByRole("dialog", {
      name: "Commit changes",
    });
    fireEvent.change(within(commitDialog).getByLabelText("Commit message"), {
      target: { value: "Commit selected after switch" },
    });
    fireEvent.click(
      within(commitDialog).getByRole("button", { name: "Commit" }),
    );

    await waitFor(() => expect(commandMocks.commitChanges).toHaveBeenCalled());
    expect(commandMocks.commitChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["src/app.ts"],
      }),
    );
  });

  it("protects the current branch and warns before deleting an unmerged local branch", async () => {
    mockBranchList();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.contextMenu(await findSidebarText("main"));
    expect(
      screen.getByRole("menuitem", { name: "Delete branch" }),
    ).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });

    const dialog = await openDeleteBranchDialog("feature/lookdev");
    expect(dialog).toHaveTextContent(
      "Unmerged commits: 2. Deleting the branch will lose them.",
    );
    const remoteCheckbox = within(dialog).getByRole("checkbox", {
      name: "Delete remote branch",
    });
    expect(remoteCheckbox).not.toBeChecked();
    expect(remoteCheckbox).toBeEnabled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete branch" }),
    );

    await waitFor(() => expect(commandMocks.deleteBranch).toHaveBeenCalled());
    expect(commandMocks.deleteBranch).toHaveBeenCalledWith({
      branchName: "feature/lookdev",
      deleteRemote: false,
      forceRemoteOnly: false,
      operationId: expect.stringMatching(/^delete-branch-/),
      repositoryPath: "/repo/art",
    });
  });

  it("can request remote deletion for a local branch", async () => {
    mockBranchList();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openDeleteBranchDialog("feature/lookdev");
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Delete remote branch" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete branch" }),
    );

    await waitFor(() => expect(commandMocks.deleteBranch).toHaveBeenCalled());
    expect(commandMocks.deleteBranch).toHaveBeenCalledWith({
      branchName: "feature/lookdev",
      deleteRemote: true,
      forceRemoteOnly: false,
      operationId: expect.stringMatching(/^delete-branch-/),
      repositoryPath: "/repo/art",
    });
  });

  it("requires remote deletion for remote-only branches", async () => {
    mockBranchList();
    commandMocks.deleteBranch.mockResolvedValueOnce({
      branchName: "concept-pass",
      repositoryPath: "/repo/art",
      status: "completed",
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openDeleteBranchDialog("concept-pass");
    const remoteCheckbox = within(dialog).getByRole("checkbox", {
      name: "Delete remote branch",
    });
    expect(remoteCheckbox).toBeChecked();
    expect(remoteCheckbox).toBeDisabled();
    expect(dialog).toHaveTextContent(
      "This is a remote-only branch, so the remote deletion choice is required and cannot be changed here.",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete branch" }),
    );

    await waitFor(() => expect(commandMocks.deleteBranch).toHaveBeenCalled());
    expect(commandMocks.deleteBranch).toHaveBeenCalledWith({
      branchName: "concept-pass",
      deleteRemote: true,
      forceRemoteOnly: true,
      operationId: expect.stringMatching(/^delete-branch-/),
      repositoryPath: "/repo/art",
    });
  });

  it("batch syncs tracked branches from the project sync button", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    mockBranchList();
    commandMocks.syncAllBranches.mockResolvedValueOnce({
      allUpToDate: false,
      autoTracking: [
        {
          conflict: null,
          message: null,
          sourceBranch: "release",
          stashRecovery: null,
          status: "applied",
          targetBranch: "main",
        },
      ],
      branches: [
        {
          attempts: 1,
          branchName: "main",
          conflict: null,
          message: null,
          remoteHistoryChange: null,
          repositoryPath: "/repo/art",
          status: "pulled",
          stashRecovery: null,
          upstream: "origin/main",
        },
      ],
      conflict: null,
      remoteHistoryChange: null,
      repositoryPath: "/repo/art",
      stashRecovery: null,
    });
    try {
      renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

      const syncButtons = await screen.findAllByRole("button", {
        name: "Sync",
      });
      fireEvent.click(syncButtons[0]);

      await waitFor(() =>
        expect(commandMocks.syncAllBranches).toHaveBeenCalledWith({
          operationId: expect.stringMatching(/^sync-all-/),
          repositoryPath: "/repo/art",
        }),
      );
      const toast = await screen.findByTestId("app-toast");
      expect(toast).toHaveTextContent(
        "Sync complete: 2 synced, 0 up to date, 0 need attention, 0 failed.",
      );

      const header = screen
        .getByTestId("repository-shell")
        .querySelector("section > header");
      expect(header).not.toBeNull();
      await waitFor(() =>
        expect(within(header as HTMLElement).getByText("Ready")).toBeVisible(),
      );
      expect(
        within(header as HTMLElement).queryByText(
          "Sync complete: 2 synced, 0 up to date, 0 need attention, 0 failed.",
        ),
      ).not.toBeInTheDocument();

      const toastTimer = timeoutSpy.mock.calls
        .filter(
          ([, delay]) =>
            typeof delay === "number" && delay >= 5_000 && delay <= 12_000,
        )
        .at(-1);
      expect(toastTimer).toBeDefined();
      await act(async () => {
        (toastTimer?.[0] as () => void)();
      });
      expect(screen.queryByTestId("app-toast")).not.toBeInTheDocument();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("keeps batch sync feedback bounded for thousands of branches", async () => {
    mockBranchList();
    commandMocks.syncAllBranches.mockResolvedValueOnce({
      allUpToDate: false,
      autoTracking: [],
      branches: Array.from({ length: 5_000 }, (_, index) => ({
        attempts: 1,
        branchName: `generated/branch-${index}`,
        conflict: null,
        message: null,
        remoteHistoryChange: null,
        repositoryPath: "/repo/art",
        stashRecovery: null,
        status:
          index % 2 === 0 ? ("pulled" as const) : ("alreadyUpToDate" as const),
        upstream: `origin/generated/branch-${index}`,
      })),
      conflict: null,
      remoteHistoryChange: null,
      repositoryPath: "/repo/art",
      stashRecovery: null,
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sync" }))[0]!,
    );

    const toast = await screen.findByTestId("app-toast");
    expect(toast).toHaveTextContent(
      "Sync complete: 2500 synced, 2500 up to date, 0 need attention, 0 failed.",
    );
    expect(toast.textContent?.length).toBeLessThan(200);
    expect(toast).not.toHaveTextContent("generated/branch-");
  });

  it("summarizes batch sync failures and attention items", async () => {
    mockBranchList();
    commandMocks.syncAllBranches.mockResolvedValueOnce({
      allUpToDate: false,
      autoTracking: [
        {
          conflict: null,
          message: "Target branch was deleted.",
          sourceBranch: "stable",
          stashRecovery: null,
          status: "invalid",
          targetBranch: "release",
        },
      ],
      branches: [
        {
          attempts: 1,
          branchName: "main",
          conflict: null,
          message: null,
          remoteHistoryChange: null,
          repositoryPath: "/repo/art",
          status: "pulled",
          stashRecovery: null,
          upstream: "origin/main",
        },
        {
          attempts: 1,
          branchName: "feature/oops",
          conflict: null,
          message: "Needs manual cleanup.",
          remoteHistoryChange: null,
          repositoryPath: "/repo/art",
          status: "failed",
          stashRecovery: null,
          upstream: null,
        },
      ],
      conflict: null,
      remoteHistoryChange: null,
      repositoryPath: "/repo/art",
      stashRecovery: null,
    });
    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const syncButtons = await screen.findAllByRole("button", {
      name: "Sync",
    });
    fireEvent.click(syncButtons[0]);

    expect(
      await screen.findByText(
        "Sync complete: 1 synced, 0 up to date, 1 need attention, 1 failed.",
      ),
    ).toBeInTheDocument();
    expect(handleError).toHaveBeenCalledTimes(1);
    const detail = (handleError.mock.calls[0]![0] as CustomEvent).detail;
    expect(detail.summary).toBe(
      "Some synchronization tasks could not be completed.",
    );
    expect(detail.response.branches[1].message).toBe("Needs manual cleanup.");
    expect(detail.response.autoTracking[0].message).toBe(
      "Target branch was deleted.",
    );
    window.removeEventListener("artistic-git:error", handleError);
  });

  it("reports an up-to-date project in a toast without changing the sync action", async () => {
    mockBranchList();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const syncButtons = await screen.findAllByRole("button", {
      name: "Sync",
    });
    fireEvent.click(syncButtons[0]);

    await waitFor(() =>
      expect(commandMocks.syncAllBranches).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^sync-all-/),
        repositoryPath: "/repo/art",
      }),
    );
    const toast = await screen.findByTestId("app-toast");
    expect(toast).toHaveTextContent("All syncable branches are up to date");
    expect(screen.getByTestId("repository-sync-all")).toHaveAccessibleName(
      "Sync",
    );
    fireEvent.click(within(toast).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("app-toast")).not.toBeInTheDocument();
  });

  it("syncs only the selected branch from a branch row action", async () => {
    commandMocks.syncBranch.mockResolvedValueOnce({
      attempts: 1,
      branchName: "feature/lookdev",
      conflict: null,
      message: null,
      remoteHistoryChange: null,
      repositoryPath: "/repo/art",
      status: "alreadyUpToDate",
      stashRecovery: null,
      upstream: "origin/feature/lookdev",
    });
    commandMocks.listBranches.mockResolvedValue({
      branches: [
        branchSummary({
          current: true,
          existence: "localAndRemote",
          headOid: "abc1234",
          shortName: "main",
        }),
        branchSummary({
          ahead: 2,
          existence: "localAndRemote",
          headOid: "def5678",
          shortName: "feature/lookdev",
        }),
      ],
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const branchLabel = await findSidebarText("feature/lookdev");
    const branchRow = branchLabel.closest("li");
    expect(branchRow).not.toBeNull();
    fireEvent.click(
      within(branchRow as HTMLElement).getByRole("button", { name: "Sync" }),
    );

    await waitFor(() =>
      expect(commandMocks.syncBranch).toHaveBeenCalledWith({
        branchName: "feature/lookdev",
        operationId: expect.stringMatching(/^sync-branch-/),
        repositoryPath: "/repo/art",
      }),
    );
    const toast = await screen.findByTestId("app-toast");
    expect(toast).toHaveTextContent("feature/lookdev: up to date");
    expect(
      within(branchRow as HTMLElement).getByRole("button", { name: "Sync" }),
    ).toBeInTheDocument();
    expect(commandMocks.syncAllBranches).not.toHaveBeenCalled();
  });

  it("allows a local-only branch row sync to publish the branch", async () => {
    commandMocks.syncBranch.mockResolvedValueOnce({
      attempts: 1,
      branchName: "feature/unpublished",
      conflict: null,
      message: null,
      remoteHistoryChange: null,
      repositoryPath: "/repo/art",
      status: "published",
      stashRecovery: null,
      upstream: null,
    });
    commandMocks.listBranches.mockResolvedValue({
      branches: [
        branchSummary({
          current: true,
          existence: "localAndRemote",
          headOid: "abc1234",
          shortName: "main",
        }),
        branchSummary({
          existence: "localOnly",
          headOid: "def5678",
          shortName: "feature/unpublished",
        }),
      ],
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const branchLabel = await findSidebarText("feature/unpublished");
    const branchRow = branchLabel.closest("li");
    expect(branchRow).not.toBeNull();
    fireEvent.click(
      within(branchRow as HTMLElement).getByRole("button", { name: "Sync" }),
    );

    await waitFor(() =>
      expect(commandMocks.syncBranch).toHaveBeenCalledWith({
        branchName: "feature/unpublished",
        operationId: expect.stringMatching(/^sync-branch-/),
        repositoryPath: "/repo/art",
      }),
    );
    expect(
      await screen.findByText("feature/unpublished: published"),
    ).toBeInTheDocument();
  });

  it("prompts before accepting rewritten remote history and resets through the dedicated command", async () => {
    mockBranchList();
    commandMocks.syncAllBranches.mockResolvedValueOnce({
      allUpToDate: false,
      autoTracking: [],
      branches: [
        {
          attempts: 1,
          branchName: "main",
          conflict: null,
          remoteHistoryChange: {
            branchName: "main",
            localHead: "localabcdef1234567890",
            previousRemoteHead: "localabcdef1234567890",
            remoteHead: "remoteabcdef1234567890",
            upstream: "origin/main",
          },
          repositoryPath: "/repo/art",
          status: "remoteHistoryChanged",
          stashRecovery: null,
          upstream: "origin/main",
        },
      ],
      conflict: null,
      remoteHistoryChange: {
        branchName: "main",
        localHead: "localabcdef1234567890",
        previousRemoteHead: "localabcdef1234567890",
        remoteHead: "remoteabcdef1234567890",
        upstream: "origin/main",
      },
      repositoryPath: "/repo/art",
      stashRecovery: null,
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const syncButtons = await screen.findAllByRole("button", {
      name: "Sync",
    });
    fireEvent.click(syncButtons[0]);

    const dialog = await screen.findByRole("dialog", {
      name: "Remote history changed",
    });
    expect(dialog).toHaveTextContent(
      "Some commits you previously pushed are no longer there.",
    );
    expect(dialog).toHaveTextContent("localab");
    expect(dialog).toHaveTextContent("remotea");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use remote version" }),
    );

    await waitFor(() =>
      expect(commandMocks.acceptRemoteHistory).toHaveBeenCalledWith({
        branchName: "main",
        operationId: expect.stringMatching(/^accept-remote-history-/),
        repositoryPath: "/repo/art",
      }),
    );
  });

  it("opens safety backups and deletes one only after confirmation", async () => {
    const pendingDelete = createPendingResponse({
      backupBranch: "backup/feature/lookdev-1760000000000",
      repositoryPath: "/repo/art",
    });
    commandMocks.deleteSafetyBackup.mockReturnValueOnce(pendingDelete.promise);
    mockBranchList();
    commandMocks.listSafetyBackups
      .mockResolvedValueOnce({
        backups: [
          safetyBackupSummary({
            name: "backup/feature/lookdev-1760000000000",
            originalBranch: "feature/lookdev",
          }),
          safetyBackupSummary({
            createdAtUnixMillis: null,
            name: "backup/manual-ref",
            originalBranch: null,
            refName: "refs/heads/backup/manual-ref",
          }),
        ],
      })
      .mockResolvedValueOnce({ backups: [] });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Safety backups" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Safety backups",
    });
    expect(dialog).toHaveTextContent("feature/lookdev");
    expect(dialog).toHaveTextContent("refs/heads/backup/manual-ref");

    fireEvent.click(
      within(dialog).getAllByRole("button", {
        name: "Delete safety backup",
      })[0],
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Delete safety backup?",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Delete safety backup" }),
    );

    await waitFor(() =>
      expect(commandMocks.deleteSafetyBackup).toHaveBeenCalledWith({
        backupBranch: "backup/feature/lookdev-1760000000000",
        operationId: expect.stringMatching(/^delete-safety-backup-/),
        repositoryPath: "/repo/art",
      }),
    );
    expect(
      within(confirm).getByRole("button", { name: "Delete safety backup" }),
    ).toBeDisabled();
    expect(
      within(confirm).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(confirm).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(within(confirm).getByRole("status")).toHaveTextContent(
      "Deleting safety backup...",
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(confirm).toBeInTheDocument();

    await act(async () => {
      pendingDelete.resolve();
    });
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
  });

  it("keeps large safety backup lists on bounded pages", async () => {
    mockBranchList();
    commandMocks.listSafetyBackups.mockResolvedValue({
      backups: Array.from({ length: 105 }, (_, index) =>
        safetyBackupSummary({
          name: `backup/main-${index}`,
          refName: `refs/heads/backup/main-${index}`,
        }),
      ),
      truncated: true,
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Safety backups" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Safety backups",
    });

    expect(within(dialog).getAllByTestId("safety-backup-row")).toHaveLength(
      100,
    );
    expect(dialog).toHaveTextContent("Showing the latest 105 safety backups.");
    expect(within(dialog).getByText("Page 1 of 2")).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Next safety backups page",
      }),
    );

    expect(within(dialog).getAllByTestId("safety-backup-row")).toHaveLength(5);
    expect(within(dialog).getByText("Page 2 of 2")).toBeInTheDocument();
  });
});

describe("RepositoryShell commit flow", () => {
  it.each([
    ["Cmd+Enter", "metaKey"],
    ["Ctrl+Enter", "ctrlKey"],
  ] as const)(
    "shows the push state and commits checked files with %s",
    async (_label, modifier) => {
      renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

      const dialog = await openCommitDialog();

      expect(
        within(dialog).getByText("Files to commit: 2."),
      ).toBeInTheDocument();
      const pushCheckbox = within(dialog).getByRole("checkbox", {
        name: "Push immediately",
      });
      expect(pushCheckbox).toBeChecked();

      fireEvent.click(pushCheckbox);
      expect(pushCheckbox).not.toBeChecked();

      const messageInput = within(dialog).getByLabelText(
        "Commit message",
      ) as HTMLTextAreaElement;
      fireEvent.change(messageInput, {
        target: { value: "Update assets" },
      });
      fireEvent.keyDown(messageInput, {
        key: "Enter",
        ...(modifier === "metaKey" ? { metaKey: true } : { ctrlKey: true }),
      });

      await waitFor(() =>
        expect(commandMocks.commitChanges).toHaveBeenCalled(),
      );
      expect(commandMocks.commitChanges).toHaveBeenCalledWith({
        disableRepositoryGpgsign: false,
        largeFileDecision: "prompt",
        largeFileThresholdMb: null,
        message: "Update assets",
        operationId: expect.stringMatching(/^commit-changes-/),
        paths: ["src/app.ts", "assets/texture.png"],
        pushImmediately: false,
        repositoryPath: "/repo/art",
      });
      expect(await screen.findByTestId("app-toast")).toHaveTextContent(
        "Commit created.",
      );
      expect(
        screen.queryByRole("dialog", { name: "Commit changes" }),
      ).not.toBeInTheDocument();
    },
  );

  it("locks the commit form and dismissal controls while committing", async () => {
    const pendingCommit = createPendingResponse({
      committedPaths: ["src/app.ts", "assets/texture.png"],
      lfsTrackedPaths: [],
      oid: "pending1234567890",
      status: "committed" as const,
    });
    commandMocks.commitChanges.mockReturnValueOnce(pendingCommit.promise);
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCommitDialog();
    const messageInput = within(dialog).getByLabelText("Commit message");
    fireEvent.change(messageInput, { target: { value: "Pending commit" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(commandMocks.commitChanges).toHaveBeenCalled());
    expect(messageInput).toBeDisabled();
    expect(
      within(dialog).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).toBeInTheDocument();

    await act(async () => pendingCommit.resolve());
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("hides the push checkbox when the repository has no remote", async () => {
    commandMocks.repositorySummary.mockResolvedValueOnce({
      currentBranch: "main",
      hasOrigin: false,
      headOid: "abc1234",
      inProgress: false,
      isDetached: false,
      isUnborn: false,
      remoteMode: "noRemote",
      repositoryPath: "/repo/art",
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCommitDialog();

    expect(
      within(dialog).queryByRole("checkbox", { name: "Push immediately" }),
    ).not.toBeInTheDocument();
  });

  it("lets the commit command own pre-commit sync for a branch with an upstream", async () => {
    commandMocks.listBranches.mockResolvedValue({
      branches: [
        branchSummary({
          current: true,
          existence: "localAndRemote",
          headOid: "abc1234",
          shortName: "main",
        }),
      ],
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalled(),
    );
    commandMocks.fetchRepository.mockClear();

    const dialog = await openCommitDialog();
    fireEvent.change(within(dialog).getByLabelText("Commit message"), {
      target: { value: "Update assets" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(commandMocks.commitChanges).toHaveBeenCalled());
    expect(commandMocks.fetchRepository).not.toHaveBeenCalled();
    expect(commandMocks.commitChanges).toHaveBeenCalledWith(
      expect.objectContaining({ pushImmediately: true }),
    );
  });

  it("skips the pre-commit fetch when the current branch has no upstream", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);
    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalled(),
    );
    commandMocks.fetchRepository.mockClear();

    const dialog = await openCommitDialog();
    fireEvent.change(within(dialog).getByLabelText("Commit message"), {
      target: { value: "Update assets" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(commandMocks.commitChanges).toHaveBeenCalled());
    expect(commandMocks.fetchRepository).not.toHaveBeenCalled();
  });

  it("continues a large-file commit with LFS after the warning", async () => {
    commandMocks.commitChanges.mockResolvedValueOnce({
      largeFiles: Array.from({ length: 250 }, (_, index) => ({
        path:
          index === 0 ? "assets/texture.png" : `assets/texture-${index}.png`,
        sizeBytes: "52428801",
      })),
      status: "largeFilesNeedDecision",
      thresholdMb: 50,
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCommitDialog();
    fireEvent.change(within(dialog).getByLabelText("Commit message"), {
      target: { value: "Add texture" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));

    expect(
      await within(dialog).findByText(
        "Some files are larger than 50 MB and aren't managed by Git LFS.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getAllByTestId("large-file-warning-item"),
    ).toHaveLength(100);
    expect(
      within(dialog).getByText("Large file page 1 of 3"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Next large file page" }),
    );
    expect(
      within(dialog).getAllByTestId("large-file-warning-item"),
    ).toHaveLength(100);
    expect(within(dialog).getByText("assets/texture-100.png")).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Manage with Git LFS and continue",
      }),
    );

    await waitFor(() =>
      expect(commandMocks.commitChanges).toHaveBeenCalledTimes(2),
    );
    expect(commandMocks.commitChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({
        largeFileDecision: "trackWithLfs",
        paths: ["src/app.ts", "assets/texture.png"],
      }),
    );
  });

  it("offers to disable repository signing after a GPG failure", async () => {
    commandMocks.commitChanges.mockResolvedValueOnce({
      status: "gpgSignFailed",
      stderr: "gpg failed to sign the data",
      summary: "commit signing failed",
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCommitDialog();
    fireEvent.change(within(dialog).getByLabelText("Commit message"), {
      target: { value: "Signed change" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));

    expect(
      await within(dialog).findByText("commit signing failed"),
    ).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Disable signing for this repository and retry",
      }),
    );

    await waitFor(() =>
      expect(commandMocks.commitChanges).toHaveBeenCalledTimes(2),
    );
    expect(commandMocks.commitChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({
        disableRepositoryGpgsign: true,
        largeFileDecision: "prompt",
      }),
    );
  });

  it("opens conflict resolution and keeps the commit draft when commit sync conflicts", async () => {
    const conflict = createConflictEvent();
    commandMocks.commitChanges.mockResolvedValueOnce({
      conflict,
      recovery: null,
      status: "conflicts",
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCommitDialog();
    fireEvent.change(within(dialog).getByLabelText("Commit message"), {
      target: { value: "Update assets" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));

    expect(
      await screen.findByText("Commit paused for conflict resolution."),
    ).toBeInTheDocument();
    const conflictDialog = await screen.findByRole("dialog", {
      name: "Resolve conflicts",
    });
    expect(screen.getByDisplayValue("Update assets")).toBeInTheDocument();
    expect(commandMocks.commitChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["src/app.ts", "assets/texture.png"],
        pushImmediately: true,
      }),
    );

    fireEvent.click(
      within(conflictDialog).getByRole("button", { name: "Cancel" }),
    );
    const cancelDialog = await screen.findByRole("dialog", {
      name: "Cancel conflict resolution",
    });
    fireEvent.click(
      within(cancelDialog).getByRole("button", { name: "Abort operation" }),
    );

    expect(
      await screen.findByText(
        "Conflict resolution ended. Review the changes, then commit again.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Commit paused for conflict resolution."),
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Update assets")).toBeInTheDocument();
  });

  it("reports a cross-window conflict-clear broadcast failure with details", async () => {
    const conflict = createConflictEvent();
    const broadcastError = new Error("event transport unavailable");
    const handleError = vi.fn();
    appEventMocks.emitAppEvent.mockRejectedValueOnce(broadcastError);
    window.addEventListener("artistic-git:error", handleError);

    try {
      renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />, {
        conflictsByRepository: { "/repo/art": conflict },
      });

      const conflictDialog = await screen.findByRole("dialog", {
        name: "Resolve conflicts",
      });
      fireEvent.click(
        within(conflictDialog).getByRole("button", { name: "Cancel" }),
      );
      const cancelDialog = await screen.findByRole("dialog", {
        name: "Cancel conflict resolution",
      });
      fireEvent.click(
        within(cancelDialog).getByRole("button", { name: "Abort operation" }),
      );

      await waitFor(() =>
        expect(appEventMocks.emitAppEvent).toHaveBeenCalledWith(
          "conflict-cleared",
          { repositoryPath: "/repo/art" },
        ),
      );
      await waitFor(() => expect(handleError).toHaveBeenCalledTimes(1));
      expect((handleError.mock.calls[0][0] as CustomEvent).detail).toEqual({
        cause: broadcastError,
        operationName: "broadcastConflictCleared",
        repositoryPath: "/repo/art",
        summary:
          "Conflict resolution ended in this window, but other open windows could not be updated.",
      });
      expect(
        screen.queryByRole("dialog", { name: "Resolve conflicts" }),
      ).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });
});

describe("RepositoryShell restore flow", () => {
  it("warns that restore is irreversible before restoring an untracked file", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openRestoreDialog("assets/texture.png");

    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Artistic Git can't undo this action.",
    );
    expect(
      within(dialog).getAllByText(
        "Selected files: 1. Current copies will be moved to Trash before the Git versions are restored.",
      ).length,
    ).toBeGreaterThan(0);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restore changes" }),
    );

    await waitFor(() => expect(commandMocks.restoreChanges).toHaveBeenCalled());
    expect(commandMocks.restoreChanges).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^restore-changes-/),
      paths: ["assets/texture.png"],
      repositoryPath: "/repo/art",
    });
  });
});

async function openStashDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /Local Changes/ }));
  await screen.findAllByText("src/app.ts");

  fireEvent.contextMenu(screen.getAllByText("src/app.ts")[0]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Stash selected (1)" }));

  return screen.getByRole("dialog", { name: "Create stash" });
}

async function openCreateBranchDialog(
  baseBranchName: string,
  { waitForRemoteReady = true }: { waitForRemoteReady?: boolean } = {},
) {
  if (waitForRemoteReady) {
    await waitFor(() =>
      expect(
        screen.queryByText("No remote repository configured"),
      ).not.toBeInTheDocument(),
    );
  }
  fireEvent.contextMenu(await findSidebarText(baseBranchName));
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Create new branch from here" }),
  );

  return screen.getByRole("dialog", { name: "Create branch" });
}

async function openCheckoutBranchDialog(branchName: string) {
  fireEvent.contextMenu(await findSidebarText(branchName));
  fireEvent.click(screen.getByRole("menuitem", { name: "Switch branch" }));

  return screen.getByRole("dialog", { name: "Switch branch" });
}

async function openDeleteBranchDialog(branchName: string) {
  fireEvent.contextMenu(await findSidebarText(branchName));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete branch" }));

  return screen.getByRole("dialog", { name: "Delete branch?" });
}

async function openCommitDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /Local Changes/ }));
  await screen.findAllByText("src/app.ts");
  fireEvent.click(screen.getByLabelText("Select all"));
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));

  return screen.getByRole("dialog", { name: "Commit changes" });
}

async function openRestoreDialog(path: string) {
  fireEvent.click(await screen.findByRole("button", { name: /Local Changes/ }));
  await screen.findAllByText(path);

  fireEvent.contextMenu(screen.getAllByText(path)[0]);
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Restore selected (1)" }),
  );

  return screen.getByRole("dialog", { name: "Restore selected changes?" });
}

async function findSidebarText(text: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(
      screen.getAllByText(text).some((candidate) => candidate.closest("aside")),
    ).toBe(true);
  });
  const element = screen
    .getAllByText(text)
    .find((candidate) => candidate.closest("aside"));

  if (!element) {
    throw new Error(`Could not find sidebar text: ${text}`);
  }

  return element;
}

function chooseBranch(label: string, branch: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search branches" }), {
    target: { value: branch },
  });
  fireEvent.click(screen.getByRole("option", { name: branch }));
}

function mockBranchList() {
  commandMocks.listBranches.mockResolvedValue({
    branches: [
      branchSummary({
        current: true,
        existence: "localOnly",
        headOid: "abc1234",
        shortName: "main",
      }),
      branchSummary({
        ahead: 2,
        existence: "localOnly",
        headOid: "def5678",
        shortName: "feature/lookdev",
      }),
      branchSummary({
        behind: 1,
        existence: "remoteOnly",
        headOid: "789abcd",
        shortName: "concept-pass",
      }),
    ],
  });
}

function branchSummary({
  ahead = 0,
  behind = 0,
  current = false,
  existence,
  headOid,
  shortName,
}: {
  ahead?: number;
  behind?: number;
  current?: boolean;
  existence: "localOnly" | "remoteOnly" | "localAndRemote";
  headOid: string;
  shortName: string;
}) {
  return {
    ahead,
    behind,
    current,
    existence,
    headOid,
    latestCommitUnixSeconds: "1760000000",
    name:
      existence === "remoteOnly"
        ? `refs/remotes/origin/${shortName}`
        : `refs/heads/${shortName}`,
    shortName,
    upstream: existence === "localAndRemote" ? `origin/${shortName}` : null,
  };
}

function createPendingResponse<T>(response: T) {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  return {
    promise,
    resolve: () => settle(response),
  };
}

function safetyBackupSummary({
  createdAtUnixMillis = "1760000000000",
  headOid = "backupabcdef1234567890",
  name = "backup/main-1760000000000",
  originalBranch = "main",
  refName,
}: {
  createdAtUnixMillis?: string | null;
  headOid?: string | null;
  name?: string;
  originalBranch?: string | null;
  refName?: string;
} = {}) {
  return {
    createdAtUnixMillis,
    headOid,
    name,
    originalBranch,
    refName: refName ?? `refs/heads/${name}`,
  };
}

function stashEntry({
  createdAtUnixSeconds = "1760000000",
  isAutoStash = false,
  message,
  origin = null,
  selector,
}: {
  createdAtUnixSeconds?: string | null;
  isAutoStash?: boolean;
  message: string;
  origin?: string | null;
  selector: string;
}) {
  return {
    branch: "main",
    createdAtUnixSeconds,
    index: 0,
    isAutoStash,
    message,
    oid: "stashoid",
    origin,
    selector,
  };
}

function reviewModeState({
  hasRemoteUpdate = true,
  pullMessage = null,
  pullStatus = "pulled",
  subject = "Latest remote work",
}: {
  hasRemoteUpdate?: boolean;
  pullMessage?: string | null;
  pullStatus?: "pulled" | "offline" | "failed" | "alreadyUpToDate";
  subject?: string;
} = {}) {
  return {
    autoStash: stashEntry({
      isAutoStash: true,
      message: "Auto Stash: review mode",
      origin: "review mode",
      selector: "stash@{0}",
    }),
    branchName: "main",
    hasRemoteUpdate,
    headOid: "abc123456789",
    latestCommit: {
      authoredAtUnixSeconds: "1760000000",
      authorEmail: "artist@example.com",
      authorName: "Artist",
      oid: "abc123456789",
      parents: [],
      refs: [],
      subject,
    },
    pullMessage,
    pullStatus,
    repositoryPath: "/repo/art",
  };
}
