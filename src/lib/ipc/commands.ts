import { invoke } from "@tauri-apps/api/core";

import type {
  AppError,
  BranchListResponse,
  CancelStashRestoreRequest,
  CancelStashRestoreResponse,
  CreateAutoStashRequest,
  CreateStashRequest,
  CreateStashResponse,
  DeleteStashRequest,
  DeleteStashResponse,
  HealthResponse,
  LocalChangesResponse,
  LogPageRequest,
  LogPageResponse,
  LogSearchRequest,
  OpenLogDirResponse,
  OpenRepositoryRequest,
  OpenRepositoryResponse,
  RepositoryPathRequest,
  RepositorySummary,
  RestoreStashRequest,
  RestoreStashResponse,
  StashDetailsRequest,
  StashDetailsResponse,
  StashListResponse,
} from "./generated";

export interface AppCommandArgs {
  health: undefined;
  open_log_dir: undefined;
  open_repository: { request: OpenRepositoryRequest };
  repository_summary: { request: RepositoryPathRequest };
  list_branches: { request: RepositoryPathRequest };
  list_local_changes: { request: RepositoryPathRequest };
  list_stashes: { request: RepositoryPathRequest };
  create_stash: { request: CreateStashRequest };
  create_auto_stash: { request: CreateAutoStashRequest };
  stash_details: { request: StashDetailsRequest };
  restore_stash: { request: RestoreStashRequest };
  cancel_stash_restore: { request: CancelStashRestoreRequest };
  delete_stash: { request: DeleteStashRequest };
  log_page: { request: LogPageRequest };
  search_log: { request: LogSearchRequest };
}

export interface AppCommandResponses {
  health: HealthResponse;
  open_log_dir: OpenLogDirResponse;
  open_repository: OpenRepositoryResponse;
  repository_summary: RepositorySummary;
  list_branches: BranchListResponse;
  list_local_changes: LocalChangesResponse;
  list_stashes: StashListResponse;
  create_stash: CreateStashResponse;
  create_auto_stash: CreateStashResponse;
  stash_details: StashDetailsResponse;
  restore_stash: RestoreStashResponse;
  cancel_stash_restore: CancelStashRestoreResponse;
  delete_stash: DeleteStashResponse;
  log_page: LogPageResponse;
  search_log: LogPageResponse;
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

export function openRepository(
  request: OpenRepositoryRequest,
): Promise<OpenRepositoryResponse> {
  return invokeAppCommand("open_repository", { request });
}

export function repositorySummary(
  request: RepositoryPathRequest,
): Promise<RepositorySummary> {
  return invokeAppCommand("repository_summary", { request });
}

export function listBranches(
  request: RepositoryPathRequest,
): Promise<BranchListResponse> {
  return invokeAppCommand("list_branches", { request });
}

export function listLocalChanges(
  request: RepositoryPathRequest,
): Promise<LocalChangesResponse> {
  return invokeAppCommand("list_local_changes", { request });
}

export function listStashes(
  request: RepositoryPathRequest,
): Promise<StashListResponse> {
  return invokeAppCommand("list_stashes", { request });
}

export function createStash(
  request: CreateStashRequest,
): Promise<CreateStashResponse> {
  return invokeAppCommand("create_stash", { request });
}

export function createAutoStash(
  request: CreateAutoStashRequest,
): Promise<CreateStashResponse> {
  return invokeAppCommand("create_auto_stash", { request });
}

export function stashDetails(
  request: StashDetailsRequest,
): Promise<StashDetailsResponse> {
  return invokeAppCommand("stash_details", { request });
}

export function restoreStash(
  request: RestoreStashRequest,
): Promise<RestoreStashResponse> {
  return invokeAppCommand("restore_stash", { request });
}

export function cancelStashRestore(
  request: CancelStashRestoreRequest,
): Promise<CancelStashRestoreResponse> {
  return invokeAppCommand("cancel_stash_restore", { request });
}

export function deleteStash(
  request: DeleteStashRequest,
): Promise<DeleteStashResponse> {
  return invokeAppCommand("delete_stash", { request });
}

export function logPage(request: LogPageRequest): Promise<LogPageResponse> {
  return invokeAppCommand("log_page", { request });
}

export function searchLog(request: LogSearchRequest): Promise<LogPageResponse> {
  return invokeAppCommand("search_log", { request });
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
