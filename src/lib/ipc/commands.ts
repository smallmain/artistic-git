import { invoke } from "@tauri-apps/api/core";

import type {
  AcceptRemoteHistoryRequest,
  AcceptRemoteHistoryResponse,
  AppError,
  AppSettings,
  AbortRevertRequest,
  AbortRevertResponse,
  BranchListResponse,
  BranchNameValidationRequest,
  BranchNameValidationResponse,
  BranchOperationResponse,
  CancelCloneRepositoryRequest,
  CancelCloneRepositoryResponse,
  CancelStashRestoreRequest,
  CancelStashRestoreResponse,
  CheckoutBranchRequest,
  CloneRepositoryRequest,
  CloneRepositoryResponse,
  CommitRequest,
  CommitResponse,
  ConflictCancelRequest,
  ConflictCancelResponse,
  ConflictCompleteRequest,
  ConflictCompleteResponse,
  ConflictDetailResponse,
  ConflictListRequest,
  ConflictListResponse,
  ConflictPathRequest,
  ConflictSaveResolutionRequest,
  ConflictSaveResolutionResponse,
  ConflictSelectSideRequest,
  ConflictSelectSideResponse,
  CreateAutoStashRequest,
  CreateBranchRequest,
  CreateStashRequest,
  CreateStashResponse,
  DeleteBranchRequest,
  DeleteSafetyBackupRequest,
  DeleteSafetyBackupResponse,
  DeleteHttpsCredentialRequest,
  DeleteStashRequest,
  DeleteStashResponse,
  ExitReviewModeResponse,
  FetchRepositoryRequest,
  FetchRepositoryResponse,
  GenerateSshKeyRequest,
  GitignoreFileResponse,
  GitignoreRequest,
  HealthResponse,
  HttpsCredentialListResponse,
  IdentityValidationRequest,
  IdentityValidationResponse,
  LocalChangesResponse,
  LogPageRequest,
  LogPageResponse,
  LogSearchRequest,
  OpenLogDirResponse,
  OpenRepositoryRequest,
  OpenRepositoryResponse,
  ProjectSettings,
  ProjectSettingsRequest,
  RemoteSettingsResponse,
  RepositoryPathRequest,
  RepositorySummary,
  RestoreChangesRequest,
  RestoreChangesResponse,
  RestoreStashRequest,
  RestoreStashResponse,
  RevertCommitRequest,
  RevertCommitResponse,
  ReviewModeRecoveryRequest,
  ReviewModeRecoveryResponse,
  ReviewModeRequest,
  SaveAppSettingsRequest,
  SaveGitignoreRequest,
  SaveProjectSettingsRequest,
  SaveRemoteSettingsRequest,
  SafetyBackupListResponse,
  SettingsSnapshot,
  SshKeyStatus,
  StashDetailsRequest,
  StashDetailsResponse,
  StashListResponse,
  StartReviewModeRequest,
  StartReviewModeResponse,
  SyncAllBranchesRequest,
  SyncAllBranchesResponse,
  SyncBranchRequest,
  SyncBranchResponse,
  SyncCurrentBranchRequest,
  SyncCurrentBranchResponse,
  SyncReviewModeResponse,
} from "./generated";
import type {
  UpdateCheckRequest,
  UpdateInstallGateResponse,
  UpdateStatusEvent,
} from "./update-types";

