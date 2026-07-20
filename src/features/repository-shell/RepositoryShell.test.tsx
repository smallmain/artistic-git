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
import type {
  ConflictEnteredEvent,
  DiffPayload,
  LocalChange,
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
  localChangeDetail: vi.fn(),
  listSafetyBackups: vi.fn(),
  listStashes: vi.fn(),
  logPage: vi.fn(),
  loadProjectSettings: vi.fn(),
  previewRenormalize: vi.fn(),
  repositorySummary: vi.fn(),
  restoreChanges: vi.fn(),
  restoreStash: vi.fn(),
  recoverReviewModeStash: vi.fn(),
  saveProjectSettings: vi.fn(),
  reviewModeRecovery: vi.fn(),
  revertCommit: vi.fn(),
  saveWindowGeometry: vi.fn(),
  saveConflictResolution: vi.fn(),
  selectConflictSide: vi.fn(),
  setWindowCloseGuard: vi.fn(),
  settingsSnapshot: vi.fn(),
  stashDetails: vi.fn(),
  startReviewMode: vi.fn(),
  syncAllBranches: vi.fn(),
  syncBranch: vi.fn(),
  syncCurrentBranch: vi.fn(),
  syncReviewMode: vi.fn(),
  validateBranchName: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => commandMocks);

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
  vi.clearAllMocks();
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
  commandMocks.saveWindowGeometry.mockResolvedValue({});
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
    rawDiff: "",
  });
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
      expect(commandMocks.logPage).toHaveBeenCalled();
    });

    expect(screen.queryByText("feature/material-library")).toBeNull();
    expect(screen.queryByText("WIP material polish")).toBeNull();
    expect(screen.queryByText("Merge color pipeline preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Local Changes/ }));

    expect(screen.queryByText("src/preview/render-preview.ts")).toBeNull();
    expect(screen.queryByLabelText("File comparison")).toBeNull();
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
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
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
    expect(screen.getAllByText("deps/lib/art.ts").length).toBeGreaterThan(0);
    expect(
      screen.getByText("deps/lib/art.ts").closest("aside"),
    ).not.toHaveAttribute("inert");
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

    fireEvent.click(screen.getByText("second.ts"));

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

  it("refetches local changes when opening the local changes tab", async () => {
    commandMocks.listLocalChanges
      .mockResolvedValueOnce({
        changes: [],
        renormalizeSuggestion: null,
      })
      .mockResolvedValue({
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
          fileKind: "text",
          oldPath: null,
          patch: "@@ -1 +1 @@\n-old\n+new",
          path: "src/app.ts",
        },
      ],
      rawDiff: "diff --git a/src/app.ts b/src/app.ts\n+new",
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Stash details" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Auto Stash: switch branch",
    });
    expect(dialog).toHaveTextContent("Automatically created by switch branch.");
    expect(dialog).toHaveTextContent("Created");
    expect(dialog).toHaveTextContent("2026");
    expect(dialog).toHaveTextContent("src/app.ts");
    expect(dialog).toHaveTextContent("Modified");
    expect(dialog).toHaveTextContent("diff --git a/src/app.ts b/src/app.ts");
  });

  it("keeps large stash detail file lists on bounded pages", async () => {
    commandMocks.listStashes.mockResolvedValue({
      stashes: [stashEntry({ message: "Large stash", selector: "stash@{0}" })],
    });
    commandMocks.stashDetails.mockResolvedValue({
      entry: stashEntry({ message: "Large stash", selector: "stash@{0}" }),
      files: Array.from({ length: 205 }, (_, index) => ({
        changeKind: "modified" as const,
        fileKind: "text" as const,
        oldPath: null,
        patch: "",
        path: `generated/file-${index}.txt`,
      })),
      rawDiff: "",
    });
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Stash details" }),
    );
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getAllByTestId("stash-detail-file")).toHaveLength(
      200,
    );
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
  it("starts review mode, blocks the shell, syncs remote updates, and exits", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review Mode" }));

    const overlay = await screen.findByRole("dialog", { name: "Review mode" });
    expect(commandMocks.startReviewMode).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^review-start-/),
      repositoryPath: "/repo/art",
    });
    expect(overlay).toHaveTextContent("Branch main");
    expect(overlay).toHaveTextContent("Latest remote work");
    expect(overlay).toHaveTextContent("New remote content is available.");
    expect(screen.getByRole("button", { name: "Review Mode" })).toBeDisabled();
    expect(commandMocks.setWindowCloseGuard).toHaveBeenCalledWith({
      active: true,
    });

    fireEvent.click(within(overlay).getByRole("button", { name: "Sync" }));

    await waitFor(() => expect(commandMocks.syncReviewMode).toHaveBeenCalled());
    expect(commandMocks.syncReviewMode).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^review-sync-/),
      repositoryPath: "/repo/art",
    });
    expect(await screen.findByText("Remote sync")).toBeInTheDocument();

    fireEvent.click(
      within(overlay).getByRole("button", { name: "Exit review mode" }),
    );

    await waitFor(() => expect(commandMocks.exitReviewMode).toHaveBeenCalled());
    expect(commandMocks.exitReviewMode).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^review-exit-/),
      repositoryPath: "/repo/art",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Review mode" }),
      ).not.toBeInTheDocument(),
    );
    expect(commandMocks.setWindowCloseGuard).toHaveBeenLastCalledWith({
      active: false,
    });
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
    expect(
      screen.getByRole("tooltip", { name: "could not resolve host" }),
    ).toBeInTheDocument();
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
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).toBeInTheDocument();

    await act(async () => {
      pendingRecovery.resolve();
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
});

describe("RepositoryShell close guard", () => {
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
  it("keeps repository controls responsive during a background fetch", async () => {
    commandMocks.fetchRepository.mockReturnValueOnce(
      new Promise(() => undefined),
    );

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    await waitFor(() =>
      expect(commandMocks.fetchRepository).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByRole("button", { name: "Review Mode" }),
    ).toBeEnabled();
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

  it("hides sync entrances and pending branch badges when the repository has no remote", async () => {
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
        message: "Branch names cannot contain spaces.",
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
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

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
    expect(
      await screen.findByText(
        "main: synced · release updated from main: synced",
      ),
    ).toBeInTheDocument();
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
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const syncButtons = await screen.findAllByRole("button", {
      name: "Sync",
    });
    fireEvent.click(syncButtons[0]);

    expect(
      await screen.findByText(
        "main: synced · feature/oops: failed (Needs manual cleanup.) · stable updated from release: action needed (Target branch was deleted.)",
      ),
    ).toBeInTheDocument();
  });

  it("flashes the project sync button when all branches are already up to date", async () => {
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
    expect(
      await screen.findByRole("button", {
        name: "All syncable branches are up to date",
      }),
    ).toBeInTheDocument();
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
    expect(await screen.findAllByText("Branch is up to date")).not.toHaveLength(
      0,
    );
    expect(
      within(branchRow as HTMLElement).getByRole("button", {
        name: "Branch is up to date",
      }),
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
    },
  );

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
      largeFiles: [{ path: "assets/texture.png", sizeBytes: "52428801" }],
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
    expect(
      await screen.findByRole("dialog", { name: "Resolve conflicts" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Update assets")).toBeInTheDocument();
    expect(commandMocks.commitChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["src/app.ts", "assets/texture.png"],
        pushImmediately: true,
      }),
    );
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
  fireEvent.click(screen.getByRole("button", { name: "Stash selected (1)" }));

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
  fireEvent.click(screen.getByRole("button", { name: "Restore selected (1)" }));

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
