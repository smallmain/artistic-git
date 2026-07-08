use artistic_git_contracts::{
    AcceptRemoteHistoryRequest, AcceptRemoteHistoryResponse, AppError, AppErrorCategory, AppResult,
    BranchExistence, BranchListResponse, BranchNameValidationRequest, BranchNameValidationResponse,
    BranchOperationResponse, BranchSummary, CancelCloneRepositoryRequest,
    CancelCloneRepositoryResponse, CancelOperationRequest, CancelOperationResponse,
    CancelStashRestoreRequest, CancelStashRestoreResponse, CheckoutBranchRequest,
    CloneRepositoryRequest, CloneRepositoryResponse, CommitSummary, CreateAutoStashRequest,
    CreateBranchRequest, CreateStashRequest, CreateStashResponse, DeleteBranchRequest,
    DeleteSafetyBackupRequest, DeleteSafetyBackupResponse, DeleteStashRequest, DeleteStashResponse,
    DiffAsset, DiffChangeKind, DiffContent, DiffFileKind, DiffPayload, FetchRepositoryRequest,
    FetchRepositoryResponse, FetchStateEvent, GitCommandError, IndexLockInfo, LfsContentStatus,
    LocalChange, LocalChangeSubmodule, LocalChangesRenormalizeSuggestion, LocalChangesResponse,
    LogPageRequest, LogPageResponse, LogSearchRequest, OpenRepositoryRequest,
    OpenRepositoryResponse, OperationId, OperationProgressEvent, ProgressState,
    RemoteSettingsResponse, RenormalizePreviewRequest, RenormalizePreviewResponse,
    RepositoryHeadState, RepositoryHealth, RepositoryMiddleState, RepositoryMiddleStateKind,
    RepositoryOpenWarning, RepositoryOpenWarningKind, RepositoryPathRequest, RepositoryRemote,
    RepositoryRemoteMode, RepositorySummary, RestoreStashRequest, RestoreStashResponse,
    SafetyBackupListResponse, SaveRemoteSettingsRequest, StashDetailsRequest, StashDetailsResponse,
    StashEntry, StashListResponse,
};
use artistic_git_core::config::{
    AppSettings, ConfigActor, GitUserSettings, ProjectSettings, WindowGeometry,
};
use artistic_git_core::diff_engine::{
    classify_diff_file, detect_image, parse_lfs_pointer, DiffChangeKind as CoreDiffChangeKind,
    DiffFileKind as CoreDiffFileKind, DiffFileProbe,
};
use artistic_git_core::keyring::{KeyringVault, SystemCredentialStore};
use artistic_git_git_runner::{
    parse_git_progress_line, CancelToken, GitCommandPlan, GitRunner, OperationBusy,
};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_LOG_LIMIT: usize = 200;
const MAX_LOG_LIMIT: usize = 200;
const TOOL_WORKTREE_PREFIX: &str = "artistic-git-";
const RENORMALIZE_SUGGESTION_THRESHOLD: usize = 1_000;
const RENORMALIZE_SUGGESTION_MIN_MODIFIED_PERCENT: usize = 80;
const RENORMALIZE_SUGGESTION_SAMPLE_LIMIT: usize = 8;

#[derive(Clone)]
pub struct RepositoryBackend {
    runner: GitRunner,
    config: Option<ConfigActor>,
    fetch_states: crate::fetch::FetchStateStore,
    cancellable_operations: Arc<CancellableOperationRegistry>,
    https_credentials: Arc<Mutex<crate::https_auth::HttpsCredentialFlow>>,
    auth_runtime: Option<crate::auth_ipc::AuthRuntime>,
}

#[derive(Debug, Default)]
struct CancellableOperationRegistry {
    operations: Mutex<BTreeMap<String, CancelToken>>,
}