export interface AppCommandArgs {
  health: undefined;
  window_context: undefined;
  new_project_window: undefined;
  open_repository_window: { request: OpenRepositoryWindowRequest };
  register_window_repository: { request: OpenRepositoryWindowRequest };
  save_window_geometry: { request: OpenRepositoryWindowRequest };
  close_current_window: undefined;
  set_window_close_guard: { request: WindowCloseGuardRequest };
  cancel_pending_window_exit: undefined;
  inject_renderer_crash: { request: RendererCrashInjectionRequest };
  open_log_dir: undefined;
  open_repository: { request: OpenRepositoryRequest };
  clone_repository: { request: CloneRepositoryRequest };
  cancel_clone_repository: { request: CancelCloneRepositoryRequest };
  repository_summary: { request: RepositoryPathRequest };
  fetch_repository: { request: FetchRepositoryRequest };
  sync_current_branch: { request: SyncCurrentBranchRequest };
  sync_branch: { request: SyncBranchRequest };
  sync_all_branches: { request: SyncAllBranchesRequest };
  accept_remote_history: { request: AcceptRemoteHistoryRequest };
  start_review_mode: { request: StartReviewModeRequest };
  sync_review_mode: { request: ReviewModeRequest };
  exit_review_mode: { request: ReviewModeRequest };
  review_mode_recovery: { request: ReviewModeRecoveryRequest };
  recover_review_mode_stash: { request: ReviewModeRecoveryRequest };
  dismiss_review_mode_recovery: { request: ReviewModeRecoveryRequest };
  load_remote_settings: { request: RepositoryPathRequest };
  save_remote_settings: { request: SaveRemoteSettingsRequest };
  list_branches: { request: RepositoryPathRequest };
  list_safety_backups: { request: RepositoryPathRequest };
  validate_branch_name: { request: BranchNameValidationRequest };
  create_branch: { request: CreateBranchRequest };
  checkout_branch: { request: CheckoutBranchRequest };
  delete_branch: { request: DeleteBranchRequest };
  delete_safety_backup: { request: DeleteSafetyBackupRequest };
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
  list_conflicts: { request: ConflictListRequest };
  conflict_detail: { request: ConflictPathRequest };
  select_conflict_side: { request: ConflictSelectSideRequest };
  save_conflict_resolution: { request: ConflictSaveResolutionRequest };
  complete_conflict_resolution: { request: ConflictCompleteRequest };
  cancel_conflict_resolution: { request: ConflictCancelRequest };
  commit_changes: { request: CommitRequest };
  restore_changes: { request: RestoreChangesRequest };
  revert_commit: { request: RevertCommitRequest };
  abort_revert: { request: AbortRevertRequest };
  settings_snapshot: undefined;
  load_app_settings: undefined;
  save_app_settings: { request: SaveAppSettingsRequest };
  load_project_settings: { request: ProjectSettingsRequest };
  save_project_settings: { request: SaveProjectSettingsRequest };
  load_gitignore: { request: GitignoreRequest };
  save_gitignore: { request: SaveGitignoreRequest };
  ssh_key_status: undefined;
  generate_ssh_key: { request: GenerateSshKeyRequest };
  validate_identity_for_write: { request: IdentityValidationRequest };
  list_https_credentials: undefined;
  delete_https_credential: { request: DeleteHttpsCredentialRequest };
  check_for_updates: { request: UpdateCheckRequest };
  update_install_gate: undefined;
  install_ready_update: undefined;
}

