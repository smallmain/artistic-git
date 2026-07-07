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
  listBranches: vi.fn(),
  listConflicts: vi.fn(),
  listLocalChanges: vi.fn(),
  listStashes: vi.fn(),
  repositorySummary: vi.fn(),
  restoreChanges: vi.fn(),
  restoreStash: vi.fn(),
  revertCommit: vi.fn(),
  saveConflictResolution: vi.fn(),
  selectConflictSide: vi.fn(),
  settingsSnapshot: vi.fn(),
  stashDetails: vi.fn(),
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

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
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
      {
        changeKind: "modified",
        indexStatus: "M",
        oldPath: null,
        path: "src/app.ts",
        worktreeStatus: "M",
      },
      {
        changeKind: "added",
        indexStatus: "?",
        oldPath: null,
        path: "assets/texture.png",
        worktreeStatus: "?",
      },
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
      remoteMode: "none",
      repositoryPath: "/repo/art",
    });

    renderWithProviders(<RepositoryShell repositoryPath="/repo/art" />);

    const dialog = await openCommitDialog();

    expect(
      within(dialog).queryByRole("checkbox", { name: "Push immediately" }),
    ).not.toBeInTheDocument();
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
