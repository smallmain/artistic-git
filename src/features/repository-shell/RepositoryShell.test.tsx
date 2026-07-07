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
  commandMocks.createStash.mockResolvedValue({
    created: true,
    stash: null,
    stdout: "",
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

async function openStashDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /Local Changes/ }));
  await screen.findAllByText("src/app.ts");

  fireEvent.contextMenu(screen.getAllByText("src/app.ts")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Stash selected (1)" }));

  return screen.getByRole("dialog", { name: "Create stash" });
}