export interface AppCommandResponses {
  health: HealthResponse;
  window_context: WindowContextResponse;
  new_project_window: NewWindowResponse;
  open_repository_window: OpenRepositoryWindowResponse;
  register_window_repository: WindowContextResponse;
  save_window_geometry: ProjectSettings;
  close_current_window: void;
  set_window_close_guard: void;
  cancel_pending_window_exit: void;
  inject_renderer_crash: void;
  open_log_dir: OpenLogDirResponse;
  open_repository: OpenRepositoryResponse;
  clone_repository: CloneRepositoryResponse;
  cancel_clone_repository: CancelCloneRepositoryResponse;
  repository_summary: RepositorySummary;
  fetch_repository: FetchRepositoryResponse;
  sync_current_branch: SyncCurrentBranchResponse;
  sync_branch: SyncBranchResponse;
  sync_all_branches: SyncAllBranchesResponse;
  accept_remote_history: AcceptRemoteHistoryResponse;
  start_review_mode: StartReviewModeResponse;
  sync_review_mode: SyncReviewModeResponse;
  exit_review_mode: ExitReviewModeResponse;
  review_mode_recovery: ReviewModeRecoveryResponse;
  recover_review_mode_stash: ExitReviewModeResponse;
  dismiss_review_mode_recovery: ReviewModeRecoveryResponse;
  load_remote_settings: RemoteSettingsResponse;
  save_remote_settings: RemoteSettingsResponse;
  list_branches: BranchListResponse;
  list_safety_backups: SafetyBackupListResponse;
  validate_branch_name: BranchNameValidationResponse;
  create_branch: BranchOperationResponse;
  checkout_branch: BranchOperationResponse;
  delete_branch: BranchOperationResponse;
  delete_safety_backup: DeleteSafetyBackupResponse;
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
  list_conflicts: ConflictListResponse;
  conflict_detail: ConflictDetailResponse;
  select_conflict_side: ConflictSelectSideResponse;
  save_conflict_resolution: ConflictSaveResolutionResponse;
  complete_conflict_resolution: ConflictCompleteResponse;
  cancel_conflict_resolution: ConflictCancelResponse;
  commit_changes: CommitResponse;
  restore_changes: RestoreChangesResponse;
  revert_commit: RevertCommitResponse;
  abort_revert: AbortRevertResponse;
  settings_snapshot: SettingsSnapshot;
  load_app_settings: AppSettings;
  save_app_settings: AppSettings;
  load_project_settings: ProjectSettings;
  save_project_settings: ProjectSettings;
  load_gitignore: GitignoreFileResponse;
  save_gitignore: GitignoreFileResponse;
  ssh_key_status: SshKeyStatus;
  generate_ssh_key: SshKeyStatus;
  validate_identity_for_write: IdentityValidationResponse;
  list_https_credentials: HttpsCredentialListResponse;
  delete_https_credential: void;
  check_for_updates: UpdateStatusEvent;
  update_install_gate: UpdateInstallGateResponse;
  install_ready_update: void;
}

export type AppCommandName = keyof AppCommandResponses;

export type OpenRepositoryWindowAction =
  "useCurrent" | "focusedExisting" | "created";

export interface WindowContextResponse {
  label: string;
  repositoryPath: string | null;
  pendingCrash: CrashDialogPayload | null;
}

export interface NewWindowResponse {
  label: string;
}

export interface OpenRepositoryWindowRequest {
  repositoryPath: string;
}

export interface WindowCloseGuardRequest {
  active: boolean;
}

export interface RendererCrashInjectionRequest {
  summary?: string | null;
}

export interface CrashDialogPayload {
  summary: string;
  details: string;
  source: "renderer" | "rustPanic";
  windowLabel: string | null;
}

export interface OpenRepositoryWindowResponse {
  action: OpenRepositoryWindowAction;
  label: string;
  repositoryPath: string;
}

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

export function windowContext(): Promise<WindowContextResponse> {
  return invokeAppCommand("window_context");
}

export function newProjectWindow(): Promise<NewWindowResponse> {
  return invokeAppCommand("new_project_window");
}

export function openRepositoryWindow(
  request: OpenRepositoryWindowRequest,
): Promise<OpenRepositoryWindowResponse> {
  return invokeAppCommand("open_repository_window", { request });
}

export function registerWindowRepository(
  request: OpenRepositoryWindowRequest,
): Promise<WindowContextResponse> {
  return invokeAppCommand("register_window_repository", { request });
}

export function saveWindowGeometry(
  request: OpenRepositoryWindowRequest,
): Promise<ProjectSettings> {
  return invokeAppCommand("save_window_geometry", { request });
}

export function closeCurrentWindow(): Promise<void> {
  return invokeAppCommand("close_current_window");
}

export function setWindowCloseGuard(
  request: WindowCloseGuardRequest,
): Promise<void> {
  return invokeAppCommand("set_window_close_guard", { request });
}

export function cancelPendingWindowExit(): Promise<void> {
  return invokeAppCommand("cancel_pending_window_exit");
}

export function injectRendererCrash(
  request: RendererCrashInjectionRequest = {},
): Promise<void> {
  return invokeAppCommand("inject_renderer_crash", { request });
}

export function openLogDir(): Promise<OpenLogDirResponse> {
  return invokeAppCommand("open_log_dir");
}

export function openRepository(
  request: OpenRepositoryRequest,
): Promise<OpenRepositoryResponse> {
  return invokeAppCommand("open_repository", { request });
}