impl CancellableOperationRegistry {
    fn register(
        self: &Arc<Self>,
        operation_id: &OperationId,
        token: CancelToken,
        operation_name: &str,
    ) -> AppResult<CancellableOperationGuard> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| operation_registry_error(operation_name))?;
        if operations.contains_key(operation_id.as_str()) {
            return Err(logged(AppError::expected(
                "operation is already registered",
                operation_name,
            )));
        }

        operations.insert(operation_id.as_str().to_owned(), token);
        Ok(CancellableOperationGuard {
            operation_id: operation_id.as_str().to_owned(),
            registry: Arc::clone(self),
        })
    }

    fn cancel(&self, operation_id: &OperationId) -> AppResult<bool> {
        let token = self
            .operations
            .lock()
            .map_err(|_| operation_registry_error("cancelOperation"))?
            .get(operation_id.as_str())
            .cloned();

        if let Some(token) = token {
            token.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn unregister(&self, operation_id: &str) {
        if let Ok(mut operations) = self.operations.lock() {
            operations.remove(operation_id);
        }
    }
}

#[derive(Debug)]
struct CancellableOperationGuard {
    operation_id: String,
    registry: Arc<CancellableOperationRegistry>,
}

impl Drop for CancellableOperationGuard {
    fn drop(&mut self) {
        self.registry.unregister(&self.operation_id);
    }
}

impl RepositoryBackend {
    pub fn new(runner: GitRunner, config: Option<ConfigActor>) -> Self {
        Self::with_auth_prompt_sinks(
            runner,
            config,
            Arc::new(crate::https_auth::CancellingHttpsCredentialPromptSink),
            Arc::new(crate::ssh_auth::CancellingSshPassphrasePromptSink),
        )
    }

    pub fn with_https_prompt_sink(
        runner: GitRunner,
        config: Option<ConfigActor>,
        prompt_sink: Arc<dyn crate::https_auth::HttpsCredentialPromptSink>,
    ) -> Self {
        let vault = KeyringVault::new(Arc::new(SystemCredentialStore::default()));
        Self::with_https_vault_and_prompt_sink(runner, config, vault, prompt_sink)
    }

    pub fn with_auth_prompt_sinks(
        runner: GitRunner,
        config: Option<ConfigActor>,
        https_prompt_sink: Arc<dyn crate::https_auth::HttpsCredentialPromptSink>,
        ssh_prompt_sink: Arc<dyn crate::ssh_auth::SshPassphrasePromptSink>,
    ) -> Self {
        let vault = KeyringVault::new(Arc::new(SystemCredentialStore::default()));
        Self::with_auth_vault_and_prompt_sinks(
            runner,
            config,
            vault,
            https_prompt_sink,
            ssh_prompt_sink,
        )
    }

    pub fn with_https_vault_and_prompt_sink(
        runner: GitRunner,
        config: Option<ConfigActor>,
        vault: KeyringVault,
        prompt_sink: Arc<dyn crate::https_auth::HttpsCredentialPromptSink>,
    ) -> Self {
        Self::with_auth_vault_and_prompt_sinks(
            runner,
            config,
            vault,
            prompt_sink,
            Arc::new(crate::ssh_auth::CancellingSshPassphrasePromptSink),
        )
    }

    pub fn with_auth_vault_and_prompt_sinks(
        runner: GitRunner,
        config: Option<ConfigActor>,
        vault: KeyringVault,
        https_prompt_sink: Arc<dyn crate::https_auth::HttpsCredentialPromptSink>,
        ssh_prompt_sink: Arc<dyn crate::ssh_auth::SshPassphrasePromptSink>,
    ) -> Self {
        let https_credentials = Arc::new(Mutex::new(crate::https_auth::HttpsCredentialFlow::new(
            vault.clone(),
        )));
        let auth_runtime = start_auth_runtime(
            &runner,
            config.clone(),
            Arc::clone(&https_credentials),
            vault,
            https_prompt_sink,
            crate::ssh_auth::SshPassphraseCache::new(),
            ssh_prompt_sink,
        );
        Self {
            runner,
            config,
            fetch_states: crate::fetch::FetchStateStore::default(),
            cancellable_operations: Arc::new(CancellableOperationRegistry::default()),
            https_credentials,
            auth_runtime,
        }
    }

    pub fn runner(&self) -> &GitRunner {
        &self.runner
    }

    pub fn open_repository(
        &self,
        request: OpenRepositoryRequest,
    ) -> AppResult<OpenRepositoryResponse> {
        open_repository(&self.runner, self.config.as_ref(), request)
    }

    pub fn open_repository_with_progress<F>(
        &self,
        request: OpenRepositoryRequest,
        progress: F,
    ) -> AppResult<OpenRepositoryResponse>
    where
        F: Fn(OperationProgressEvent),
    {
        open_repository_with_progress(&self.runner, self.config.as_ref(), request, progress)
    }

    pub fn clone_repository(
        &self,
        request: CloneRepositoryRequest,
    ) -> AppResult<CloneRepositoryResponse> {
        self.clone_repository_with_progress(request, |_| {})
    }

    pub fn clone_repository_with_progress<F>(
        &self,
        request: CloneRepositoryRequest,
        progress: F,
    ) -> AppResult<CloneRepositoryResponse>
    where
        F: Fn(OperationProgressEvent),
    {
        let operation_id = request.operation_id.clone();
        let token = CancelToken::new();
        let _operation_guard = operation_id
            .as_ref()
            .map(|operation_id| {
                self.cancellable_operations
                    .register(operation_id, token.clone(), "cloneRepository")
            })
            .transpose()?;

        crate::git_ops::with_auth_runtime_for_operation(
            self.auth_runtime.as_ref(),
            crate::auth_ipc::InteractionPolicy::interactive(),
            operation_id,
            None,
            || {
                clone_repository_with_cancel_and_progress(
                    &self.runner,
                    self.config.as_ref(),
                    request,
                    &token,
                    progress,
                )
            },
        )
    }

    pub fn cancel_clone_repository(
        &self,
        request: CancelCloneRepositoryRequest,
    ) -> AppResult<CancelCloneRepositoryResponse> {
        let response = self.cancel_operation(CancelOperationRequest {
            operation_id: request.operation_id,
        })?;
        Ok(CancelCloneRepositoryResponse {
            cancelled: response.cancelled,
        })
    }

    pub fn cancel_operation(
        &self,
        request: CancelOperationRequest,
    ) -> AppResult<CancelOperationResponse> {
        Ok(CancelOperationResponse {
            cancelled: self.cancellable_operations.cancel(&request.operation_id)?,
        })
    }

    pub fn repository_summary(
        &self,
        request: RepositoryPathRequest,
    ) -> AppResult<RepositorySummary> {
        repository_summary(&self.runner, request)
    }

    pub fn fetch_started_event(&self, repository_path: &str) -> FetchStateEvent {
        self.fetch_states.started_event(repository_path)
    }

    pub fn fetch_state_event(&self, repository_path: &str) -> FetchStateEvent {
        self.fetch_states.snapshot_event(repository_path)
    }

    pub fn fetch_repository(
        &self,
        request: FetchRepositoryRequest,
    ) -> AppResult<FetchRepositoryResponse> {
        crate::fetch::fetch_repository_with_auth(
            &self.runner,
            self.auth_runtime.as_ref(),
            &self.fetch_states,
            request,
        )
    }

    pub fn sync_current_branch(
        &self,
        request: artistic_git_contracts::SyncCurrentBranchRequest,
    ) -> AppResult<artistic_git_contracts::SyncCurrentBranchResponse> {
        let operation_id = request.operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        crate::git_ops::with_auth_runtime_for_operation(
            self.auth_runtime.as_ref(),
            crate::auth_ipc::InteractionPolicy::interactive(),
            operation_id,
            repository_path,
            || crate::sync_current_branch(&self.runner, request),
        )
    }

    pub fn sync_current_branch_with_progress<F>(
        &self,
        request: artistic_git_contracts::SyncCurrentBranchRequest,
        progress: F,
    ) -> AppResult<artistic_git_contracts::SyncCurrentBranchResponse>
    where
        F: Fn(OperationProgressEvent),
    {
        let operation_id = request.operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        crate::git_ops::with_auth_runtime_for_operation(
            self.auth_runtime.as_ref(),
            crate::auth_ipc::InteractionPolicy::interactive(),
            operation_id,
            repository_path,
            || crate::sync_current_branch_with_progress(&self.runner, request, progress),
        )
    }

    pub fn sync_branch(
        &self,
        request: artistic_git_contracts::SyncBranchRequest,
    ) -> AppResult<artistic_git_contracts::SyncBranchResponse> {
        let operation_id = request.operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        crate::git_ops::with_auth_runtime_for_operation(
            self.auth_runtime.as_ref(),
            crate::auth_ipc::InteractionPolicy::interactive(),
            operation_id,
            repository_path,
            || crate::sync_branch(&self.runner, request),
        )
    }

    pub fn sync_branch_with_progress<F>(
        &self,
        request: artistic_git_contracts::SyncBranchRequest,
        progress: F,
    ) -> AppResult<artistic_git_contracts::SyncBranchResponse>
    where
        F: Fn(OperationProgressEvent),
    {
        let operation_id = request.operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        crate::git_ops::with_auth_runtime_for_operation(
            self.auth_runtime.as_ref(),
            crate::auth_ipc::InteractionPolicy::interactive(),
            operation_id,
            repository_path,
            || crate::sync_branch_with_progress(&self.runner, request, progress),
        )
    }

    pub fn sync_all_branches_with_progress<F>(
        &self,
        request: artistic_git_contracts::SyncAllBranchesRequest,
        progress: F,
    ) -> AppResult<artistic_git_contracts::SyncAllBranchesResponse>
    where
        F: Fn(OperationProgressEvent),
    {
        let operation_id = request.operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        crate::git_ops::with_auth_runtime_for_operation(
            self.auth_runtime.as_ref(),
            crate::auth_ipc::InteractionPolicy::interactive(),
            operation_id,
            repository_path,
            || {
                crate::sync_all_branches_with_config(
                    &self.runner,
                    self.config.as_ref(),
                    request,
                    progress,
                )
            },
        )
    }

    pub fn accept_remote_history(
        &self,
        request: AcceptRemoteHistoryRequest,
    ) -> AppResult<AcceptRemoteHistoryResponse> {
        let operation_id = request.operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        crate::git_ops::with_auth_runtime_for_operation(
            self.auth_runtime.as_ref(),
            crate::auth_ipc::InteractionPolicy::interactive(),
            operation_id,
            repository_path,
            || crate::accept_remote_history(&self.runner, request),
        )
    }

    pub fn start_review_mode(
        &self,
        request: artistic_git_contracts::StartReviewModeRequest,
    ) -> AppResult<artistic_git_contracts::StartReviewModeResponse> {
        crate::start_review_mode_with_config(&self.runner, self.config.as_ref(), request)
    }

    pub fn sync_review_mode(
        &self,
        request: artistic_git_contracts::ReviewModeRequest,
    ) -> AppResult<artistic_git_contracts::SyncReviewModeResponse> {
        crate::sync_review_mode_with_lock(&self.runner, request)
    }

    pub fn exit_review_mode(
        &self,
        request: artistic_git_contracts::ReviewModeRequest,
    ) -> AppResult<artistic_git_contracts::ExitReviewModeResponse> {
        crate::exit_review_mode_with_config(&self.runner, self.config.as_ref(), request)
    }

    pub fn review_mode_recovery(
        &self,
        request: artistic_git_contracts::ReviewModeRecoveryRequest,
    ) -> AppResult<artistic_git_contracts::ReviewModeRecoveryResponse> {
        crate::review_mode_recovery(&self.runner, self.config.as_ref(), request)
    }

    pub fn recover_review_mode_stash(
        &self,
        request: artistic_git_contracts::ReviewModeRecoveryRequest,
    ) -> AppResult<artistic_git_contracts::ExitReviewModeResponse> {
        crate::recover_review_mode_stash_with_config(&self.runner, self.config.as_ref(), request)
    }

    pub fn dismiss_review_mode_recovery(
        &self,
        request: artistic_git_contracts::ReviewModeRecoveryRequest,
    ) -> AppResult<artistic_git_contracts::ReviewModeRecoveryResponse> {
        crate::dismiss_review_mode_recovery(self.config.as_ref(), request)
    }

    pub fn load_remote_settings(
        &self,
        request: RepositoryPathRequest,
    ) -> AppResult<RemoteSettingsResponse> {
        crate::remote::load_remote_settings(&self.runner, request.repository_path)
    }

    pub fn save_remote_settings(
        &self,
        request: SaveRemoteSettingsRequest,
    ) -> AppResult<RemoteSettingsResponse> {
        crate::remote::save_remote_settings(&self.runner, request)
    }

    pub fn list_branches(&self, request: RepositoryPathRequest) -> AppResult<BranchListResponse> {
        list_branches(&self.runner, request)
    }

    pub fn list_safety_backups(
        &self,
        request: RepositoryPathRequest,
    ) -> AppResult<SafetyBackupListResponse> {
        crate::branches::list_safety_backups(&self.runner, request)
    }

    pub fn validate_branch_name(
        &self,
        request: BranchNameValidationRequest,
    ) -> AppResult<BranchNameValidationResponse> {
        crate::branches::validate_branch_name(&self.runner, request)
    }

    pub fn create_branch(
        &self,
        request: CreateBranchRequest,
    ) -> AppResult<BranchOperationResponse> {
        crate::branches::create_branch(&self.runner, request)
    }

    pub fn checkout_branch(
        &self,
        request: CheckoutBranchRequest,
    ) -> AppResult<BranchOperationResponse> {
        crate::branches::checkout_branch(&self.runner, request)
    }

    pub fn delete_branch(
        &self,
        request: DeleteBranchRequest,
    ) -> AppResult<BranchOperationResponse> {
        crate::branches::delete_branch(&self.runner, request)
    }

    pub fn delete_safety_backup(
        &self,
        request: DeleteSafetyBackupRequest,
    ) -> AppResult<DeleteSafetyBackupResponse> {
        crate::delete_safety_backup_with_lock(&self.runner, request)
    }

    pub fn list_local_changes(
        &self,
        request: RepositoryPathRequest,
    ) -> AppResult<LocalChangesResponse> {
        list_local_changes(&self.runner, request)
    }

    pub fn preview_renormalize(
        &self,
        request: RenormalizePreviewRequest,
    ) -> AppResult<RenormalizePreviewResponse> {
        preview_renormalize(&self.runner, request)
    }

    pub fn list_stashes(&self, request: RepositoryPathRequest) -> AppResult<StashListResponse> {
        crate::stash::list_stashes(&self.runner, request)
    }

    pub fn create_stash(&self, request: CreateStashRequest) -> AppResult<CreateStashResponse> {
        crate::stash::create_stash(&self.runner, request)
    }

    pub fn create_auto_stash(
        &self,
        request: CreateAutoStashRequest,
    ) -> AppResult<CreateStashResponse> {
        crate::stash::create_auto_stash(&self.runner, request)
    }

    pub fn stash_details(&self, request: StashDetailsRequest) -> AppResult<StashDetailsResponse> {
        crate::stash::stash_details(&self.runner, request)
    }

    pub fn restore_stash(&self, request: RestoreStashRequest) -> AppResult<RestoreStashResponse> {
        crate::stash::restore_stash(&self.runner, request)
    }

    pub fn cancel_stash_restore(
        &self,
        request: CancelStashRestoreRequest,
    ) -> AppResult<CancelStashRestoreResponse> {
        crate::stash::cancel_stash_restore(&self.runner, request)
    }

    pub fn delete_stash(&self, request: DeleteStashRequest) -> AppResult<DeleteStashResponse> {
        crate::stash::delete_stash(&self.runner, request)
    }

    pub fn log_page(&self, request: LogPageRequest) -> AppResult<LogPageResponse> {
        log_page_with_cancel(&self.runner, request, &CancelToken::new())
    }

    pub fn search_log(&self, request: LogSearchRequest) -> AppResult<LogPageResponse> {
        search_log_with_cancel(&self.runner, request, &CancelToken::new())
    }

    pub fn commit_changes(
        &self,
        request: artistic_git_contracts::CommitRequest,
    ) -> AppResult<artistic_git_contracts::CommitResponse> {
        crate::commit_changes(&self.runner, request)
    }

    pub fn restore_changes(
        &self,
        request: artistic_git_contracts::RestoreChangesRequest,
    ) -> AppResult<artistic_git_contracts::RestoreChangesResponse> {
        crate::restore_changes(&self.runner, request)
    }

    pub fn revert_commit(
        &self,
        request: artistic_git_contracts::RevertCommitRequest,
    ) -> AppResult<artistic_git_contracts::RevertCommitResponse> {
        crate::revert_commit(&self.runner, request)
    }

    pub fn abort_revert(
        &self,
        request: artistic_git_contracts::AbortRevertRequest,
    ) -> AppResult<artistic_git_contracts::AbortRevertResponse> {
        crate::abort_revert(&self.runner, request)
    }

    pub fn settings_snapshot(&self) -> AppResult<crate::settings::SettingsSnapshot> {
        crate::settings::settings_snapshot(self.config.as_ref(), &self.runner)
    }

    pub fn load_app_settings(&self) -> AppResult<AppSettings> {
        crate::settings::load_app_settings(self.config.as_ref())
    }

    pub fn save_app_settings(
        &self,
        request: crate::settings::SaveAppSettingsRequest,
    ) -> AppResult<AppSettings> {
        crate::settings::save_app_settings(&self.runner, self.config.as_ref(), request)
    }

    pub fn load_project_settings(
        &self,
        request: crate::settings::ProjectSettingsRequest,
    ) -> AppResult<ProjectSettings> {
        crate::settings::load_project_settings(self.config.as_ref(), request)
    }

    pub fn save_project_settings(
        &self,
        request: crate::settings::SaveProjectSettingsRequest,
    ) -> AppResult<ProjectSettings> {
        crate::settings::save_project_settings(self.config.as_ref(), request)
    }

    pub fn save_project_window_geometry(
        &self,
        repository_path: String,
        window_geometry: WindowGeometry,
    ) -> AppResult<ProjectSettings> {
        crate::settings::save_project_window_geometry(
            self.config.as_ref(),
            repository_path,
            window_geometry,
        )
    }

    pub fn validate_identity_for_write(
        &self,
        request: crate::settings::IdentityValidationRequest,
    ) -> AppResult<crate::settings::IdentityValidationResponse> {
        crate::settings::validate_identity_for_write(&self.runner, request)
    }

    pub fn list_https_credentials(
        &self,
    ) -> AppResult<crate::https_auth::HttpsCredentialListResponse> {
        let flow = self
            .https_credentials
            .lock()
            .map_err(|_| credentials_registry_error("listHttpsCredentials"))?;
        flow.list_credentials()
            .map_err(|source| credentials_flow_error(source, "listHttpsCredentials"))
    }

    pub fn delete_https_credential(
        &self,
        request: crate::https_auth::DeleteHttpsCredentialRequest,
    ) -> AppResult<()> {
        let mut flow = self
            .https_credentials
            .lock()
            .map_err(|_| credentials_registry_error("deleteHttpsCredential"))?;
        flow.delete_credential(request)
            .map_err(|source| credentials_flow_error(source, "deleteHttpsCredential"))
    }

    pub fn save_https_credential(
        &self,
        request: crate::https_auth::SaveHttpsCredentialRequest,
    ) -> AppResult<crate::https_auth::HttpsCredentialEntry> {
        let mut flow = self
            .https_credentials
            .lock()
            .map_err(|_| credentials_registry_error("saveHttpsCredential"))?;
        flow.save_credential(request)
            .map_err(|source| credentials_flow_error(source, "saveHttpsCredential"))
    }
}

fn start_auth_runtime(
    runner: &GitRunner,
    config: Option<ConfigActor>,
    https_credentials: Arc<Mutex<crate::https_auth::HttpsCredentialFlow>>,
    ssh_keyring: KeyringVault,
    https_prompt_sink: Arc<dyn crate::https_auth::HttpsCredentialPromptSink>,
    ssh_passphrase_cache: crate::ssh_auth::SshPassphraseCache,
    ssh_prompt_sink: Arc<dyn crate::ssh_auth::SshPassphrasePromptSink>,
) -> Option<crate::auth_ipc::AuthRuntime> {
    let handler = move |context: crate::auth_ipc::AuthIpcRequestContext,
                        payload: artistic_git_helpers::HelperIpcPayload| {
        match payload {
            artistic_git_helpers::HelperIpcPayload::Credential { credential } => {
                let mut flow = match https_credentials.lock() {
                    Ok(flow) => flow,
                    Err(error) => {
                        return artistic_git_helpers::HelperIpcResponse::Error {
                            message: format!("HTTPS credential registry is poisoned: {error}"),
                        };
                    }
                };
                let prompt_sink = Arc::clone(&https_prompt_sink);
                let mut prompter = move |request| prompt_sink.prompt_https_credentials(request);
                match flow.handle_git_credential_request(
                    &credential,
                    context.interaction_policy,
                    &mut prompter,
                ) {
                    Ok(outcome) => outcome.response,
                    Err(error) => artistic_git_helpers::HelperIpcResponse::Error {
                        message: error.to_string(),
                    },
                }
            }
            artistic_git_helpers::HelperIpcPayload::Askpass { prompt } => {
                let remember_ssh_passphrase = match config.as_ref() {
                    Some(config) => match config.settings() {
                        Ok(settings) => settings.git.remember_ssh_passphrase,
                        Err(error) => {
                            return artistic_git_helpers::HelperIpcResponse::Error {
                                message: format!(
                                    "SSH passphrase settings could not be read: {error}"
                                ),
                            };
                        }
                    },
                    None => false,
                };

                handle_ssh_askpass_request(
                    &ssh_passphrase_cache,
                    &ssh_keyring,
                    ssh_prompt_sink.as_ref(),
                    context.interaction_policy,
                    remember_ssh_passphrase,
                    prompt,
                )
            }
        }
    };

    match crate::auth_ipc::AuthRuntime::start(runner, Arc::new(handler)) {
        Ok(runtime) => Some(runtime),
        Err(error) => {
            tracing::warn!(error = %error, "failed to start auth IPC runtime");
            None
        }
    }
}

fn handle_ssh_askpass_request(
    cache: &crate::ssh_auth::SshPassphraseCache,
    keyring: &KeyringVault,
    prompt_sink: &dyn crate::ssh_auth::SshPassphrasePromptSink,
    interaction_policy: crate::auth_ipc::InteractionPolicy,
    remember_ssh_passphrase: bool,
    prompt: String,
) -> artistic_git_helpers::HelperIpcResponse {
    match crate::ssh_auth::resolve_askpass_prompt(
        cache,
        Some(keyring),
        interaction_policy,
        remember_ssh_passphrase,
        prompt,
    ) {
        crate::ssh_auth::SshAskpassDecision::ReturnSecret { secret, .. } => {
            artistic_git_helpers::HelperIpcResponse::Askpass { secret }
        }
        crate::ssh_auth::SshAskpassDecision::PromptUser {
            key,
            prompt,
            remember_available,
        } => match prompt_sink.prompt_ssh_passphrase(
            crate::ssh_auth::SshPassphrasePromptRequest::new(&key, prompt, remember_available),
        ) {
            crate::ssh_auth::SshPassphrasePromptResult::Cancel => {
                artistic_git_helpers::HelperIpcResponse::Error {
                    message: format!("SSH passphrase entry for {} was cancelled", key.key_id),
                }
            }
            crate::ssh_auth::SshPassphrasePromptResult::Submit(submission) => {
                let remember = submission.remember && remember_available;
                match crate::ssh_auth::remember_prompted_passphrase(
                    cache,
                    Some(keyring),
                    &key,
                    submission.passphrase.clone(),
                    remember,
                ) {
                    Ok(()) => artistic_git_helpers::HelperIpcResponse::Askpass {
                        secret: submission.passphrase,
                    },
                    Err(error) => artistic_git_helpers::HelperIpcResponse::Error {
                        message: format!(
                            "SSH passphrase could not be saved for {}: {error}",
                            key.key_id
                        ),
                    },
                }
            }
        },
        crate::ssh_auth::SshAskpassDecision::Fail {
            reason,
            classification,
        } => artistic_git_helpers::HelperIpcResponse::Error {
            message: ssh_askpass_failure_message(reason, classification),
        },
    }
}

fn ssh_askpass_failure_message(
    reason: crate::ssh_auth::SshAskpassFailureReason,
    classification: crate::ssh_auth::SshAuthFailureClassification,
) -> String {
    let detail = match reason {
        crate::ssh_auth::SshAskpassFailureReason::PassphraseRequired => {
            "SSH key passphrase is required but this operation is non-interactive"
        }
        crate::ssh_auth::SshAskpassFailureReason::UnsupportedPrompt => {
            "SSH askpass prompt is not supported"
        }
        crate::ssh_auth::SshAskpassFailureReason::KeyringUnavailable => {
            "SSH passphrase keyring is unavailable"
        }
    };
    let class = match classification {
        crate::ssh_auth::SshAuthFailureClassification::ExpectedOffline => "expected offline",
        crate::ssh_auth::SshAuthFailureClassification::ExpectedAuthenticationFailure => {
            "expected authentication failure"
        }
    };
    format!("{detail} ({class})")
}

fn credentials_registry_error(operation_name: &str) -> AppError {
    logged(AppError::unexpected(
        "credential registry lock poisoned",
        operation_name,
    ))
}

fn credentials_flow_error(
    source: crate::https_auth::HttpsCredentialFlowError,
    operation_name: &str,
) -> AppError {
    logged(AppError::expected(source.to_string(), operation_name))
}

pub fn open_repository(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: OpenRepositoryRequest,
) -> AppResult<OpenRepositoryResponse> {
    open_repository_impl(runner, config, request, None, &|_| {}, true)
}

pub fn open_repository_with_progress<F>(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: OpenRepositoryRequest,
    progress: F,
) -> AppResult<OpenRepositoryResponse>
where
    F: Fn(OperationProgressEvent),
{
    let operation_id = open_operation_id();
    open_repository_impl(
        runner,
        config,
        request,
        Some(&operation_id),
        &progress,
        true,
    )
}

fn open_repository_impl(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: OpenRepositoryRequest,
    operation_id: Option<&OperationId>,
    progress: &dyn Fn(OperationProgressEvent),
    acquire_write_lock: bool,
) -> AppResult<OpenRepositoryResponse> {
    let input_path = PathBuf::from(request.path.trim());
    if input_path.as_os_str().is_empty() {
        return Err(logged(AppError::expected(
            "不是有效的 Git 项目",
            "openRepository",
        )));
    }

    let root = resolve_repository_root(runner, &input_path)?;
    let git_dir = git_path(runner, &root, ["rev-parse", "--git-dir"], "openRepository")?;
    let git_common_dir = git_path(
        runner,
        &root,
        ["rev-parse", "--git-common-dir"],
        "openRepository",
    )?;
    reject_unsupported_repository_type(runner, &root, &git_dir, &git_common_dir)?;

    let _permit = if acquire_write_lock {
        Some(
            runner
                .operation_concurrency()
                .try_begin_write()
                .map_err(open_busy_error)?,
        )
    } else {
        None
    };

    clean_tool_worktree_residue(&git_common_dir);
    crate::sync::cleanup_sync_worktree_residue(runner, &root);
    apply_tool_identity(
        runner,
        &root,
        request.tool_identity.as_ref(),
        "openRepository",
    )?;
    install_lfs_if_needed(runner, &root)?;
    update_submodules_after_checkout(runner, &root, "openRepository", operation_id, progress)?;

    let remotes = list_remotes(runner, &root)?;
    let remote_mode = remote_mode(&remotes);
    let health = inspect_health(runner, &root, &git_common_dir)?;
    let summary = build_summary(
        &root,
        remote_mode,
        remotes.iter().any(|remote| remote.is_origin),
        &health,
    );
    let warnings = open_warnings(&remotes, remote_mode, &health);

    if let Some(config) = config {
        let path = display_path(&root);
        let timestamp = unix_now_seconds().to_string();
        config
            .update_project(path.clone(), |project| {
                project.path = path.clone();
                project.last_opened_at = Some(timestamp);
            })
            .map_err(|source| {
                logged(AppError::unexpected(
                    format!("failed to record recently opened repository: {source}"),
                    "openRepository",
                ))
            })?;
    }

    Ok(OpenRepositoryResponse {
        repository_path: display_path(&root),
        git_dir: display_path(&git_dir),
        remote_mode,
        remotes,
        warnings,
        health,
        summary,
    })
}

pub fn clone_repository(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: CloneRepositoryRequest,
) -> AppResult<CloneRepositoryResponse> {
    clone_repository_with_cancel_and_progress(runner, config, request, &CancelToken::new(), |_| {})
}

pub fn clone_repository_with_cancel(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: CloneRepositoryRequest,
    cancel_token: &CancelToken,
) -> AppResult<CloneRepositoryResponse> {
    clone_repository_with_cancel_and_progress(runner, config, request, cancel_token, |_| {})
}

pub fn clone_repository_with_cancel_and_progress<F>(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: CloneRepositoryRequest,
    cancel_token: &CancelToken,
    progress: F,
) -> AppResult<CloneRepositoryResponse>
where
    F: Fn(OperationProgressEvent),
{
    let target = validate_clone_target(&request)?;
    let url = request.url.trim();
    if url.is_empty() {
        return Err(logged(AppError::expected(
            "repository URL is required",
            "cloneRepository",
        )));
    }

    let _permit = runner
        .operation_concurrency()
        .try_begin_write()
        .map_err(clone_busy_error)?;

    run_clone_command(
        runner,
        url,
        &target,
        cancel_token,
        request.operation_id.as_ref(),
        progress,
    )?;

    let repository = open_repository_impl(
        runner,
        config,
        OpenRepositoryRequest {
            path: display_path(&target.path),
            tool_identity: request.tool_identity,
        },
        None,
        &|_| {},
        false,
    )?;

    Ok(CloneRepositoryResponse { repository })
}

pub fn repository_summary(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<RepositorySummary> {
    let root = canonical_repository_path(&request.repository_path, "repositorySummary")?;
    let git_common_dir = git_path(
        runner,
        &root,
        ["rev-parse", "--git-common-dir"],
        "repositorySummary",
    )?;
    let remotes = list_remotes(runner, &root)?;
    let health = inspect_health(runner, &root, &git_common_dir)?;
    Ok(build_summary(
        &root,
        remote_mode(&remotes),
        remotes.iter().any(|remote| remote.is_origin),
        &health,
    ))
}

pub fn list_branches(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<BranchListResponse> {
    let root = canonical_repository_path(&request.repository_path, "listBranches")?;
    let current_branch = current_branch_name(runner, &root, "listBranches").ok();
    let output = git_stdout(
        runner,
        Some(&root),
        [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)",
            "refs/heads",
            "refs/remotes",
        ],
        "listBranches",
    )?;

    let mut merged = BTreeMap::<String, BranchAccumulator>::new();
    for line in output.lines() {
        let parts = line.split('\0').collect::<Vec<_>>();
        if parts.len() < 4 {
            continue;
        }

        let refname = parts[0];
        let oid = empty_to_none(parts[1]).map(str::to_owned);
        let commit_time = empty_to_none(parts[2]).map(str::to_owned);
        let upstream = empty_to_none(parts[3]).map(str::to_owned);

        if let Some(local) = refname.strip_prefix("refs/heads/") {
            if local.starts_with("backup/") {
                continue;
            }
            let entry = merged.entry(local.to_owned()).or_default();
            entry.local_oid = oid;
            entry.local_time = commit_time;
            entry.upstream = upstream;
        } else if let Some(remote) = refname.strip_prefix("refs/remotes/origin/") {
            if remote == "HEAD" || remote.starts_with("backup/") {
                continue;
            }
            let entry = merged.entry(remote.to_owned()).or_default();
            entry.remote_oid = oid;
            entry.remote_time = commit_time;
        }
    }

    let mut branches = merged
        .into_iter()
        .map(|(short_name, entry)| {
            branch_summary(runner, &root, current_branch.as_deref(), short_name, entry)
        })
        .collect::<AppResult<Vec<_>>>()?;

    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| {
                right
                    .latest_commit_unix_seconds
                    .cmp(&left.latest_commit_unix_seconds)
            })
            .then_with(|| left.short_name.cmp(&right.short_name))
    });

    Ok(BranchListResponse { branches })
}

