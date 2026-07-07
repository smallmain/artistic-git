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
    const changes = createChanges();

    expect(filterChanges(changes, "console")).toHaveLength(1);
    expect(filterChanges(changes, "roughness")).toHaveLength(1);
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
