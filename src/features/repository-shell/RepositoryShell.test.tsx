import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";
import type {
  ConflictEnteredEvent,
  DiffPayload,
  LocalChange,
} from "@/lib/ipc/generated";

import { RepositoryShell } from "./RepositoryShell";

const commandMocks = vi.hoisted(() => ({
  cancelConflictResolution: vi.fn(),
  cancelStashRestore: vi.fn(),
  checkoutBranch: vi.fn(),
  commitChanges: vi.fn(),
  completeConflictResolution: vi.fn(),
  conflictDetail: vi.fn(),
  createBranch: vi.fn(),
  createStash: vi.fn(),
  deleteBranch: vi.fn(),
  deleteStash: vi.fn(),
  dismissReviewModeRecovery: vi.fn(),
  exitReviewMode: vi.fn(),
  fetchRepository: vi.fn(),
  listBranches: vi.fn(),
  listConflicts: vi.fn(),
  listLocalChanges: vi.fn(),
  listStashes: vi.fn(),
  loadProjectSettings: vi.fn(),
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
  syncCurrentBranch: vi.fn(),
  syncReviewMode: vi.fn(),
  validateBranchName: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => commandMocks);

function renderWithProviders(ui: ReactElement) {
  return render(
    <AppProviders
      i18n={createI18n("en")}
      initialLanguagePreference="en"
      initialThemePreference="light"
      queryClient={createAppQueryClient()}
    >
      {ui}
    </AppProviders>,
  );
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
  });
  commandMocks.listStashes.mockResolvedValue({ stashes: [] });
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
    repositoryPath: "/repo/art",
    status: "alreadyUpToDate",
    stashRecovery: null,
    upstream: "origin/main",
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
      operationName: null,
      repositoryPath: "/repo/art",
      selector: "stash@{0}",
    });
  });

  it("requires confirmation before deleting a stash", async () => {
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
    expect(commandMocks.deleteStash).toHaveBeenCalledWith({
      repositoryPath: "/repo/art",
      selector: "stash@{0}",
    });
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
});

describe("RepositoryShell review mode", () => {
  it("starts review mode, blocks the shell, syncs remote updates, and exits", async () => {
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    fireEvent.click(await screen.findByRole("button", { name: "Review Mode" }));

    const overlay = await screen.findByRole("dialog", { name: "Review mode" });
    expect(commandMocks.startReviewMode).toHaveBeenCalledWith({
      operationId: null,
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
      repositoryPath: "/repo/art",
    });
    expect(await screen.findByText("Remote sync")).toBeInTheDocument();

    fireEvent.click(
      within(overlay).getByRole("button", { name: "Exit review mode" }),
    );

    await waitFor(() => expect(commandMocks.exitReviewMode).toHaveBeenCalled());
    expect(commandMocks.exitReviewMode).toHaveBeenCalledWith({
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
    expect(overlay).toHaveTextContent("could not resolve host");
    expect(errorListener).not.toHaveBeenCalled();

    window.removeEventListener("artistic-git:error", errorListener);
  });

  it("prompts to recover a previous review mode stash", async () => {
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
        repositoryPath: "/repo/art",
      }),
    );
  });
});

describe("RepositoryShell branch flow", () => {
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
    const baseSelect = within(dialog).getByLabelText("Base branch");
    expect(baseSelect).toHaveValue("main");
    fireEvent.change(baseSelect, { target: { value: "concept-pass" } });
    expect(baseSelect).toHaveValue("concept-pass");
    expect(dialog).toHaveTextContent(
      "Remote-only branch. Creating from it will create a local tracking branch.",
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
      operationId: null,
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
      within(dialog).getByRole("radio", { name: /Move changes with me/ }),
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
      operationId: null,
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
    fireEvent.click(screen.getByLabelText("Toggle src/app.ts"));

    const checkoutDialog = await openCheckoutBranchDialog("feature/lookdev");
    fireEvent.click(
      within(checkoutDialog).getByRole("button", { name: "Switch branch" }),
    );
    await waitFor(() => expect(commandMocks.checkoutBranch).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Local Changes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
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
      "Contains 2 unmerged commits; deleting it will lose them.",
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
      repositoryPath: "/repo/art",
    });
  });

  it("syncs the current branch from the project sync button", async () => {
    mockBranchList();
    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const syncButtons = await screen.findAllByRole("button", {
      name: "Sync",
    });
    fireEvent.click(syncButtons[0]);

    await waitFor(() =>
      expect(commandMocks.syncCurrentBranch).toHaveBeenCalledWith({
        operationId: null,
        repositoryPath: "/repo/art",
      }),
    );
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
        within(dialog).getByText("2 files will be committed."),
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
        "Files over 50 MB are not covered by LFS rules.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Track with LFS and continue",
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
      "This action cannot be undone.",
    );
    expect(
      within(dialog).getAllByText(
        "1 selected files will be restored after their current versions are moved to the system trash.",
      ).length,
    ).toBeGreaterThan(0);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restore changes" }),
    );

    await waitFor(() => expect(commandMocks.restoreChanges).toHaveBeenCalled());
    expect(commandMocks.restoreChanges).toHaveBeenCalledWith({
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
    screen.getByRole("menuitem", { name: "Create new branch from base" }),
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
