import { invoke } from "@tauri-apps/api/core";

import type { AppError, HealthResponse, OpenLogDirResponse } from "./generated";

export interface AppCommandArgs {
  health: undefined;
  open_log_dir: undefined;
}

export interface AppCommandResponses {
  health: HealthResponse;
  open_log_dir: OpenLogDirResponse;
}

export type AppCommandName = keyof AppCommandResponses;

export async function invokeCommand<TResponse>(
  command: string,
  args?: Record<string, unknown>,
): Promise<TResponse> {
  try {
    return await invoke<TResponse>(command, args);
  } catch (error) {
    throw normalizeIpcError(error);
  }
}

export function invokeAppCommand<TName extends AppCommandName>(
  command: TName,
  ...args: AppCommandArgs[TName] extends undefined
    ? [] | [undefined]
    : [AppCommandArgs[TName]]
): Promise<AppCommandResponses[TName]> {
  return invokeCommand<AppCommandResponses[TName]>(
    command,
    args[0] as Record<string, unknown> | undefined,
  );
}

export function health(): Promise<HealthResponse> {
  return invokeAppCommand("health");
}

export function openLogDir(): Promise<OpenLogDirResponse> {
  return invokeAppCommand("open_log_dir");
}

function normalizeIpcError(error: unknown): AppError | Error {
  if (isAppError(error)) {
    return error;
  }

  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "Unknown IPC error");
}

function isAppError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    "summary" in error &&
    "context" in error
  );
}