pub fn list_local_changes(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<LocalChangesResponse> {
    let root = canonical_repository_path(&request.repository_path, "listLocalChanges")?;
    let mut changes = list_local_changes_for_repository(runner, &root, None)?;

    if repository_has_submodules(&root) {
        for submodule_root in initialized_submodule_paths(runner, &root, "listLocalChanges")? {
            let Some(submodule_path) = repository_relative_display_path(&root, &submodule_root)
            else {
                continue;
            };
            let submodule = LocalChangeSubmodule {
                name: submodule_path.clone(),
                path: submodule_path,
            };
            changes.extend(list_local_changes_for_repository(
                runner,
                &submodule_root,
                Some(submodule),
            )?);
        }
    }

    sort_local_changes(&mut changes);
    let renormalize_suggestion = renormalize_suggestion_for_changes(&changes);
    Ok(LocalChangesResponse {
        changes,
        renormalize_suggestion,
    })
}

fn list_local_changes_for_repository(
    runner: &GitRunner,
    root: &Path,
    submodule: Option<LocalChangeSubmodule>,
) -> AppResult<Vec<LocalChange>> {
    let output = git_output_bytes(
        runner,
        Some(root),
        ["status", "--porcelain=v1", "-z", "--find-renames"],
        "listLocalChanges",
    )?;
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect::<Vec<_>>();

    let mut changes = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let entry = &fields[index];
        if entry.len() < 3 {
            index += 1;
            continue;
        }

        let index_status = entry[0..1].to_owned();
        let worktree_status = entry[1..2].to_owned();
        let path = entry[3..].to_owned();
        let mut old_path = None;
        if index_status == "R" || worktree_status == "R" {
            index += 1;
            old_path = fields.get(index).cloned();
        }

        let change_kind = local_change_kind(&index_status, &worktree_status);
        if should_skip_uncommitted_submodule_directory_change(
            runner,
            root,
            &path,
            old_path.as_deref(),
            &index_status,
            &worktree_status,
        )? {
            index += 1;
            continue;
        }

        let (payload, diff) = local_change_diff(
            runner,
            root,
            &path,
            old_path.as_deref(),
            change_kind,
            &index_status,
            &worktree_status,
        )?;

        let mut change = LocalChange {
            change_kind,
            diff,
            path,
            old_path,
            payload,
            index_status,
            worktree_status,
            submodule: None,
        };
        if let Some(submodule) = submodule.as_ref() {
            qualify_submodule_local_change(&mut change, submodule);
        }
        changes.push(change);
        index += 1;
    }

    Ok(changes)
}

fn qualify_submodule_local_change(change: &mut LocalChange, submodule: &LocalChangeSubmodule) {
    let inner_path = change.path.clone();
    let inner_old_path = change.old_path.clone();

    change.path = prefix_submodule_path(&submodule.path, &change.path);
    change.old_path = change
        .old_path
        .as_deref()
        .map(|path| prefix_submodule_path(&submodule.path, path));
    change.payload.new_path = prefix_submodule_path(&submodule.path, &change.payload.new_path);
    change.payload.old_path = change
        .payload
        .old_path
        .as_deref()
        .map(|path| prefix_submodule_path(&submodule.path, path));
    change
        .payload
        .metadata
        .insert("submodulePath".to_owned(), submodule.path.clone());
    change
        .payload
        .metadata
        .insert("submoduleName".to_owned(), submodule.name.clone());
    change
        .payload
        .metadata
        .insert("submoduleInnerPath".to_owned(), inner_path);
    if let Some(inner_old_path) = inner_old_path {
        change
            .payload
            .metadata
            .insert("submoduleInnerOldPath".to_owned(), inner_old_path);
    }
    change.submodule = Some(submodule.clone());
}

fn prefix_submodule_path(submodule_path: &str, path: &str) -> String {
    let submodule_path = submodule_path.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        submodule_path.to_owned()
    } else {
        format!("{submodule_path}/{path}")
    }
}

pub(crate) fn repository_relative_display_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn sort_local_changes(changes: &mut [LocalChange]) {
    changes.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.old_path.cmp(&right.old_path))
            .then_with(|| left.index_status.cmp(&right.index_status))
            .then_with(|| left.worktree_status.cmp(&right.worktree_status))
    });
}

fn should_skip_uncommitted_submodule_directory_change(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    old_path: Option<&str>,
    index_status: &str,
    worktree_status: &str,
) -> AppResult<bool> {
    let Some(old_gitlink) = gitlink_at_head(runner, root, old_path.unwrap_or(path))? else {
        return Ok(false);
    };

    if index_status != " " && index_status != "?" {
        match gitlink_at_index(runner, root, path)? {
            Some(index_gitlink) if index_gitlink.oid != old_gitlink.oid => return Ok(false),
            None => return Ok(false),
            _ => {}
        }
    }

    if worktree_status != " " {
        match gitlink_at_worktree_head(runner, root, path, "listLocalChanges")? {
            Some(worktree_gitlink) if worktree_gitlink.oid == old_gitlink.oid => {}
            _ => return Ok(false),
        }
    }

    Ok(true)
}

pub fn preview_renormalize(
    runner: &GitRunner,
    request: RenormalizePreviewRequest,
) -> AppResult<RenormalizePreviewResponse> {
    let root = canonical_repository_path(&request.repository_path, "previewRenormalize")?;
    let output = git_stdout(
        runner,
        Some(&root),
        ["add", "--renormalize", "--dry-run", "--", "."],
        "previewRenormalize",
    )?;
    let paths = parse_renormalize_dry_run_paths(&output);
    let sample_limit = request
        .sample_limit
        .unwrap_or(RENORMALIZE_SUGGESTION_SAMPLE_LIMIT as u32)
        .max(1) as usize;
    let total_paths = paths.len() as u32;
    let sample_paths = paths.into_iter().take(sample_limit).collect::<Vec<_>>();
    let truncated = total_paths as usize > sample_paths.len();
    Ok(RenormalizePreviewResponse {
        total_paths,
        sample_paths,
        truncated,
    })
}

fn renormalize_suggestion_for_changes(
    changes: &[LocalChange],
) -> Option<LocalChangesRenormalizeSuggestion> {
    let root_changes = changes.iter().filter(|change| change.submodule.is_none());
    let total = root_changes.clone().count();
    let modified = changes
        .iter()
        .filter(|change| {
            change.submodule.is_none()
                && change.change_kind == DiffChangeKind::Modified
                && change.index_status.trim().is_empty()
                && change.worktree_status == "M"
        })
        .count();

    if !should_suggest_renormalize(total, modified) {
        return None;
    }

    Some(LocalChangesRenormalizeSuggestion {
        total_changes: total as u32,
        modified_changes: modified as u32,
        threshold: RENORMALIZE_SUGGESTION_THRESHOLD as u32,
        sample_paths: changes
            .iter()
            .filter(|change| {
                change.submodule.is_none()
                    && change.change_kind == DiffChangeKind::Modified
                    && change.index_status.trim().is_empty()
                    && change.worktree_status == "M"
            })
            .take(RENORMALIZE_SUGGESTION_SAMPLE_LIMIT)
            .map(|change| change.path.clone())
            .collect(),
    })
}

fn should_suggest_renormalize(total: usize, modified: usize) -> bool {
    total >= RENORMALIZE_SUGGESTION_THRESHOLD
        && modified * 100 >= total * RENORMALIZE_SUGGESTION_MIN_MODIFIED_PERCENT
}

fn parse_renormalize_dry_run_paths(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let (_, path) = trimmed.split_once(' ')?;
            Some(
                path.trim()
                    .trim_matches('\'')
                    .trim_matches('"')
                    .replace("\\'", "'"),
            )
        })
        .filter(|path| !path.is_empty())
        .collect()
}

pub fn list_stashes(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<StashListResponse> {
    let root = canonical_repository_path(&request.repository_path, "listStashes")?;
    let output = match git_stdout(
        runner,
        Some(&root),
        ["stash", "list", "--format=%gd%x00%H%x00%ct%x00%gs%x1e"],
        "listStashes",
    ) {
        Ok(output) => output,
        Err(error) if is_empty_stash_error(&error) => String::new(),
        Err(error) => return Err(error),
    };

    let stashes = output
        .split('\x1e')
        .filter(|record| !record.trim().is_empty())
        .filter_map(parse_stash_record)
        .collect();

    Ok(StashListResponse { stashes })
}

pub fn log_page_with_cancel(
    runner: &GitRunner,
    request: LogPageRequest,
    cancel_token: &CancelToken,
) -> AppResult<LogPageResponse> {
    let root = canonical_repository_path(&request.repository_path, "logPage")?;
    let (limit, skip) = log_limit_and_skip(request.limit, request.after.as_deref());
    let mut args = vec![
        OsString::from("log"),
        OsString::from("--topo-order"),
        OsString::from("--parents"),
        OsString::from(format!("--max-count={}", limit + 1)),
        OsString::from(format!("--skip={skip}")),
        OsString::from("--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x1e"),
        OsString::from("--all"),
    ];

    run_log_command(
        runner,
        &root,
        args.drain(..),
        limit,
        skip,
        "logPage",
        cancel_token,
    )
}

pub fn search_log_with_cancel(
    runner: &GitRunner,
    request: LogSearchRequest,
    cancel_token: &CancelToken,
) -> AppResult<LogPageResponse> {
    let root = canonical_repository_path(&request.repository_path, "searchLog")?;
    let (limit, skip) = log_limit_and_skip(request.limit, request.after.as_deref());
    let mut args = vec![
        OsString::from("log"),
        OsString::from("--topo-order"),
        OsString::from("--parents"),
        OsString::from(format!("--max-count={}", limit + 1)),
        OsString::from(format!("--skip={skip}")),
        OsString::from("--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x1e"),
    ];

    if let Some(grep) = request.grep.filter(|value| !value.is_empty()) {
        args.push(OsString::from("--grep"));
        args.push(OsString::from(grep));
    }
    if let Some(author) = request.author.filter(|value| !value.is_empty()) {
        args.push(OsString::from("--author"));
        args.push(OsString::from(author));
    }
    if let Some(pickaxe) = request.pickaxe.filter(|value| !value.is_empty()) {
        args.push(OsString::from(format!("-S{pickaxe}")));
    }
    args.push(OsString::from("--all"));

    run_log_command(
        runner,
        &root,
        args.drain(..),
        limit,
        skip,
        "searchLog",
        cancel_token,
    )
}

fn validate_clone_target(request: &CloneRepositoryRequest) -> AppResult<CloneTarget> {
    let parent_directory = request.target_parent_directory.trim();
    if parent_directory.is_empty() {
        return Err(logged(AppError::expected(
            "target parent directory is required",
            "cloneRepository",
        )));
    }

    let parent = canonicalize_path(Path::new(parent_directory), "cloneRepository")?;
    if !parent.is_dir() {
        return Err(logged(AppError::expected(
            "target parent directory is not a directory",
            "cloneRepository",
        )));
    }

    let directory_name = validate_clone_directory_name(&request.directory_name)?;
    let path = parent.join(&directory_name);
    if fs::symlink_metadata(&path).is_ok() {
        return Err(logged(AppError::expected(
            "target directory already exists",
            "cloneRepository",
        )));
    }

    Ok(CloneTarget {
        parent,
        directory_name,
        path,
    })
}

fn validate_clone_directory_name(name: &str) -> AppResult<OsString> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(logged(AppError::expected(
            "target directory name is required",
            "cloneRepository",
        )));
    }

    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(component)), None) => Ok(component.to_owned()),
        _ => Err(logged(AppError::expected(
            "target directory name must be a single folder name",
            "cloneRepository",
        ))),
    }
}

fn run_clone_command<F>(
    runner: &GitRunner,
    url: &str,
    target: &CloneTarget,
    cancel_token: &CancelToken,
    operation_id: Option<&OperationId>,
    progress: F,
) -> AppResult<()>
where
    F: Fn(OperationProgressEvent),
{
    const OPERATION: &str = "cloneRepository";
    let repository_path = display_path(&target.path);

    if cancel_token.is_cancelled() {
        cleanup_clone_target(target);
        return Err(cancelled_error(OPERATION));
    }

    emit_clone_progress(
        operation_id,
        Some(repository_path.as_str()),
        &progress,
        "Cloning repository",
        ProgressState::Indeterminate,
    );

    let plan = runner
        .git_command_builder()
        .default_credential_helper()
        .enable_windows_longpaths()
        .args([
            OsString::from("clone"),
            OsString::from("--recurse-submodules"),
            OsString::from("--progress"),
            OsString::from(url),
            target.directory_name.clone(),
        ])
        .build();
    let plan = crate::git_ops::apply_auth_context_to_plan(plan, None, OPERATION)?;
    let mut command = plan.to_command();
    command.current_dir(&target.parent);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(&plan, source, OPERATION))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = stdout.map(spawn_output_reader);
    let (progress_tx, progress_rx) = mpsc::channel();
    let stderr_reader = stderr.map(|stderr| spawn_clone_stderr_reader(stderr, progress_tx));

    let status;
    loop {
        drain_clone_progress(
            operation_id,
            Some(repository_path.as_str()),
            &progress,
            &progress_rx,
        );
        if cancel_token.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.map(|reader| reader.join());
            let _ = stderr_reader.map(|reader| reader.join());
            cleanup_clone_target(target);
            return Err(cancelled_error(OPERATION));
        }
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                status = exit_status;
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => {
                let _ = stdout_reader.map(|reader| reader.join());
                let _ = stderr_reader.map(|reader| reader.join());
                cleanup_clone_target(target);
                return Err(spawn_error(&plan, source, OPERATION));
            }
        }
    }
    drain_clone_progress(
        operation_id,
        Some(repository_path.as_str()),
        &progress,
        &progress_rx,
    );

    let stdout = stdout_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let stderr = stderr_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    drain_clone_progress(
        operation_id,
        Some(repository_path.as_str()),
        &progress,
        &progress_rx,
    );

    let output = Output {
        status,
        stdout,
        stderr,
    };
    if output.status.success() {
        emit_clone_progress(
            operation_id,
            Some(repository_path.as_str()),
            &progress,
            "Clone complete",
            ProgressState::Percent { value: 100.0 },
        );
    }
    handle_clone_output(&plan, output, target)
}