export function cloneRepository(
  request: CloneRepositoryRequest,
): Promise<CloneRepositoryResponse> {
  return invokeAppCommand("clone_repository", { request });
}

export function cancelCloneRepository(
  request: CancelCloneRepositoryRequest,
): Promise<CancelCloneRepositoryResponse> {
  return invokeAppCommand("cancel_clone_repository", { request });
}

export function repositorySummary(
  request: RepositoryPathRequest,
): Promise<RepositorySummary> {
  return invokeAppCommand("repository_summary", { request });
}

export function fetchRepository(
  request: FetchRepositoryRequest,
): Promise<FetchRepositoryResponse> {
  return invokeAppCommand("fetch_repository", { request });
}

export function syncCurrentBranch(
  request: SyncCurrentBranchRequest,
): Promise<SyncCurrentBranchResponse> {
  return invokeAppCommand("sync_current_branch", { request });
}

export function syncBranch(
  request: SyncBranchRequest,
): Promise<SyncBranchResponse> {
  return invokeAppCommand("sync_branch", { request });
}

export function syncAllBranches(
  request: SyncAllBranchesRequest,
): Promise<SyncAllBranchesResponse> {
  return invokeAppCommand("sync_all_branches", { request });
}

export function acceptRemoteHistory(
  request: AcceptRemoteHistoryRequest,
): Promise<AcceptRemoteHistoryResponse> {
  return invokeAppCommand("accept_remote_history", { request });
}

export function startReviewMode(
  request: StartReviewModeRequest,
): Promise<StartReviewModeResponse> {
  return invokeAppCommand("start_review_mode", { request });
}

export function syncReviewMode(
  request: ReviewModeRequest,
): Promise<SyncReviewModeResponse> {
  return invokeAppCommand("sync_review_mode", { request });
}

export function exitReviewMode(
  request: ReviewModeRequest,
): Promise<ExitReviewModeResponse> {
  return invokeAppCommand("exit_review_mode", { request });
}

export function reviewModeRecovery(
  request: ReviewModeRecoveryRequest,
): Promise<ReviewModeRecoveryResponse> {
  return invokeAppCommand("review_mode_recovery", { request });
}

export function recoverReviewModeStash(
  request: ReviewModeRecoveryRequest,
): Promise<ExitReviewModeResponse> {
  return invokeAppCommand("recover_review_mode_stash", { request });
}

export function dismissReviewModeRecovery(
  request: ReviewModeRecoveryRequest,
): Promise<ReviewModeRecoveryResponse> {
  return invokeAppCommand("dismiss_review_mode_recovery", { request });
}

export function loadRemoteSettings(
  request: RepositoryPathRequest,
): Promise<RemoteSettingsResponse> {
  return invokeAppCommand("load_remote_settings", { request });
}

export function saveRemoteSettings(
  request: SaveRemoteSettingsRequest,
): Promise<RemoteSettingsResponse> {
  return invokeAppCommand("save_remote_settings", { request });
}

export function listBranches(
  request: RepositoryPathRequest,
): Promise<BranchListResponse> {
  return invokeAppCommand("list_branches", { request });
}

export function listSafetyBackups(
  request: RepositoryPathRequest,
): Promise<SafetyBackupListResponse> {
  return invokeAppCommand("list_safety_backups", { request });
}

export function validateBranchName(
  request: BranchNameValidationRequest,
): Promise<BranchNameValidationResponse> {
  return invokeAppCommand("validate_branch_name", { request });
}

export function createBranch(
  request: CreateBranchRequest,
): Promise<BranchOperationResponse> {
  return invokeAppCommand("create_branch", { request });
}

export function checkoutBranch(
  request: CheckoutBranchRequest,
): Promise<BranchOperationResponse> {
  return invokeAppCommand("checkout_branch", { request });
}

export function deleteBranch(
  request: DeleteBranchRequest,
): Promise<BranchOperationResponse> {
  return invokeAppCommand("delete_branch", { request });
}

