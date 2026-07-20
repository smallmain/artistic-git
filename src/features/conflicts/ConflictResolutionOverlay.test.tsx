import {
  act,
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
        operationId: expect.stringMatching(/^conflict-select-/),
        paths: ["assets/conflict.png"],
        repositoryPath: "/repo/art",
        side: "own",
      });
    });
  });

  it("keeps oversized conflict text out of the diff and editor", async () => {
    const file = createFile({
      fileKind: "oversizedText",
      path: "data/large-conflict.txt",
      status: "unresolved",
    });
    const api = createApi({
      conflictDetail: vi.fn(async () => createOversizedTextDetail(file)),
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
      await screen.findByRole("heading", {
        name: "This conflict file is too large to preview",
      }),
    ).toBeVisible();
    expect(screen.getByText(/2 MB.*1 MB preview limit/)).toBeVisible();
    expect(
      screen.queryByLabelText("Resolved file content"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("File comparison")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("conflict-oversized-use-own"));

    await waitFor(() => {
      expect(api.selectConflictSide).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^conflict-select-/),
        paths: ["data/large-conflict.txt"],
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
        operationId: expect.stringMatching(/^conflict-select-/),
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

  it("hides stale details and ignores a slow response after selecting another file", async () => {
    const files = [
      createFile({ path: "src/first.txt" }),
      createFile({ path: "src/slow.txt" }),
      createFile({ path: "src/latest.txt" }),
    ];
    let resolveSlowDetail!: (detail: ConflictDetailResponse) => void;
    const api = createApi({
      conflictDetail: vi.fn(({ path }) => {
        const file = files.find((candidate) => candidate.path === path)!;
        if (path === "src/slow.txt") {
          return new Promise<ConflictDetailResponse>((resolve) => {
            resolveSlowDetail = resolve;
          });
        }
        return Promise.resolve(createResolvedTextDetail(file));
      }),
      listConflicts: vi.fn(async () => ({
        files,
        operation: mergeOperation,
      })),
    });

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent(files)}
        onClose={vi.fn()}
      />,
    );

    const conflictList = screen.getByTestId("conflict-file-list");
    await screen.findByLabelText("Resolved file content");
    fireEvent.click(
      within(conflictList).getByText("src/slow.txt").closest("button")!,
    );

    expect(await screen.findByText("Loading conflict details")).toBeVisible();
    expect(screen.queryByLabelText("Resolved file content")).toBeNull();

    fireEvent.click(
      within(conflictList).getByText("src/latest.txt").closest("button")!,
    );
    const comparison = await screen.findByLabelText("File comparison");
    expect(within(comparison).getByText("src/latest.txt")).toBeVisible();

    await act(async () => {
      resolveSlowDetail(createResolvedTextDetail(files[1]!));
    });

    expect(within(comparison).getByText("src/latest.txt")).toBeVisible();
    expect(within(comparison).queryByText("src/slow.txt")).toBeNull();
  });

  it("freezes conflict selection and pagination while a write is running", async () => {
    const files = Array.from({ length: 201 }, (_, index) =>
      createFile({ path: `src/write-${String(index).padStart(3, "0")}.txt` }),
    );
    let resolveSelection!: (value: { files: ConflictFile[] }) => void;
    const api = createApi({
      conflictDetail: vi.fn(async ({ path }) =>
        createResolvedTextDetail(
          files.find((file) => file.path === path) ?? files[0]!,
        ),
      ),
      listConflicts: vi.fn(async () => ({
        files,
        operation: mergeOperation,
      })),
      selectConflictSide: vi.fn(
        () =>
          new Promise<{ files: ConflictFile[] }>((resolve) => {
            resolveSelection = resolve;
          }),
      ),
    });

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent(files)}
        onClose={vi.fn()}
      />,
    );

    await screen.findByLabelText("Resolved file content");
    fireEvent.click(screen.getByTestId("conflict-use-own"));
    await waitFor(() =>
      expect(api.selectConflictSide).toHaveBeenCalledTimes(1),
    );
    const selectionRequest = vi.mocked(api.selectConflictSide).mock
      .calls[0]![0];
    expect(selectionRequest.paths).toEqual([files[0]!.path]);
    expect(selectionRequest.operationId).toMatch(/^conflict-select-/);

    const conflictList = screen.getByTestId("conflict-file-list");
    const rows = within(conflictList).getAllByTestId("conflict-file-row");
    expect(rows[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: "Select all" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Invert selection" }),
    ).toBeDisabled();
    expect(screen.getByTestId("conflict-next-page")).toBeDisabled();

    fireEvent.click(rows[1]);
    expect(api.conflictDetail).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("conflict-cancel-active-operation"));
    await waitFor(() => {
      expect(api.cancelOperation).toHaveBeenCalledWith({
        operationId: selectionRequest.operationId,
      });
    });

    await act(async () => {
      resolveSelection({ files: [] });
    });
    await waitFor(() =>
      expect(screen.getByTestId("conflict-next-page")).toBeEnabled(),
    );
  });

  it("paginates large conflict lists instead of rendering every row", async () => {
    const files = Array.from({ length: 1_000 }, (_, index) =>
      createFile({
        path: `src/conflict-${String(index).padStart(4, "0")}.txt`,
      }),
    );
    const api = createApi({
      conflictDetail: vi.fn(async ({ path }) =>
        createTextDetail(files.find((file) => file.path === path) ?? files[0]!),
      ),
      listConflicts: vi.fn(async () => ({
        files,
        operation: mergeOperation,
      })),
    });

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent(files)}
        onClose={vi.fn()}
      />,
    );

    await screen.findByLabelText("Resolved file content");
    const conflictList = screen.getByTestId("conflict-file-list");
    expect(
      within(conflictList).getAllByTestId("conflict-file-row"),
    ).toHaveLength(200);
    expect(
      within(conflictList).queryByText("src/conflict-0200.txt"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Page 1 of 5")).toBeVisible();
    expect(screen.getByTestId("conflict-previous-page")).toBeDisabled();

    fireEvent.click(screen.getByTestId("conflict-next-page"));

    expect(
      within(conflictList).getAllByTestId("conflict-file-row"),
    ).toHaveLength(200);
    expect(
      within(conflictList).queryByText("src/conflict-0000.txt"),
    ).not.toBeInTheDocument();
    expect(
      within(conflictList).getByText("src/conflict-0200.txt"),
    ).toBeVisible();
    expect(screen.getByText("Page 2 of 5")).toBeVisible();
    expect(screen.getByTestId("conflict-previous-page")).toBeEnabled();
  });

  it("forwards the complete conflict error to the detailed error dialog", async () => {
    const file = createFile();
    const source = {
      category: "expected",
      git: {
        command: "git checkout --ours -- src/conflict.txt",
        exitCode: 1,
        stderr: "checkout failed with detailed diagnostics",
        stdout: "",
      },
      operation: "selectConflictSide",
      summary: "checkout failed",
    };
    const api = createApi({
      conflictDetail: vi.fn(async () => createTextDetail(file)),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
      selectConflictSide: vi.fn(async () => Promise.reject(source)),
    });
    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);

    renderWithProviders(
      <ConflictResolutionOverlay
        api={api}
        event={createEvent([file])}
        onClose={vi.fn()}
      />,
    );

    await screen.findByLabelText("Resolved file content");
    fireEvent.click(screen.getByTestId("conflict-use-own"));

    await waitFor(() => {
      expect(screen.getByText("checkout failed")).toBeVisible();
      expect(handleError).toHaveBeenCalledTimes(1);
    });
    expect((handleError.mock.calls[0]![0] as CustomEvent).detail).toBe(source);
    window.removeEventListener("artistic-git:error", handleError);
  });

  it("reports a real selection failure received after cancellation", async () => {
    const file = createFile();
    const source = {
      category: "unexpected",
      context: {
        operationId: "conflict-select-test",
        operationName: "selectConflictSide",
        repositoryPath: "/repo/art",
        windowLabel: "main",
      },
      git: {
        command: ["git", "checkout", "--ours", "--", file.path],
        exitCode: 1,
        stderr: "cleanup failed after cancellation",
        stdout: "",
      },
      summary: "conflict cleanup failed",
    };
    let rejectSelection: (reason: unknown) => void = () => undefined;
    const api = createApi({
      conflictDetail: vi.fn(async () => createTextDetail(file)),
      listConflicts: vi.fn(async () => ({
        files: [file],
        operation: mergeOperation,
      })),
      selectConflictSide: vi.fn(
        () =>
          new Promise<{ files: ConflictFile[] }>((_resolve, reject) => {
            rejectSelection = reject;
          }),
      ),
    });
    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);

    try {
      renderWithProviders(
        <ConflictResolutionOverlay
          api={api}
          event={createEvent([file])}
          onClose={vi.fn()}
        />,
      );

      await screen.findByLabelText("Resolved file content");
      fireEvent.click(screen.getByTestId("conflict-use-own"));
      await waitFor(() =>
        expect(api.selectConflictSide).toHaveBeenCalledTimes(1),
      );
      fireEvent.click(screen.getByTestId("conflict-cancel-active-operation"));
      await waitFor(() => expect(api.cancelOperation).toHaveBeenCalledTimes(1));
      await act(async () => rejectSelection(source));

      await waitFor(() => {
        expect(screen.getByText("conflict cleanup failed")).toBeVisible();
        expect(handleError).toHaveBeenCalledTimes(1);
      });
      expect((handleError.mock.calls[0]![0] as CustomEvent).detail).toBe(
        source,
      );
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
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

    let resolveCancel!: (value: { aborted: "merge" }) => void;
    const cancelApi = createApi({
      conflictDetail: vi.fn(async () => createResolvedTextDetail(file)),
      cancelConflictResolution: vi.fn(
        () =>
          new Promise<{ aborted: "merge" }>((resolve) => {
            resolveCancel = resolve;
          }),
      ),
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
    const cancelDialog = await screen.findByRole("dialog", {
      name: "Cancel conflict resolution",
    });
    fireEvent.click(
      within(cancelDialog).getByRole("button", { name: "Abort operation" }),
    );

    await waitFor(() => {
      expect(cancelApi.cancelConflictResolution).toHaveBeenCalledWith({
        operationId: "op-conflict",
        repositoryPath: "/repo/art",
      });
    });
    expect(
      within(cancelDialog).getByRole("button", { name: "Abort operation" }),
    ).toBeDisabled();
    expect(
      within(cancelDialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(cancelDialog).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(cancelDialog).toBeInTheDocument();
    expect(onCancelClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveCancel({ aborted: "merge" });
    });
    await waitFor(() => {
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
    cancelOperation: vi.fn(async () => ({ cancelled: true })),
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

function createOversizedTextDetail(file: ConflictFile): ConflictDetailResponse {
  return {
    detail: {
      kind: "oversizedText",
      maxPreviewBytes: 1024 * 1024,
      sizeBytes: String(2 * 1024 * 1024),
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