fn handle_clone_output(
    plan: &GitCommandPlan,
    output: Output,
    target: &CloneTarget,
) -> AppResult<()> {
    if output.status.success() {
        Ok(())
    } else {
        let error = command_failure(plan, output, "cloneRepository");
        cleanup_clone_target(target);
        Err(error)
    }
}

fn spawn_output_reader<R>(mut reader: R) -> thread::JoinHandle<Vec<u8>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = Vec::new();
        let _ = reader.read_to_end(&mut output);
        output
    })
}

fn spawn_clone_stderr_reader<R>(
    mut reader: R,
    progress_tx: mpsc::Sender<String>,
) -> thread::JoinHandle<Vec<u8>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut stderr = Vec::new();
        let mut pending = String::new();
        let mut buffer = [0_u8; 1024];

        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(_) => break,
            };
            stderr.extend_from_slice(&buffer[..read]);

            for character in String::from_utf8_lossy(&buffer[..read]).chars() {
                if character == '\r' || character == '\n' {
                    let line = pending.trim().to_owned();
                    if !line.is_empty() {
                        let _ = progress_tx.send(line);
                    }
                    pending.clear();
                } else {
                    pending.push(character);
                }
            }
        }

        let line = pending.trim().to_owned();
        if !line.is_empty() {
            let _ = progress_tx.send(line);
        }

        stderr
    })
}

fn drain_clone_progress<F>(
    operation_id: Option<&OperationId>,
    repository_path: Option<&str>,
    progress: &F,
    progress_rx: &mpsc::Receiver<String>,
) where
    F: Fn(OperationProgressEvent),
{
    while let Ok(line) = progress_rx.try_recv() {
        emit_clone_progress(
            operation_id,
            repository_path,
            progress,
            clone_progress_label(&line),
            parse_git_progress_line(&line),
        );
    }
}

fn emit_clone_progress<F>(
    operation_id: Option<&OperationId>,
    repository_path: Option<&str>,
    progress: &F,
    label: impl Into<String>,
    progress_state: ProgressState,
) where
    F: Fn(OperationProgressEvent),
{
    let Some(operation_id) = operation_id else {
        return;
    };

    progress(OperationProgressEvent {
        operation_id: operation_id.clone(),
        label: label.into(),
        progress: progress_state,
        cancellable: true,
        repository_path: repository_path.map(ToOwned::to_owned),
        window_label: None,
    });
}

fn clone_progress_label(line: &str) -> &'static str {
    let lower = line.to_ascii_lowercase();
    if lower.contains("filtering content") || lower.contains("git-lfs") || lower.contains("lfs") {
        "Downloading LFS objects"
    } else if lower.contains("checking out files") || lower.contains("checkout") {
        "Checking out files"
    } else if lower.contains("submodule") {
        "Cloning submodules"
    } else {
        "Cloning repository"
    }
}

pub(crate) fn update_submodules_after_checkout<F>(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
    operation_id: Option<&OperationId>,
    progress: &F,
) -> AppResult<()>
where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    if !repository_has_submodules(root) {
        return Ok(());
    }
    let repository_path = display_path(root);

    emit_operation_progress(
        operation_id,
        Some(repository_path.as_str()),
        progress,
        "Updating submodules",
        ProgressState::Indeterminate,
        false,
    );

    let plan = runner
        .git_command_builder()
        .default_credential_helper()
        .enable_windows_longpaths()
        .args([
            OsString::from("-C"),
            root.as_os_str().to_owned(),
            OsString::from("submodule"),
            OsString::from("update"),
            OsString::from("--init"),
            OsString::from("--recursive"),
            OsString::from("--progress"),
        ])
        .build();
    let plan = crate::git_ops::apply_auth_context_to_plan(plan, Some(root), operation_name)?;
    run_command_with_progress(
        plan,
        operation_name,
        operation_id,
        Some(repository_path.as_str()),
        progress,
        submodule_progress_label,
    )?;

    pull_submodule_lfs_objects(
        runner,
        root,
        operation_name,
        operation_id,
        Some(repository_path.as_str()),
        progress,
    )?;

    emit_operation_progress(
        operation_id,
        Some(repository_path.as_str()),
        progress,
        "Submodules ready",
        ProgressState::Percent { value: 100.0 },
        false,
    );

    Ok(())
}

fn repository_has_submodules(root: &Path) -> bool {
    root.join(".gitmodules").is_file()
}

fn submodule_progress_label(line: &str) -> &'static str {
    let lower = line.to_ascii_lowercase();
    if lower.contains("filtering content") || lower.contains("git-lfs") || lower.contains("lfs") {
        "Downloading submodule LFS objects"
    } else {
        "Updating submodules"
    }
}

fn pull_submodule_lfs_objects<F>(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
    operation_id: Option<&OperationId>,
    repository_path: Option<&str>,
    progress: &F,
) -> AppResult<()>
where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    for submodule in initialized_submodule_paths(runner, root, operation_name)? {
        if !submodule_has_lfs_files(runner, &submodule, operation_name)? {
            continue;
        }

        emit_operation_progress(
            operation_id,
            repository_path,
            progress,
            "Downloading submodule LFS objects",
            ProgressState::Indeterminate,
            false,
        );
        run_git_lfs_for_submodule(runner, &submodule, ["install", "--local"], operation_name)?;
        run_git_lfs_for_submodule_with_progress(
            runner,
            &submodule,
            ["pull"],
            operation_name,
            operation_id,
            repository_path,
            progress,
        )?;
        run_git_lfs_for_submodule(runner, &submodule, ["checkout"], operation_name)?;
    }

    Ok(())
}

pub(crate) fn initialized_submodule_paths(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Vec<PathBuf>> {
    let output = git_stdout(
        runner,
        Some(root),
        [
            "submodule",
            "foreach",
            "--quiet",
            "--recursive",
            "printf '%s\t%s\n' \"$toplevel\" \"$sm_path\"",
        ],
        operation_name,
    )?;
    let mut paths = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let Some((toplevel, submodule_path)) = line.split_once('\t') else {
            continue;
        };
        let path = PathBuf::from(toplevel).join(submodule_path);
        paths.push(canonical_or_self(&path));
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn submodule_has_lfs_files(
    runner: &GitRunner,
    submodule: &Path,
    operation_name: &str,
) -> AppResult<bool> {
    let mut args = vec![OsString::from("-C"), submodule.as_os_str().to_owned()];
    args.push(OsString::from("ls-files"));
    let plan = runner.git_lfs_command_plan(args);
    let output = plan
        .to_command()
        .output()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
    if output.status.success() {
        Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
    } else {
        Err(command_failure(&plan, output, operation_name))
    }
}

fn run_git_lfs_for_submodule<I, S>(
    runner: &GitRunner,
    submodule: &Path,
    args: I,
    operation_name: &str,
) -> AppResult<()>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut planned_args = vec![OsString::from("-C"), submodule.as_os_str().to_owned()];
    planned_args.extend(args.into_iter().map(Into::into));
    let plan = runner.git_lfs_command_plan(planned_args);
    command_to_output(plan.to_command(), &plan, operation_name).map(|_| ())
}

fn run_git_lfs_for_submodule_with_progress<F, I, S>(
    runner: &GitRunner,
    submodule: &Path,
    args: I,
    operation_name: &str,
    operation_id: Option<&OperationId>,
    repository_path: Option<&str>,
    progress: &F,
) -> AppResult<()>
where
    F: Fn(OperationProgressEvent) + ?Sized,
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut planned_args = vec![OsString::from("-C"), submodule.as_os_str().to_owned()];
    planned_args.extend(args.into_iter().map(Into::into));
    let plan = runner.git_lfs_command_plan(planned_args);
    run_command_with_progress(
        plan,
        operation_name,
        operation_id,
        repository_path,
        progress,
        submodule_progress_label,
    )
}

fn run_command_with_progress<F>(
    plan: GitCommandPlan,
    operation_name: &str,
    operation_id: Option<&OperationId>,
    repository_path: Option<&str>,
    progress: &F,
    label_for_line: fn(&str) -> &'static str,
) -> AppResult<()>
where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    let mut command = plan.to_command();
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = stdout.map(spawn_output_reader);
    let (progress_tx, progress_rx) = mpsc::channel();
    let stderr_reader = stderr.map(|stderr| spawn_clone_stderr_reader(stderr, progress_tx));

    let status;
    loop {
        drain_operation_progress(
            operation_id,
            repository_path,
            progress,
            &progress_rx,
            label_for_line,
        );
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                status = exit_status;
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => {
                let _ = stdout_reader.map(|reader| reader.join());
                let _ = stderr_reader.map(|reader| reader.join());
                return Err(spawn_error(&plan, source, operation_name));
            }
        }
    }
    drain_operation_progress(
        operation_id,
        repository_path,
        progress,
        &progress_rx,
        label_for_line,
    );

    let stdout = stdout_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let stderr = stderr_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    drain_operation_progress(
        operation_id,
        repository_path,
        progress,
        &progress_rx,
        label_for_line,
    );

    let output = Output {
        status,
        stdout,
        stderr,
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(command_failure(&plan, output, operation_name))
    }
}

fn drain_operation_progress<F>(
    operation_id: Option<&OperationId>,
    repository_path: Option<&str>,
    progress: &F,
    progress_rx: &mpsc::Receiver<String>,
    label_for_line: fn(&str) -> &'static str,
) where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    while let Ok(line) = progress_rx.try_recv() {
        emit_operation_progress(
            operation_id,
            repository_path,
            progress,
            label_for_line(&line),
            parse_git_progress_line(&line),
            false,
        );
    }
}

fn emit_operation_progress<F>(
    operation_id: Option<&OperationId>,
    repository_path: Option<&str>,
    progress: &F,
    label: impl Into<String>,
    progress_state: ProgressState,
    cancellable: bool,
) where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    let Some(operation_id) = operation_id else {
        return;
    };

    progress(OperationProgressEvent {
        operation_id: operation_id.clone(),
        label: label.into(),
        progress: progress_state,
        cancellable,
        repository_path: repository_path.map(ToOwned::to_owned),
        window_label: None,
    });
}

fn cleanup_clone_target(target: &CloneTarget) {
    if target.path.is_dir() {
        let _ = fs::remove_dir_all(&target.path);
    }
}

fn clone_busy_error(error: OperationBusy) -> AppError {
    let summary = match error {
        OperationBusy::WriteBusy => "another write operation is already in progress",
        OperationBusy::BackgroundBusy => "a background operation is already in progress",
    };
    logged(AppError::expected(summary, "cloneRepository"))
}

fn open_busy_error(error: OperationBusy) -> AppError {
    let summary = match error {
        OperationBusy::WriteBusy => "another write operation is already in progress",
        OperationBusy::BackgroundBusy => "a background operation is already in progress",
    };
    logged(AppError::expected(summary, "openRepository"))
}

fn operation_registry_error(operation_name: &str) -> AppError {
    logged(AppError::unexpected(
        "operation registry is unavailable",
        operation_name,
    ))
}

fn open_operation_id() -> OperationId {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    OperationId(format!("open-repository-{millis}"))
}

fn resolve_repository_root(runner: &GitRunner, path: &Path) -> AppResult<PathBuf> {
    let output = run_git(
        runner,
        Some(path),
        ["rev-parse", "--show-toplevel"],
        "openRepository",
    )
    .map_err(|error| {
        if error.category == AppErrorCategory::Expected {
            logged(AppError::expected("不是有效的 Git 项目", "openRepository"))
        } else {
            error
        }
    })?;
    let root = PathBuf::from(output.stdout.trim());
    canonicalize_path(&root, "openRepository")
}

fn reject_unsupported_repository_type(
    runner: &GitRunner,
    root: &Path,
    git_dir: &Path,
    git_common_dir: &Path,
) -> AppResult<()> {
    let is_bare = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--is-bare-repository"],
        "openRepository",
    )?;
    let inside_work_tree = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--is-inside-work-tree"],
        "openRepository",
    )?;

    if is_bare.trim() == "true" || inside_work_tree.trim() != "true" {
        return Err(logged(AppError::expected(
            "不是受支持的 Git 项目类型",
            "openRepository",
        )));
    }

    if canonical_or_self(git_dir) != canonical_or_self(git_common_dir) {
        return Err(logged(AppError::expected(
            "不是受支持的 Git 项目类型",
            "openRepository",
        )));
    }

    Ok(())
}

fn apply_tool_identity(
    runner: &GitRunner,
    root: &Path,
    identity: Option<&artistic_git_contracts::ToolGitIdentity>,
    operation_name: &str,
) -> AppResult<()> {
    let Some(identity) = identity else {
        return Ok(());
    };

    if let Some(name) = identity.name.as_deref().filter(|value| !value.is_empty()) {
        write_local_config_if_changed(runner, root, "user.name", name, operation_name)?;
    }
    if let Some(email) = identity.email.as_deref().filter(|value| !value.is_empty()) {
        write_local_config_if_changed(runner, root, "user.email", email, operation_name)?;
    }

    Ok(())
}

pub fn apply_git_user_settings_to_repository(
    runner: &GitRunner,
    repository_path: &str,
    identity: &GitUserSettings,
    operation_name: &str,
) -> AppResult<()> {
    let root = canonical_repository_path(repository_path, operation_name)?;
    if let Some(name) = identity
        .name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        write_local_config_if_changed(runner, &root, "user.name", name.trim(), operation_name)?;
    }
    if let Some(email) = identity
        .email
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        write_local_config_if_changed(runner, &root, "user.email", email.trim(), operation_name)?;
    }

    Ok(())
}

pub fn read_local_git_identity(
    runner: &GitRunner,
    repository_path: &str,
    operation_name: &str,
) -> AppResult<GitUserSettings> {
    let root = canonical_repository_path(repository_path, operation_name)?;
    Ok(GitUserSettings {
        name: read_local_config(runner, &root, "user.name", operation_name),
        email: read_local_config(runner, &root, "user.email", operation_name),
    })
}

fn read_local_config(
    runner: &GitRunner,
    root: &Path,
    key: &str,
    operation_name: &str,
) -> Option<String> {
    git_stdout(
        runner,
        Some(root),
        ["config", "--local", "--get", key],
        operation_name,
    )
    .ok()
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty())
}

fn write_local_config_if_changed(
    runner: &GitRunner,
    root: &Path,
    key: &str,
    value: &str,
    operation_name: &str,
) -> AppResult<()> {
    let current = git_stdout(
        runner,
        Some(root),
        ["config", "--local", "--get", key],
        operation_name,
    )
    .ok()
    .map(|value| value.trim().to_owned());

    if current.as_deref() != Some(value) {
        git_stdout(
            runner,
            Some(root),
            ["config", "--local", key, value],
            operation_name,
        )?;
    }

    Ok(())
}

fn install_lfs_if_needed(runner: &GitRunner, root: &Path) -> AppResult<()> {
    if !repository_has_lfs_rules(root) {
        return Ok(());
    }

    let plan = runner.git_lfs_command_plan(["install", "--local"]);
    let mut command = plan.to_command();
    command.current_dir(root);
    command_to_output(command, &plan, "openRepository").map(|_| ())
}

