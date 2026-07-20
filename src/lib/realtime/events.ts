import type { QueryClient } from "@tanstack/react-query";

import {
  listenAppEvent,
  type AppEventPayloads,
  type ConflictClearedEvent,
} from "@/lib/ipc/events";
import type {
  ConflictEnteredEvent,
  FetchStateEvent,
  OperationProgressEvent,
  RepoChangedEvent,
} from "@/lib/ipc/generated";
import { repoChangedQueryKeys } from "@/lib/realtime/query-keys";

type AppEventListener = typeof listenAppEvent;
type RealtimeUnsubscribe = () => void;

export interface RealtimeEventBridgeOptions {
  listen?: AppEventListener;
  onConflictCleared?: (event: ConflictClearedEvent) => void;
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

export async function installRealtimeEventBridge({
  listen = listenAppEvent,
  onConflictCleared,
  onConflictEntered,
  onFetchState,
  onOperationProgress,
  operationProgressFilter,
  onRepoChanged,
  queryClient,
}: RealtimeEventBridgeOptions): Promise<RealtimeUnsubscribe> {
  const unlisteners: RealtimeUnsubscribe[] = [];
  try {
    unlisteners.push(
      await listen("repo-changed", (event) => {
        const payload = event.payload as AppEventPayloads["repo-changed"];

        onRepoChanged?.(payload);
        void invalidateRepoChangedQueries(queryClient, payload);
      }),
    );
    unlisteners.push(
      await listen("conflict-entered", (event) => {
        const payload = event.payload as AppEventPayloads["conflict-entered"];

        onConflictEntered?.(payload);
      }),
    );
    unlisteners.push(
      await listen("conflict-cleared", (event) => {
        const payload = event.payload as AppEventPayloads["conflict-cleared"];

        onConflictCleared?.(payload);
      }),
    );
    unlisteners.push(
      await listen("fetch-state", (event) => {
        const payload = event.payload as AppEventPayloads["fetch-state"];

        onFetchState?.(payload);
        window.dispatchEvent(
          new CustomEvent("artistic-git:fetch-state", { detail: payload }),
        );
      }),
    );
    unlisteners.push(
      await listen("operation-progress", (event) => {
        const payload = event.payload as AppEventPayloads["operation-progress"];

        if (operationProgressFilter && !operationProgressFilter(payload)) {
          return;
        }
        onOperationProgress?.(payload);
      }),
    );
  } catch (error) {
    for (const unlisten of unlisteners.toReversed()) {
      unlisten();
    }
    throw error;
  }

  return () => {
    for (const unlisten of unlisteners.toReversed()) {
      unlisten();
    }
  };
}
