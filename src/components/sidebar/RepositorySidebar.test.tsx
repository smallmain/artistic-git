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

  it("disables branch write actions when the repository has no commits", () => {
    const onCheckoutBranch = vi.fn();
    const onCreateBranchFromBase = vi.fn();
    const onDeleteBranch = vi.fn();

    renderSidebar({
      branchActionsDisabledReason:
        "Create the first commit before managing branches",
      onCheckoutBranch,
      onCreateBranchFromBase,
      onDeleteBranch,
    });

    fireEvent.contextMenu(screen.getByText("feature/lookdev"));

    expect(
      screen.getByRole("menuitem", { name: "Switch branch" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Create new branch from base" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Delete branch" }),
    ).toBeDisabled();
    expect(onCheckoutBranch).not.toHaveBeenCalled();
    expect(onCreateBranchFromBase).not.toHaveBeenCalled();
    expect(onDeleteBranch).not.toHaveBeenCalled();
  });

  it("exposes manual stash action callbacks", () => {
    const onApplyStash = vi.fn();
    const onDeleteStash = vi.fn();
    const onShowStashDetails = vi.fn();

    renderSidebar({
      onApplyStash,
      onDeleteStash,
      onShowStashDetails,
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply stash" }));
    expect(onApplyStash).toHaveBeenCalledWith(
      expect.objectContaining({ id: "stash@{0}" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete stash" }));
    expect(onDeleteStash).toHaveBeenCalledWith(
      expect.objectContaining({ id: "stash@{0}" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash details" }));
    expect(onShowStashDetails).toHaveBeenCalledWith(
      expect.objectContaining({ id: "stash@{0}" }),
    );
  });
});

function renderSidebar({
  branchActionsDisabledReason,
  onApplyStash,
  onCheckoutBranch,
  onCreateBranchFromBase,
  onDeleteBranch,
  onDeleteStash,
  onShowStashDetails,
}: {
  branchActionsDisabledReason?: string;
  onApplyStash?: (stash: StashListItem) => void;
  onCheckoutBranch?: (branch: BranchListItem) => void;
  onCreateBranchFromBase?: (branch: BranchListItem) => void;
  onDeleteBranch?: (branch: BranchListItem) => void;
  onDeleteStash?: (stash: StashListItem) => void;
  onShowStashDetails?: (stash: StashListItem) => void;
}) {
  return renderWithProviders(
    <RepositorySidebar
      branchActionsDisabledReason={branchActionsDisabledReason}
      branches={branches}
      busy={false}
      onApplyStash={onApplyStash}
      onBranchFocus={vi.fn()}
      onCheckoutBranch={onCheckoutBranch}
      onCreateBranchFromBase={onCreateBranchFromBase}
      onDeleteBranch={onDeleteBranch}
      onDeleteStash={onDeleteStash}
      onShowStashDetails={onShowStashDetails}
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
