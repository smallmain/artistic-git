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
import type {
  ConflictDetailResponse,
  ConflictEnteredEvent,
  ConflictFile,
  ConflictOperation,
} from "@/lib/ipc/generated";
import { createAppQueryClient } from "@/lib/query/client";

import {
  ConflictResolutionOverlay,
  type ConflictResolutionApi,
} from "./ConflictResolutionOverlay";

const mergeOperation: ConflictOperation = { kind: "merge", label: "Merge" };
const rebaseOperation: ConflictOperation = { kind: "rebase", label: "Rebase" };

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

describe("ConflictResolutionOverlay", () => {
  it("gates save and complete while text hunks remain unresolved", async () => {
    const file = createFile({ status: "unresolved" });
    const api = createApi({
      conflictDetail: vi.fn(async () => createTextDetail(file)),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
      saveConflictResolution: vi.fn(async () => ({
        file: resolvedFile(file),
      })),
    });

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent([file])}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Finish resolving" }),
    ).toBeDisabled();
    const editor = await screen.findByLabelText("Resolved file content");
    expect(editor).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const hunk = screen.getByLabelText("Conflict at line 2");
    expect(within(hunk).getByText("Current changes")).toBeInTheDocument();
    expect(within(hunk).getByText("Incoming changes")).toBeInTheDocument();
    expect(within(hunk).getByText("own line")).toBeInTheDocument();
    expect(within(hunk).getByText("other line")).toBeInTheDocument();
    expect(
      screen.queryByText(/<<<<<<<|=======|>>>>>>>/),
    ).not.toBeInTheDocument();
    expectResolutionEditorValue(
      editor,
      "before\nown line\nother line\nafter\n",
    );

    fireEvent.click(
      within(hunk).getByRole("button", { name: "Use current changes here" }),
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.saveConflictResolution).toHaveBeenCalledWith({
        content: "before\nown line\nafter\n",
        path: "src/conflict.txt",
        pendingHunks: 0,
        repositoryPath: "/repo/art",
      });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Finish resolving" }),
      ).toBeEnabled();
    });
  });

  it("allows manual text edits but blocks saving while markers or unresolved hunks remain", async () => {
    const file = createFile({ status: "unresolved" });
    const api = createApi({
      conflictDetail: vi.fn(async () => createTextDetail(file)),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
      saveConflictResolution: vi.fn(async () => ({
        file: resolvedFile(file),
      })),
    });

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent([file])}
        onClose={vi.fn()}
      />,
    );

    const editor = await screen.findByLabelText("Resolved file content");
    editResolutionContent(editor, "before\nmanual\n<<<<<<< HEAD\nafter\n");

    expect(
      await screen.findByText(
        "Remove the remaining conflict markers before continuing.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    editResolutionContent(editor, "before\nmanual\nafter\n");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
    fireEvent.click(screen.getByLabelText("Mark resolved"));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.saveConflictResolution).toHaveBeenCalledWith({
        content: "before\nmanual\nafter\n",
        path: "src/conflict.txt",
        pendingHunks: 0,
        repositoryPath: "/repo/art",
      });
    });
  });

  it("labels stash restore conflict sides as stashed and current branch content", async () => {
    const file = createFile({ status: "unresolved" });
    const api = createApi({
      conflictDetail: vi.fn(async () => createTextDetail(file)),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
    });

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent([file], { operationName: "restoreStash" })}
        onClose={vi.fn()}
      />,
    );

    const hunk = await screen.findByLabelText("Conflict at line 2");
    expect(screen.getByText("Current branch version")).toBeInTheDocument();
    expect(screen.getByText("Stashed version")).toBeInTheDocument();
    expect(
      within(hunk).getByText("Current branch content"),
    ).toBeInTheDocument();
    expect(within(hunk).getByText("Stashed content")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use current branch" }),
    ).toBeInTheDocument();
    expect(
      within(hunk).getByRole("button", {
        name: "Use stashed section",
      }),
    ).toBeInTheDocument();
  });

  it("labels sync conflicts as remote content and local commits", async () => {
    const file = createFile({ status: "unresolved" });
    const api = createApi({
      conflictDetail: vi.fn(async () => createTextDetail(file)),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: rebaseOperation,
      })),
    });

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent([file], { operationName: "syncCurrentBranch" })}
        onClose={vi.fn()}
      />,
    );

    const hunk = await screen.findByLabelText("Conflict at line 2");
    expect(screen.getByText("Remote version")).toBeInTheDocument();
    expect(screen.getByText("Local commit version")).toBeInTheDocument();
    expect(within(hunk).getByText("Remote content")).toBeInTheDocument();
    expect(within(hunk).getByText("Local commit content")).toBeInTheDocument();
    expect(
      within(hunk).getByRole("button", { name: "Use remote section" }),
    ).toBeInTheDocument();
    expect(
      within(hunk).getByRole("button", { name: "Use local commit section" }),
    ).toBeInTheDocument();
  });

  it("renders binary side details, image previews, and only resolves by choosing a side", async () => {
    const file = createFile({
      fileKind: "image",
      path: "assets/conflict.png",
      status: "unresolved",
    });
    const api = createApi({
      conflictDetail: vi.fn(async () => createBinaryDetail(file)),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
      selectConflictSide: vi.fn(async () => ({
        files: [resolvedFile(file)],
      })),
    });

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent([file])}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("For binary files, choose one complete version."),
    ).toBeVisible();
    expect(
      screen.queryByLabelText("Resolved file content"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Type")).toHaveLength(2);
    expect(screen.getAllByText("Size")).toHaveLength(2);
    expect(screen.getAllByText("Modified")).toHaveLength(2);
    expect(screen.getAllByText("image/png")).toHaveLength(2);
    expect(screen.getByText("512 byte")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Current version" }),
    ).toHaveAttribute("src", "data:image/png;base64,AAAA");

    const ownSide = screen.getByText("Current version").closest("section");
    expect(ownSide).not.toBeNull();
    fireEvent.click(
      within(ownSide as HTMLElement).getByRole("button", {
        name: "Choose version",
      }),
    );

    await waitFor(() => {
      expect(api.selectConflictSide).toHaveBeenCalledWith({
        paths: ["assets/conflict.png"],
        repositoryPath: "/repo/art",
        side: "own",
      });
    });
  });

  it("keeps submodule-prefixed paths in the list, diff, and conflict commands", async () => {
    const file = createFile({
      path: "deps/lib/src/conflict.ts",
      status: "unresolved",
    });
    const api = createApi({
      completeConflictResolution: vi.fn(async () => ({
        continuation: "merge" as const,
      })),
      conflictDetail: vi.fn(async () => createTextDetail(file)),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
      saveConflictResolution: vi.fn(async () => ({
        file: resolvedFile(file),
      })),
      selectConflictSide: vi.fn(async () => ({
        files: [resolvedFile(file)],
      })),
    });
    const onClose = vi.fn();

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent([file])}
        onClose={onClose}
      />,
    );

    expect(
      await screen.findAllByText("deps/lib/src/conflict.ts"),
    ).not.toHaveLength(0);
    expect(
      within(screen.getByLabelText("File comparison")).getByText(
        "deps/lib/src/conflict.ts",
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(api.conflictDetail).toHaveBeenCalledWith({
        path: "deps/lib/src/conflict.ts",
        repositoryPath: "/repo/art",
      });
    });

    const hunk = screen.getByLabelText("Conflict at line 2");
    fireEvent.click(
      within(hunk).getByRole("button", { name: "Use current changes here" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.saveConflictResolution).toHaveBeenCalledWith({
        content: "before\nown line\nafter\n",
        path: "deps/lib/src/conflict.ts",
        pendingHunks: 0,
        repositoryPath: "/repo/art",
      });
    });

    const useCurrentVersion = screen.getByTestId("conflict-use-own");
    expect(useCurrentVersion).toHaveTextContent("Use current version");
    fireEvent.click(useCurrentVersion);

    await waitFor(() => {
      expect(api.selectConflictSide).toHaveBeenCalledWith({
        paths: ["deps/lib/src/conflict.ts"],
        repositoryPath: "/repo/art",
        side: "own",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Finish resolving" }));

    await waitFor(() => {
      expect(api.completeConflictResolution).toHaveBeenCalledWith({
        operationId: "op-conflict",
        paths: ["deps/lib/src/conflict.ts"],
        repositoryPath: "/repo/art",
      });
      expect(onClose).toHaveBeenCalledWith("/repo/art");
    });
  });

  it("calls complete only after all files are resolved and cancel after confirmation", async () => {
    const file = createFile({ status: "resolved" });
    const completeApi = createApi({
      conflictDetail: vi.fn(async () => createResolvedTextDetail(file)),
      completeConflictResolution: vi.fn(async () => ({
        continuation: "merge" as const,
      })),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
    });
    const onCompleteClose = vi.fn();

    renderWithProviders(
      <ConflictResolutionOverlay
        api={completeApi}
        event={createEvent([file])}
        onClose={onCompleteClose}
      />,
    );

    expect(await screen.findByLabelText("Resolved file content")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Finish resolving" }));

    await waitFor(() => {
      expect(completeApi.completeConflictResolution).toHaveBeenCalledWith({
        operationId: "op-conflict",
        paths: ["src/conflict.txt"],
        repositoryPath: "/repo/art",
      });
      expect(onCompleteClose).toHaveBeenCalledWith("/repo/art");
    });

    cleanup();

    const cancelApi = createApi({
      conflictDetail: vi.fn(async () => createResolvedTextDetail(file)),
      cancelConflictResolution: vi.fn(async () => ({
        aborted: "merge" as const,
      })),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
    });
    const onCancelClose = vi.fn();

    renderWithProviders(
      <ConflictResolutionOverlay
        api={cancelApi}
        event={createEvent([file])}
        onClose={onCancelClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByText("Cancel conflict resolution"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abort operation" }));

    await waitFor(() => {
      expect(cancelApi.cancelConflictResolution).toHaveBeenCalledWith({
        operationId: "op-conflict",
        repositoryPath: "/repo/art",
      });
      expect(onCancelClose).toHaveBeenCalledWith("/repo/art");
    });
  });
});

function editResolutionContent(editor: HTMLElement, value: string) {
  fireEvent.input(editor, {
    target: {
      textContent: value,
    },
  });
}

function expectResolutionEditorValue(editor: HTMLElement, value: string) {
  expect(editor).toHaveAttribute("data-editor-value", value);
}

function createApi(
  overrides: Partial<ConflictResolutionApi> = {},
): ConflictResolutionApi {
  return {
    cancelConflictResolution: vi.fn(async () => ({
      aborted: "merge" as const,
    })),
    completeConflictResolution: vi.fn(async () => ({
      continuation: "merge" as const,
    })),
    conflictDetail: vi.fn(async () =>
      createResolvedTextDetail(createFile({ status: "resolved" })),
    ),
    listConflicts: vi.fn(async () => ({
      files: [createFile({ status: "resolved" })],
      operation: mergeOperation,
    })),
    saveConflictResolution: vi.fn(async () => ({
      file: createFile({ status: "resolved" }),
    })),
    selectConflictSide: vi.fn(async () => ({
      files: [createFile({ status: "resolved" })],
    })),
    ...overrides,
  };
}

function resolvedFile(file: ConflictFile): ConflictFile {
  return { ...file, status: "resolved" };
}

function createEvent(
  files: ConflictFile[],
  overrides: Partial<ConflictEnteredEvent> = {},
): ConflictEnteredEvent {
  return {
    files,
    operationId: "op-conflict",
    operationName: "Resolving merge",
    repositoryPath: "/repo/art",
    ...overrides,
  };
}

function createFile(overrides: Partial<ConflictFile> = {}): ConflictFile {
  return {
    fileKind: "text",
    path: "src/conflict.txt",
    status: "unresolved",
    ...overrides,
  };
}

function createTextDetail(file: ConflictFile): ConflictDetailResponse {
  const prefix = "before\n";
  const ownText = "own line\n";
  const otherText = "other line\n";
  const suffix = "after\n";
  const startOffset = prefix.length;
  const endOffset = startOffset + ownText.length + otherText.length;

  return {
    detail: {
      currentText: `${prefix}${ownText}${otherText}${suffix}`,
      hunks: [
        {
          endLine: 4,
          endOffset,
          id: 0,
          otherText,
          ownText,
          startLine: 2,
          startOffset,
        },
      ],
      kind: "text",
      language: "ts",
      otherText: `${prefix}${otherText}${suffix}`,
      ownText: `${prefix}${ownText}${suffix}`,
    },
    file,
  };
}

function createResolvedTextDetail(file: ConflictFile): ConflictDetailResponse {
  return {
    detail: {
      currentText: "resolved\n",
      hunks: [],
      kind: "text",
      language: "ts",
      otherText: "other\n",
      ownText: "own\n",
    },
    file,
  };
}

function createBinaryDetail(file: ConflictFile): ConflictDetailResponse {
  return {
    detail: {
      kind: "binary",
      other: {
        mimeType: "image/png",
        modifiedUnixSeconds: null,
        oid: "other-oid",
        preview: null,
        side: "other",
        sizeBytes: 1024,
      },
      own: {
        mimeType: "image/png",
        modifiedUnixSeconds: "1800000000",
        oid: "own-oid",
        preview: { dataUrl: "data:image/png;base64,AAAA" },
        side: "own",
        sizeBytes: 512,
      },
    },
    file,
  };
}
