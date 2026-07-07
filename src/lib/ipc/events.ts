import {
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

export type AppEventName =
  | "repo-changed"
  | "operation-progress"
  | "fetch-state"
  | "conflict-entered"
  | "config-change";

export interface AppEventPayloads {
  "repo-changed": RepoChangedEvent;
  "operation-progress": OperationProgressEvent;
  "fetch-state": FetchStateEvent;
  "conflict-entered": ConflictEnteredEvent;
  "config-change": ConfigChangeEvent;
}

export function listenAppEvent<TName extends AppEventName>(
  name: TName,
  handler: EventCallback<AppEventPayloads[TName]>,
): Promise<UnlistenFn> {
  return listen<AppEventPayloads[TName]>(name, handler);
}
