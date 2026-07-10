import {
  emit,
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";

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
  return listen<AppEventPayloads[TName]>(name, handler);
}

export function emitAppEvent<TName extends AppEventName>(
  name: TName,
  payload: AppEventPayloads[TName],
): Promise<void> {
  return emit(name, payload);
}
