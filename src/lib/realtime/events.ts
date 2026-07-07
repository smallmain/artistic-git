import type { QueryClient } from "@tanstack/react-query";

import { listenAppEvent, type AppEventPayloads } from "@/lib/ipc/events";
import type { RepoChangedEvent } from "@/lib/ipc/generated";
import { repoChangedQueryKeys } from "@/lib/realtime/query-keys";

type AppEventListener = typeof listenAppEvent;
type RealtimeUnsubscribe = () => void;

export interface RealtimeEventBridgeOptions {
  listen?: AppEventListener;
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
  onRepoChanged,
  queryClient,
}: RealtimeEventBridgeOptions): Promise<RealtimeUnsubscribe> {
  const unlistenRepoChanged = await listen("repo-changed", (event) => {
    const payload = event.payload as AppEventPayloads["repo-changed"];

    onRepoChanged?.(payload);
    void invalidateRepoChangedQueries(queryClient, payload);
  });

  return () => {
    unlistenRepoChanged();
  };
}
