import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { AppEventName } from "@/lib/ipc/events";
import type {
  ConflictEnteredEvent,
  RepoChangedEvent,
} from "@/lib/ipc/generated";
import {
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

  it("subscribes to repo-changed and conflict-entered events", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const onRepoChanged = vi.fn();
    const onConflictEntered = vi.fn();
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

    const unsubscribe = await installRealtimeEventBridge({
      listen,
      onConflictEntered,
      onRepoChanged,
      queryClient,
    });

    handlers.get("repo-changed")?.({ payload });
    handlers.get("conflict-entered")?.({ payload: conflictPayload });

    expect(listen).toHaveBeenCalledWith("repo-changed", expect.any(Function));
    expect(listen).toHaveBeenCalledWith(
      "conflict-entered",
      expect.any(Function),
    );
    expect(onRepoChanged).toHaveBeenCalledWith(payload);
    expect(onConflictEntered).toHaveBeenCalledWith(conflictPayload);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["repository", "/repo/art", "summary"],
    });

    unsubscribe();

    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