fn clean_tool_worktree_residue(git_common_dir: &Path) {
    let worktrees = git_common_dir.join("worktrees");
    let Ok(entries) = fs::read_dir(worktrees) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(OsStr::to_str) else {
            continue;
        };
        if !name.starts_with(TOOL_WORKTREE_PREFIX) {
            continue;
        }

        let gitdir = path.join("gitdir");
        let remove = fs::read_to_string(&gitdir)
            .map(|target| !Path::new(target.trim()).exists())
            .unwrap_or(false);
        if remove {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn list_remotes(runner: &GitRunner, root: &Path) -> AppResult<Vec<RepositoryRemote>> {
    let output = git_stdout(runner, Some(root), ["remote", "-v"], "openRepository")?;
    let mut remotes = BTreeMap::<String, String>::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        let Some(url) = parts.next() else {
            continue;
        };
        let kind = parts.next().unwrap_or_default();
        if kind == "(fetch)" {
            remotes
                .entry(name.to_owned())
                .or_insert_with(|| url.to_owned());
        }
    }

    Ok(remotes
        .into_iter()
        .map(|(name, url)| {
            let is_origin = name == "origin";
            RepositoryRemote {
                name,
                url,
                is_origin,
                managed: is_origin,
            }
        })
        .collect())
}

fn remote_mode(remotes: &[RepositoryRemote]) -> RepositoryRemoteMode {
    if remotes.iter().any(|remote| remote.is_origin) {
        RepositoryRemoteMode::Origin
    } else {
        RepositoryRemoteMode::NoRemote
    }
}

fn open_warnings(
    remotes: &[RepositoryRemote],
    remote_mode: RepositoryRemoteMode,
    health: &RepositoryHealth,
) -> Vec<RepositoryOpenWarning> {
    let mut warnings = Vec::new();
    if remotes.len() > 1 && remote_mode == RepositoryRemoteMode::Origin {
        warnings.push(warning(
            RepositoryOpenWarningKind::MultipleRemotesOriginManaged,
            "检测到多个远程仓库；Artistic Git 仅管理 origin，其他远程保持只读展示。",
        ));
    } else if remotes.len() > 1 {
        warnings.push(warning(
            RepositoryOpenWarningKind::MultipleRemotesNoOrigin,
            "检测到多个远程仓库但没有 origin；已进入无远程模式。",
        ));
    } else if remotes.is_empty() {
        warnings.push(warning(
            RepositoryOpenWarningKind::NoRemote,
            "未配置远程仓库；已进入无远程模式。",
        ));
    }

    match health.head {
        RepositoryHeadState::Detached { .. } => warnings.push(warning(
            RepositoryOpenWarningKind::DetachedHead,
            "当前处于游离 HEAD 状态，可新建分支或切换到已有分支。",
        )),
        RepositoryHeadState::Unborn { .. } => warnings.push(warning(
            RepositoryOpenWarningKind::UnbornHead,
            "当前仓库还没有提交，历史为空，分支切换/删除暂不可用。",
        )),
        RepositoryHeadState::Branch { .. } => {}
    }

    if !health.middle_states.is_empty() {
        warnings.push(warning(
            RepositoryOpenWarningKind::OperationInProgress,
            "检测到外部 Git 操作中间态，请完成或放弃恢复后继续。",
        ));
    }
    if health.index_lock.is_some() {
        warnings.push(warning(
            RepositoryOpenWarningKind::IndexLockPresent,
            "检测到 .git/index.lock 残留；不会自动删除，需确认没有 Git 进程运行后手动处理。",
        ));
    }

    warnings
}

fn inspect_health(
    runner: &GitRunner,
    root: &Path,
    git_common_dir: &Path,
) -> AppResult<RepositoryHealth> {
    let head = inspect_head(runner, root)?;
    let middle_states = inspect_middle_states(git_common_dir);
    let index_lock = inspect_index_lock(git_common_dir);
    Ok(RepositoryHealth {
        head,
        middle_states,
        index_lock,
    })
}

fn inspect_head(runner: &GitRunner, root: &Path) -> AppResult<RepositoryHeadState> {
    if let Ok(branch) = current_branch_name(runner, root, "repositoryHealth") {
        let oid = git_stdout(
            runner,
            Some(root),
            ["rev-parse", "--verify", "HEAD"],
            "repositoryHealth",
        )
        .ok()
        .map(|value| value.trim().to_owned());
        return Ok(if let Some(oid) = oid {
            RepositoryHeadState::Branch {
                name: branch,
                oid: Some(oid),
            }
        } else {
            RepositoryHeadState::Unborn { branch }
        });
    }

    let oid = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--verify", "HEAD"],
        "repositoryHealth",
    )?
    .trim()
    .to_owned();
    Ok(RepositoryHeadState::Detached { oid })
}

