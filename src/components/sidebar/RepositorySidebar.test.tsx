import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";

import {
  type BranchListItem,
  RepositorySidebar,
  type StashListItem,
} from "./RepositorySidebar";

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
});

afterEach(() => {
  cleanup();
});

describe("RepositorySidebar", () => {
  it("exposes branch callbacks from the context menu", () => {
    const onCheckoutBranch = vi.fn();
    const onCreateBranchFromBase = vi.fn();
    const onDeleteBranch = vi.fn();

    renderSidebar({
      onCheckoutBranch,
      onCreateBranchFromBase,
      onDeleteBranch,
    });

    fireEvent.contextMenu(screen.getByText("feature/lookdev"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Switch branch" }));
    expect(onCheckoutBranch).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature/lookdev" }),
    );

    fireEvent.contextMenu(screen.getByText("feature/lookdev"));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Create new branch from base",
      }),
    );
    expect(onCreateBranchFromBase).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature/lookdev" }),
    );

    fireEvent.contextMenu(screen.getByText("feature/lookdev"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete branch" }));
    expect(onDeleteBranch).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature/lookdev" }),
    );
  });

  it("keeps current and remote-only branch deletion disabled", () => {
    const onDeleteBranch = vi.fn();

    renderSidebar({ onDeleteBranch });

    fireEvent.contextMenu(screen.getByText("main"));
    expect(
      screen.getByRole("menuitem", { name: "Delete branch" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.contextMenu(screen.getByText("concept-pass"));
    expect(
      screen.getByRole("menuitem", { name: "Delete branch" }),
    ).toBeDisabled();
    expect(onDeleteBranch).not.toHaveBeenCalled();
  });
});

function renderSidebar({
  onCheckoutBranch,
  onCreateBranchFromBase,
  onDeleteBranch,
}: {
  onCheckoutBranch?: (branch: BranchListItem) => void;
  onCreateBranchFromBase?: (branch: BranchListItem) => void;
  onDeleteBranch?: (branch: BranchListItem) => void;
}) {
  return renderWithProviders(
    <RepositorySidebar
      branches={branches}
      busy={false}
      onBranchFocus={vi.fn()}
      onCheckoutBranch={onCheckoutBranch}
      onCreateBranchFromBase={onCreateBranchFromBase}
      onDeleteBranch={onDeleteBranch}
      repository={{
        branchName: "main",
        hasRemote: true,
        path: "/repo/art",
        projectName: "art",
      }}
      stashes={stashes}
    />,
  );
}

const branches: BranchListItem[] = [
  {
    ahead: 0,
    behind: 0,
    current: true,
    latestCommitId: "abc1234",
    name: "main",
  },
  {
    ahead: 1,
    behind: 0,
    latestCommitId: "def5678",
    name: "feature/lookdev",
  },
  {
    ahead: 0,
    behind: 0,
    latestCommitId: "789abcd",
    name: "concept-pass",
    remoteOnly: true,
  },
];

const stashes: StashListItem[] = [
  {
    id: "stash@{0}",
    name: "WIP",
    timeLabel: "2h",
  },
];
