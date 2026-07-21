import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
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

function openExpandableSearch(label: string) {
  const existing = screen.queryByRole("textbox", { name: label });
  if (existing) {
    return existing;
  }
  fireEvent.click(screen.getByRole("button", { name: label }));
  return screen.getByRole("textbox", { name: label });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("RepositorySidebar", () => {
  it("keeps review mode and icon-only settings below the stash list", () => {
    const onShowSafetyBackups = vi.fn();
    renderSidebar({ onShowSafetyBackups });

    const reviewButton = screen.getByRole("button", { name: "Review Mode" });
    const settingsButton = screen.getByRole("button", {
      name: "Open settings",
    });
    const safetyBackupsButton = screen.getByRole("button", {
      name: "Safety backups",
    });
    const reviewArea = screen.getByTestId("sidebar-review-action");
    const settingsArea = screen.getByTestId("sidebar-settings-action");
    const stashSection = screen.getByRole("button", { name: "Stashes" });
    const sidebar = reviewArea.closest("aside")!;

    expect(reviewArea).not.toBe(settingsArea);
    expect(reviewArea).toContainElement(reviewButton);
    expect(settingsArea).toContainElement(settingsButton);
    expect(settingsArea).toContainElement(safetyBackupsButton);
    expect(reviewButton).toHaveClass(
      "w-full",
      "bg-review",
      "text-review-foreground",
    );
    expect(reviewButton.className).not.toMatch(/gradient/i);
    expect(reviewButton.querySelector("svg")).not.toBeNull();
    expect(settingsButton).toHaveClass("size-9");
    expect(settingsButton).not.toHaveTextContent("Settings");
    expect(safetyBackupsButton).toHaveClass("size-9");
    expect(safetyBackupsButton).not.toHaveTextContent("Safety backups");
    expect(
      settingsButton.compareDocumentPosition(safetyBackupsButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(reviewArea).toHaveClass("border-t");
    expect(settingsArea).toHaveClass("border-t");
    expect(
      sidebar.compareDocumentPosition(stashSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      stashSection.compareDocumentPosition(reviewArea) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      reviewArea.compareDocumentPosition(settingsArea) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(safetyBackupsButton);
    expect(onShowSafetyBackups).toHaveBeenCalledTimes(1);
  });

  it("constrains the repository path so long absolute paths truncate in the header", () => {
    renderSidebar({
      repositoryPath: "/Users/smallmain/Documents/Work/Peek/vscode",
    });

    const pathLabels = screen.getAllByText(
      "/Users/smallmain/Documents/Work/Peek/vscode",
    );
    const visiblePath = pathLabels.find(
      (node) => node.getAttribute("role") !== "tooltip",
    );

    expect(visiblePath).toBeDefined();
    expect(visiblePath).toHaveClass("truncate", "max-w-full", "min-w-0");
    expect(visiblePath?.parentElement).toHaveClass(
      "block",
      "w-full",
      "max-w-full",
      "min-w-0",
    );
    expect(visiblePath?.parentElement?.parentElement).toHaveClass(
      "min-w-0",
      "flex-1",
    );
  });

  it("renders branch and stash hover actions with an edge-fade background", () => {
    renderSidebar({});

    const branchActions = screen.getAllByTestId("branch-hover-actions")[0];
    const stashActions = screen.getAllByTestId("stash-hover-actions")[0];
    const branchButton = screen
      .getAllByTestId("branch-row")[0]
      .querySelector(":scope > button");
    const stashButton = screen
      .getAllByTestId("stash-row")[0]
      .querySelector(":scope > button");

    for (const actionGroup of [branchActions, stashActions]) {
      expect(actionGroup).toHaveClass(
        "hover-action-group-fade",
        "absolute",
        "right-1",
        "top-1/2",
        "hidden",
        "-translate-y-1/2",
        "items-center",
        "gap-0.5",
        "py-0.5",
        "pr-0.5",
        "pl-[22px]",
        "group-hover:flex",
        "group-focus-within:flex",
      );
      expect(actionGroup).not.toHaveClass(
        "rounded-md",
        "bg-background/80",
        "shadow-sm",
      );
      for (const actionButton of actionGroup.querySelectorAll("button")) {
        expect(actionButton).toHaveClass("size-7", "bg-card/40");
      }
    }

    expect(branchButton).toHaveClass(
      "group-hover:bg-accent",
      "group-focus-within:bg-accent",
    );
    expect(stashButton).toHaveClass(
      "group-hover:bg-accent",
      "group-focus-within:bg-accent",
    );

    expect(
      screen.queryByRole("button", { name: "More actions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stash details" }),
    ).not.toBeInTheDocument();
  });

  it("keeps branch and stash rows contiguous beneath overlay scrollbars", () => {
    renderSidebar({});

    const branchRows = screen.getAllByTestId("branch-row");
    const stashRows = screen.getAllByTestId("stash-row");

    expect(branchRows[0]).toHaveStyle({ height: "40px", top: "0px" });
    expect(branchRows[1]).toHaveStyle({ height: "40px", top: "40px" });
    expect(stashRows[0]).toHaveStyle({ height: "40px", top: "0px" });
    expect(screen.getByTestId("sidebar-branches-scroll")).toHaveClass(
      "overlay-scrollbar-viewport",
    );
    expect(screen.getByTestId("sidebar-stashes-scroll")).toHaveClass(
      "overlay-scrollbar-viewport",
    );
  });

  it("opens branch context menus outside the list and dismisses them elsewhere", () => {
    renderSidebar({});

    fireEvent.contextMenu(screen.getByText("feature/lookdev"), {
      clientX: 280,
      clientY: 220,
    });

    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(menu.parentElement).toBe(document.body);
    expect(
      screen.queryByRole("menuitem", { name: "Close" }),
    ).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Branches" }));
    expect(
      screen.queryByRole("menu", { name: "More actions" }),
    ).not.toBeInTheDocument();
  });

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
        name: "Create new branch from here",
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

  it("keeps current branch deletion disabled and routes remote-only deletion to confirmation", () => {
    const onDeleteBranch = vi.fn();

    renderSidebar({ onDeleteBranch });

    fireEvent.contextMenu(screen.getByText("main"));
    expect(
      screen.getByRole("menuitem", { name: "Delete branch" }),
    ).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(screen.getByText("concept-pass"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete branch" }));
    expect(onDeleteBranch).toHaveBeenCalledWith(
      expect.objectContaining({ name: "concept-pass", remoteOnly: true }),
    );
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
      screen.getByRole("menuitem", { name: "Create new branch from here" }),
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

    fireEvent.click(screen.getByRole("button", { name: /WIP/ }));
    expect(onShowStashDetails).toHaveBeenCalledWith(
      expect.objectContaining({ id: "stash@{0}" }),
    );
  });

  it("shows fetch offline status with the failure summary", () => {
    renderSidebar({
      fetchState: {
        lastSuccessAt: "1760000000",
        message: "Could not resolve host: example.test",
        repositoryPath: "/repo/art",
        state: "offline",
      },
    });

    const tooltip = screen
      .getByText("Technical details: Could not resolve host: example.test")
      .closest('[role="tooltip"]')!;
    expect(tooltip).toHaveTextContent("Remote repository may be offline");
    expect(tooltip).toHaveTextContent(
      "Technical details: Could not resolve host: example.test",
    );
    expect(tooltip).toHaveTextContent("2025");
    expect(tooltip).not.toHaveTextContent("1760000000");
  });

  it("distinguishes empty lists from empty search results", () => {
    renderSidebar({ branchItems: [], stashItems: [] });

    expect(screen.getByText("No branches yet")).toBeVisible();
    expect(screen.getByText("No stashes yet")).toBeVisible();

    fireEvent.change(openExpandableSearch("Search branches"), {
      target: { value: "missing" },
    });
    expect(screen.getByText("No matching items")).toBeVisible();
  });

  it("hides sync entrances and pending badges when there is no remote", () => {
    renderSidebar({ hasRemote: false });

    expect(
      screen.queryByRole("button", { name: "Sync" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("↑1")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("feature/lookdev"));

    expect(
      screen.queryByRole("menuitem", { name: "Sync" }),
    ).not.toBeInTheDocument();
  });

  it("keeps large branch lists windowed while retaining every branch", () => {
    const largeBranchList = Array.from({ length: 1_000 }, (_, index) => ({
      ahead: 0,
      behind: 0,
      latestCommitId: `commit-${index}`,
      name: `branch-${index.toString().padStart(4, "0")}`,
    }));
    const onBranchFocus = vi.fn();
    renderSidebar({
      branchItems: largeBranchList,
      branchesTruncated: true,
      onBranchFocus,
    });

    const branchesButton = screen.getByRole("button", {
      name: "Branches (latest 1000)",
    });
    expect(branchesButton).toBeInTheDocument();
    expect(screen.getAllByTestId("branch-row").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("branch-row").length).toBeLessThanOrEqual(40);
    expect(screen.getByText("branch-0000")).toBeInTheDocument();
    expect(screen.queryByText("branch-0999")).not.toBeInTheDocument();

    const viewport = screen.getByTestId("sidebar-branches-scroll");
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 440,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 44_000,
      writable: true,
    });
    fireEvent.scroll(viewport);

    expect(screen.getAllByTestId("branch-row").length).toBeLessThanOrEqual(23);
    expect(screen.getByText("branch-0999")).toBeInTheDocument();
    expect(screen.getByText("branch-0999").closest("li")).toHaveAttribute(
      "aria-setsize",
      "1000",
    );

    fireEvent.click(screen.getByText("branch-0999"));
    expect(onBranchFocus).toHaveBeenCalledWith(
      expect.objectContaining({ name: "branch-0999" }),
    );

    fireEvent.change(openExpandableSearch("Search branches"), {
      target: { value: "branch-0000" },
    });
    expect(screen.getByText("branch-0000")).toBeInTheDocument();

    fireEvent.change(openExpandableSearch("Search branches"), {
      target: { value: "" },
    });
    expect(screen.getByText("branch-0000")).toBeInTheDocument();

    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 44_000,
      writable: true,
    });
    fireEvent.scroll(viewport);
    fireEvent.click(branchesButton);
    fireEvent.click(branchesButton);

    expect(screen.getByText("branch-0000")).toBeInTheDocument();
    expect(screen.queryByText("branch-0999")).not.toBeInTheDocument();
  });

  it("keeps large stash lists windowed and searchable", () => {
    const largeStashList = Array.from({ length: 1_000 }, (_, index) => ({
      id: `stash@{${index}}`,
      name: `stash-${index.toString().padStart(4, "0")}`,
      timeLabel: `${index}m`,
    }));
    renderSidebar({ stashItems: largeStashList, stashesTruncated: true });

    expect(
      screen.getByRole("button", { name: "Stashes (latest 1000)" }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("stash-row").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("stash-row").length).toBeLessThanOrEqual(40);
    expect(screen.getByText("stash-0000")).toBeInTheDocument();
    expect(screen.queryByText("stash-0999")).not.toBeInTheDocument();

    const viewport = screen.getByTestId("sidebar-stashes-scroll");
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 440,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 44_000,
      writable: true,
    });
    fireEvent.scroll(viewport);

    expect(screen.getAllByTestId("stash-row").length).toBeLessThanOrEqual(23);
    expect(screen.getByText("stash-0999")).toBeInTheDocument();
    expect(screen.getByText("stash-0999").closest("li")).toHaveAttribute(
      "aria-setsize",
      "1000",
    );

    fireEvent.change(openExpandableSearch("Search stashes"), {
      target: { value: "stash-0000" },
    });
    expect(screen.getByText("stash-0000")).toBeInTheDocument();
  });

  it("persists sidebar width once after dragging ends", () => {
    const onSidebarLayoutChange = vi.fn();
    renderSidebar({ onSidebarLayoutChange });
    const resizeHandle = screen.getByLabelText("Resize sidebar");
    const sidebar = resizeHandle.closest("aside");

    fireEvent.pointerDown(resizeHandle, { clientX: 320, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 350 });
    fireEvent.pointerMove(window, { clientX: 390 });

    expect(sidebar).toHaveStyle({ width: "390px" });
    expect(onSidebarLayoutChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);

    expect(onSidebarLayoutChange).toHaveBeenCalledTimes(1);
    expect(onSidebarLayoutChange).toHaveBeenCalledWith(
      expect.objectContaining({ widthPx: 390 }),
    );
  });

  it("uses directional cursors and thickens sidebar resize lines", () => {
    renderSidebar({});

    const widthHandle = screen.getByLabelText("Resize sidebar");
    const ratioHandle = screen.getByLabelText(
      "Resize branch and stash sections",
    );

    expect(widthHandle).toHaveClass("group", "cursor-ew-resize");
    expect(widthHandle.firstElementChild).toHaveClass(
      "w-px",
      "bg-border",
      "group-hover:w-0.5",
      "group-hover:bg-ring",
      "group-active:w-0.5",
      "group-active:bg-ring",
    );
    expect(ratioHandle).toHaveClass("group", "cursor-ns-resize");
    expect(ratioHandle.firstElementChild).toHaveClass(
      "h-px",
      "bg-border",
      "group-hover:h-0.5",
      "group-hover:bg-ring",
      "group-active:h-0.5",
      "group-active:bg-ring",
    );
  });

  it("keeps the main sidebar divider below overlays in the adjacent panel", () => {
    renderSidebar({});

    expect(screen.getByLabelText("Resize sidebar")).toHaveClass("z-0");
  });

  it("finishes and cleans up an interrupted sidebar drag", () => {
    const onSidebarLayoutChange = vi.fn();
    renderSidebar({ onSidebarLayoutChange });
    const resizeHandle = screen.getByLabelText("Resize sidebar");
    const sidebar = resizeHandle.closest("aside");

    fireEvent.pointerDown(resizeHandle, { clientX: 320, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 380 });
    fireEvent.pointerCancel(window);

    expect(onSidebarLayoutChange).toHaveBeenCalledTimes(1);
    expect(onSidebarLayoutChange).toHaveBeenCalledWith(
      expect.objectContaining({ widthPx: 380 }),
    );

    fireEvent.pointerMove(window, { clientX: 450 });
    expect(sidebar).toHaveStyle({ width: "380px" });
    expect(onSidebarLayoutChange).toHaveBeenCalledTimes(1);
  });

  it("persists the section ratio once after dragging ends", () => {
    const onSidebarLayoutChange = vi.fn();
    renderSidebar({ onSidebarLayoutChange });
    const resizeHandle = screen.getByLabelText(
      "Resize branch and stash sections",
    );
    vi.spyOn(
      resizeHandle.parentElement as HTMLElement,
      "getBoundingClientRect",
    ).mockReturnValue({
      bottom: 500,
      height: 400,
      left: 0,
      right: 320,
      toJSON: () => ({}),
      top: 100,
      width: 320,
      x: 0,
      y: 100,
    });

    fireEvent.pointerDown(resizeHandle, { clientY: 356, pointerId: 2 });
    fireEvent.pointerMove(window, { clientY: 300 });
    fireEvent.pointerMove(window, { clientY: 340 });

    expect(onSidebarLayoutChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);

    expect(onSidebarLayoutChange).toHaveBeenCalledTimes(1);
    expect(onSidebarLayoutChange).toHaveBeenCalledWith(
      expect.objectContaining({ branchSectionRatioPercent: 60 }),
    );
  });

  it("finishes an active section drag when the window loses focus", () => {
    const onSidebarLayoutChange = vi.fn();
    renderSidebar({ onSidebarLayoutChange });
    const resizeHandle = screen.getByLabelText(
      "Resize branch and stash sections",
    );
    vi.spyOn(
      resizeHandle.parentElement as HTMLElement,
      "getBoundingClientRect",
    ).mockReturnValue({
      bottom: 500,
      height: 400,
      left: 0,
      right: 320,
      toJSON: () => ({}),
      top: 100,
      width: 320,
      x: 0,
      y: 100,
    });

    fireEvent.pointerDown(resizeHandle, { clientY: 300, pointerId: 4 });
    fireEvent.pointerMove(window, { clientY: 360 });
    fireEvent.blur(window);

    expect(onSidebarLayoutChange).toHaveBeenCalledTimes(1);
    expect(onSidebarLayoutChange).toHaveBeenCalledWith(
      expect.objectContaining({ branchSectionRatioPercent: 65 }),
    );
  });
});

function renderSidebar({
  branchActionsDisabledReason,
  branchItems = branches,
  branchesTruncated = false,
  busy = false,
  fetchState,
  hasRemote = true,
  onApplyStash,
  onCheckoutBranch,
  onCreateBranchFromBase,
  onDeleteBranch,
  onDeleteStash,
  onBranchFocus = vi.fn(),
  onShowSafetyBackups,
  onShowStashDetails,
  onSidebarLayoutChange,
  repositoryPath = "/repo/art",
  stashItems = stashes,
  stashesTruncated = false,
}: {
  branchActionsDisabledReason?: string;
  branchItems?: BranchListItem[];
  branchesTruncated?: boolean;
  busy?: boolean;
  fetchState?: ComponentProps<typeof RepositorySidebar>["fetchState"];
  hasRemote?: boolean;
  onApplyStash?: (stash: StashListItem) => void;
  onCheckoutBranch?: (branch: BranchListItem) => void;
  onCreateBranchFromBase?: (branch: BranchListItem) => void;
  onDeleteBranch?: (branch: BranchListItem) => void;
  onDeleteStash?: (stash: StashListItem) => void;
  onBranchFocus?: (branch: BranchListItem) => void;
  onShowSafetyBackups?: () => void;
  onShowStashDetails?: (stash: StashListItem) => void;
  onSidebarLayoutChange?: ComponentProps<
    typeof RepositorySidebar
  >["onSidebarLayoutChange"];
  repositoryPath?: string;
  stashItems?: StashListItem[];
  stashesTruncated?: boolean;
}) {
  return renderWithProviders(
    <RepositorySidebar
      branchActionsDisabledReason={branchActionsDisabledReason}
      branches={branchItems}
      branchesTruncated={branchesTruncated}
      busy={busy}
      fetchState={fetchState}
      onApplyStash={onApplyStash}
      onBranchFocus={onBranchFocus}
      onCheckoutBranch={onCheckoutBranch}
      onCreateBranchFromBase={onCreateBranchFromBase}
      onDeleteBranch={onDeleteBranch}
      onDeleteStash={onDeleteStash}
      onShowSafetyBackups={onShowSafetyBackups}
      onShowStashDetails={onShowStashDetails}
      onSidebarLayoutChange={onSidebarLayoutChange}
      repository={{
        branchName: "main",
        hasRemote,
        path: repositoryPath,
        projectName: "art",
      }}
      stashes={stashItems}
      stashesTruncated={stashesTruncated}
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
