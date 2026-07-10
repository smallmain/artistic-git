import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import type { ConflictClearedEvent, listenAppEvent } from "@/lib/ipc/events";
import type {
  ConflictEnteredEvent,
  FetchStateEvent,
  OperationProgressEvent,
  RepoChangedEvent,
} from "@/lib/ipc/generated";
import { installRealtimeEventBridge } from "@/lib/realtime/events";

type AppEventListener = typeof listenAppEvent;
type RealtimeUnsubscribe = () => void;

interface RealtimeEventBridgeProps {
  listen?: AppEventListener;
  onConflictCleared?: (event: ConflictClearedEvent) => void;
  onConflictEntered?: (event: ConflictEnteredEvent) => void;
  onFetchState?: (event: FetchStateEvent) => void;
  onOperationProgress?: (event: OperationProgressEvent) => void;
  operationProgressFilter?: (event: OperationProgressEvent) => boolean;
  onRepoChanged?: (event: RepoChangedEvent) => void;
}

export function RealtimeEventBridge({
  listen,
  onConflictCleared,
  onConflictEntered,
  onFetchState,
  onOperationProgress,
  operationProgressFilter,
  onRepoChanged,
}: RealtimeEventBridgeProps) {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    let active = true;
    let unsubscribe: RealtimeUnsubscribe | null = null;

    void installRealtimeEventBridge({
      listen,
      onConflictCleared,
      onConflictEntered,
      onFetchState,
      onOperationProgress,
      operationProgressFilter,
      onRepoChanged,
      queryClient,
    })
      .then((resolvedUnsubscribe) => {
        if (active) {
          unsubscribe = resolvedUnsubscribe;
        } else {
          resolvedUnsubscribe();
        }
      })
      .catch(() => {
        // The bridge is inert outside a Tauri event runtime, which keeps
        // browser-only tests and Storybook-style renders usable.
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [
    listen,
    onConflictCleared,
    onConflictEntered,
    onFetchState,
    onOperationProgress,
    operationProgressFilter,
    onRepoChanged,
    queryClient,
  ]);

  return null;
}
