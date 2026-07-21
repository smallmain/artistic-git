import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";
import type { DiffPayload } from "@/lib/ipc/generated";

import { LocalChangesPanel } from "./LocalChangesPanel";
import {
  filterChanges,
  formatChangeName,
  formatChangePath,
  getCheckState,
} from "./local-change-utils";
import type { LocalChangeItem } from "./types";

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

describe("local change utilities", () => {
  it("filters paths and searchable content", () => {
    const changes = [...createChanges(), createSubmoduleChange()];

    expect(filterChanges(changes, "console")).toHaveLength(1);
    expect(filterChanges(changes, "roughness")).toHaveLength(1);
    expect(filterChanges(changes, "deps/lib")).toEqual([
      createSubmoduleChange(),
    ]);
    expect(formatChangePath(changes[2])).toBe(
      "assets/old-name.png -> assets/new-name.png",
    );
    expect(formatChangeName(changes[0])).toBe("main.ts");
    expect(formatChangeName(changes[2])).toBe("old-name.png -> new-name.png");
    expect(getCheckState(["a", "b"], new Set(["a"]))).toBe("mixed");
  });
});

describe("LocalChangesPanel", () => {
  it("shows a retryable error without replacing it with the empty state", () => {
    const error = {
      operation: "git status",
      stderr: "fatal: unable to read index",
      summary: "Unable to list local changes",
    };
    const onRetry = vi.fn();
    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    window.addEventListener("artistic-git:error", handleError);

    try {
      renderWithProviders(
        <LocalChangesPanel changes={[]} error={error} onRetry={onRetry} />,
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Couldn't load local changes",
      );
      expect(screen.queryByText("No matching changes")).not.toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails).toEqual([error]);
      expect(receivedDetails[0]).toBe(error);

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("blocks stale file actions while local changes are loading", () => {
    renderWithProviders(
      <LocalChangesPanel changes={createChanges()} loading />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading local changes...",
    );
    expect(screen.getByTestId("local-changes-commit")).toBeDisabled();
    expect(
      screen.getAllByText("src/main.ts")[0].closest("aside"),
    ).toHaveAttribute("inert");
  });

  it("checks files, searches contents, and calls the commit placeholder", () => {
    const onCheckedChange = vi.fn();
    const onCommit = vi.fn();

    renderWithProviders(
      <LocalChangesPanel
        changes={createChanges()}
        onCheckedChange={onCheckedChange}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByLabelText("Select all"));
    expect(onCheckedChange).toHaveBeenLastCalledWith(["1", "2", "3"]);

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(onCommit).toHaveBeenCalledWith(["1", "2", "3"]);

    fireEvent.change(screen.getByLabelText("Search files and contents"), {
      target: { value: "roughness" },
    });

    expect(
      screen.getAllByText("assets/textures/material.bin").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("src/main.ts")).not.toBeInTheDocument();
  });

  it("shows flat filenames above full paths with full-path tooltips", () => {
    renderWithProviders(<LocalChangesPanel changes={createChanges()} />);

    const rows = screen.getAllByTestId("local-change-row");
    const materialRow = rows.find(
      (row) =>
        row.getAttribute("data-change-path") === "assets/textures/material.bin",
    );
    const renamedRow = rows.find(
      (row) => row.getAttribute("data-change-path") === "assets/new-name.png",
    );

    expect(materialRow).toBeDefined();
    expect(renamedRow).toBeDefined();
    expect(within(materialRow!).getByText("material.bin")).toBeInTheDocument();
    expect(
      within(materialRow!).getByText("assets/textures/material.bin"),
    ).toBeInTheDocument();
    expect(
      within(renamedRow!).getByText("old-name.png -> new-name.png"),
    ).toBeInTheDocument();
    expect(
      within(renamedRow!).getByText(
        "assets/old-name.png -> assets/new-name.png",
      ),
    ).toBeInTheDocument();

    const label = within(materialRow!).getByTestId("local-change-label");
    const tooltip = document.getElementById(
      label.getAttribute("aria-describedby")!,
    );
    expect(tooltip).toHaveTextContent("assets/textures/material.bin");

    fireEvent.mouseEnter(label.parentElement!);
    expect(tooltip).toHaveAttribute("data-state", "open");
  });

  it("resizes and persists the change list and diff panel ratio", () => {
    const { unmount } = renderWithProviders(
      <LocalChangesPanel changes={createChanges()} />,
    );
    const panel = screen.getByTestId("local-changes-panel");
    const resizeHandle = screen.getByRole("separator", {
      name: "Resize change list and diff panels",
    });

    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      bottom: 700,
      height: 600,
      left: 100,
      right: 1_100,
      toJSON: () => ({}),
      top: 100,
      width: 1_000,
      x: 100,
      y: 100,
    });
    vi.spyOn(resizeHandle, "getBoundingClientRect").mockReturnValue({
      bottom: 700,
      height: 600,
      left: 486,
      right: 494,
      toJSON: () => ({}),
      top: 100,
      width: 8,
      x: 486,
      y: 100,
    });

    expect(panel.style.gridTemplateColumns).toContain("39%");
    expect(resizeHandle).toHaveClass("group", "cursor-ew-resize");
    expect(resizeHandle.firstElementChild).toHaveClass(
      "w-px",
      "bg-border",
      "group-hover:w-0.5",
      "group-hover:bg-ring",
      "group-active:w-0.5",
      "group-active:bg-ring",
    );

    fireEvent.pointerDown(resizeHandle, { clientX: 490, pointerId: 7 });
    fireEvent.pointerMove(window, { clientX: 600 });

    expect(panel.style.gridTemplateColumns).toContain("50%");
    expect(
      window.localStorage.getItem("artistic-git.local-changes.split-ratio"),
    ).toBeNull();

    fireEvent.pointerUp(window);

    expect(
      window.localStorage.getItem("artistic-git.local-changes.split-ratio"),
    ).toBe("50");

    fireEvent.pointerMove(window, { clientX: 700 });
    expect(panel.style.gridTemplateColumns).toContain("50%");

    unmount();
    renderWithProviders(<LocalChangesPanel changes={createChanges()} />);
    expect(
      screen.getByTestId("local-changes-panel").style.gridTemplateColumns,
    ).toContain("50%");
  });

  it("switches to tree mode, persists it, and supports folder tri-state checks", () => {
    renderWithProviders(
      <LocalChangesPanel
        changes={createChanges()}
        storageKey="test-view-mode"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Tree view" }));

    expect(window.localStorage.getItem("test-view-mode")).toBe("tree");
    expect(screen.getAllByText("assets").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByLabelText("assets")[0]);

    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("shows the right-click placeholder menu for selected files", () => {
    renderWithProviders(<LocalChangesPanel changes={createChanges()} />);

    fireEvent.contextMenu(screen.getAllByText("src/main.ts")[0]);

    const menu = screen.getByText("Restore changes unavailable").closest("div");
    expect(menu).not.toBeNull();
    expect(
      within(menu as HTMLElement).getByText("Check selected (1)"),
    ).toBeInTheDocument();
  });

  it("closes and blocks file action menus while busy", () => {
    const onRestore = vi.fn();
    const onStash = vi.fn();
    let startBusy: () => void = () => undefined;

    function BusyPanel() {
      const [busy, setBusy] = useState(false);
      startBusy = () => setBusy(true);

      return (
        <LocalChangesPanel
          busy={busy}
          changes={createChanges()}
          onRestore={onRestore}
          onStash={onStash}
        />
      );
    }

    renderWithProviders(<BusyPanel />);
    fireEvent.contextMenu(screen.getAllByText("src/main.ts")[0]);

    expect(
      screen.getByRole("menuitem", { name: "Stash selected (1)" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: "Restore selected (1)" }),
    ).toBeEnabled();

    act(() => startBusy());

    expect(
      screen.queryByRole("menuitem", { name: "Stash selected (1)" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Restore selected (1)" }),
    ).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getAllByText("src/main.ts")[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "More actions" })[0]);

    expect(screen.queryByText("Stash selected (1)")).not.toBeInTheDocument();
    expect(screen.queryByText("Restore selected (1)")).not.toBeInTheDocument();
    expect(onStash).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("shows a renormalize preview prompt without checking files", () => {
    const onPreviewRenormalize = vi.fn();

    renderWithProviders(
      <LocalChangesPanel
        changes={createChanges()}
        onPreviewRenormalize={onPreviewRenormalize}
        renormalizePreviewStatus="Affected files: 1. src/main.ts"
        renormalizeSuggestion={{
          modifiedChanges: 1_000,
          samplePaths: ["src/main.ts"],
          threshold: 1_000,
          totalChanges: 1_200,
        }}
      />,
    );

    expect(
      screen.getByText("Many files changed unexpectedly"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("src/main.ts").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Review affected files" }),
    );

    expect(onPreviewRenormalize).toHaveBeenCalled();
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });

  it("shows submodule badges while search and tree checks keep working", () => {
    const onCheckedChange = vi.fn();
    const changes = [...createChanges(), createSubmoduleChange()];

    renderWithProviders(
      <LocalChangesPanel
        changes={changes}
        onCheckedChange={onCheckedChange}
        storageKey="submodule-test-view-mode"
      />,
    );

    expect(screen.getByText("Submodule: deps/lib")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search files and contents"), {
      target: { value: "deps/lib" },
    });

    expect(
      screen.getAllByText("deps/lib/src/shader.ts").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("src/main.ts")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByLabelText("Select or deselect deps/lib/src/shader.ts"),
    );
    expect(onCheckedChange).toHaveBeenLastCalledWith(["4"]);

    fireEvent.click(screen.getByRole("button", { name: "Tree view" }));
    fireEvent.click(screen.getByLabelText("deps"));

    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(onCheckedChange).toHaveBeenLastCalledWith([]);
  });

  it("renders large change sets in bounded pages", () => {
    const changes = Array.from({ length: 255 }, (_, index) => ({
      id: `large-${index}`,
      payload: createPayload({ newPath: `generated/file-${index}.txt` }),
    }));

    renderWithProviders(<LocalChangesPanel changes={changes} />);

    expect(screen.getAllByTestId("local-change-row")).toHaveLength(250);
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(
      screen
        .getAllByTestId("local-change-row")
        .some((row) => within(row).queryByText("generated/file-0.txt")),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next changes page" }));

    expect(screen.getAllByTestId("local-change-row")).toHaveLength(5);
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(
      screen
        .getAllByTestId("local-change-row")
        .some((row) => within(row).queryByText("generated/file-250.txt")),
    ).toBe(true);
    expect(
      screen
        .getAllByTestId("local-change-row")
        .some((row) => within(row).queryByText("generated/file-0.txt")),
    ).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Previous changes page" }),
    );
    expect(screen.getAllByTestId("local-change-row")).toHaveLength(250);
    expect(
      screen
        .getAllByTestId("local-change-row")
        .some((row) => within(row).queryByText("generated/file-0.txt")),
    ).toBe(true);
  });
});

function createChanges(): LocalChangeItem[] {
  return [
    {
      diff: {
        kind: "text",
        newText: "console.log('hello')\n",
        oldText: "console.log('old')\n",
      },
      id: "1",
      payload: createPayload({
        changeKind: "modified",
        fileKind: "text",
        newPath: "src/main.ts",
      }),
      searchableText: "console hello",
    },
    {
      id: "2",
      payload: createPayload({
        changeKind: "added",
        fileKind: "binary",
        metadata: { newBytes: "2048" },
        newPath: "assets/textures/material.bin",
      }),
      searchableText: "roughness metallic",
    },
    {
      id: "3",
      payload: createPayload({
        changeKind: "renamed",
        fileKind: "image",
        newPath: "assets/new-name.png",
        oldPath: "assets/old-name.png",
      }),
    },
  ];
}

function createPayload(overrides: Partial<DiffPayload>): DiffPayload {
  return {
    changeKind: "modified",
    fileKind: "text",
    lfsLock: null,
    metadata: {},
    newPath: "file.txt",
    oldPath: null,
    ...overrides,
  };
}

function createSubmoduleChange(): LocalChangeItem {
  return {
    diff: {
      kind: "text",
      newText: "export const shader = 'new';\n",
      oldText: "export const shader = 'old';\n",
    },
    id: "4",
    payload: createPayload({
      changeKind: "modified",
      fileKind: "text",
      metadata: {
        submoduleInnerPath: "src/shader.ts",
        submoduleName: "deps/lib",
        submodulePath: "deps/lib",
      },
      newPath: "deps/lib/src/shader.ts",
    }),
    searchableText: "shader deps lib",
    submodule: {
      name: "deps/lib",
      path: "deps/lib",
    },
  };
}