fn inspect_middle_states(git_common_dir: &Path) -> Vec<RepositoryMiddleState> {
    let candidates = [
        (
            RepositoryMiddleStateKind::Merge,
            "MERGE_HEAD",
            Some(vec![
                "git".to_owned(),
                "merge".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (
            RepositoryMiddleStateKind::Rebase,
            "rebase-merge",
            Some(vec![
                "git".to_owned(),
                "rebase".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (
            RepositoryMiddleStateKind::Rebase,
            "rebase-apply",
            Some(vec![
                "git".to_owned(),
                "rebase".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (
            RepositoryMiddleStateKind::CherryPick,
            "CHERRY_PICK_HEAD",
            Some(vec![
                "git".to_owned(),
                "cherry-pick".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (
            RepositoryMiddleStateKind::Revert,
            "REVERT_HEAD",
            Some(vec![
                "git".to_owned(),
                "revert".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (RepositoryMiddleStateKind::Bisect, "BISECT_LOG", None),
    ];

    candidates
        .into_iter()
        .filter_map(|(kind, relative, abort_command)| {
            let path = git_common_dir.join(relative);
            path.exists().then(|| RepositoryMiddleState {
                kind,
                path: display_path(&path),
                abort_command,
            })
        })
        .collect()
}

fn inspect_index_lock(git_common_dir: &Path) -> Option<IndexLockInfo> {
    let path = git_common_dir.join("index.lock");
    let metadata = fs::metadata(&path).ok()?;
    let modified = metadata.modified().ok()?;
    let age_seconds = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        .as_secs();
    Some(IndexLockInfo {
        path: display_path(&path),
        age_seconds: age_seconds.min(u64::from(u32::MAX)) as u32,
        warning: "index.lock 可能表示仍有 Git 进程在运行；Artistic Git 永不自动清除该文件。"
            .to_owned(),
    })
}

fn build_summary(
    root: &Path,
    remote_mode: RepositoryRemoteMode,
    has_origin: bool,
    health: &RepositoryHealth,
) -> RepositorySummary {
    let (current_branch, head_oid, is_detached, is_unborn) = match &health.head {
        RepositoryHeadState::Branch { name, oid } => {
            (Some(name.clone()), oid.clone(), false, false)
        }
        RepositoryHeadState::Detached { oid } => (None, Some(oid.clone()), true, false),
        RepositoryHeadState::Unborn { branch } => (Some(branch.clone()), None, false, true),
    };

    RepositorySummary {
        repository_path: display_path(root),
        current_branch,
        head_oid,
        remote_mode,
        has_origin,
        is_detached,
        is_unborn,
        in_progress: !health.middle_states.is_empty() || health.index_lock.is_some(),
    }
}

fn branch_summary(
    runner: &GitRunner,
    root: &Path,
    current_branch: Option<&str>,
    short_name: String,
    entry: BranchAccumulator,
) -> AppResult<BranchSummary> {
    let existence = match (&entry.local_oid, &entry.remote_oid) {
        (Some(_), Some(_)) => BranchExistence::LocalAndRemote,
        (Some(_), None) => BranchExistence::LocalOnly,
        (None, Some(_)) => BranchExistence::RemoteOnly,
        (None, None) => BranchExistence::LocalOnly,
    };
    let current = current_branch == Some(short_name.as_str());
    let (ahead, behind) = branch_ahead_behind(runner, root, &short_name, &entry)?;
    let head_oid = entry.local_oid.clone().or(entry.remote_oid.clone());
    let latest_commit_unix_seconds = entry.local_time.or(entry.remote_time);

    Ok(BranchSummary {
        name: short_name.clone(),
        short_name,
        existence,
        current,
        head_oid,
        upstream: entry.upstream,
        ahead,
        behind,
        latest_commit_unix_seconds,
    })
}

fn branch_ahead_behind(
    runner: &GitRunner,
    root: &Path,
    short_name: &str,
    entry: &BranchAccumulator,
) -> AppResult<(u32, u32)> {
    if entry.local_oid.is_none() || entry.remote_oid.is_none() {
        return Ok((0, 0));
    }

    let spec = format!("{short_name}...origin/{short_name}");
    let output = git_stdout(
        runner,
        Some(root),
        ["rev-list", "--left-right", "--count", spec.as_str()],
        "listBranches",
    )?;
    let mut parts = output.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok((ahead, behind))
}

fn run_log_command<I>(
    runner: &GitRunner,
    root: &Path,
    args: I,
    limit: usize,
    skip: usize,
    operation_name: &str,
    cancel_token: &CancelToken,
) -> AppResult<LogPageResponse>
where
    I: IntoIterator<Item = OsString>,
{
    let output = match run_git_cancellable(runner, Some(root), args, operation_name, cancel_token) {
        Ok(output) => output,
        Err(error) if is_unborn_log_error(&error) => {
            return Ok(LogPageResponse {
                commits: Vec::new(),
                next_after: None,
            });
        }
        Err(error) => return Err(error),
    };
    let mut commits = parse_log_records(&output.stdout);
    let has_next = commits.len() > limit;
    commits.truncate(limit);
    let next_after = has_next.then(|| (skip + limit).to_string());
    Ok(LogPageResponse {
        commits,
        next_after,
    })
}

fn parse_log_records(output: &str) -> Vec<CommitSummary> {
    output
        .split('\x1e')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let parts = record.trim_matches('\n').split('\0').collect::<Vec<_>>();
            if parts.len() < 7 {
                return None;
            }
            Some(CommitSummary {
                oid: parts[0].to_owned(),
                parents: parts[1]
                    .split_whitespace()
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
                author_name: parts[2].to_owned(),
                author_email: parts[3].to_owned(),
                authored_at_unix_seconds: parts[4].to_owned(),
                subject: parts[5].to_owned(),
                refs: parts[6]
                    .split(", ")
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .collect()
}

fn parse_stash_record(record: &str) -> Option<StashEntry> {
    let parts = record.trim_matches('\n').split('\0').collect::<Vec<_>>();
    if parts.len() < 4 {
        return None;
    }

    let selector = parts[0].to_owned();
    let index = selector
        .strip_prefix("stash@{")
        .and_then(|value| value.strip_suffix('}'))
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    let message = parts[3].to_owned();
    let branch = message
        .strip_prefix("WIP on ")
        .and_then(|value| value.split_once(':').map(|(branch, _)| branch.to_owned()));
    let is_auto_stash =
        message.contains("Auto Stash:") || message.to_ascii_lowercase().contains("autostash");

    Some(StashEntry {
        index,
        selector,
        oid: parts[1].to_owned(),
        message,
        branch,
        created_at_unix_seconds: empty_to_none(parts[2]).map(str::to_owned),
        is_auto_stash,
        origin: is_auto_stash.then(|| "auto-stash".to_owned()),
    })
}

fn local_change_kind(index_status: &str, worktree_status: &str) -> DiffChangeKind {
    if index_status == "R" || worktree_status == "R" {
        DiffChangeKind::Renamed
    } else if index_status == "D" || worktree_status == "D" {
        DiffChangeKind::Deleted
    } else if index_status == "A" || worktree_status == "A" || index_status == "?" {
        DiffChangeKind::Added
    } else {
        DiffChangeKind::Modified
    }
}

fn local_change_diff(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    old_path: Option<&str>,
    change_kind: DiffChangeKind,
    index_status: &str,
    worktree_status: &str,
) -> AppResult<(DiffPayload, DiffContent)> {
    if let Some(submodule) = submodule_pointer_change(
        runner,
        root,
        path,
        old_path,
        change_kind,
        index_status,
        worktree_status,
    )? {
        return Ok(submodule);
    }

    let mut contents = local_change_contents(
        runner,
        root,
        path,
        old_path,
        change_kind,
        index_status,
        worktree_status,
    )?;
    let changed_lines = changed_lines_for_local_change(
        runner,
        root,
        path,
        change_kind,
        contents.old_display_content.as_deref(),
        contents.new_display_content.as_deref(),
    );
    let mut probe = DiffFileProbe::new(path.to_owned(), core_change_kind(change_kind));
    probe.old_path = old_path.map(|value| value.to_owned().into());
    probe.old_content = contents.old_content.as_deref();
    probe.new_content = contents.new_content.as_deref();
    probe.old_display_content = contents.old_display_content.as_deref();
    probe.new_display_content = contents.new_display_content.as_deref();
    probe.changed_lines = changed_lines;

    let classification = classify_diff_file(probe);
    let mut metadata = classification.metadata;
    metadata.insert("indexStatus".to_owned(), index_status.to_owned());
    metadata.insert("worktreeStatus".to_owned(), worktree_status.to_owned());
    if contents.lfs_fetch_attempted {
        metadata.insert("lfsFetchStatus".to_owned(), "fetched".to_owned());
    } else if contents.lfs_pointer_seen {
        metadata.insert("lfsFetchStatus".to_owned(), "local".to_owned());
    }

    if let Some(error) = contents.lfs_error.take() {
        metadata.insert("lfsFetchStatus".to_owned(), "error".to_owned());
        metadata.insert("lfsError".to_owned(), error.clone());
        let payload = DiffPayload {
            old_path: old_path.map(ToOwned::to_owned),
            new_path: path.to_owned(),
            change_kind,
            file_kind: DiffFileKind::LfsPointer,
            lfs_lock: None,
            metadata,
        };
        return Ok((
            payload,
            DiffContent::LfsPointer {
                status: LfsContentStatus::Error,
                message: Some(error),
            },
        ));
    }

    let file_kind = contract_file_kind(classification.file_kind);
    let payload = DiffPayload {
        old_path: classification.old_path,
        new_path: classification.new_path,
        change_kind,
        file_kind,
        lfs_lock: None,
        metadata,
    };
    let diff = diff_content_for_kind(file_kind, &payload, &contents);

    Ok((payload, diff))
}

#[derive(Debug, Default)]
struct LocalChangeContents {
    old_content: Option<Vec<u8>>,
    new_content: Option<Vec<u8>>,
    old_display_content: Option<Vec<u8>>,
    new_display_content: Option<Vec<u8>>,
    lfs_pointer_seen: bool,
    lfs_fetch_attempted: bool,
    lfs_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitlinkPointer {
    oid: String,
}

fn submodule_pointer_change(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    old_path: Option<&str>,
    change_kind: DiffChangeKind,
    index_status: &str,
    worktree_status: &str,
) -> AppResult<Option<(DiffPayload, DiffContent)>> {
    let old_gitlink = gitlink_at_head(runner, root, old_path.unwrap_or(path))?;
    let Some(old_gitlink) = old_gitlink else {
        return Ok(None);
    };

    let new_gitlink = if worktree_status != " " {
        gitlink_at_worktree_head(runner, root, path, "listLocalChanges")?
    } else if index_status != " " && index_status != "?" {
        gitlink_at_index(runner, root, path)?
    } else {
        gitlink_at_worktree_head(runner, root, path, "listLocalChanges")?
    };
    let Some(new_gitlink) = new_gitlink else {
        return Ok(None);
    };

    if old_gitlink.oid == new_gitlink.oid {
        return Ok(None);
    }

    let mut metadata = BTreeMap::new();
    metadata.insert("indexStatus".to_owned(), index_status.to_owned());
    metadata.insert("worktreeStatus".to_owned(), worktree_status.to_owned());
    metadata.insert("submodule".to_owned(), "true".to_owned());
    metadata.insert("oldOid".to_owned(), old_gitlink.oid);
    metadata.insert("newOid".to_owned(), new_gitlink.oid);

    Ok(Some((
        DiffPayload {
            old_path: old_path.map(ToOwned::to_owned),
            new_path: path.to_owned(),
            change_kind,
            file_kind: DiffFileKind::Binary,
            lfs_lock: None,
            metadata,
        },
        DiffContent::Moved { message: None },
    )))
}

fn gitlink_at_head(
    runner: &GitRunner,
    root: &Path,
    path: &str,
) -> AppResult<Option<GitlinkPointer>> {
    gitlink_at_tree(runner, root, "HEAD", path, "listLocalChanges")
}

fn gitlink_at_tree(
    runner: &GitRunner,
    root: &Path,
    rev: &str,
    path: &str,
    operation_name: &str,
) -> AppResult<Option<GitlinkPointer>> {
    let output = git_output_bytes(
        runner,
        Some(root),
        ["ls-tree", "-z", rev, "--", path],
        operation_name,
    )?;
    let record = output
        .split(|byte| *byte == 0)
        .find(|record| !record.is_empty());
    Ok(record.and_then(parse_ls_tree_gitlink))
}

fn gitlink_at_index(
    runner: &GitRunner,
    root: &Path,
    path: &str,
) -> AppResult<Option<GitlinkPointer>> {
    let output = git_output_bytes(
        runner,
        Some(root),
        ["ls-files", "-s", "-z", "--", path],
        "listLocalChanges",
    )?;
    let record = output
        .split(|byte| *byte == 0)
        .find(|record| !record.is_empty());
    Ok(record.and_then(parse_ls_files_gitlink))
}

fn gitlink_at_worktree_head(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    operation_name: &str,
) -> AppResult<Option<GitlinkPointer>> {
    let submodule = repository_relative_path(root, path, operation_name)?;
    if !submodule.is_dir() {
        return Ok(None);
    }

    let oid = match git_stdout(
        runner,
        Some(&submodule),
        ["rev-parse", "--verify", "HEAD"],
        operation_name,
    ) {
        Ok(output) => output.trim().to_owned(),
        Err(_) => return Ok(None),
    };
    Ok((is_full_oid(&oid)).then_some(GitlinkPointer { oid }))
}

fn parse_ls_tree_gitlink(record: &[u8]) -> Option<GitlinkPointer> {
    let record = String::from_utf8_lossy(record);
    let (header, _path) = record.split_once('\t')?;
    let mut fields = header.split_whitespace();
    let mode = fields.next()?;
    let object_type = fields.next()?;
    let oid = fields.next()?;
    (mode == "160000" && object_type == "commit" && is_full_oid(oid)).then(|| GitlinkPointer {
        oid: oid.to_owned(),
    })
}

fn parse_ls_files_gitlink(record: &[u8]) -> Option<GitlinkPointer> {
    let record = String::from_utf8_lossy(record);
    let (header, _path) = record.split_once('\t')?;
    let mut fields = header.split_whitespace();
    let mode = fields.next()?;
    let oid = fields.next()?;
    (mode == "160000" && is_full_oid(oid)).then(|| GitlinkPointer {
        oid: oid.to_owned(),
    })
}

fn local_change_contents(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    old_path: Option<&str>,
    change_kind: DiffChangeKind,
    index_status: &str,
    worktree_status: &str,
) -> AppResult<LocalChangeContents> {
    let old_content = if matches!(change_kind, DiffChangeKind::Added) {
        None
    } else {
        git_blob_at_rev_path(runner, root, "HEAD", old_path.unwrap_or(path)).ok()
    };
    let new_content = if matches!(change_kind, DiffChangeKind::Deleted) {
        None
    } else {
        local_change_new_content(runner, root, path, index_status, worktree_status)?
    };

    let mut contents = LocalChangeContents {
        old_content,
        new_content,
        ..LocalChangeContents::default()
    };

    if let Some(content) = contents.old_content.as_deref() {
        match display_content_for_side(runner, root, path, DiffSide::Old, content) {
            Ok(resolved) => {
                contents.old_display_content = Some(resolved.content);
                contents.lfs_pointer_seen |= resolved.lfs_pointer;
                contents.lfs_fetch_attempted |= resolved.fetch_attempted;
            }
            Err(error) => {
                contents.lfs_pointer_seen = true;
                contents.lfs_fetch_attempted |= error.fetch_attempted;
                contents.lfs_error = Some(error.message);
            }
        }
    }

    if let Some(content) = contents.new_content.as_deref() {
        match display_content_for_side(runner, root, path, DiffSide::New, content) {
            Ok(resolved) => {
                contents.new_display_content = Some(resolved.content);
                contents.lfs_pointer_seen |= resolved.lfs_pointer;
                contents.lfs_fetch_attempted |= resolved.fetch_attempted;
            }
            Err(error) => {
                contents.lfs_pointer_seen = true;
                contents.lfs_fetch_attempted |= error.fetch_attempted;
                contents.lfs_error = Some(error.message);
            }
        }
    }

    Ok(contents)
}

fn local_change_new_content(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    index_status: &str,
    worktree_status: &str,
) -> AppResult<Option<Vec<u8>>> {
    if index_status == "D" || worktree_status == "D" {
        return Ok(None);
    }

    let worktree_path = repository_relative_path(root, path, "listLocalChanges")?;
    if let Ok(bytes) = fs::read(&worktree_path) {
        return Ok(Some(bytes));
    }

    if index_status != " " && index_status != "?" {
        return Ok(git_blob_at_rev_path(runner, root, "", path).ok());
    }

    Ok(None)
}

#[derive(Debug, Clone, Copy)]
enum DiffSide {
    Old,
    New,
}

impl DiffSide {
    fn label(self) -> &'static str {
        match self {
            Self::Old => "old",
            Self::New => "new",
        }
    }
}

#[derive(Debug)]
struct DisplayContent {
    content: Vec<u8>,
    lfs_pointer: bool,
    fetch_attempted: bool,
}

#[derive(Debug)]
struct LfsDisplayError {
    message: String,
    fetch_attempted: bool,
}

fn display_content_for_side(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    side: DiffSide,
    content: &[u8],
) -> Result<DisplayContent, LfsDisplayError> {
    let Some(pointer) = parse_lfs_pointer(content) else {
        return Ok(DisplayContent {
            content: content.to_vec(),
            lfs_pointer: false,
            fetch_attempted: false,
        });
    };

    if let Ok(content) = read_local_lfs_object(runner, root, &pointer.oid, Some(pointer.size)) {
        return Ok(DisplayContent {
            content,
            lfs_pointer: true,
            fetch_attempted: false,
        });
    }

    if let Err(error) = fetch_lfs_object(runner, root, &pointer.oid, "listLocalChanges") {
        return Err(LfsDisplayError {
            message: format!(
                "Git LFS {} content for {} is not available locally and fetch failed: {}",
                side.label(),
                path,
                error.summary
            ),
            fetch_attempted: true,
        });
    }

    read_local_lfs_object(runner, root, &pointer.oid, Some(pointer.size))
        .map(|content| DisplayContent {
            content,
            lfs_pointer: true,
            fetch_attempted: true,
        })
        .map_err(|error| LfsDisplayError {
            message: format!(
                "Git LFS {} content for {} is still unavailable after fetch: {}",
                side.label(),
                path,
                error.summary
            ),
            fetch_attempted: true,
        })
}

fn diff_content_for_kind(
    file_kind: DiffFileKind,
    payload: &DiffPayload,
    contents: &LocalChangeContents,
) -> DiffContent {
    if payload.change_kind == DiffChangeKind::Renamed
        && payload.metadata.get("contentChanged").map(String::as_str) == Some("false")
    {
        return DiffContent::Moved { message: None };
    }

    match file_kind {
        DiffFileKind::Text => DiffContent::Text {
            old_text: contents
                .old_display_content
                .as_deref()
                .map(bytes_to_lossy_string),
            new_text: contents
                .new_display_content
                .as_deref()
                .map(bytes_to_lossy_string),
            language: None,
        },
        DiffFileKind::Image => DiffContent::Image {
            old_image: contents
                .old_display_content
                .as_deref()
                .and_then(|content| diff_asset(payload.old_path.as_deref(), content)),
            new_image: contents
                .new_display_content
                .as_deref()
                .and_then(|content| diff_asset(Some(payload.new_path.as_str()), content)),
        },
        DiffFileKind::OversizedText => DiffContent::OversizedText { message: None },
        DiffFileKind::LfsPointer => DiffContent::LfsPointer {
            status: LfsContentStatus::Missing,
            message: Some("Git LFS content is not available locally yet".to_owned()),
        },
        DiffFileKind::Binary => DiffContent::Binary { message: None },
    }
}

fn git_blob_at_rev_path(
    runner: &GitRunner,
    root: &Path,
    rev: &str,
    path: &str,
) -> AppResult<Vec<u8>> {
    let spec = if rev.is_empty() {
        format!(":{path}")
    } else {
        format!("{rev}:{path}")
    };
    git_output_bytes(
        runner,
        Some(root),
        ["show".to_owned(), spec],
        "listLocalChanges",
    )
}

fn read_local_lfs_object(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    expected_size: Option<u64>,
) -> AppResult<Vec<u8>> {
    let path = local_lfs_object_path(runner, root, oid, "listLocalChanges")?;
    let bytes = fs::read(&path).map_err(|source| {
        logged(AppError::expected(
            format!("Git LFS object is not available locally: {source}"),
            "listLocalChanges",
        ))
    })?;
    if let Some(expected_size) = expected_size {
        if bytes.len() as u64 != expected_size {
            return Err(logged(AppError::expected(
                "local Git LFS object size does not match pointer metadata",
                "listLocalChanges",
            )));
        }
    }
    Ok(bytes)
}

fn fetch_lfs_object(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    operation_name: &str,
) -> AppResult<()> {
    if !is_sha256_oid(oid) {
        return Err(logged(AppError::expected(
            "invalid Git LFS object id",
            operation_name,
        )));
    }

    let mut planned_args = Vec::new();
    planned_args.push(OsString::from("-C"));
    planned_args.push(root.as_os_str().to_owned());
    planned_args.extend([
        OsString::from("fetch"),
        OsString::from("--object-id"),
        OsString::from("origin"),
        OsString::from(oid),
    ]);
    let plan = runner.git_lfs_command_plan(planned_args);
    command_to_output(plan.to_command(), &plan, operation_name).map(|_| ())
}

fn local_lfs_object_path(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    operation_name: &str,
) -> AppResult<PathBuf> {
    if !is_sha256_oid(oid) {
        return Err(logged(AppError::expected(
            "invalid Git LFS object id",
            operation_name,
        )));
    }

    let common_dir = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--git-common-dir"],
        operation_name,
    )?;
    let common_dir = common_dir.trim();
    let common_dir = Path::new(common_dir);
    let common_dir = if common_dir.is_absolute() {
        common_dir.to_path_buf()
    } else {
        root.join(common_dir)
    };

    Ok(common_dir
        .join("lfs")
        .join("objects")
        .join(&oid[0..2])
        .join(&oid[2..4])
        .join(oid))
}

fn is_sha256_oid(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_full_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn repository_relative_path(root: &Path, path: &str, operation_name: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(logged(AppError::expected(
            "repository path must be relative",
            operation_name,
        )));
    }

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(logged(AppError::expected(
                    "repository path must stay inside the repository",
                    operation_name,
                )));
            }
        }
    }

    Ok(root.join(normalized))
}

fn diff_asset(path: Option<&str>, content: &[u8]) -> Option<DiffAsset> {
    let image = detect_image(content)?;
    let (width, height) = image.dimensions.unwrap_or((0, 0));
    Some(DiffAsset {
        alt: path.map(ToOwned::to_owned),
        height: (height > 0).then_some(height),
        mime_type: Some(image.mime_type.to_owned()),
        size_bytes: Some(content.len().min(u32::MAX as usize) as u32),
        src: format!("data:{};base64,{}", image.mime_type, base64_encode(content)),
        width: (width > 0).then_some(width),
    })
}

fn bytes_to_lossy_string(content: &[u8]) -> String {
    String::from_utf8_lossy(content).into_owned()
}

fn changed_lines_for_local_change(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    change_kind: DiffChangeKind,
    old_content: Option<&[u8]>,
    new_content: Option<&[u8]>,
) -> usize {
    git_changed_lines(runner, root, path)
        .unwrap_or_else(|| changed_lines_for_content(change_kind, old_content, new_content))
}

fn git_changed_lines(runner: &GitRunner, root: &Path, path: &str) -> Option<usize> {
    let output = git_stdout(
        runner,
        Some(root),
        ["diff", "--numstat", "HEAD", "--", path],
        "listLocalChanges",
    )
    .ok()?;
    let line = output.lines().find(|line| !line.trim().is_empty())?;
    let mut fields = line.split_whitespace();
    let additions = fields.next()?.parse::<usize>().ok()?;
    let deletions = fields.next()?.parse::<usize>().ok()?;
    Some(additions + deletions)
}

fn changed_lines_for_content(
    change_kind: DiffChangeKind,
    old_content: Option<&[u8]>,
    new_content: Option<&[u8]>,
) -> usize {
    if old_content == new_content {
        return 0;
    }

    match change_kind {
        DiffChangeKind::Added => line_count(new_content.unwrap_or_default()),
        DiffChangeKind::Deleted => line_count(old_content.unwrap_or_default()),
        DiffChangeKind::Modified | DiffChangeKind::Renamed | DiffChangeKind::Copied => {
            line_count(old_content.unwrap_or_default())
                + line_count(new_content.unwrap_or_default())
        }
    }
}

fn line_count(content: &[u8]) -> usize {
    if content.is_empty() {
        0
    } else {
        content.iter().filter(|byte| **byte == b'\n').count() + 1
    }
}

fn base64_encode(content: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(content.len().div_ceil(3) * 4);

    for chunk in content.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);

        encoded.push(TABLE[(first >> 2) as usize] as char);
        encoded.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            encoded.push('=');
        }
    }

    encoded
}

fn core_change_kind(kind: DiffChangeKind) -> CoreDiffChangeKind {
    match kind {
        DiffChangeKind::Added => CoreDiffChangeKind::Added,
        DiffChangeKind::Modified => CoreDiffChangeKind::Modified,
        DiffChangeKind::Deleted => CoreDiffChangeKind::Deleted,
        DiffChangeKind::Renamed => CoreDiffChangeKind::Renamed,
        DiffChangeKind::Copied => CoreDiffChangeKind::Copied,
    }
}

fn contract_file_kind(kind: CoreDiffFileKind) -> DiffFileKind {
    match kind {
        CoreDiffFileKind::Text => DiffFileKind::Text,
        CoreDiffFileKind::Binary => DiffFileKind::Binary,
        CoreDiffFileKind::Image => DiffFileKind::Image,
        CoreDiffFileKind::LfsPointer => DiffFileKind::LfsPointer,
        CoreDiffFileKind::OversizedText => DiffFileKind::OversizedText,
    }
}

fn log_limit_and_skip(limit: Option<u16>, after: Option<&str>) -> (usize, usize) {
    let limit = limit
        .map(usize::from)
        .unwrap_or(DEFAULT_LOG_LIMIT)
        .clamp(1, MAX_LOG_LIMIT);
    let skip = after.and_then(|value| value.parse().ok()).unwrap_or(0);
    (limit, skip)
}

pub(crate) fn current_branch_name(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<String> {
    git_stdout(
        runner,
        Some(root),
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        operation_name,
    )
    .map(|value| value.trim().to_owned())
}

fn git_path<I, S>(
    runner: &GitRunner,
    root: &Path,
    args: I,
    operation_name: &str,
) -> AppResult<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let output = git_stdout(runner, Some(root), args, operation_name)?;
    let path = PathBuf::from(output.trim());
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

pub(crate) fn git_stdout<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    run_git(runner, root, args, operation_name).map(|output| output.stdout)
}

fn git_output_bytes<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = plan_git(runner, root, args);
    let output = plan
        .to_command()
        .output()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(command_failure(&plan, output, operation_name))
    }
}

fn run_git<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<CommandOutput>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = plan_git(runner, root, args);
    let command = plan.to_command();
    command_to_output(command, &plan, operation_name)
}

fn run_git_cancellable<I>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
    cancel_token: &CancelToken,
) -> AppResult<CommandOutput>
where
    I: IntoIterator<Item = OsString>,
{
    if cancel_token.is_cancelled() {
        return Err(cancelled_error(operation_name));
    }

    let plan = plan_git(runner, root, args);
    let mut command = plan.to_command();
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;

    loop {
        if cancel_token.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cancelled_error(operation_name));
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => return Err(spawn_error(&plan, source, operation_name)),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
    if output.status.success() {
        Ok(CommandOutput::from_output(output))
    } else {
        Err(command_failure(&plan, output, operation_name))
    }
}

fn command_to_output(
    mut command: Command,
    plan: &GitCommandPlan,
    operation_name: &str,
) -> AppResult<CommandOutput> {
    let output = command
        .output()
        .map_err(|source| spawn_error(plan, source, operation_name))?;
    if output.status.success() {
        Ok(CommandOutput::from_output(output))
    } else {
        Err(command_failure(plan, output, operation_name))
    }
}

fn plan_git<I, S>(runner: &GitRunner, root: Option<&Path>, args: I) -> GitCommandPlan
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut planned_args = Vec::new();
    if let Some(root) = root {
        planned_args.push(OsString::from("-C"));
        planned_args.push(root.as_os_str().to_owned());
    }
    planned_args.extend(args.into_iter().map(Into::into));

    runner
        .git_command_builder()
        .enable_rename_detection()
        .enable_windows_longpaths()
        .args(planned_args)
        .build()
}

fn command_failure(
    plan: &GitCommandPlan,
    output: std::process::Output,
    operation_name: &str,
) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let summary = if stderr.trim().is_empty() {
        format!("git command failed during {operation_name}")
    } else {
        stderr
            .lines()
            .next()
            .unwrap_or("git command failed")
            .to_owned()
    };

    logged(
        AppError::expected(summary, operation_name).with_git(GitCommandError {
            command: plan.command_for_error(),
            exit_code: output.status.code(),
            stdout,
            stderr,
        }),
    )
}

fn spawn_error(plan: &GitCommandPlan, source: io::Error, operation_name: &str) -> AppError {
    logged(
        AppError::fatal(
            format!("embedded git command could not be executed: {source}"),
            operation_name,
        )
        .with_git(GitCommandError {
            command: plan.command_for_error(),
            exit_code: None,
            stdout: String::new(),
            stderr: source.to_string(),
        }),
    )
}

fn cancelled_error(operation_name: &str) -> AppError {
    logged(AppError::expected("operation cancelled", operation_name))
}

pub(crate) fn canonical_repository_path(path: &str, operation_name: &str) -> AppResult<PathBuf> {
    canonicalize_path(Path::new(path), operation_name)
}

fn canonicalize_path(path: &Path, operation_name: &str) -> AppResult<PathBuf> {
    fs::canonicalize(path).map_err(|source| {
        logged(AppError::expected(
            format!("failed to resolve repository path: {source}"),
            operation_name,
        ))
    })
}

fn repository_has_lfs_rules(root: &Path) -> bool {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
            if file_name == ".git" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if file_name == ".gitattributes"
                && fs::read_to_string(&path)
                    .map(|content| content.contains("filter=lfs"))
                    .unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
}

fn canonical_or_self(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn empty_to_none(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn is_empty_stash_error(error: &AppError) -> bool {
    error
        .git
        .as_ref()
        .map(|git| git.stderr.contains("No stash entries found"))
        .unwrap_or(false)
}

fn is_unborn_log_error(error: &AppError) -> bool {
    error
        .git
        .as_ref()
        .map(|git| {
            git.stderr.contains("does not have any commits")
                || git.stderr.contains("bad default revision")
                || git.stderr.contains("ambiguous argument")
        })
        .unwrap_or(false)
}

fn warning(kind: RepositoryOpenWarningKind, message: impl Into<String>) -> RepositoryOpenWarning {
    RepositoryOpenWarning {
        kind,
        message: message.into(),
    }
}

pub(crate) fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub(crate) fn unix_now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn logged(error: AppError) -> AppError {
    crate::logged_app_error(error)
}

#[derive(Debug)]
struct CommandOutput {
    stdout: String,
}

impl CommandOutput {
    fn from_output(output: std::process::Output) -> Self {
        Self {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        }
    }
}

#[derive(Debug, Default)]
struct BranchAccumulator {
    local_oid: Option<String>,
    remote_oid: Option<String>,
    local_time: Option<String>,
    remote_time: Option<String>,
    upstream: Option<String>,
}

#[derive(Debug)]
struct CloneTarget {
    parent: PathBuf,
    directory_name: OsString,
    path: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_core::keyring::{InMemoryCredentialStore, SshPassphraseKey};
    use artistic_git_git_runner::GitDistribution;
    use artistic_git_helpers::HelperIpcResponse;
    use artistic_git_test_support::{
        git_dist_manifest_fixture, require_git_dist, write_executable_script,
        write_git_dist_manifest, GitDistError, TestTempDir,
    };
    use std::{io::Write, sync::Mutex};

    #[test]
    fn cancellable_operation_registry_cancels_registered_token() {
        let registry = Arc::new(CancellableOperationRegistry::default());
        let operation_id = OperationId::new("operation-1");
        let token = CancelToken::new();
        let _guard = registry
            .register(&operation_id, token.clone(), "testOperation")
            .expect("register operation");

        assert!(!token.is_cancelled());
        assert!(registry.cancel(&operation_id).expect("cancel operation"));
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancellable_operation_guard_unregisters_on_drop() {
        let registry = Arc::new(CancellableOperationRegistry::default());
        let operation_id = OperationId::new("operation-1");
        let token = CancelToken::new();
        let guard = registry
            .register(&operation_id, token, "testOperation")
            .expect("register operation");

        drop(guard);

        assert!(!registry.cancel(&operation_id).expect("cancel operation"));
    }

    #[test]
    fn cancellable_operation_registry_rejects_duplicate_operation_ids() {
        let registry = Arc::new(CancellableOperationRegistry::default());
        let operation_id = OperationId::new("operation-1");
        let _guard = registry
            .register(&operation_id, CancelToken::new(), "testOperation")
            .expect("register operation");

        let error = registry
            .register(&operation_id, CancelToken::new(), "testOperation")
            .expect_err("duplicate operation id rejected");

        assert_eq!(error.summary, "operation is already registered");
    }

    #[derive(Debug)]
    struct TestSshPassphrasePromptSink {
        response: crate::ssh_auth::SshPassphrasePromptResult,
        requests: Mutex<Vec<crate::ssh_auth::SshPassphrasePromptRequest>>,
    }

    impl TestSshPassphrasePromptSink {
        fn new(response: crate::ssh_auth::SshPassphrasePromptResult) -> Self {
            Self {
                response,
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<crate::ssh_auth::SshPassphrasePromptRequest> {
            self.requests.lock().expect("requests").clone()
        }
    }

    impl crate::ssh_auth::SshPassphrasePromptSink for TestSshPassphrasePromptSink {
        fn prompt_ssh_passphrase(
            &self,
            request: crate::ssh_auth::SshPassphrasePromptRequest,
        ) -> crate::ssh_auth::SshPassphrasePromptResult {
            self.requests.lock().expect("requests").push(request);
            self.response.clone()
        }
    }

    #[test]
    fn local_change_parser_marks_untracked_as_added() {
        assert_eq!(local_change_kind("?", "?"), DiffChangeKind::Added);
        assert_eq!(local_change_kind("R", " "), DiffChangeKind::Renamed);
        assert_eq!(local_change_kind(" ", "D"), DiffChangeKind::Deleted);
    }

    #[test]
    fn log_pagination_is_capped_at_phase_batch_size() {
        assert_eq!(log_limit_and_skip(None, None), (200, 0));
        assert_eq!(log_limit_and_skip(Some(500), Some("12")), (200, 12));
    }

    #[test]
    fn ssh_askpass_prompts_and_remembers_passphrase_when_enabled() {
        let cache = crate::ssh_auth::SshPassphraseCache::new();
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let sink =
            TestSshPassphrasePromptSink::new(crate::ssh_auth::SshPassphrasePromptResult::Submit(
                crate::ssh_auth::SshPassphrasePromptSubmission::new("secret", true),
            ));

        let response = handle_ssh_askpass_request(
            &cache,
            &vault,
            &sink,
            crate::auth_ipc::InteractionPolicy::interactive(),
            true,
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':".to_owned(),
        );

        assert_eq!(
            response,
            HelperIpcResponse::Askpass {
                secret: "secret".to_owned(),
            }
        );
        assert_eq!(
            sink.requests(),
            vec![crate::ssh_auth::SshPassphrasePromptRequest {
                key_id: "/Users/me/.ssh/id_ed25519".to_owned(),
                prompt: "Enter passphrase for key '/Users/me/.ssh/id_ed25519':".to_owned(),
                remember_available: true,
            }]
        );
        let key = SshPassphraseKey::new("/Users/me/.ssh/id_ed25519");
        assert_eq!(cache.get(&key), Some("secret".to_owned()));
        assert_eq!(
            vault.get_ssh_passphrase(&key).expect("stored passphrase"),
            Some("secret".to_owned())
        );
    }

    #[test]
    fn ssh_askpass_uses_memory_cache_without_prompting() {
        let cache = crate::ssh_auth::SshPassphraseCache::new();
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let key = SshPassphraseKey::new("/Users/me/.ssh/id_ed25519");
        cache.insert(key, "cached-secret");
        let sink =
            TestSshPassphrasePromptSink::new(crate::ssh_auth::SshPassphrasePromptResult::Cancel);

        let response = handle_ssh_askpass_request(
            &cache,
            &vault,
            &sink,
            crate::auth_ipc::InteractionPolicy::background_non_interactive(),
            false,
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':".to_owned(),
        );

        assert_eq!(
            response,
            HelperIpcResponse::Askpass {
                secret: "cached-secret".to_owned(),
            }
        );
        assert!(sink.requests().is_empty());
    }

    #[test]
    fn ssh_askpass_background_without_cache_fails_without_prompting() {
        let cache = crate::ssh_auth::SshPassphraseCache::new();
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let sink =
            TestSshPassphrasePromptSink::new(crate::ssh_auth::SshPassphrasePromptResult::Cancel);

        let response = handle_ssh_askpass_request(
            &cache,
            &vault,
            &sink,
            crate::auth_ipc::InteractionPolicy::background_non_interactive(),
            false,
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':".to_owned(),
        );

        match response {
            HelperIpcResponse::Error { message } => {
                assert!(message.contains("non-interactive"));
                assert!(message.contains("expected offline"));
            }
            other => panic!("expected askpass error, got {other:?}"),
        }
        assert!(sink.requests().is_empty());
    }

    #[test]
    fn ssh_askpass_cancel_returns_error() {
        let cache = crate::ssh_auth::SshPassphraseCache::new();
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let sink =
            TestSshPassphrasePromptSink::new(crate::ssh_auth::SshPassphrasePromptResult::Cancel);

        let response = handle_ssh_askpass_request(
            &cache,
            &vault,
            &sink,
            crate::auth_ipc::InteractionPolicy::interactive(),
            false,
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':".to_owned(),
        );

        match response {
            HelperIpcResponse::Error { message } => {
                assert!(message.contains("was cancelled"));
            }
            other => panic!("expected askpass error, got {other:?}"),
        }
        assert_eq!(sink.requests().len(), 1);
    }

    #[test]
    fn renormalize_suggestion_requires_large_modified_majority() {
        assert!(!should_suggest_renormalize(999, 999));
        assert!(!should_suggest_renormalize(1_000, 799));
        assert!(should_suggest_renormalize(1_000, 800));
        assert!(should_suggest_renormalize(2_000, 1_900));
    }

    #[test]
    fn parses_renormalize_dry_run_paths() {
        assert_eq!(
            parse_renormalize_dry_run_paths("add 'src/main.ts'\nadd \"assets/space name.png\"\n"),
            vec!["src/main.ts", "assets/space name.png"]
        );
    }

    #[test]
    fn parses_auto_stash_origin() {
        let entry = parse_stash_record(concat!(
            "stash@{0}",
            "\0",
            "abc",
            "\0",
            "1700000000",
            "\0",
            "Auto Stash: before checkout",
            "\x1e"
        ))
        .expect("stash entry");

        assert!(entry.is_auto_stash);
        assert_eq!(entry.origin.as_deref(), Some("auto-stash"));
    }

    #[test]
    fn missing_embedded_git_distribution_is_explicit() {
        if std::env::var_os("ARTISTIC_GIT_DIST_DIR").is_some() {
            return;
        }

        let error = require_git_dist().expect_err("missing dist should be explicit");

        assert!(matches!(error, GitDistError::MissingEnvironment));
    }

    #[test]
    fn opens_repository_from_subdirectory_and_reports_no_remote() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        repo.write("nested/file.txt", "hello");

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path.join("nested")),
                tool_identity: None,
            },
        )
        .expect("open repo");

        assert_eq!(response.repository_path, display_path(&repo.path));
        assert_eq!(response.remote_mode, RepositoryRemoteMode::NoRemote);
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.kind == RepositoryOpenWarningKind::NoRemote));
    }

    #[test]
    fn clones_local_bare_repository_and_reuses_open_flow() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let source = TestRepo::new(&runner);
        source.init_with_commit();
        let branch = source
            .git_output(["symbolic-ref", "--short", "HEAD"])
            .trim()
            .to_owned();
        let bare = TestTempDir::new("ag-bare-remote").expect("bare remote");
        git_stdout(&runner, Some(bare.path()), ["init", "--bare"], "test")
            .expect("init bare remote");
        let bare_path = display_path(bare.path());
        source.git(["remote", "add", "origin", bare_path.as_str()]);
        source.git(vec![
            OsString::from("push"),
            OsString::from("-u"),
            OsString::from("origin"),
            OsString::from(format!("HEAD:{branch}")),
        ]);
        git_stdout(
            &runner,
            Some(bare.path()),
            vec![
                OsString::from("symbolic-ref"),
                OsString::from("HEAD"),
                OsString::from(format!("refs/heads/{branch}")),
            ],
            "test",
        )
        .expect("point bare HEAD at pushed branch");

        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");
        let response = clone_repository(
            &runner,
            None,
            CloneRepositoryRequest {
                url: bare_path.clone(),
                target_parent_directory: display_path(parent.path()),
                directory_name: "cloned-art".to_owned(),
                tool_identity: Some(artistic_git_contracts::ToolGitIdentity {
                    name: Some("Artistic Git".to_owned()),
                    email: Some("tool@example.test".to_owned()),
                }),
                operation_id: None,
            },
        )
        .expect("clone repository");
        let target = parent.path().join("cloned-art");

        assert_eq!(
            response.repository.repository_path,
            display_path(&canonical_or_self(&target))
        );
        assert_eq!(
            response.repository.remote_mode,
            RepositoryRemoteMode::Origin
        );
        assert!(target.join("tracked.txt").exists());
        assert!(response
            .repository
            .remotes
            .iter()
            .any(|remote| remote.name == "origin" && remote.url == bare_path));
        assert_eq!(
            git_stdout(
                &runner,
                Some(&target),
                ["config", "--local", "--get", "user.name"],
                "test",
            )
            .expect("local user name")
            .trim(),
            "Artistic Git"
        );
    }

    #[test]
    fn clone_emits_progress_events_for_local_bare_repository() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let source = TestRepo::new(&runner);
        source.init_with_commit();
        let branch = source
            .git_output(["symbolic-ref", "--short", "HEAD"])
            .trim()
            .to_owned();
        let bare = TestTempDir::new("ag-bare-remote").expect("bare remote");
        git_stdout(&runner, Some(bare.path()), ["init", "--bare"], "test")
            .expect("init bare remote");
        let bare_path = display_path(bare.path());
        source.git(["remote", "add", "origin", bare_path.as_str()]);
        source.git(vec![
            OsString::from("push"),
            OsString::from("-u"),
            OsString::from("origin"),
            OsString::from(format!("HEAD:{branch}")),
        ]);
        git_stdout(
            &runner,
            Some(bare.path()),
            vec![
                OsString::from("symbolic-ref"),
                OsString::from("HEAD"),
                OsString::from(format!("refs/heads/{branch}")),
            ],
            "test",
        )
        .expect("point bare HEAD at pushed branch");

        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");
        let events = std::cell::RefCell::new(Vec::new());
        clone_repository_with_cancel_and_progress(
            &runner,
            None,
            CloneRepositoryRequest {
                url: bare_path,
                target_parent_directory: display_path(parent.path()),
                directory_name: "progress-clone".to_owned(),
                tool_identity: None,
                operation_id: Some(OperationId::new("clone-progress-test")),
            },
            &CancelToken::new(),
            |event| events.borrow_mut().push(event),
        )
        .expect("clone repository");

        let events = events.borrow();
        assert!(events.iter().any(|event| matches!(
            event.progress,
            ProgressState::Percent { value } if (value - 100.0).abs() < f32::EPSILON
        )));
        assert!(events
            .iter()
            .any(|event| event.label == "Cloning repository"));
    }

    #[test]
    fn clone_progress_labels_lfs_checkout_and_submodules() {
        assert_eq!(
            clone_progress_label("Filtering content:  50% (1/2), 10.00 MiB"),
            "Downloading LFS objects"
        );
        assert_eq!(
            clone_progress_label("Checking out files: 100% (20/20), done."),
            "Checking out files"
        );
        assert_eq!(
            clone_progress_label("Submodule path 'textures': checked out 'abc123'"),
            "Cloning submodules"
        );
    }

    #[test]
    fn clone_source_uses_recurse_submodules_flag() {
        let source = include_str!("repository.rs");
        assert!(source.contains("OsString::from(\"--recurse-submodules\")"));
    }

    #[test]
    fn open_repository_initializes_submodules_and_emits_progress() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let child = TestRepo::new(&runner);
        child.init_with_commit();
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        repo.git(["config", "user.name", "Tester"]);
        repo.git(["config", "user.email", "tester@example.test"]);
        repo.git(vec![
            OsString::from("-c"),
            OsString::from("protocol.file.allow=always"),
            OsString::from("submodule"),
            OsString::from("add"),
            OsString::from(display_path(&child.path)),
            OsString::from("deps/lib"),
        ]);
        repo.git(["commit", "-m", "add submodule"]);
        repo.git(["submodule", "deinit", "-f", "deps/lib"]);
        let _ = fs::remove_dir_all(repo.path.join(".git/modules/deps/lib"));
        let _ = fs::remove_dir_all(repo.path.join("deps/lib"));

        let events = std::cell::RefCell::new(Vec::new());
        open_repository_with_progress(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
            |event| events.borrow_mut().push(event),
        )
        .expect("open repository with submodule");

        assert!(repo.path.join("deps/lib/tracked.txt").exists());
        let labels = events
            .borrow()
            .iter()
            .map(|event| event.label.clone())
            .collect::<Vec<_>>();
        assert!(labels.iter().any(|label| label == "Updating submodules"));
        assert!(labels.iter().any(|label| label == "Submodules ready"));
    }

    #[test]
    fn local_changes_render_gitlink_pointer_as_submodule_card() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let child = TestRepo::new(&runner);
        child.init_with_commit();
        let old_oid = child.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        repo.git(["config", "user.name", "Tester"]);
        repo.git(["config", "user.email", "tester@example.test"]);
        repo.git(vec![
            OsString::from("-c"),
            OsString::from("protocol.file.allow=always"),
            OsString::from("submodule"),
            OsString::from("add"),
            OsString::from(display_path(&child.path)),
            OsString::from("deps/lib"),
        ]);
        repo.git(["commit", "-m", "add submodule"]);

        child.write("tracked.txt", "two\n");
        child.git(["add", "tracked.txt"]);
        child.git(["commit", "-m", "update child"]);
        let new_oid = child.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        let submodule = repo.path.join("deps/lib");
        git_stdout(&runner, Some(&submodule), ["fetch", "origin"], "test")
            .expect("fetch submodule update");
        git_stdout(
            &runner,
            Some(&submodule),
            ["checkout", new_oid.as_str()],
            "test",
        )
        .expect("checkout new submodule commit");

        let changes = list_local_changes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("local changes");
        let change = changes
            .changes
            .iter()
            .find(|change| change.path == "deps/lib")
            .expect("submodule change");

        assert_eq!(change.payload.metadata["submodule"], "true");
        assert_eq!(change.payload.metadata["oldOid"], old_oid);
        assert_eq!(change.payload.metadata["newOid"], new_oid);
        assert_eq!(change.payload.file_kind, DiffFileKind::Binary);
        assert!(change.submodule.is_none());
        assert!(matches!(change.diff, DiffContent::Moved { .. }));
    }

    #[test]
    fn list_local_changes_includes_submodule_workspace_changes() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let child = TestRepo::new(&runner);
        child.init_with_commit();

        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        repo.git(["config", "user.name", "Tester"]);
        repo.git(["config", "user.email", "tester@example.test"]);
        repo.write("root.txt", "one\n");
        repo.git(["add", "root.txt"]);
        repo.git(["commit", "-m", "root"]);
        repo.git(vec![
            OsString::from("-c"),
            OsString::from("protocol.file.allow=always"),
            OsString::from("submodule"),
            OsString::from("add"),
            OsString::from(display_path(&child.path)),
            OsString::from("deps/lib"),
        ]);
        repo.git(["commit", "-m", "add submodule"]);

        repo.write("root.txt", "two\n");
        fs::write(repo.path.join("deps/lib/tracked.txt"), "two\n").expect("modify submodule file");
        fs::write(repo.path.join("deps/lib/new.txt"), "new\n").expect("write submodule file");

        let changes = list_local_changes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("local changes");

        assert!(changes
            .changes
            .iter()
            .any(|change| change.path == "root.txt" && change.submodule.is_none()));
        assert!(!changes
            .changes
            .iter()
            .any(|change| change.path == "deps/lib"));

        let tracked = changes
            .changes
            .iter()
            .find(|change| change.path == "deps/lib/tracked.txt")
            .expect("submodule tracked change");
        let submodule = tracked.submodule.as_ref().expect("submodule metadata");
        assert_eq!(submodule.path, "deps/lib");
        assert_eq!(submodule.name, "deps/lib");
        assert_eq!(tracked.payload.new_path, "deps/lib/tracked.txt");
        assert_eq!(tracked.payload.metadata["submodulePath"], "deps/lib");
        assert_eq!(tracked.payload.metadata["submoduleName"], "deps/lib");
        assert_eq!(
            tracked.payload.metadata["submoduleInnerPath"],
            "tracked.txt"
        );
        assert_eq!(tracked.payload.metadata.get("submodule"), None);
        match &tracked.diff {
            DiffContent::Text {
                old_text, new_text, ..
            } => {
                assert_eq!(old_text.as_deref(), Some("one\n"));
                assert_eq!(new_text.as_deref(), Some("two\n"));
            }
            other => panic!("expected text diff, got {other:?}"),
        }

        let added = changes
            .changes
            .iter()
            .find(|change| change.path == "deps/lib/new.txt")
            .expect("submodule added change");
        assert_eq!(added.change_kind, DiffChangeKind::Added);
        assert_eq!(
            added
                .submodule
                .as_ref()
                .map(|submodule| submodule.path.as_str()),
            Some("deps/lib")
        );
    }

    #[test]
    fn clone_rejects_existing_target_directory() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");
        fs::create_dir(parent.path().join("existing")).expect("existing target");

        let error = clone_repository(
            &runner,
            None,
            CloneRepositoryRequest {
                url: "https://example.test/art.git".to_owned(),
                target_parent_directory: display_path(parent.path()),
                directory_name: "existing".to_owned(),
                tool_identity: None,
                operation_id: None,
            },
        )
        .expect_err("existing target should be rejected");

        assert_eq!(error.summary, "target directory already exists");
    }

    #[test]
    fn clone_with_pre_cancelled_token_does_not_create_target() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");
        let token = CancelToken::new();
        token.cancel();

        let error = clone_repository_with_cancel(
            &runner,
            None,
            CloneRepositoryRequest {
                url: "https://example.test/art.git".to_owned(),
                target_parent_directory: display_path(parent.path()),
                directory_name: "cancelled".to_owned(),
                tool_identity: None,
                operation_id: None,
            },
            &token,
        )
        .expect_err("cancelled clone should fail");

        assert_eq!(error.summary, "operation cancelled");
        assert!(!parent.path().join("cancelled").exists());
    }

    #[test]
    fn rejects_bare_repository() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init", "--bare"]);

        let error = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect_err("bare repo should be rejected");

        assert_eq!(error.summary, "不是受支持的 Git 项目类型");
    }

    #[test]
    fn reports_unborn_and_index_lock_health() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        fs::File::create(repo.path.join(".git/index.lock")).expect("index.lock");

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect("open unborn repo");

        assert!(matches!(
            response.health.head,
            RepositoryHeadState::Unborn { .. }
        ));
        assert!(response.health.index_lock.is_some());
    }

    #[test]
    fn lists_local_changes_and_filters_backup_branches() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        repo.git(["config", "user.name", "Tester"]);
        repo.git(["config", "user.email", "tester@example.test"]);
        repo.write("tracked.txt", "one\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "initial"]);
        repo.git(["branch", "backup/hidden"]);
        repo.write("new.txt", "new\n");
        repo.write("tracked.txt", "two\n");

        let changes = list_local_changes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("local changes");
        let branches = list_branches(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("branches");

        assert!(changes
            .changes
            .iter()
            .any(|change| change.path == "new.txt" && change.change_kind == DiffChangeKind::Added));
        assert!(changes
            .changes
            .iter()
            .any(|change| change.path == "tracked.txt"));
        assert!(!branches
            .branches
            .iter()
            .any(|branch| branch.short_name.starts_with("backup/")));
    }

    #[test]
    fn local_changes_render_available_lfs_content_instead_of_pointer() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("asset.bin", "base\n");
        repo.git(["add", "asset.bin"]);
        repo.git(["commit", "-m", "add asset"]);

        let oid = "f3c54363167755d57ec287a7681a6962346c299015b57786a3e8b5b6466152df";
        let pointer = format!(
            "version https://git-lfs.github.com/spec/v1\n\
oid sha256:{oid}\n\
size 16\n"
        );
        repo.write("asset.bin", &pointer);
        repo.write_lfs_object(oid, b"actual lfs text\n");

        let changes = list_local_changes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("local changes");
        let change = changes
            .changes
            .iter()
            .find(|change| change.path == "asset.bin")
            .expect("asset change");

        assert_eq!(change.payload.file_kind, DiffFileKind::Text);
        assert_eq!(change.payload.metadata["lfsResolved"], "true");
        assert_eq!(change.payload.metadata["lfsFetchStatus"], "local");
        match &change.diff {
            DiffContent::Text {
                old_text, new_text, ..
            } => {
                assert_eq!(old_text.as_deref(), Some("base\n"));
                assert_eq!(new_text.as_deref(), Some("actual lfs text\n"));
            }
            other => panic!("expected text diff, got {other:?}"),
        }
    }

    #[test]
    fn fetch_lfs_object_uses_embedded_lfs_runner_with_object_id() {
        let temp = TestTempDir::new("ag-local-change-lfs-fetch").expect("temp repo");
        let dist_root = temp.path().join("dist");
        let manifest = git_dist_manifest_fixture();
        write_git_dist_manifest(&dist_root, &manifest).expect("write manifest");
        write_executable_script(
            &dist_root.join(&manifest.paths.git_executable),
            "#!/bin/sh\nexit 0\n",
            "@echo off\r\nexit /b 0\r\n",
        )
        .expect("write git");
        let marker = temp.path().join("lfs-args.txt");
        let unix_script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexit 0\n",
            marker.display()
        );
        let windows_script = format!(
            "@echo off\r\necho %* > \"{}\"\r\nexit /b 0\r\n",
            marker.display()
        );
        write_executable_script(
            &dist_root.join(&manifest.paths.git_lfs_executable),
            &unix_script,
            &windows_script,
        )
        .expect("write git-lfs");
        write_executable_script(
            &dist_root.join(&manifest.paths.credential_helper),
            "#!/bin/sh\nexit 0\n",
            "@echo off\r\nexit /b 0\r\n",
        )
        .expect("write helper");
        write_executable_script(
            &dist_root.join(&manifest.paths.ssh_askpass),
            "#!/bin/sh\nexit 0\n",
            "@echo off\r\nexit /b 0\r\n",
        )
        .expect("write askpass");
        let distribution =
            GitDistribution::from_manifest(dist_root, manifest).expect("load fake distribution");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("create repo");
        let oid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        fetch_lfs_object(&runner, &repo, oid, "testFetchLfs").expect("fetch lfs object");

        let args = fs::read_to_string(marker).expect("read lfs args");
        assert!(args.contains("-C"));
        assert!(args.contains(&display_path(&repo)));
        assert!(args.contains("fetch"));
        assert!(args.contains("--object-id"));
        assert!(args.contains("origin"));
        assert!(args.contains(oid));
    }

    #[test]
    fn rejects_linked_worktree() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let linked = TestTempDir::new("ag-linked-worktree").expect("linked worktree path");
        fs::remove_dir_all(linked.path()).expect("git worktree target must not exist");
        let linked_path = display_path(linked.path());
        repo.git(["worktree", "add", linked_path.as_str(), "HEAD"]);

        let error = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(linked.path()),
                tool_identity: None,
            },
        )
        .expect_err("linked worktree should be rejected");

        assert_eq!(error.summary, "不是受支持的 Git 项目类型");
    }

    #[test]
    fn reports_detached_head_warning() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["checkout", "--detach", "HEAD"]);

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect("open detached repo");

        assert!(matches!(
            response.health.head,
            RepositoryHeadState::Detached { .. }
        ));
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.kind == RepositoryOpenWarningKind::DetachedHead));
    }

    #[test]
    fn multiple_remotes_manage_only_origin() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["remote", "add", "origin", "https://example.test/origin.git"]);
        repo.git([
            "remote",
            "add",
            "upstream",
            "https://example.test/upstream.git",
        ]);

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect("open repo with remotes");

        assert_eq!(response.remote_mode, RepositoryRemoteMode::Origin);
        assert!(response
            .remotes
            .iter()
            .any(|remote| remote.name == "origin" && remote.managed));
        assert!(response
            .remotes
            .iter()
            .any(|remote| remote.name == "upstream" && !remote.managed));
        assert!(response.warnings.iter().any(|warning| {
            warning.kind == RepositoryOpenWarningKind::MultipleRemotesOriginManaged
        }));
    }

    #[test]
    fn writes_tool_identity_only_to_local_config() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);

        open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: Some(artistic_git_contracts::ToolGitIdentity {
                    name: Some("Artistic Git".to_owned()),
                    email: Some("tool@example.test".to_owned()),
                }),
            },
        )
        .expect("open with identity");

        assert_eq!(
            repo.git_output(["config", "--local", "--get", "user.name"])
                .trim(),
            "Artistic Git"
        );
        assert_eq!(
            repo.git_output(["config", "--local", "--get", "user.email"])
                .trim(),
            "tool@example.test"
        );
    }

    #[test]
    fn lists_stashes_and_searches_log() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("second.txt", "needle\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "second searchable commit"]);
        repo.write("second.txt", "needle changed\n");
        repo.git(["stash", "push", "-m", "Auto Stash: before test"]);

        let stashes = list_stashes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("stashes");
        let log = log_page_with_cancel(
            &runner,
            LogPageRequest {
                repository_path: display_path(&repo.path),
                after: None,
                limit: Some(1),
            },
            &CancelToken::new(),
        )
        .expect("log page");
        let search = search_log_with_cancel(
            &runner,
            LogSearchRequest {
                repository_path: display_path(&repo.path),
                grep: Some("searchable".to_owned()),
                author: None,
                pickaxe: None,
                after: None,
                limit: Some(200),
            },
            &CancelToken::new(),
        )
        .expect("search log");

        assert!(stashes.stashes.iter().any(|stash| stash.is_auto_stash));
        assert_eq!(log.commits.len(), 1);
        assert!(log.next_after.is_some());
        assert_eq!(search.commits.len(), 1);
        assert_eq!(search.commits[0].subject, "second searchable commit");
    }

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => {
                eprintln!(
                    "skipping real Git/LFS repository test: ARTISTIC_GIT_DIST_DIR is not set"
                );
                return None;
            }
            Err(error) => panic!("invalid embedded git distribution: {error}"),
        };
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-app-runner-home").expect("temp home");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("create runner home");
        let runner = GitRunner::from_distribution(distribution, home);
        Some((runner, temp))
    }

    fn allow_file_protocol_for_local_submodule_fixtures(runner: &GitRunner) {
        git_stdout(
            runner,
            None,
            ["config", "--global", "protocol.file.allow", "always"],
            "test",
        )
        .expect("allow file protocol for local submodule fixtures");
    }

    struct TestRepo {
        path: PathBuf,
        _temp: TestTempDir,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-repo").expect("temp repo");
            Self {
                path: temp.path().to_path_buf(),
                _temp: temp,
                runner: runner.clone(),
            }
        }

        fn init_with_commit(&self) {
            self.git(["init"]);
            self.git(["config", "user.name", "Tester"]);
            self.git(["config", "user.email", "tester@example.test"]);
            self.write("tracked.txt", "one\n");
            self.git(["add", "."]);
            self.git(["commit", "-m", "initial"]);
        }

        fn git<I, S>(&self, args: I)
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            self.git_output(args);
        }

        fn git_output<I, S>(&self, args: I) -> String
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            git_stdout(&self.runner, Some(&self.path), args, "test").expect("git command")
        }

        fn write(&self, relative: &str, content: &str) {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("parent dir");
            }
            let mut file = fs::File::create(path).expect("create file");
            file.write_all(content.as_bytes()).expect("write file");
        }

        fn write_lfs_object(&self, oid: &str, contents: &[u8]) {
            let path = self
                .path
                .join(".git")
                .join("lfs")
                .join("objects")
                .join(&oid[0..2])
                .join(&oid[2..4])
                .join(oid);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create lfs object dir");
            }
            fs::write(path, contents).expect("write lfs object");
        }
    }
}
