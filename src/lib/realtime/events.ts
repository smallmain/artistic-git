import type { QueryClient } from "@tanstack/react-query";

import { listenAppEvent, type AppEventPayloads } from "@/lib/ipc/events";
import type {
  ConflictEnteredEvent,
  FetchStateEvent,
  OperationProgressEvent,
  RepoChangedEvent,
} from "@/lib/ipc/generated";
import { repoChangedQueryKeys, repoQueryKeys } from "@/lib/realtime/query-keys";

type AppEventListener = typeof listenAppEvent;
type RealtimeUnsubscribe = () => void;

export interface RealtimeEventBridgeOptions {
  listen?: AppEventListener;
  onConflictEntered?: (event: ConflictEnteredEvent) => void;
  onFetchState?: (event: FetchStateEvent) => void;
  onOperationProgress?: (event: OperationProgressEvent) => void;
  operationProgressFilter?: (event: OperationProgressEvent) => boolean;
  onRepoChanged?: (event: RepoChangedEvent) => void;
  queryClient: QueryClient;
}

export function invalidateRepoChangedQueries(
  queryClient: QueryClient,
  event: RepoChangedEvent,
): Promise<unknown[]> {
  return Promise.all(
    repoChangedQueryKeys(event).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

export function invalidateFetchStateQueries(
  queryClient: QueryClient,
  event: FetchStateEvent,
): Promise<unknown[]> {
  if (event.state !== "idle") {
    return Promise.resolve([]);
  }

  return Promise.all(
    [
      repoQueryKeys.summary(event.repositoryPath),
      repoQueryKeys.branches(event.repositoryPath),
      repoQueryKeys.history(event.repositoryPath),
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

export async function installRealtimeEventBridge({
  listen = listenAppEvent,
  onConflictEntered,
  onFetchState,
  onOperationProgress,
  operationProgressFilter,
  onRepoChanged,
  queryClient,
}: RealtimeEventBridgeOptions): Promise<RealtimeUnsubscribe> {
  const unlistenRepoChanged = await listen("repo-changed", (event) => {
    const payload = event.payload as AppEventPayloads["repo-changed"];

    onRepoChanged?.(payload);
    void invalidateRepoChangedQueries(queryClient, payload);
  });
  const unlistenConflictEntered = await listen("conflict-entered", (event) => {
    const payload = event.payload as AppEventPayloads["conflict-entered"];

    onConflictEntered?.(payload);
  });
  const unlistenFetchState = await listen("fetch-state", (event) => {
    const payload = event.payload as AppEventPayloads["fetch-state"];

    onFetchState?.(payload);
    void invalidateFetchStateQueries(queryClient, payload);
    window.dispatchEvent(
      new CustomEvent("artistic-git:fetch-state", { detail: payload }),
    );
  });
  const unlistenOperationProgress = await listen(
    "operation-progress",
    (event) => {
      const payload = event.payload as AppEventPayloads["operation-progress"];

      if (operationProgressFilter && !operationProgressFilter(payload)) {
        return;
      }
      onOperationProgress?.(payload);
    },
  );

  return () => {
    unlistenRepoChanged();
    unlistenConflictEntered();
    unlistenFetchState();
    unlistenOperationProgress();
  };
}
