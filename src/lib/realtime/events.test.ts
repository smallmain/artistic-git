import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { AppEventName, ConflictClearedEvent } from "@/lib/ipc/events";
import type {
  ConflictEnteredEvent,
  FetchStateEvent,
  OperationProgressEvent,
  RepoChangedEvent,
} from "@/lib/ipc/generated";
import {
  invalidateFetchStateQueries,
  installRealtimeEventBridge,
  invalidateRepoChangedQueries,
  repoChangedQueryKeys,
  repoQueryKeys,
} from "@/lib/realtime";

describe("realtime query invalidation", () => {
  it("maps repo-changed events to repository and query-kind keys", () => {
    const event: RepoChangedEvent = {
      changedQueries: ["summary", "localChanges", "history"],
      repositoryPath: "/repo/art",
    };

    expect(repoChangedQueryKeys(event)).toEqual([
      ["repository", "/repo/art", "summary"],
      ["repository", "/repo/art", "localChanges"],
      ["repository", "/repo/art", "history"],
    ]);
    expect(repoQueryKeys.branches("/repo/art")).toEqual([
      "repository",
      "/repo/art",
      "branches",
    ]);
  });

  it("invalidates only the changed repository query kinds", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    await invalidateRepoChangedQueries(queryClient, {
      changedQueries: ["branches", "stashes"],
      repositoryPath: "/repo/art",
    });

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ["repository", "/repo/art", "branches"],
    });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ["repository", "/repo/art", "stashes"],
    });
  });

  it("invalidates repository summary, branches, and history when fetch recovers", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    await invalidateFetchStateQueries(queryClient, {
      lastSuccessAt: "1760000000",
      message: null,
      repositoryPath: "/repo/art",
      state: "idle",
    });

    expect(invalidateQueries).toHaveBeenCalledTimes(3);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ["repository", "/repo/art", "summary"],
    });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ["repository", "/repo/art", "branches"],
    });
    expect(invalidateQueries).toHaveBeenNthCalledWith(3, {
      queryKey: ["repository", "/repo/art", "history"],
    });
  });

  it("does not invalidate repository data for offline fetch-state events", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    await invalidateFetchStateQueries(queryClient, {
      lastSuccessAt: "1760000000",
      message: "offline",
      repositoryPath: "/repo/art",
      state: "offline",
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("subscribes to repository, conflict, fetch, and operation events", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const onRepoChanged = vi.fn();
    const onConflictCleared = vi.fn();
    const onConflictEntered = vi.fn();
    const onFetchState = vi.fn();
    const onOperationProgress = vi.fn();
    const unlisten = vi.fn();
    const handlers = new Map<
      AppEventName,
      (event: { payload: unknown }) => void
    >();
    const listen = vi.fn(async (name, handler) => {
      handlers.set(name, handler);
      return unlisten;
    });
    const payload: RepoChangedEvent = {
      changedQueries: ["summary"],
      repositoryPath: "/repo/art",
    };
    const conflictPayload: ConflictEnteredEvent = {
      files: [],
      operationId: "op-1",
      operationName: "Rebase",
      repositoryPath: "/repo/art",
    };
    const conflictClearedPayload: ConflictClearedEvent = {
      repositoryPath: "/repo/art",
    };
    const fetchPayload: FetchStateEvent = {
      lastSuccessAt: null,
      message: "offline",
      repositoryPath: "/repo/art",
      state: "offline",
    };
    const progressPayload = {
      cancellable: false,
      label: "Updating submodules",
      operationId: "op-progress",
      progress: { kind: "indeterminate" as const },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };

    const unsubscribe = await installRealtimeEventBridge({
      listen,
      onConflictCleared,
      onConflictEntered,
      onFetchState,
      onOperationProgress,
      onRepoChanged,
      queryClient,
    });

    handlers.get("repo-changed")?.({ payload });
    handlers.get("conflict-entered")?.({ payload: conflictPayload });
    handlers.get("conflict-cleared")?.({ payload: conflictClearedPayload });
    handlers.get("fetch-state")?.({ payload: fetchPayload });
    handlers.get("operation-progress")?.({ payload: progressPayload });

    expect(listen).toHaveBeenCalledWith("repo-changed", expect.any(Function));
    expect(listen).toHaveBeenCalledWith(
      "conflict-entered",
      expect.any(Function),
    );
    expect(listen).toHaveBeenCalledWith(
      "conflict-cleared",
      expect.any(Function),
    );
    expect(listen).toHaveBeenCalledWith("fetch-state", expect.any(Function));
    expect(listen).toHaveBeenCalledWith(
      "operation-progress",
      expect.any(Function),
    );
    expect(onRepoChanged).toHaveBeenCalledWith(payload);
    expect(onConflictEntered).toHaveBeenCalledWith(conflictPayload);
    expect(onConflictCleared).toHaveBeenCalledWith(conflictClearedPayload);
    expect(onFetchState).toHaveBeenCalledWith(fetchPayload);
    expect(onOperationProgress).toHaveBeenCalledWith(progressPayload);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["repository", "/repo/art", "summary"],
    });

    unsubscribe();

    expect(unlisten).toHaveBeenCalledTimes(5);
  });

  it("filters operation-progress events before notifying listeners", async () => {
    const queryClient = new QueryClient();
    const onOperationProgress = vi.fn();
    const handlers = new Map<
      AppEventName,
      (event: { payload: unknown }) => void
    >();
    const listen = vi.fn(async (name, handler) => {
      handlers.set(name, handler);
      return vi.fn();
    });
    const ownProgress: OperationProgressEvent = {
      cancellable: false,
      label: "Own sync",
      operationId: "op-own",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    };
    const otherProgress: OperationProgressEvent = {
      cancellable: false,
      label: "Other sync",
      operationId: "op-other",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/other",
      windowLabel: "repo-2",
    };

    await installRealtimeEventBridge({
      listen,
      onOperationProgress,
      operationProgressFilter: (event) => event.repositoryPath === "/repo/art",
      queryClient,
    });

    handlers.get("operation-progress")?.({ payload: otherProgress });
    handlers.get("operation-progress")?.({ payload: ownProgress });

    expect(onOperationProgress).toHaveBeenCalledTimes(1);
    expect(onOperationProgress).toHaveBeenCalledWith(ownProgress);
  });
});
