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
import type { UpdateStatusEvent } from "./update-types";

export type AppEventName =
  | "repo-changed"
  | "operation-progress"
  | "fetch-state"
  | "conflict-entered"
  | "update-status"
  | "config-change";

export interface AppEventPayloads {
  "repo-changed": RepoChangedEvent;
  "operation-progress": OperationProgressEvent;
  "fetch-state": FetchStateEvent;
  "conflict-entered": ConflictEnteredEvent;
  "update-status": UpdateStatusEvent;
  "config-change": ConfigChangeEvent;
}

export function listenAppEvent<TName extends AppEventName>(
  name: TName,
  handler: EventCallback<AppEventPayloads[TName]>,
): Promise<UnlistenFn> {
  return listen<AppEventPayloads[TName]>(name, handler);
}
