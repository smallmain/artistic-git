import {
  emit,
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";

import { reportDesktopRuntimeError } from "@/lib/runtime-errors";

import type {
  ConflictEnteredEvent,
  ConfigChangeEvent,
  FetchStateEvent,
  OperationProgressEvent,
  RepoChangedEvent,
} from "./generated";
import type {
  UpdateInstallGateRequestEvent,
  UpdateInstallGateWindowResponseEvent,
  UpdateStatusEvent,
} from "./update-types";

export interface ConflictClearedEvent {
  repositoryPath: string;
}

export type AppEventName =
  | "repo-changed"
  | "operation-progress"
  | "fetch-state"
  | "conflict-entered"
  | "conflict-cleared"
  | "update-status"
  | "update-install-gate-request"
  | "update-install-gate-response"
  | "config-change";

export interface AppEventPayloads {
  "repo-changed": RepoChangedEvent;
  "operation-progress": OperationProgressEvent;
  "fetch-state": FetchStateEvent;
  "conflict-entered": ConflictEnteredEvent;
  "conflict-cleared": ConflictClearedEvent;
  "update-status": UpdateStatusEvent;
  "update-install-gate-request": UpdateInstallGateRequestEvent;
  "update-install-gate-response": UpdateInstallGateWindowResponseEvent;
  "config-change": ConfigChangeEvent;
}

export function listenAppEvent<TName extends AppEventName>(
  name: TName,
  handler: EventCallback<AppEventPayloads[TName]>,
): Promise<UnlistenFn> {
  return listenRuntimeEvent<AppEventPayloads[TName]>(name, handler);
}

export function emitAppEvent<TName extends AppEventName>(
  name: TName,
  payload: AppEventPayloads[TName],
): Promise<void> {
  if (!runtimeEventsAvailable()) {
    return Promise.resolve();
  }
  return emit(name, payload);
}

export function listenRuntimeEvent<T>(
  name: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  if (!runtimeEventsAvailable()) {
    return Promise.resolve(() => undefined);
  }
  guardRuntimeEventUnregister();
  return listen<T>(name, handler).then(createSafeUnlisten);
}

function runtimeEventsAvailable(): boolean {
  return isTauri() || import.meta.env.MODE === "test";
}

const unregisterGuardMarker = "__artisticGitMissingListenerGuard";

type RuntimeUnregisterListener = (event: string, eventId: number) => void;
type GuardedRuntimeUnregisterListener = RuntimeUnregisterListener & {
  [unregisterGuardMarker]?: true;
};

function guardRuntimeEventUnregister(): void {
  const internals = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const unregister = internals?.unregisterListener as
    GuardedRuntimeUnregisterListener | undefined;
  if (!unregister || unregister[unregisterGuardMarker]) {
    return;
  }

  // Tauri's generated callback dereferences stale event IDs during Strict Mode/HMR cleanup.
  // Ignoring only that lookup failure lets its subsequent backend unlisten still run.
  const guarded: GuardedRuntimeUnregisterListener = (event, eventId) => {
    try {
      unregister.call(internals, event, eventId);
    } catch (error) {
      if (!isMissingRuntimeListenerError(error)) {
        throw error;
      }
    }
  };
  guarded[unregisterGuardMarker] = true;
  internals.unregisterListener = guarded;
}

function createSafeUnlisten(unlisten: UnlistenFn): UnlistenFn {
  let active = true;

  return () => {
    if (!active) {
      return;
    }
    active = false;

    try {
      const result = (unlisten as () => unknown)();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error: unknown) => {
          if (!isMissingRuntimeListenerError(error)) {
            reportDesktopRuntimeError(error);
          }
        });
      }
    } catch (error) {
      if (!isMissingRuntimeListenerError(error)) {
        throw error;
      }
    }
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function isMissingRuntimeListenerError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("handlerId") &&
    error.message.toLowerCase().includes("undefined")
  );
}
