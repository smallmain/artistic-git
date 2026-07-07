import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";
import type { DiffPayload } from "@/lib/ipc/generated";

import { DiffViewer } from "./DiffViewer";
import { buildLineDiffRows } from "./line-diff";
import type { TextDiffRendererAdapter } from "./types";

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

describe("buildLineDiffRows", () => {
  it("pairs adjacent removed and added lines as a modified row", () => {
    expect(buildLineDiffRows("a\nold\nc", "a\nnew\nc")).toEqual([
      {
        newLineNumber: 1,
        newText: "a",
        oldLineNumber: 1,
        oldText: "a",
        type: "unchanged",
      },
      {
        newLineNumber: 2,
        newText: "new",
        oldLineNumber: 2,
        oldText: "old",
        type: "modified",
      },
      {
        newLineNumber: 3,
        newText: "c",
        oldLineNumber: 3,
        oldText: "c",
        type: "unchanged",
      },
    ]);
  });
});

describe("DiffViewer", () => {
  it("renders text diffs and switches to inline mode", () => {
    renderWithProviders(
      <DiffViewer
        content={{ kind: "text", newText: "hello\nnew", oldText: "hello\nold" }}
        payload={createPayload({ fileKind: "text" })}
        source="commitDetails"
      />,
    );

    expect(screen.getByLabelText("Diff viewer")).toHaveAttribute(
      "data-diff-source",
      "commitDetails",
    );
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inline diff" }));

    expect(screen.getByRole("button", { name: "Inline diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("delegates text rendering to the CodeMirror adapter seam", () => {
    const adapter: TextDiffRendererAdapter = {
      render: vi.fn(() => <div>adapter-rendered</div>),
    };

    renderWithProviders(
      <DiffViewer
        content={{ kind: "text", newText: "new", oldText: "old" }}
        payload={createPayload({ fileKind: "text" })}
        source="localChanges"
        textRenderer={adapter}
      />,
    );

    expect(screen.getByText("adapter-rendered")).toBeInTheDocument();
    expect(adapter.render).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "split" }),
    );
  });

  it("renders moved, oversized, and image-specific surfaces", () => {
    const { rerender } = renderWithProviders(
      <DiffViewer
        content={{ kind: "text", newText: "same", oldText: "same" }}
        payload={createPayload({
          changeKind: "renamed",
          metadata: { contentChanged: "false" },
          oldPath: "old/file.txt",
        })}
        source="localChanges"
      />,
    );

    expect(
      screen.getByText("File moved with no content changes"),
    ).toBeInTheDocument();

    rerender(
      <AppProviders
        i18n={createI18n("en")}
        initialLanguagePreference="en"
        initialThemePreference="light"
        queryClient={createAppQueryClient()}
      >
        <DiffViewer
          content={{ kind: "oversizedText" }}
          payload={createPayload({ fileKind: "oversizedText" })}
          source="conflictResolution"
        />
      </AppProviders>,
    );

    expect(screen.getByText("File is too large to render")).toBeInTheDocument();

    rerender(
      <AppProviders
        i18n={createI18n("en")}
        initialLanguagePreference="en"
        initialThemePreference="light"
        queryClient={createAppQueryClient()}
      >
        <DiffViewer
          content={{
            kind: "image",
            newImage: {
              height: 20,
              sizeBytes: 2048,
              src: "data:image/png;base64,",
              width: 10,
            },
          }}
          payload={createPayload({ fileKind: "image" })}
          source="localChanges"
        />
      </AppProviders>,
    );

    expect(screen.getByText("Zoom")).toBeInTheDocument();
    expect(screen.getByText(/10 x 20/)).toBeInTheDocument();
  });

  it("renders explicit LFS loading and error states", () => {
    const { rerender } = renderWithProviders(
      <DiffViewer
        content={{ kind: "lfsPointer", message: null, status: "loading" }}
        payload={createPayload({ fileKind: "lfsPointer" })}
        source="localChanges"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading Git LFS content",
    );
    expect(screen.getByText("Loading")).toBeInTheDocument();

    rerender(
      <AppProviders
        i18n={createI18n("en")}
        initialLanguagePreference="en"
        initialThemePreference="light"
        queryClient={createAppQueryClient()}
      >
        <DiffViewer
          content={{
            kind: "lfsPointer",
            message: "Git LFS old content fetch failed",
            status: "error",
          }}
          payload={createPayload({ fileKind: "lfsPointer" })}
          source="localChanges"
        />
      </AppProviders>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Git LFS old content fetch failed",
    );
    expect(screen.getByText("Fetch failed")).toBeInTheDocument();
  });
});

function createPayload(overrides: Partial<DiffPayload> = {}): DiffPayload {
  return {
    changeKind: "modified",
    fileKind: "text",
    lfsLock: null,
    metadata: {},
    newPath: "src/file.txt",
    oldPath: null,
    ...overrides,
  };
}
