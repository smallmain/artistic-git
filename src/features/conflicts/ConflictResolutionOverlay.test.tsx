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

    expect(screen.getByRole("button", { name: "Complete" })).toBeDisabled();
    expect(
      await screen.findByLabelText("Resolution content"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const hunk = screen.getByText("Conflict at line 1").closest("div");
    expect(hunk).not.toBeNull();
    fireEvent.click(
      within(hunk as HTMLElement).getByRole("button", { name: "Use own" }),
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.saveConflictResolution).toHaveBeenCalledWith({
        content: "own\n",
        path: "src/conflict.txt",
        pendingHunks: 0,
        repositoryPath: "/repo/art",
      });
    });
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

    expect(await screen.findByText(/Binary conflicts can only/)).toBeVisible();
    expect(
      screen.queryByLabelText("Resolution content"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Type")).toHaveLength(2);
    expect(screen.getAllByText("Size")).toHaveLength(2);
    expect(screen.getAllByText("Modified")).toHaveLength(2);
    expect(screen.getAllByText("image/png")).toHaveLength(2);
    expect(screen.getByText("512 byte")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Own version" })).toHaveAttribute(
      "src",
      "data:image/png;base64,AAAA",
    );

    const ownSide = screen.getByText("Own version").closest("section");
    expect(ownSide).not.toBeNull();
    fireEvent.click(
      within(ownSide as HTMLElement).getByRole("button", { name: "Choose" }),
    );

    await waitFor(() => {
      expect(api.selectConflictSide).toHaveBeenCalledWith({
        paths: ["assets/conflict.png"],
        repositoryPath: "/repo/art",
        side: "own",
      });
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

    expect(await screen.findByLabelText("Resolution content")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));

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

function createEvent(files: ConflictFile[]): ConflictEnteredEvent {
  return {
    files,
    operationId: "op-conflict",
    operationName: "Resolving merge",
    repositoryPath: "/repo/art",
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
  return {
    detail: {
      currentText: "own\nother\n",
      hunks: [
        {
          endLine: 2,
          endOffset: 10,
          id: 0,
          otherText: "other\n",
          ownText: "own\n",
          startLine: 1,
          startOffset: 0,
        },
      ],
      kind: "text",
      language: "ts",
      otherText: "other\n",
      ownText: "own\n",
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
