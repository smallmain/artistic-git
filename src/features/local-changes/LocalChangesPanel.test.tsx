import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";
import type { DiffPayload } from "@/lib/ipc/generated";

import { LocalChangesPanel } from "./LocalChangesPanel";
import {
  filterChanges,
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
    expect(getCheckState(["a", "b"], new Set(["a"]))).toBe("mixed");
  });
});

describe("LocalChangesPanel", () => {
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

    const menu = screen
      .getByText("Revert changes (coming later)")
      .closest("div");
    expect(menu).not.toBeNull();
    expect(
      within(menu as HTMLElement).getByText("Check selected (1)"),
    ).toBeInTheDocument();
  });

  it("shows a renormalize preview prompt without checking files", () => {
    const onPreviewRenormalize = vi.fn();

    renderWithProviders(
      <LocalChangesPanel
        changes={createChanges()}
        onPreviewRenormalize={onPreviewRenormalize}
        renormalizePreviewStatus="Preview found 1 paths: src/main.ts"
        renormalizeSuggestion={{
          modifiedChanges: 1_000,
          samplePaths: ["src/main.ts"],
          threshold: 1_000,
          totalChanges: 1_200,
        }}
      />,
    );

    expect(screen.getByText("Many files changed")).toBeInTheDocument();
    expect(screen.getAllByText("src/main.ts").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Preview renormalization" }),
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

    expect(screen.getAllByText("deps/lib/src/shader.ts").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("src/main.ts")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Toggle deps/lib/src/shader.ts"));
    expect(onCheckedChange).toHaveBeenLastCalledWith(["4"]);

    fireEvent.click(screen.getByRole("button", { name: "Tree view" }));
    fireEvent.click(screen.getByLabelText("deps"));

    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(onCheckedChange).toHaveBeenLastCalledWith([]);
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