export function deleteSafetyBackup(
  request: DeleteSafetyBackupRequest,
): Promise<DeleteSafetyBackupResponse> {
  return invokeAppCommand("delete_safety_backup", { request });
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

export function listConflicts(
  request: ConflictListRequest,
): Promise<ConflictListResponse> {
  return invokeAppCommand("list_conflicts", { request });
}

export function conflictDetail(
  request: ConflictPathRequest,
): Promise<ConflictDetailResponse> {
  return invokeAppCommand("conflict_detail", { request });
}

export function selectConflictSide(
  request: ConflictSelectSideRequest,
): Promise<ConflictSelectSideResponse> {
  return invokeAppCommand("select_conflict_side", { request });
}

export function saveConflictResolution(
  request: ConflictSaveResolutionRequest,
): Promise<ConflictSaveResolutionResponse> {
  return invokeAppCommand("save_conflict_resolution", { request });
}

export function completeConflictResolution(
  request: ConflictCompleteRequest,
): Promise<ConflictCompleteResponse> {
  return invokeAppCommand("complete_conflict_resolution", { request });
}

export function cancelConflictResolution(
  request: ConflictCancelRequest,
): Promise<ConflictCancelResponse> {
  return invokeAppCommand("cancel_conflict_resolution", { request });
}

export function commitChanges(request: CommitRequest): Promise<CommitResponse> {
  return invokeAppCommand("commit_changes", { request });
}

export function restoreChanges(
  request: RestoreChangesRequest,
): Promise<RestoreChangesResponse> {
  return invokeAppCommand("restore_changes", { request });
}

export function revertCommit(
  request: RevertCommitRequest,
): Promise<RevertCommitResponse> {
  return invokeAppCommand("revert_commit", { request });
}

export function abortRevert(
  request: AbortRevertRequest,
): Promise<AbortRevertResponse> {
  return invokeAppCommand("abort_revert", { request });
}

export function settingsSnapshot(): Promise<SettingsSnapshot> {
  return invokeAppCommand("settings_snapshot");
}

export function loadAppSettings(): Promise<AppSettings> {
  return invokeAppCommand("load_app_settings");
}

export function saveAppSettings(
  request: SaveAppSettingsRequest,
): Promise<AppSettings> {
  return invokeAppCommand("save_app_settings", { request });
}

export function loadProjectSettings(
  request: ProjectSettingsRequest,
): Promise<ProjectSettings> {
  return invokeAppCommand("load_project_settings", { request });
}

export function saveProjectSettings(
  request: SaveProjectSettingsRequest,
): Promise<ProjectSettings> {
  return invokeAppCommand("save_project_settings", { request });
}

export function loadGitignore(
  request: GitignoreRequest,
): Promise<GitignoreFileResponse> {
  return invokeAppCommand("load_gitignore", { request });
}

export function saveGitignore(
  request: SaveGitignoreRequest,
): Promise<GitignoreFileResponse> {
  return invokeAppCommand("save_gitignore", { request });
}

export function sshKeyStatus(): Promise<SshKeyStatus> {
  return invokeAppCommand("ssh_key_status");
}

export function generateSshKey(
  request: GenerateSshKeyRequest,
): Promise<SshKeyStatus> {
  return invokeAppCommand("generate_ssh_key", { request });
}

export function validateIdentityForWrite(
  request: IdentityValidationRequest,
): Promise<IdentityValidationResponse> {
  return invokeAppCommand("validate_identity_for_write", { request });
}

export function listHttpsCredentials(): Promise<HttpsCredentialListResponse> {
  return invokeAppCommand("list_https_credentials");
}

export function deleteHttpsCredential(
  request: DeleteHttpsCredentialRequest,
): Promise<void> {
  return invokeAppCommand("delete_https_credential", { request });
}

export function checkForUpdates(
  request: UpdateCheckRequest,
): Promise<UpdateStatusEvent> {
  return invokeAppCommand("check_for_updates", { request });
}

export function updateInstallGate(): Promise<UpdateInstallGateResponse> {
  return invokeAppCommand("update_install_gate");
}

export function installReadyUpdate(): Promise<void> {
  return invokeAppCommand("install_ready_update");
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
