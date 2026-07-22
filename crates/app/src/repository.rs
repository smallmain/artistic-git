#[cfg(test)]
use artistic_git_contracts::StashEntry;
use artistic_git_contracts::{
    AcceptRemoteHistoryRequest, AcceptRemoteHistoryResponse, AppError, AppErrorCategory, AppResult,
    BranchExistence, BranchListResponse, BranchNameValidationRequest, BranchNameValidationResponse,
    BranchOperationResponse, BranchSummary, CancelCloneRepositoryRequest,
    CancelCloneRepositoryResponse, CancelOperationRequest, CancelOperationResponse,
    CancelStashRestoreRequest, CancelStashRestoreResponse, CheckoutBranchRequest,
    CloneRepositoryRequest, CloneRepositoryResponse, CommitChangedFile, CommitDetailsRequest,
    CommitDetailsResponse, CommitFileDetailRequest, CommitFileDetailResponse, CommitSummary,
    CreateAutoStashRequest, CreateBranchRequest, CreateStashRequest, CreateStashResponse,
    DeleteBranchRequest, DeleteSafetyBackupRequest, DeleteSafetyBackupResponse, DeleteStashRequest,
    DeleteStashResponse, DiffAsset, DiffChangeKind, DiffContent, DiffFileKind, DiffPayload,
    FetchRepositoryRequest, FetchRepositoryResponse, FetchStateEvent, GitCommandError,
    IndexLockInfo, LfsContentStatus, LocalChange, LocalChangeDetailRequest, LocalChangeSubmodule,
    LocalChangesRenormalizeSuggestion, LocalChangesResponse, LogPageRequest, LogPageResponse,
    LogSearchRequest, OpenRepositoryRequest, OpenRepositoryResponse, OperationId,
    OperationProgressEvent, ProgressState, RemoteRepositoryProbeRequest,
    RemoteRepositoryProbeResponse, RemoteSettingsResponse, RenormalizePreviewRequest,
    RenormalizePreviewResponse, RepositoryHeadState, RepositoryHealth, RepositoryMiddleState,
    RepositoryMiddleStateKind, RepositoryOpenWarning, RepositoryOpenWarningKind,
    RepositoryPathRequest, RepositoryRemote, RepositoryRemoteMode, RepositorySummary,
    RestoreStashRequest, RestoreStashResponse, SafetyBackupListResponse, SaveRemoteSettingsRequest,
    StashDetailsRequest, StashDetailsResponse, StashFileDetailRequest, StashFileDetailResponse,
    StashListResponse,
};
use artistic_git_core::config::{
    AppSettings, ConfigActor, GitUserSettings, ProjectSettings, WindowGeometry,
};
use artistic_git_core::diff_engine::{
    classify_diff_file, detect_image, parse_lfs_pointer, DiffChangeKind as CoreDiffChangeKind,
    DiffFileKind as CoreDiffFileKind, DiffFileProbe, OVERSIZED_TEXT_BYTES,
};
use artistic_git_core::keyring::{KeyringVault, SystemCredentialStore};
use artistic_git_git_runner::{
    parse_git_progress_line, CancelToken, GitCommandPlan, GitRunner, OperationBusy,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DEFAULT_LOG_LIMIT: usize = 200;
const MAX_LOG_LIMIT: usize = 200;
const MAX_LOG_REVISIONS: usize = 20;
const DEFAULT_COMMIT_DETAIL_FILE_LIMIT: usize = 1_000;
const MAX_COMMIT_DETAIL_FILE_LIMIT: usize = 5_000;
const MAX_COMMIT_BODY_BYTES: usize = 64 * 1024;
const TOOL_WORKTREE_PREFIX: &str = "artistic-git-";
const RENORMALIZE_SUGGESTION_THRESHOLD: usize = 1_000;
const RENORMALIZE_SUGGESTION_MIN_MODIFIED_PERCENT: usize = 80;
const RENORMALIZE_SUGGESTION_SAMPLE_LIMIT: usize = 8;
const PROBE_REMOTE_REPOSITORY_OPERATION: &str = "probeRemoteRepository";
const LOCAL_CHANGE_PREVIEW_FILE_LIMIT: usize = 250;
const LOCAL_CHANGE_PREVIEW_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const IMAGE_PREVIEW_LIMIT_BYTES: usize = 8 * 1024 * 1024;
const LOCAL_CHANGE_ENTRY_LIMIT: usize = 5_000;
const COMMAND_OUTPUT_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const COMMAND_OUTPUT_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const PROGRESS_LINE_LIMIT_BYTES: usize = 8 * 1024;
const OUTPUT_READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const LFS_RULE_SCAN_ENTRY_LIMIT: usize = 100_000;
const LFS_ATTRIBUTES_READ_LIMIT: usize = 64 * 1024;
const BRANCH_LIST_ENTRY_LIMIT: usize = 5_000;
const BRANCH_REF_QUERY_LIMIT: usize = BRANCH_LIST_ENTRY_LIMIT + 1;
const REMOTE_BRANCH_LIST_ENTRY_LIMIT: usize = 5_000;
const WORKTREE_GITDIR_FILE_LIMIT_BYTES: usize = 64 * 1024;
const CANCEL_COMPLETION_TIMEOUT: Duration = Duration::from_secs(60);
// Git briefly creates `.git/index.lock` while refreshing the index during concurrent
// `status`/`diff` reads. Residual crash locks almost always age past this threshold
// before the user reopens the app; active external writers will surface once age grows.
const INDEX_LOCK_RESIDUAL_AGE_SECONDS: u64 = 2;

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
    operations: Mutex<BTreeMap<String, CancellableOperationEntry>>,
    completion: Condvar,
}

#[derive(Debug)]
struct CancellableOperationEntry {
    phase: CancellableOperationPhase,
    token: CancelToken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancellableOperationPhase {
    Reserved,
    Running,
}

impl CancellableOperationRegistry {
    fn reserve(
        self: &Arc<Self>,
        operation_id: &OperationId,
        operation_name: &str,
    ) -> AppResult<CancellableOperationReservation> {
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

        operations.insert(
            operation_id.as_str().to_owned(),
            CancellableOperationEntry {
                phase: CancellableOperationPhase::Reserved,
                token: CancelToken::new(),
            },
        );
        Ok(CancellableOperationReservation {
            operation_id: operation_id.as_str().to_owned(),
            registry: Arc::clone(self),
        })
    }

    fn register(
        self: &Arc<Self>,
        operation_id: &OperationId,
        operation_name: &str,
    ) -> AppResult<(CancelToken, CancellableOperationGuard)> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| operation_registry_error(operation_name))?;
        let token = match operations.get_mut(operation_id.as_str()) {
            Some(entry) if entry.phase == CancellableOperationPhase::Reserved => {
                entry.phase = CancellableOperationPhase::Running;
                entry.token.clone()
            }
            Some(_) => {
                return Err(logged(AppError::expected(
                    "operation is already registered",
                    operation_name,
                )));
            }
            None => {
                let token = CancelToken::new();
                operations.insert(
                    operation_id.as_str().to_owned(),
                    CancellableOperationEntry {
                        phase: CancellableOperationPhase::Running,
                        token: token.clone(),
                    },
                );
                token
            }
        };

        Ok((
            token,
            CancellableOperationGuard {
                operation_id: operation_id.as_str().to_owned(),
                registry: Arc::clone(self),
            },
        ))
    }

    fn cancel(&self, operation_id: &OperationId) -> AppResult<bool> {
        let token = self
            .operations
            .lock()
            .map_err(|_| operation_registry_error("cancelOperation"))?
            .get(operation_id.as_str())
            .map(|entry| entry.token.clone());

        if let Some(token) = token {
            token.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn cancel_and_wait(&self, operation_id: &OperationId, operation_name: &str) -> AppResult<bool> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| operation_registry_error(operation_name))?;
        let Some(token) = operations
            .get(operation_id.as_str())
            .map(|entry| entry.token.clone())
        else {
            return Ok(false);
        };

        token.cancel();
        let deadline = Instant::now() + CANCEL_COMPLETION_TIMEOUT;
        while operations.contains_key(operation_id.as_str()) {
            let now = Instant::now();
            if now >= deadline {
                return Err(operation_cancellation_timeout_error(
                    operation_id,
                    operation_name,
                ));
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next, timeout) = self
                .completion
                .wait_timeout(operations, remaining)
                .map_err(|_| operation_registry_error(operation_name))?;
            operations = next;
            if timeout.timed_out() && operations.contains_key(operation_id.as_str()) {
                return Err(operation_cancellation_timeout_error(
                    operation_id,
                    operation_name,
                ));
            }
        }

        Ok(true)
    }

    fn unregister(&self, operation_id: &str) {
        if let Ok(mut operations) = self.operations.lock() {
            if operations.remove(operation_id).is_some() {
                self.completion.notify_all();
            }
        }
    }

    fn unregister_reservation(&self, operation_id: &str) {
        if let Ok(mut operations) = self.operations.lock() {
            if operations
                .get(operation_id)
                .is_some_and(|entry| entry.phase == CancellableOperationPhase::Reserved)
            {
                operations.remove(operation_id);
                self.completion.notify_all();
            }
        }
    }
}

#[derive(Debug)]
pub struct CancellableOperationReservation {
    operation_id: String,
    registry: Arc<CancellableOperationRegistry>,
}

impl Drop for CancellableOperationReservation {
    fn drop(&mut self) {
        self.registry.unregister_reservation(&self.operation_id);
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
        let operation_id = request.operation_id.clone();
        let auth_operation_id = operation_id.clone();
        let repository_path = PathBuf::from(request.path.trim());
        self.run_cancellable_operation(operation_id, "openRepository", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                auth_operation_id,
                Some(repository_path),
                || {
                    open_repository_with_progress(
                        &self.runner,
                        self.config.as_ref(),
                        request,
                        progress,
                    )
                },
            )
        })
    }

    pub fn clone_repository(
        &self,
        request: CloneRepositoryRequest,
    ) -> AppResult<CloneRepositoryResponse> {
        self.clone_repository_with_progress(request, |_| {})
    }

    pub fn probe_remote_repository(
        &self,
        request: RemoteRepositoryProbeRequest,
    ) -> AppResult<RemoteRepositoryProbeResponse> {
        let operation_id = request.operation_id.clone();
        let auth_operation_id = operation_id.clone();
        self.run_cancellable_operation(operation_id, PROBE_REMOTE_REPOSITORY_OPERATION, || {
            if request.interactive {
                crate::git_ops::with_auth_runtime_for_operation(
                    self.auth_runtime.as_ref(),
                    crate::auth_ipc::InteractionPolicy::interactive(),
                    auth_operation_id,
                    None,
                    || probe_remote_repository(&self.runner, request),
                )
            } else {
                probe_remote_repository(&self.runner, request)
            }
        })
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
        let registered = operation_id
            .as_ref()
            .map(|operation_id| {
                self.cancellable_operations
                    .register(operation_id, "cloneRepository")
            })
            .transpose()?;
        let (token, _operation_guard) = registered
            .map(|(token, guard)| (token, Some(guard)))
            .unwrap_or_else(|| (CancelToken::new(), None));

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

    pub fn cancel_clone_repository_and_wait(
        &self,
        request: CancelCloneRepositoryRequest,
    ) -> AppResult<CancelCloneRepositoryResponse> {
        let response = self.cancel_operation_and_wait(CancelOperationRequest {
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

    pub fn cancel_operation_and_wait(
        &self,
        request: CancelOperationRequest,
    ) -> AppResult<CancelOperationResponse> {
        Ok(CancelOperationResponse {
            cancelled: self
                .cancellable_operations
                .cancel_and_wait(&request.operation_id, "cancelOperation")?,
        })
    }

    pub fn reserve_cancellable_operation(
        &self,
        operation_id: Option<&OperationId>,
        operation_name: &str,
    ) -> AppResult<Option<CancellableOperationReservation>> {
        operation_id
            .map(|operation_id| {
                self.cancellable_operations
                    .reserve(operation_id, operation_name)
            })
            .transpose()
    }

    pub(crate) fn run_cancellable_operation<T>(
        &self,
        operation_id: Option<OperationId>,
        operation_name: &str,
        action: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        let registered = operation_id
            .as_ref()
            .map(|operation_id| {
                self.cancellable_operations
                    .register(operation_id, operation_name)
            })
            .transpose()?;
        let (token, _operation_guard) = registered
            .map(|(token, guard)| (token, Some(guard)))
            .unwrap_or_else(|| (CancelToken::new(), None));

        crate::git_ops::with_cancel_token_for_operation(&token, action)
    }

    pub fn repository_summary(
        &self,
        request: RepositoryPathRequest,
    ) -> AppResult<RepositorySummary> {
        repository_summary(&self.runner, request)
    }

    pub fn reset_bisect(&self, request: RepositoryPathRequest) -> AppResult<RepositorySummary> {
        let _permit = self
            .runner
            .operation_concurrency()
            .try_begin_exclusive()
            .map_err(reset_bisect_busy_error)?;
        reset_bisect(&self.runner, request)
    }

    pub fn fetch_started_event(&self, repository_path: &str) -> FetchStateEvent {
        self.fetch_states.started_event(repository_path)
    }

    pub fn fetch_failed_event(
        &self,
        repository_path: &str,
        message: impl Into<String>,
    ) -> FetchStateEvent {
        self.fetch_states.failed_event(repository_path, message)
    }

    pub fn fetch_succeeded_event(&self, repository_path: &str) -> FetchStateEvent {
        self.fetch_states.success_event(repository_path)
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
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "syncCurrentBranch", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::sync_current_branch(&self.runner, request),
            )
        })
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
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "syncCurrentBranch", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::sync_current_branch_with_progress(&self.runner, request, progress),
            )
        })
    }

    pub fn sync_branch(
        &self,
        request: artistic_git_contracts::SyncBranchRequest,
    ) -> AppResult<artistic_git_contracts::SyncBranchResponse> {
        let operation_id = request.operation_id.clone();
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "syncBranch", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::sync_branch(&self.runner, request),
            )
        })
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
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "syncBranch", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::sync_branch_with_progress(&self.runner, request, progress),
            )
        })
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
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "syncAllBranches", || {
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
        })
    }

    pub fn accept_remote_history(
        &self,
        request: AcceptRemoteHistoryRequest,
    ) -> AppResult<AcceptRemoteHistoryResponse> {
        let operation_id = request.operation_id.clone();
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "acceptRemoteHistory", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::accept_remote_history(&self.runner, request),
            )
        })
    }

    pub fn start_review_mode(
        &self,
        request: artistic_git_contracts::StartReviewModeRequest,
    ) -> AppResult<artistic_git_contracts::StartReviewModeResponse> {
        let operation_id = request.operation_id.clone();
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "startReviewMode", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || {
                    crate::start_review_mode_with_config(
                        &self.runner,
                        self.config.as_ref(),
                        request,
                    )
                },
            )
        })
    }

    pub fn sync_review_mode(
        &self,
        request: artistic_git_contracts::ReviewModeRequest,
    ) -> AppResult<artistic_git_contracts::SyncReviewModeResponse> {
        let operation_id = request.operation_id.clone();
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "syncReviewMode", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::sync_review_mode_with_lock(&self.runner, request),
            )
        })
    }

    pub fn exit_review_mode(
        &self,
        request: artistic_git_contracts::ReviewModeRequest,
    ) -> AppResult<artistic_git_contracts::ExitReviewModeResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "exitReviewMode", || {
            crate::exit_review_mode_with_config(&self.runner, self.config.as_ref(), request)
        })
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
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "recoverReviewModeStash", || {
            crate::recover_review_mode_stash_with_config(
                &self.runner,
                self.config.as_ref(),
                request,
            )
        })
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
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "createBranch", || {
            crate::branches::create_branch(&self.runner, request)
        })
    }

    pub fn checkout_branch(
        &self,
        request: CheckoutBranchRequest,
    ) -> AppResult<BranchOperationResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "checkoutBranch", || {
            crate::branches::checkout_branch(&self.runner, request)
        })
    }

    pub fn delete_branch(
        &self,
        request: DeleteBranchRequest,
    ) -> AppResult<BranchOperationResponse> {
        let operation_id = request.operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(operation_id.clone(), "deleteBranch", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::branches::delete_branch(&self.runner, request),
            )
        })
    }

    pub fn delete_safety_backup(
        &self,
        request: DeleteSafetyBackupRequest,
    ) -> AppResult<DeleteSafetyBackupResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "deleteSafetyBackup", || {
            crate::delete_safety_backup_with_lock(&self.runner, request)
        })
    }

    pub fn list_local_changes(
        &self,
        request: RepositoryPathRequest,
    ) -> AppResult<LocalChangesResponse> {
        list_local_changes(&self.runner, request)
    }

    pub fn local_change_detail(&self, request: LocalChangeDetailRequest) -> AppResult<LocalChange> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "localChangeDetail", || {
            local_change_detail(&self.runner, request)
        })
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
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "createStash", || {
            crate::stash::create_stash(&self.runner, request)
        })
    }

    pub fn create_auto_stash(
        &self,
        request: CreateAutoStashRequest,
    ) -> AppResult<CreateStashResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "createAutoStash", || {
            crate::stash::create_auto_stash(&self.runner, request)
        })
    }

    pub fn stash_details(&self, request: StashDetailsRequest) -> AppResult<StashDetailsResponse> {
        crate::stash::stash_details(&self.runner, request)
    }

    pub fn stash_file_detail(
        &self,
        request: StashFileDetailRequest,
    ) -> AppResult<StashFileDetailResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "stashFileDetail", || {
            crate::stash::stash_file_detail(&self.runner, request)
        })
    }

    pub fn restore_stash(&self, request: RestoreStashRequest) -> AppResult<RestoreStashResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "restoreStash", || {
            crate::stash::restore_stash(&self.runner, request)
        })
    }

    pub fn cancel_stash_restore(
        &self,
        request: CancelStashRestoreRequest,
    ) -> AppResult<CancelStashRestoreResponse> {
        crate::stash::cancel_stash_restore(&self.runner, request)
    }

    pub fn delete_stash(&self, request: DeleteStashRequest) -> AppResult<DeleteStashResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "deleteStash", || {
            crate::stash::delete_stash(&self.runner, request)
        })
    }

    pub fn log_page(&self, request: LogPageRequest) -> AppResult<LogPageResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "logPage", || {
            let token = crate::git_ops::active_cancel_token().unwrap_or_default();
            log_page_with_cancel(&self.runner, request, &token)
        })
    }

    pub fn search_log(&self, request: LogSearchRequest) -> AppResult<LogPageResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "searchLog", || {
            let token = crate::git_ops::active_cancel_token().unwrap_or_default();
            search_log_with_cancel(&self.runner, request, &token)
        })
    }

    pub fn commit_details(
        &self,
        request: CommitDetailsRequest,
    ) -> AppResult<CommitDetailsResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "commitDetails", || {
            commit_details(&self.runner, request)
        })
    }

    pub fn commit_file_detail(
        &self,
        request: CommitFileDetailRequest,
    ) -> AppResult<CommitFileDetailResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "commitFileDetail", || {
            commit_file_detail(&self.runner, request)
        })
    }

    pub fn commit_changes(
        &self,
        request: artistic_git_contracts::CommitRequest,
    ) -> AppResult<artistic_git_contracts::CommitResponse> {
        let operation_id = request.operation_id.clone();
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "commitChanges", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::commit_changes(&self.runner, request),
            )
        })
    }

    pub fn restore_changes(
        &self,
        request: artistic_git_contracts::RestoreChangesRequest,
    ) -> AppResult<artistic_git_contracts::RestoreChangesResponse> {
        let operation_id = request.operation_id.clone();
        self.run_cancellable_operation(operation_id, "restoreChanges", || {
            crate::restore_changes(&self.runner, request)
        })
    }

    pub fn revert_commit(
        &self,
        request: artistic_git_contracts::RevertCommitRequest,
    ) -> AppResult<artistic_git_contracts::RevertCommitResponse> {
        let operation_id = request.operation_id.clone();
        let cancellable_operation_id = operation_id.clone();
        let repository_path = Some(PathBuf::from(request.repository_path.clone()));
        self.run_cancellable_operation(cancellable_operation_id, "revertCommit", || {
            crate::git_ops::with_auth_runtime_for_operation(
                self.auth_runtime.as_ref(),
                crate::auth_ipc::InteractionPolicy::interactive(),
                operation_id,
                repository_path,
                || crate::revert_commit(&self.runner, request),
            )
        })
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

    pub fn list_recent_projects(
        &self,
        request: crate::settings::RecentProjectsRequest,
    ) -> AppResult<Vec<crate::settings::RecentProjectEntry>> {
        crate::settings::list_recent_projects(self.config.as_ref(), request)
    }

    pub fn forget_recent_project(
        &self,
        request: crate::settings::ForgetRecentProjectRequest,
    ) -> AppResult<()> {
        crate::settings::forget_recent_project(self.config.as_ref(), request)
    }

    pub fn clear_recent_projects(&self) -> AppResult<()> {
        crate::settings::clear_recent_projects(self.config.as_ref())
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
                let operation_id = context.operation_id.clone();
                let mut prompter = move |request| {
                    prompt_sink.prompt_https_credentials_for_operation(&operation_id, request)
                };
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
                    &context.operation_id,
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
    operation_id: &OperationId,
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
        } => match prompt_sink.prompt_ssh_passphrase_for_operation(
            operation_id,
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
    let operation_id = request
        .operation_id
        .clone()
        .unwrap_or_else(open_operation_id);
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

    let mut non_fatal_errors = Vec::new();
    clean_tool_worktree_residue(&git_common_dir);
    crate::sync::cleanup_sync_worktree_residue(runner, &root);
    if acquire_write_lock {
        if let Err(error) = apply_tool_identity(
            runner,
            &root,
            request.tool_identity.as_ref(),
            "openRepository",
        ) {
            non_fatal_errors.push(error);
        }
    } else {
        apply_tool_identity(
            runner,
            &root,
            request.tool_identity.as_ref(),
            "openRepository",
        )?;
        install_lfs_if_needed(runner, &root)?;
        update_submodules_after_checkout(runner, &root, "openRepository", operation_id, progress)?;
    }

    let remotes = list_remotes(runner, &root)?;
    let remote_mode = remote_mode(&remotes);
    let health = inspect_health(runner, &root, &git_common_dir)?;
    let summary = build_summary(
        &root,
        remote_mode,
        remotes.iter().any(|remote| remote.is_origin),
        &remotes,
        &health,
    );
    let warnings = open_warnings(&remotes, remote_mode, &health);

    if let Some(config) = config {
        let path = display_path(&root);
        let timestamp = unix_now_seconds().to_string();
        if let Err(source) = config.mark_project_opened(path, timestamp) {
            non_fatal_errors.push(logged(AppError::unexpected(
                format!("failed to record recently opened repository: {source}"),
                "openRepository",
            )));
        }
    }

    Ok(OpenRepositoryResponse {
        repository_path: display_path(&root),
        git_dir: display_path(&git_dir),
        remote_mode,
        remotes,
        warnings,
        non_fatal_errors,
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

pub fn probe_remote_repository(
    runner: &GitRunner,
    request: RemoteRepositoryProbeRequest,
) -> AppResult<RemoteRepositoryProbeResponse> {
    let url = validate_remote_repository_url(&request.url, PROBE_REMOTE_REPOSITORY_OPERATION)?;
    let safe_url = diagnostic_remote_url(url);
    let output = crate::git_ops::git_stdout_with_redacted_argument(
        runner,
        None,
        [
            OsString::from("ls-remote"),
            OsString::from("--symref"),
            OsString::from("--"),
            OsString::from(url),
            OsString::from("HEAD"),
            OsString::from("refs/heads/*"),
        ],
        OsString::from(url),
        OsString::from(safe_url),
        PROBE_REMOTE_REPOSITORY_OPERATION,
    )?;

    Ok(parse_remote_repository_probe(&output))
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
    crate::git_ops::with_cancel_token_for_operation(cancel_token, || {
        clone_repository_with_cancel_and_progress_inner(
            runner,
            config,
            request,
            cancel_token,
            progress,
        )
    })
}

fn clone_repository_with_cancel_and_progress_inner<F>(
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
    let url = validate_remote_repository_url(&request.url, "cloneRepository")?;
    let branch_name = validate_clone_branch_name(runner, request.branch_name.as_deref())?;
    let operation_id = request.operation_id.clone();

    let _permit = runner
        .operation_concurrency()
        .try_begin_write()
        .map_err(clone_busy_error)?;

    run_clone_command(
        runner,
        url,
        branch_name.as_deref(),
        &target,
        cancel_token,
        operation_id.as_ref(),
        &progress,
    )?;
    if cancel_token.is_cancelled() {
        return Err(cancelled_clone_error_after_cleanup(&target));
    }
    if let Some(branch_name) = branch_name.as_deref() {
        let current_branch = git_stdout(
            runner,
            Some(&target.path),
            ["branch", "--show-current"],
            "cloneRepository",
        );
        match current_branch {
            Ok(current_branch) if current_branch.trim() == branch_name => {}
            Ok(_) => {
                return Err(clone_error_after_cleanup(
                    &target,
                    logged(AppError::expected(
                        "selected branch is no longer available on the remote",
                        "cloneRepository",
                    )),
                ));
            }
            Err(error) => {
                return Err(clone_error_after_cleanup(&target, error));
            }
        }
    }

    let repository = match open_repository_impl(
        runner,
        config,
        OpenRepositoryRequest {
            path: display_path(&target.path),
            tool_identity: request.tool_identity,
            operation_id: operation_id.clone(),
        },
        operation_id.as_ref(),
        &progress,
        false,
    ) {
        Ok(repository) => repository,
        Err(error) => {
            return Err(clone_error_after_cleanup(&target, error));
        }
    };

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
        &remotes,
        &health,
    ))
}

pub fn reset_bisect(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<RepositorySummary> {
    let root = canonical_repository_path(&request.repository_path, "resetBisect")?;
    git_stdout(runner, Some(&root), ["bisect", "reset"], "resetBisect")?;
    repository_summary(
        runner,
        RepositoryPathRequest {
            repository_path: display_path(&root),
        },
    )
}

pub fn list_branches(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<BranchListResponse> {
    let root = canonical_repository_path(&request.repository_path, "listBranches")?;
    let current_branch = current_branch_name(runner, &root, "listBranches").ok();
    let query_limit = format!("--count={BRANCH_REF_QUERY_LIMIT}");
    let local_output = git_stdout(
        runner,
        Some(&root),
        [
            "for-each-ref",
            query_limit.as_str(),
            "--exclude=refs/heads/backup/*",
            "--sort=-committerdate",
            "--sort=-HEAD",
            "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track,nobracket)",
            "refs/heads",
        ],
        "listBranches",
    )?;
    let remote_output = git_stdout(
        runner,
        Some(&root),
        [
            "for-each-ref",
            query_limit.as_str(),
            "--exclude=refs/remotes/origin/backup/*",
            "--exclude=refs/remotes/origin/HEAD",
            "--sort=-committerdate",
            "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track,nobracket)",
            "refs/remotes/origin",
        ],
        "listBranches",
    )?;

    let mut merged = BTreeMap::<String, BranchAccumulator>::new();
    if let Some(current_branch) = current_branch
        .as_ref()
        .filter(|branch| !branch.starts_with("backup/"))
    {
        merged.insert(current_branch.clone(), BranchAccumulator::default());
    }
    let local_query_truncated = local_output.lines().count() >= BRANCH_REF_QUERY_LIMIT;
    let remote_query_truncated = remote_output.lines().count() >= BRANCH_REF_QUERY_LIMIT;
    let mut truncated = local_query_truncated || remote_query_truncated;
    for line in local_output.lines().chain(remote_output.lines()) {
        let parts = line.split('\0').collect::<Vec<_>>();
        if parts.len() < 5 {
            continue;
        }

        let refname = parts[0];
        let oid = empty_to_none(parts[1]).map(str::to_owned);
        let commit_time = empty_to_none(parts[2]).map(str::to_owned);
        let upstream = empty_to_none(parts[3]).map(str::to_owned);
        let upstream_track = parts[4].trim().to_owned();

        if let Some(local) = refname.strip_prefix("refs/heads/") {
            if local.starts_with("backup/") {
                continue;
            }
            let entry = merged.entry(local.to_owned()).or_default();
            entry.local_oid = oid;
            entry.local_time = commit_time;
            entry.upstream = upstream;
            entry.upstream_track = Some(upstream_track);
        } else if let Some(remote) = refname.strip_prefix("refs/remotes/origin/") {
            if remote == "HEAD" || remote.starts_with("backup/") {
                continue;
            }
            let entry = merged.entry(remote.to_owned()).or_default();
            entry.remote_oid = oid;
            entry.remote_time = commit_time;
        }
    }

    if remote_query_truncated {
        if let Some(current_branch) = current_branch.as_deref() {
            if let Some(entry) = merged.get_mut(current_branch) {
                if entry.remote_oid.is_none() {
                    let remote_ref = format!("refs/remotes/origin/{current_branch}");
                    entry.remote_oid = exact_ref_oid(runner, &root, &remote_ref)?;
                }
            }
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
    truncated |= branches.len() > BRANCH_LIST_ENTRY_LIMIT;
    branches.truncate(BRANCH_LIST_ENTRY_LIMIT);

    Ok(BranchListResponse {
        branches,
        truncated,
    })
}

pub fn list_local_changes(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<LocalChangesResponse> {
    let root = canonical_repository_path(&request.repository_path, "listLocalChanges")?;
    let mut preview_budget = LocalChangePreviewBudget::metadata_only();
    let mut entry_budget = LocalChangeEntryBudget::default();
    let mut changes = list_local_changes_for_repository(
        runner,
        &root,
        None,
        &mut preview_budget,
        &mut entry_budget,
        &[],
        LocalChangeLoadPolicy::Batch,
    )?;

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
                &mut preview_budget,
                &mut entry_budget,
                &[],
                LocalChangeLoadPolicy::Batch,
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
    preview_budget: &mut LocalChangePreviewBudget,
    entry_budget: &mut LocalChangeEntryBudget,
    path_filters: &[String],
    load_policy: LocalChangeLoadPolicy,
) -> AppResult<Vec<LocalChange>> {
    let inspect_submodules = repository_has_submodules(root);
    let mut args = vec![
        OsString::from("status"),
        OsString::from("--porcelain=v1"),
        OsString::from("-z"),
        OsString::from("--find-renames"),
    ];
    if !path_filters.is_empty() {
        args.push(OsString::from("--"));
        args.extend(path_filters.iter().map(crate::git_ops::literal_pathspec));
    }
    let output = git_output_bytes(runner, Some(root), args, load_policy.operation_name())?;
    entry_budget.reserve(local_change_entry_count_bytes(&output), root)?;
    let changed_lines = if output.is_empty() || preview_budget.exhausted() {
        BTreeMap::new()
    } else {
        local_change_changed_lines(runner, root, path_filters, load_policy.operation_name())
    };
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
        if inspect_submodules
            && should_skip_uncommitted_submodule_directory_change(
                runner,
                root,
                &path,
                old_path.as_deref(),
                &index_status,
                &worktree_status,
            )?
        {
            index += 1;
            continue;
        }

        let diff_context = LocalChangeDiffContext {
            root,
            path: &path,
            old_path: old_path.as_deref(),
            change_kind,
            changed_lines: changed_lines.get(&path).copied(),
            index_status: &index_status,
            inspect_submodules,
            worktree_status: &worktree_status,
            load_policy,
        };
        let (payload, diff) = local_change_diff(runner, diff_context, preview_budget)?;

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

pub fn local_change_detail(
    runner: &GitRunner,
    request: LocalChangeDetailRequest,
) -> AppResult<LocalChange> {
    const OPERATION: &str = "localChangeDetail";
    let root = canonical_repository_path(&request.repository_path, OPERATION)?;
    let requested_path = request.path;
    let requested_old_path = request.old_path;
    let (target_root, path_filters, submodule) = if let Some(submodule) = request.submodule {
        let requested_submodule = canonical_or_self(&repository_relative_path(
            &root,
            &submodule.path,
            OPERATION,
        )?);
        let initialized = initialized_submodule_paths(runner, &root, OPERATION)?;
        if !initialized.iter().any(|path| path == &requested_submodule) {
            return Err(logged(AppError::expected(
                "the selected submodule is no longer available",
                OPERATION,
            )));
        }
        let canonical_submodule_path =
            repository_relative_display_path(&root, &requested_submodule).ok_or_else(|| {
                logged(AppError::expected(
                    "the selected submodule path is outside the repository",
                    OPERATION,
                ))
            })?;
        let prefix = format!("{}/", canonical_submodule_path.trim_end_matches('/'));
        let inner_path = requested_path.strip_prefix(&prefix).ok_or_else(|| {
            logged(AppError::expected(
                "the selected file does not belong to the requested submodule",
                OPERATION,
            ))
        })?;
        repository_relative_path(&requested_submodule, inner_path, OPERATION)?;
        let inner_old_path = requested_old_path
            .as_deref()
            .map(|old_path| {
                old_path.strip_prefix(&prefix).ok_or_else(|| {
                    logged(AppError::expected(
                        "the previous file path does not belong to the requested submodule",
                        OPERATION,
                    ))
                })
            })
            .transpose()?;
        if let Some(inner_old_path) = inner_old_path {
            repository_relative_path(&requested_submodule, inner_old_path, OPERATION)?;
        }
        let mut path_filters = vec![inner_path.to_owned()];
        if let Some(inner_old_path) = inner_old_path {
            path_filters.push(inner_old_path.to_owned());
        }
        (
            requested_submodule,
            path_filters,
            Some(LocalChangeSubmodule {
                name: canonical_submodule_path.clone(),
                path: canonical_submodule_path,
            }),
        )
    } else {
        repository_relative_path(&root, &requested_path, OPERATION)?;
        let mut path_filters = vec![requested_path.clone()];
        if let Some(old_path) = requested_old_path.as_deref() {
            repository_relative_path(&root, old_path, OPERATION)?;
            path_filters.push(old_path.to_owned());
        }
        (root.clone(), path_filters, None)
    };

    let mut preview_budget = LocalChangePreviewBudget::for_policy(LocalChangeLoadPolicy::Detail);
    let mut entry_budget = LocalChangeEntryBudget::default();
    let changes = list_local_changes_for_repository(
        runner,
        &target_root,
        submodule,
        &mut preview_budget,
        &mut entry_budget,
        &path_filters,
        LocalChangeLoadPolicy::Detail,
    )?;

    changes
        .into_iter()
        .find(|change| change.path == requested_path)
        .ok_or_else(|| {
            logged(AppError::expected(
                "the selected local change no longer exists; reload local changes and try again",
                OPERATION,
            ))
        })
}

fn local_change_entry_count_bytes(output: &[u8]) -> usize {
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut count = 0;
    let mut skip_rename_source = false;
    for field in fields {
        if skip_rename_source {
            skip_rename_source = false;
            continue;
        }
        if field.len() < 3 {
            continue;
        }
        count += 1;
        skip_rename_source = field[0] == b'R' || field[1] == b'R';
    }
    count
}

#[derive(Debug, Default)]
struct LocalChangeEntryBudget {
    used: usize,
}

impl LocalChangeEntryBudget {
    fn reserve(&mut self, count: usize, repository_path: &Path) -> AppResult<()> {
        let detected = self.used.saturating_add(count);
        if detected > LOCAL_CHANGE_ENTRY_LIMIT {
            return Err(logged(
                AppError::expected(
                    format!(
                        "too many local changes to display safely (limit: {LOCAL_CHANGE_ENTRY_LIMIT}; detected at least: {detected})"
                    ),
                    "listLocalChanges",
                )
                .with_context(
                    artistic_git_contracts::OperationContext::new("listLocalChanges")
                        .with_repository_path(display_path(repository_path)),
                ),
            ));
        }
        self.used = detected;
        Ok(())
    }
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
        [
            "stash",
            "list",
            "--max-count=5001",
            "--format=%gd%x00%H%x00%ct%x00%gs%x1e",
        ],
        "listStashes",
    ) {
        Ok(output) => output,
        Err(error) if is_empty_stash_error(&error) => String::new(),
        Err(error) => return Err(error),
    };

    Ok(crate::stash_impl::parse_stash_list_response(&output))
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
        OsString::from("--decorate-refs-exclude=refs/heads/backup/*"),
        OsString::from("--decorate-refs-exclude=refs/remotes/*/backup/*"),
        OsString::from("--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x1e"),
    ];
    append_log_revisions(&mut args, &request.revisions, "logPage")?;

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
        OsString::from("--decorate-refs-exclude=refs/heads/backup/*"),
        OsString::from("--decorate-refs-exclude=refs/remotes/*/backup/*"),
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
    append_log_revisions(&mut args, &request.revisions, "searchLog")?;

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

pub fn commit_details(
    runner: &GitRunner,
    request: CommitDetailsRequest,
) -> AppResult<CommitDetailsResponse> {
    let operation_name = "commitDetails";
    let root = canonical_repository_path(&request.repository_path, operation_name)?;
    validate_commit_oid(runner, &root, &request.oid, operation_name)?;
    let limit = request
        .limit
        .map(usize::from)
        .unwrap_or(DEFAULT_COMMIT_DETAIL_FILE_LIMIT)
        .clamp(1, MAX_COMMIT_DETAIL_FILE_LIMIT);

    let body = git_stdout(
        runner,
        Some(&root),
        [
            "show".to_owned(),
            "-s".to_owned(),
            "--format=%b".to_owned(),
            request.oid.clone(),
        ],
        operation_name,
    )?;
    let body = body.trim_end_matches(['\r', '\n']);
    let (body, body_truncated) = truncate_utf8(body, MAX_COMMIT_BODY_BYTES);
    let body = (!body.is_empty()).then_some(body);

    let mut files = commit_changed_files(
        runner,
        &root,
        &request.oid,
        None,
        limit.saturating_add(1),
        operation_name,
    )?;
    let truncated = files.len() > limit;
    files.truncate(limit);

    Ok(CommitDetailsResponse {
        repository_path: display_path(&root),
        oid: request.oid,
        body,
        body_truncated,
        files,
        truncated,
    })
}

pub fn commit_file_detail(
    runner: &GitRunner,
    request: CommitFileDetailRequest,
) -> AppResult<CommitFileDetailResponse> {
    let operation_name = "commitFileDetail";
    let root = canonical_repository_path(&request.repository_path, operation_name)?;
    validate_commit_oid(runner, &root, &request.oid, operation_name)?;
    validate_commit_changed_file(&root, &request.file, operation_name)?;
    let file = request.file;
    let parent = commit_first_parent(runner, &root, &request.oid, operation_name)?;
    let old_path = file.old_path.as_deref().unwrap_or(file.path.as_str());

    if [file.old_mode.as_deref(), file.new_mode.as_deref()].contains(&Some("160000")) {
        if let Some((payload, diff)) = historical_submodule_diff(
            runner,
            &root,
            parent.as_deref(),
            &request.oid,
            &file,
            operation_name,
        )? {
            return Ok(CommitFileDetailResponse {
                repository_path: display_path(&root),
                oid: request.oid,
                file,
                payload,
                diff,
            });
        }
    }

    let old_revision_and_path = match file.change_kind {
        DiffChangeKind::Added => None,
        DiffChangeKind::Modified
        | DiffChangeKind::Deleted
        | DiffChangeKind::Renamed
        | DiffChangeKind::Copied => parent.as_deref().map(|parent| (parent, old_path)),
    };
    let new_revision_and_path = match file.change_kind {
        DiffChangeKind::Deleted => None,
        DiffChangeKind::Added
        | DiffChangeKind::Modified
        | DiffChangeKind::Renamed
        | DiffChangeKind::Copied => Some((request.oid.as_str(), file.path.as_str())),
    };

    let old_size = historical_blob_size(runner, &root, old_revision_and_path, operation_name)?;
    let new_size = historical_blob_size(runner, &root, new_revision_and_path, operation_name)?;
    let preview_limit = LocalChangeLoadPolicy::Historical.preview_limit(&file.path);
    let oversized = old_size.is_some_and(|size| size > preview_limit as u64)
        || new_size.is_some_and(|size| size > preview_limit as u64);

    let (payload, diff) = if oversized {
        commit_file_oversized_diff(&file, old_size, new_size, preview_limit)
    } else {
        let old_content =
            historical_blob_content(runner, &root, old_revision_and_path, operation_name)?;
        let new_content =
            historical_blob_content(runner, &root, new_revision_and_path, operation_name)?;
        commit_file_diff(runner, &root, &file, old_content, new_content)?
    };

    Ok(CommitFileDetailResponse {
        repository_path: display_path(&root),
        oid: request.oid,
        file,
        payload,
        diff,
    })
}

fn validate_commit_oid(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    operation_name: &str,
) -> AppResult<()> {
    if !is_full_oid(oid) {
        return Err(logged(AppError::expected(
            "commit id is invalid",
            operation_name,
        )));
    }
    git_stdout(
        runner,
        Some(root),
        ["cat-file", "-e", format!("{oid}^{{commit}}").as_str()],
        operation_name,
    )?;
    Ok(())
}

fn validate_commit_file_path(root: &Path, path: &str, operation_name: &str) -> AppResult<()> {
    if path.is_empty() || path.contains('\0') {
        return Err(logged(AppError::expected(
            "commit file path is invalid",
            operation_name,
        )));
    }
    repository_relative_path(root, path, operation_name)?;
    Ok(())
}

fn validate_commit_changed_file(
    root: &Path,
    file: &CommitChangedFile,
    operation_name: &str,
) -> AppResult<()> {
    validate_commit_file_path(root, &file.path, operation_name)?;
    if let Some(old_path) = file.old_path.as_deref() {
        validate_commit_file_path(root, old_path, operation_name)?;
    }
    for mode in [file.old_mode.as_deref(), file.new_mode.as_deref()]
        .into_iter()
        .flatten()
    {
        if mode.len() != 6 || !mode.bytes().all(|byte| matches!(byte, b'0'..=b'7')) {
            return Err(logged(AppError::expected(
                "commit file mode is invalid",
                operation_name,
            )));
        }
    }
    if matches!(
        file.change_kind,
        DiffChangeKind::Renamed | DiffChangeKind::Copied
    ) && file.old_path.is_none()
    {
        return Err(logged(AppError::expected(
            "commit file source path is missing",
            operation_name,
        )));
    }
    Ok(())
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }

    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommitNumstat {
    additions: u32,
    deletions: u32,
    old_path: Option<String>,
    path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommitRawChange {
    new_mode: Option<String>,
    old_mode: Option<String>,
    old_path: Option<String>,
    path: String,
}

fn commit_changed_files(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    path: Option<&str>,
    max_entries: usize,
    operation_name: &str,
) -> AppResult<Vec<CommitChangedFile>> {
    let parent = commit_first_parent(runner, root, oid, operation_name)?;
    let status_output = git_stdout(
        runner,
        Some(root),
        commit_diff_args(parent.as_deref(), oid, "--name-status", path),
        operation_name,
    )?;
    let numstat_output = git_stdout(
        runner,
        Some(root),
        commit_diff_args(parent.as_deref(), oid, "--numstat", path),
        operation_name,
    )?;
    let raw_output = git_stdout(
        runner,
        Some(root),
        commit_diff_args(parent.as_deref(), oid, "--raw", path),
        operation_name,
    )?;

    let statuses = parse_commit_name_status(&status_output, max_entries, operation_name)?;
    let stats = parse_commit_numstat(&numstat_output, max_entries, operation_name)?;
    let raw_changes = parse_commit_raw_changes(&raw_output, max_entries, operation_name)?;
    let mut stats_by_path = stats
        .into_iter()
        .map(|stat| ((stat.old_path.clone(), stat.path.clone()), stat))
        .collect::<BTreeMap<_, _>>();
    let mut raw_by_path = raw_changes
        .into_iter()
        .map(|change| ((change.old_path.clone(), change.path.clone()), change))
        .collect::<BTreeMap<_, _>>();

    Ok(statuses
        .into_iter()
        .map(|mut file| {
            if let Some(stat) = stats_by_path.remove(&(file.old_path.clone(), file.path.clone())) {
                file.additions = stat.additions;
                file.deletions = stat.deletions;
            }
            if let Some(change) = raw_by_path.remove(&(file.old_path.clone(), file.path.clone())) {
                file.old_mode = change.old_mode;
                file.new_mode = change.new_mode;
            }
            file
        })
        .collect())
}

fn commit_first_parent(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    operation_name: &str,
) -> AppResult<Option<String>> {
    let output = git_stdout(
        runner,
        Some(root),
        ["rev-list", "--parents", "-n", "1", oid],
        operation_name,
    )?;
    Ok(output.split_whitespace().nth(1).map(ToOwned::to_owned))
}

fn commit_diff_args(
    parent: Option<&str>,
    oid: &str,
    format: &str,
    path: Option<&str>,
) -> Vec<OsString> {
    let mut args = if let Some(parent) = parent {
        vec![
            OsString::from("diff"),
            OsString::from("--no-ext-diff"),
            OsString::from("--find-renames"),
            OsString::from(format),
            OsString::from("-z"),
            OsString::from(parent),
            OsString::from(oid),
        ]
    } else {
        vec![
            OsString::from("diff-tree"),
            OsString::from("--root"),
            OsString::from("--no-commit-id"),
            OsString::from("-r"),
            OsString::from("--find-renames"),
            OsString::from(format),
            OsString::from("-z"),
            OsString::from(oid),
        ]
    };
    if let Some(path) = path {
        args.push(OsString::from("--"));
        args.push(crate::git_ops::literal_pathspec(path));
    }
    args
}

fn parse_commit_name_status(
    output: &str,
    max_entries: usize,
    operation_name: &str,
) -> AppResult<Vec<CommitChangedFile>> {
    let mut fields = output.split('\0');
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let code = status.as_bytes().first().copied().unwrap_or_default();
        let (old_path, path) = if matches!(code, b'R' | b'C') {
            let old_path = fields.next().filter(|value| !value.is_empty());
            let path = fields.next().filter(|value| !value.is_empty());
            match (old_path, path) {
                (Some(old_path), Some(path)) => (Some(old_path.to_owned()), path.to_owned()),
                _ => return Err(invalid_commit_file_list(operation_name)),
            }
        } else {
            let Some(path) = fields.next().filter(|value| !value.is_empty()) else {
                return Err(invalid_commit_file_list(operation_name));
            };
            (None, path.to_owned())
        };
        let change_kind = match code {
            b'A' => DiffChangeKind::Added,
            b'D' => DiffChangeKind::Deleted,
            b'R' => DiffChangeKind::Renamed,
            b'C' => DiffChangeKind::Copied,
            b'M' | b'T' => DiffChangeKind::Modified,
            _ => return Err(invalid_commit_file_list(operation_name)),
        };
        files.push(CommitChangedFile {
            path,
            old_path,
            old_mode: None,
            new_mode: None,
            change_kind,
            additions: 0,
            deletions: 0,
        });
        if files.len() >= max_entries {
            break;
        }
    }
    Ok(files)
}

fn parse_commit_numstat(
    output: &str,
    max_entries: usize,
    operation_name: &str,
) -> AppResult<Vec<CommitNumstat>> {
    let mut fields = output.split('\0');
    let mut stats = Vec::new();
    while let Some(header) = fields.next() {
        if header.is_empty() {
            continue;
        }
        let mut parts = header.splitn(3, '\t');
        let additions = parts
            .next()
            .map(parse_numstat_count)
            .ok_or_else(|| invalid_commit_file_list(operation_name))?;
        let deletions = parts
            .next()
            .map(parse_numstat_count)
            .ok_or_else(|| invalid_commit_file_list(operation_name))?;
        let path_field = parts
            .next()
            .ok_or_else(|| invalid_commit_file_list(operation_name))?;
        let (old_path, path) = if path_field.is_empty() {
            let old_path = fields.next().filter(|value| !value.is_empty());
            let path = fields.next().filter(|value| !value.is_empty());
            match (old_path, path) {
                (Some(old_path), Some(path)) => (Some(old_path.to_owned()), path.to_owned()),
                _ => return Err(invalid_commit_file_list(operation_name)),
            }
        } else {
            (None, path_field.to_owned())
        };
        stats.push(CommitNumstat {
            additions,
            deletions,
            old_path,
            path,
        });
        if stats.len() >= max_entries {
            break;
        }
    }
    Ok(stats)
}

fn parse_commit_raw_changes(
    output: &str,
    max_entries: usize,
    operation_name: &str,
) -> AppResult<Vec<CommitRawChange>> {
    let mut fields = output.split('\0');
    let mut changes = Vec::new();
    while let Some(header) = fields.next() {
        if header.is_empty() {
            continue;
        }
        let Some(header) = header.strip_prefix(':') else {
            return Err(invalid_commit_file_list(operation_name));
        };
        let mut header_fields = header.split_whitespace();
        let old_mode = header_fields
            .next()
            .ok_or_else(|| invalid_commit_file_list(operation_name))?;
        let new_mode = header_fields
            .next()
            .ok_or_else(|| invalid_commit_file_list(operation_name))?;
        header_fields
            .next()
            .ok_or_else(|| invalid_commit_file_list(operation_name))?;
        header_fields
            .next()
            .ok_or_else(|| invalid_commit_file_list(operation_name))?;
        let status = header_fields
            .next()
            .ok_or_else(|| invalid_commit_file_list(operation_name))?;
        let code = status.as_bytes().first().copied().unwrap_or_default();
        let (old_path, path) = if matches!(code, b'R' | b'C') {
            let old_path = fields.next().filter(|value| !value.is_empty());
            let path = fields.next().filter(|value| !value.is_empty());
            match (old_path, path) {
                (Some(old_path), Some(path)) => (Some(old_path.to_owned()), path.to_owned()),
                _ => return Err(invalid_commit_file_list(operation_name)),
            }
        } else {
            let Some(path) = fields.next().filter(|value| !value.is_empty()) else {
                return Err(invalid_commit_file_list(operation_name));
            };
            (None, path.to_owned())
        };
        changes.push(CommitRawChange {
            new_mode: normalize_git_mode(new_mode),
            old_mode: normalize_git_mode(old_mode),
            old_path,
            path,
        });
        if changes.len() >= max_entries {
            break;
        }
    }
    Ok(changes)
}

fn normalize_git_mode(mode: &str) -> Option<String> {
    (mode != "000000").then(|| mode.to_owned())
}

fn parse_numstat_count(value: &str) -> u32 {
    value
        .parse::<u64>()
        .unwrap_or_default()
        .min(u32::MAX as u64) as u32
}

fn invalid_commit_file_list(operation_name: &str) -> AppError {
    logged(AppError::expected(
        "Git returned an invalid commit file list",
        operation_name,
    ))
}

fn historical_blob_size(
    runner: &GitRunner,
    root: &Path,
    revision_and_path: Option<(&str, &str)>,
    operation_name: &str,
) -> AppResult<Option<u64>> {
    let Some((revision, path)) = revision_and_path else {
        return Ok(None);
    };
    let spec = format!("{revision}:{path}");
    let output = git_stdout(
        runner,
        Some(root),
        ["cat-file".to_owned(), "-s".to_owned(), spec],
        operation_name,
    )?;
    output.trim().parse().map(Some).map_err(|_| {
        logged(AppError::expected(
            "Git returned an invalid historical file size",
            operation_name,
        ))
    })
}

fn historical_blob_content(
    runner: &GitRunner,
    root: &Path,
    revision_and_path: Option<(&str, &str)>,
    operation_name: &str,
) -> AppResult<Option<Vec<u8>>> {
    revision_and_path
        .map(|(revision, path)| git_blob_at_rev_path(runner, root, revision, path, operation_name))
        .transpose()
}

fn historical_submodule_diff(
    runner: &GitRunner,
    root: &Path,
    parent: Option<&str>,
    oid: &str,
    file: &CommitChangedFile,
    operation_name: &str,
) -> AppResult<Option<(DiffPayload, DiffContent)>> {
    let old_path = file.old_path.as_deref().unwrap_or(file.path.as_str());
    let old_gitlink = match file.change_kind {
        DiffChangeKind::Added => None,
        DiffChangeKind::Modified
        | DiffChangeKind::Deleted
        | DiffChangeKind::Renamed
        | DiffChangeKind::Copied => parent
            .map(|parent| gitlink_at_tree(runner, root, parent, old_path, operation_name))
            .transpose()?
            .flatten(),
    };
    let new_gitlink = match file.change_kind {
        DiffChangeKind::Deleted => None,
        DiffChangeKind::Added
        | DiffChangeKind::Modified
        | DiffChangeKind::Renamed
        | DiffChangeKind::Copied => gitlink_at_tree(runner, root, oid, &file.path, operation_name)?,
    };
    if old_gitlink.is_none() && new_gitlink.is_none() {
        return Ok(None);
    }

    let mut metadata = commit_file_metadata(file);
    metadata.insert("submodule".to_owned(), "true".to_owned());
    if let Some(old_gitlink) = old_gitlink {
        metadata.insert("oldOid".to_owned(), old_gitlink.oid);
    }
    if let Some(new_gitlink) = new_gitlink {
        metadata.insert("newOid".to_owned(), new_gitlink.oid);
    }

    Ok(Some((
        DiffPayload {
            old_path: file.old_path.clone(),
            new_path: file.path.clone(),
            change_kind: file.change_kind,
            file_kind: DiffFileKind::Binary,
            lfs_lock: None,
            metadata,
        },
        DiffContent::Moved { message: None },
    )))
}

fn commit_file_oversized_diff(
    file: &CommitChangedFile,
    old_size: Option<u64>,
    new_size: Option<u64>,
    preview_limit: usize,
) -> (DiffPayload, DiffContent) {
    let mut metadata = commit_file_metadata(file);
    metadata.insert("previewLimitBytes".to_owned(), preview_limit.to_string());
    metadata.insert("previewDeferred".to_owned(), "true".to_owned());
    metadata.insert("oversized".to_owned(), "true".to_owned());
    if let Some(size) = old_size {
        metadata.insert("oldBytes".to_owned(), size.to_string());
    }
    if let Some(size) = new_size {
        metadata.insert("newBytes".to_owned(), size.to_string());
    }
    (
        DiffPayload {
            old_path: file.old_path.clone(),
            new_path: file.path.clone(),
            change_kind: file.change_kind,
            file_kind: deferred_large_file_kind(&file.path),
            lfs_lock: None,
            metadata,
        },
        DiffContent::Deferred { message: None },
    )
}

fn commit_file_diff(
    runner: &GitRunner,
    root: &Path,
    file: &CommitChangedFile,
    old_content: Option<Vec<u8>>,
    new_content: Option<Vec<u8>>,
) -> AppResult<(DiffPayload, DiffContent)> {
    let preview_limit = LocalChangeLoadPolicy::Historical.preview_limit(&file.path);
    if let Some((oid, size)) = [old_content.as_deref(), new_content.as_deref()]
        .into_iter()
        .flatten()
        .filter_map(parse_lfs_pointer)
        .find(|pointer| pointer.size > preview_limit as u64)
        .map(|pointer| (pointer.oid, pointer.size))
    {
        let mut metadata = commit_file_metadata(file);
        metadata.insert("lfsOid".to_owned(), oid);
        metadata.insert("lfsSize".to_owned(), size.to_string());
        metadata.insert("oversized".to_owned(), "true".to_owned());
        metadata.insert("previewDeferred".to_owned(), "true".to_owned());
        metadata.insert("previewLimitBytes".to_owned(), preview_limit.to_string());
        return Ok((
            DiffPayload {
                old_path: file.old_path.clone(),
                new_path: file.path.clone(),
                change_kind: file.change_kind,
                file_kind: DiffFileKind::LfsPointer,
                lfs_lock: None,
                metadata,
            },
            DiffContent::Deferred {
                message: Some(format!(
                    "Git LFS content is {size} bytes, above the {} byte preview limit",
                    preview_limit
                )),
            },
        ));
    }

    let mut contents = LocalChangeContents {
        old_content,
        new_content,
        ..LocalChangeContents::default()
    };
    for (side, content) in [
        (DiffSide::Old, contents.old_content.as_deref()),
        (DiffSide::New, contents.new_content.as_deref()),
    ] {
        let Some(content) = content else {
            continue;
        };
        match display_content_for_side(
            runner,
            root,
            &file.path,
            side,
            content,
            LocalChangeLoadPolicy::Historical,
        )? {
            Ok(resolved) => {
                match side {
                    DiffSide::Old => contents.old_display_content = Some(resolved.content),
                    DiffSide::New => contents.new_display_content = Some(resolved.content),
                }
                contents.lfs_pointer_seen |= resolved.lfs_pointer;
            }
            Err(issue) => {
                contents.lfs_pointer_seen = true;
                contents.lfs_issue = Some(issue);
            }
        }
    }
    let mut probe = DiffFileProbe::new(file.path.clone(), core_change_kind(file.change_kind));
    probe.old_path = file.old_path.clone().map(Into::into);
    probe.old_content = contents.old_content.as_deref();
    probe.new_content = contents.new_content.as_deref();
    probe.old_display_content = contents.old_display_content.as_deref();
    probe.new_display_content = contents.new_display_content.as_deref();
    probe.changed_lines = file.additions.saturating_add(file.deletions) as usize;

    let classification = classify_diff_file(probe);
    let file_kind = contract_file_kind(classification.file_kind);
    let mut metadata = classification.metadata;
    metadata.extend(commit_file_metadata(file));
    let content_changed = contents.old_content != contents.new_content;
    metadata.insert("contentChanged".to_owned(), content_changed.to_string());
    if contents.lfs_pointer_seen {
        metadata.insert(
            "lfsFetchStatus".to_owned(),
            match contents.lfs_issue.as_ref().map(|issue| issue.status) {
                Some(LfsContentStatus::Missing) => "missing",
                Some(LfsContentStatus::Error) => "error",
                Some(LfsContentStatus::Loading) => "loading",
                None => "local",
            }
            .to_owned(),
        );
    }
    if let Some(issue) = contents.lfs_issue.take() {
        metadata.insert("lfsResolved".to_owned(), "false".to_owned());
        let payload = DiffPayload {
            old_path: classification.old_path,
            new_path: classification.new_path,
            change_kind: file.change_kind,
            file_kind: DiffFileKind::LfsPointer,
            lfs_lock: None,
            metadata,
        };
        return Ok((
            payload,
            DiffContent::LfsPointer {
                status: issue.status,
                message: issue.message,
            },
        ));
    }
    let payload = DiffPayload {
        old_path: classification.old_path,
        new_path: classification.new_path,
        change_kind: file.change_kind,
        file_kind,
        lfs_lock: None,
        metadata,
    };
    let diff = if !content_changed && commit_file_mode_changed(file) {
        DiffContent::Moved { message: None }
    } else {
        diff_content_for_kind(file_kind, &payload, &contents)
    };
    Ok((payload, diff))
}

fn commit_file_metadata(file: &CommitChangedFile) -> BTreeMap<String, String> {
    let mut metadata = BTreeMap::from([
        ("additions".to_owned(), file.additions.to_string()),
        ("deletions".to_owned(), file.deletions.to_string()),
        (
            "contentChanged".to_owned(),
            (file.change_kind != DiffChangeKind::Renamed
                || file.additions > 0
                || file.deletions > 0)
                .to_string(),
        ),
    ]);
    if let Some(old_mode) = file.old_mode.as_ref() {
        metadata.insert("oldMode".to_owned(), old_mode.clone());
    }
    if let Some(new_mode) = file.new_mode.as_ref() {
        metadata.insert("newMode".to_owned(), new_mode.clone());
    }
    if commit_file_mode_changed(file) {
        metadata.insert("modeChanged".to_owned(), "true".to_owned());
    }
    metadata
}

fn commit_file_mode_changed(file: &CommitChangedFile) -> bool {
    matches!(
        (file.old_mode.as_deref(), file.new_mode.as_deref()),
        (Some(old_mode), Some(new_mode)) if old_mode != new_mode
    )
}

fn append_log_revisions(
    args: &mut Vec<OsString>,
    revisions: &[String],
    operation_name: &str,
) -> AppResult<()> {
    if revisions.is_empty() {
        args.push(OsString::from("--exclude=backup/*"));
        args.push(OsString::from("--branches"));
        args.push(OsString::from("--tags"));
        args.push(OsString::from("--exclude=*/backup/*"));
        args.push(OsString::from("--remotes"));
        return Ok(());
    }

    if revisions.len() > MAX_LOG_REVISIONS {
        return Err(logged(AppError::expected(
            "too many history revisions were requested",
            operation_name,
        )));
    }

    let mut unique = BTreeSet::new();
    for revision in revisions {
        if !is_safe_history_revision(revision) {
            return Err(logged(AppError::expected(
                "history revision is invalid",
                operation_name,
            )));
        }
        if unique.insert(revision) {
            args.push(OsString::from(revision));
        }
    }
    args.push(OsString::from("--"));
    Ok(())
}

fn is_safe_history_revision(revision: &str) -> bool {
    let Some(name) = revision
        .strip_prefix("refs/heads/")
        .or_else(|| revision.strip_prefix("refs/remotes/"))
    else {
        return false;
    };

    !name.is_empty()
        && !name.ends_with(['.', '/'])
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && !name.chars().any(|character| {
            character.is_control() || character.is_whitespace() || "~^:?*[\\".contains(character)
        })
        && name.split('/').all(|component| {
            !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
        })
}

fn validate_remote_repository_url<'a>(url: &'a str, operation_name: &str) -> AppResult<&'a str> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(logged(AppError::expected(
            "repository URL is required",
            operation_name,
        )));
    }
    if trimmed.contains('\0') || trimmed.starts_with('-') {
        return Err(logged(AppError::expected(
            "repository URL is invalid",
            operation_name,
        )));
    }
    if url_contains_embedded_credentials_or_parameters(trimmed) {
        return Err(logged(AppError::expected(
            "repository URL must not contain credentials, query parameters, or fragments; use the credential prompt instead",
            operation_name,
        )));
    }

    Ok(trimmed)
}

fn url_contains_embedded_credentials_or_parameters(url: &str) -> bool {
    let Some((_, remainder)) = url.split_once("://") else {
        return false;
    };
    let authority = remainder.split('/').next().unwrap_or(remainder);
    let embeds_password = authority
        .rsplit_once('@')
        .is_some_and(|(userinfo, _)| userinfo.contains(':'));

    embeds_password || remainder.contains('?') || remainder.contains('#')
}

fn diagnostic_remote_url(url: &str) -> String {
    let Some((scheme, remainder)) = url.split_once("://") else {
        return url.to_owned();
    };
    let (authority, suffix) = remainder
        .split_once('/')
        .map(|(authority, path)| (authority, format!("/{path}")))
        .unwrap_or((remainder, String::new()));
    let Some((_, host)) = authority.rsplit_once('@') else {
        return url.to_owned();
    };

    format!("{scheme}://[REDACTED]@{host}{suffix}")
}

fn validate_clone_branch_name(
    runner: &GitRunner,
    branch_name: Option<&str>,
) -> AppResult<Option<String>> {
    let Some(branch_name) = branch_name else {
        return Ok(None);
    };
    let trimmed = branch_name.trim();
    if trimmed.is_empty() || trimmed != branch_name || trimmed.starts_with('-') {
        return Err(logged(AppError::expected(
            "selected branch name is invalid",
            "cloneRepository",
        )));
    }

    let branch_ref = format!("refs/heads/{trimmed}");
    git_stdout(
        runner,
        None,
        ["check-ref-format", branch_ref.as_str()],
        "cloneRepository",
    )?;
    Ok(Some(trimmed.to_owned()))
}

fn parse_remote_repository_probe(output: &str) -> RemoteRepositoryProbeResponse {
    let mut default_branch = None;
    let mut branches = BTreeSet::new();
    let mut truncated = false;

    for line in output.lines() {
        let Some((value, reference)) = line.split_once('\t') else {
            continue;
        };
        if reference == "HEAD" {
            if let Some(branch) = value
                .strip_prefix("ref: refs/heads/")
                .filter(|branch| !branch.is_empty())
            {
                default_branch = Some(branch.to_owned());
            }
            continue;
        }
        if let Some(branch) = reference.strip_prefix("refs/heads/") {
            if !branch.is_empty() {
                if branches.len() < REMOTE_BRANCH_LIST_ENTRY_LIMIT || branches.contains(branch) {
                    branches.insert(branch.to_owned());
                } else {
                    truncated = true;
                }
            }
        }
    }

    if let Some(default_branch) = default_branch.as_ref() {
        if !branches.contains(default_branch) && truncated {
            branches.pop_last();
            branches.insert(default_branch.clone());
        }
    }

    let branches = branches.into_iter().collect::<Vec<_>>();
    let default_branch = default_branch.filter(|branch| branches.contains(branch));
    RemoteRepositoryProbeResponse {
        is_empty: branches.is_empty(),
        default_branch,
        branches,
        truncated,
    }
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
    branch_name: Option<&str>,
    target: &CloneTarget,
    cancel_token: &CancelToken,
    operation_id: Option<&OperationId>,
    progress: &F,
) -> AppResult<()>
where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    const OPERATION: &str = "cloneRepository";
    let repository_path = display_path(&target.path);

    if cancel_token.is_cancelled() {
        return Err(cancelled_clone_error_after_cleanup(target));
    }

    emit_clone_progress(
        operation_id,
        Some(repository_path.as_str()),
        progress,
        "Cloning repository",
        ProgressState::Indeterminate,
    );

    let mut clone_args = vec![
        OsString::from("clone"),
        OsString::from("--recurse-submodules"),
        OsString::from("--progress"),
    ];
    if let Some(branch_name) = branch_name {
        clone_args.push(OsString::from("--branch"));
        clone_args.push(OsString::from(branch_name));
    }
    clone_args.extend([
        OsString::from("--"),
        OsString::from(url),
        target.directory_name.clone(),
    ]);

    let plan = runner
        .git_command_builder()
        .default_credential_helper()
        .enable_windows_longpaths()
        .args(clone_args)
        .build()
        .redact_argument(
            OsString::from(url),
            OsString::from(diagnostic_remote_url(url)),
        );
    let plan = crate::git_ops::apply_auth_context_to_plan(plan, None, OPERATION)?;
    let mut command = plan.to_command();
    command.current_dir(&target.parent);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::git_ops::prepare_child_process_tree(&mut command);
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(&plan, source, OPERATION))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut stdout_reader = stdout.map(spawn_output_reader);
    let (progress_tx, progress_rx) = mpsc::sync_channel(128);
    let mut stderr_reader = stderr.map(|stderr| spawn_clone_stderr_reader(stderr, progress_tx));

    let status = loop {
        drain_clone_progress(
            operation_id,
            Some(repository_path.as_str()),
            progress,
            &progress_rx,
        );
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancel_token.is_cancelled() => {
                if let Some(status) = crate::git_ops::terminate_child_process_tree(&mut child)
                    .ok()
                    .filter(|status| status.success())
                {
                    break status;
                }
                discard_output_reader(&mut stdout_reader);
                discard_output_reader(&mut stderr_reader);
                return Err(cancelled_clone_error_after_cleanup(target));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => {
                let _ = crate::git_ops::terminate_child_process_tree(&mut child);
                discard_output_reader(&mut stdout_reader);
                discard_output_reader(&mut stderr_reader);
                return Err(clone_error_after_cleanup(
                    target,
                    spawn_error(&plan, source, OPERATION),
                ));
            }
        }
    };
    drain_clone_progress(
        operation_id,
        Some(repository_path.as_str()),
        progress,
        &progress_rx,
    );

    let output_deadline = Instant::now() + OUTPUT_READER_DRAIN_TIMEOUT;
    let stdout = match collect_output_reader(
        &mut stdout_reader,
        "stdout",
        OPERATION,
        output_deadline,
        None,
        Some(&plan),
        status.code(),
    ) {
        Ok(output) => output,
        Err(error) => {
            discard_output_reader(&mut stderr_reader);
            return Err(clone_error_after_cleanup(target, error));
        }
    };
    let stderr = match collect_output_reader(
        &mut stderr_reader,
        "stderr",
        OPERATION,
        output_deadline,
        None,
        Some(&plan),
        status.code(),
    ) {
        Ok(output) => output,
        Err(error) => {
            return Err(clone_error_after_cleanup(target, error));
        }
    };
    drain_clone_progress(
        operation_id,
        Some(repository_path.as_str()),
        progress,
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
            progress,
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
        Err(clone_error_after_cleanup(target, error))
    }
}

#[derive(Debug)]
struct BoundedCommandOutput {
    bytes: Vec<u8>,
    exceeded_limit: bool,
}

type OutputReader = thread::JoinHandle<io::Result<BoundedCommandOutput>>;

fn read_bounded_command_output<R>(reader: R) -> io::Result<BoundedCommandOutput>
where
    R: Read,
{
    read_bounded_command_output_with_limit(reader, COMMAND_OUTPUT_LIMIT_BYTES)
}

fn read_bounded_command_output_with_limit<R>(
    mut reader: R,
    limit_bytes: usize,
) -> io::Result<BoundedCommandOutput>
where
    R: Read,
{
    const READ_CHUNK_BYTES: usize = 16 * 1024;

    let capture_limit = limit_bytes.saturating_add(1);
    let mut output = Vec::with_capacity(capture_limit.min(READ_CHUNK_BYTES));
    let mut buffer = [0_u8; READ_CHUNK_BYTES];
    loop {
        let bytes_read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes_read) => bytes_read,
            Err(source) if source.kind() == io::ErrorKind::Interrupted => continue,
            Err(source) => return Err(source),
        };
        let captured_bytes = bytes_read.min(capture_limit.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..captured_bytes]);
    }
    let exceeded_limit = output.len() > limit_bytes;
    output.truncate(limit_bytes);
    Ok(BoundedCommandOutput {
        bytes: output,
        exceeded_limit,
    })
}

fn spawn_output_reader<R>(reader: R) -> OutputReader
where
    R: Read + Send + 'static,
{
    thread::spawn(move || read_bounded_command_output(reader))
}

fn discard_output_reader(reader: &mut Option<OutputReader>) {
    // Git hooks and transport helpers can outlive Git while retaining its pipes.
    // Detaching the reader keeps cancellation from waiting on those descendants.
    reader.take();
}

fn collect_output_reader(
    reader: &mut Option<OutputReader>,
    stream_name: &str,
    operation_name: &str,
    deadline: Instant,
    cancel_token: Option<&CancelToken>,
    plan: Option<&GitCommandPlan>,
    exit_code: Option<i32>,
) -> AppResult<Vec<u8>> {
    let Some(reader) = reader.take() else {
        return Ok(Vec::new());
    };
    while !reader.is_finished() {
        if cancel_token.is_some_and(CancelToken::is_cancelled) {
            return Err(cancelled_error(operation_name));
        }
        if Instant::now() >= deadline {
            return Err(output_pipe_timeout_error(stream_name, operation_name));
        }
        thread::sleep(Duration::from_millis(10));
    }
    match reader.join() {
        Ok(Ok(output)) if output.exceeded_limit => Err(output_limit_error(
            stream_name,
            operation_name,
            &output.bytes,
            plan,
            exit_code,
        )),
        Ok(Ok(output)) => Ok(output.bytes),
        Ok(Err(source)) => Err(logged(AppError::unexpected(
            format!("failed to read git {stream_name}: {source}"),
            operation_name,
        ))),
        Err(_) => Err(logged(AppError::unexpected(
            format!("git {stream_name} reader thread panicked"),
            operation_name,
        ))),
    }
}

fn output_limit_error(
    stream_name: &str,
    operation_name: &str,
    output: &[u8],
    plan: Option<&GitCommandPlan>,
    exit_code: Option<i32>,
) -> AppError {
    let diagnostic = bounded_output_diagnostic(output);
    let (stdout, stderr) = if stream_name == "stdout" {
        (diagnostic, String::new())
    } else {
        (String::new(), diagnostic)
    };
    logged(
        AppError::unexpected(
            format!(
                "git {stream_name} exceeded the {} MiB output limit; the command was stopped to protect application memory",
                COMMAND_OUTPUT_LIMIT_BYTES / (1024 * 1024)
            ),
            operation_name,
        )
        .with_git(GitCommandError {
            command: plan.map(GitCommandPlan::command_for_error).unwrap_or_default(),
            exit_code,
            stdout,
            stderr,
        }),
    )
}

fn bounded_output_diagnostic(output: &[u8]) -> String {
    if output.len() <= COMMAND_OUTPUT_DIAGNOSTIC_BYTES {
        return String::from_utf8_lossy(output).into_owned();
    }
    let half = COMMAND_OUTPUT_DIAGNOSTIC_BYTES / 2;
    format!(
        "{}\n\n[output truncated: showing first and last {half} bytes]\n\n{}",
        String::from_utf8_lossy(&output[..half]),
        String::from_utf8_lossy(&output[output.len() - half..]),
    )
}

fn output_pipe_timeout_error(stream_name: &str, operation_name: &str) -> AppError {
    logged(AppError::unexpected(
        format!(
            "git {stream_name} remained open after the command exited; a child process may still be holding the output pipe"
        ),
        operation_name,
    ))
}

fn spawn_clone_stderr_reader<R>(reader: R, progress_tx: mpsc::SyncSender<String>) -> OutputReader
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = reader;
        let capture_limit = COMMAND_OUTPUT_LIMIT_BYTES.saturating_add(1);
        let mut stderr = Vec::new();
        let mut pending = String::new();
        let mut buffer = [0_u8; 1024];

        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(_) => break,
            };
            let captured_bytes = read.min(capture_limit.saturating_sub(stderr.len()));
            stderr.extend_from_slice(&buffer[..captured_bytes]);

            if stderr.len() >= capture_limit {
                continue;
            }

            for character in String::from_utf8_lossy(&buffer[..captured_bytes]).chars() {
                if character == '\r' || character == '\n' {
                    let line = pending.trim().to_owned();
                    if !line.is_empty() {
                        let _ = progress_tx.try_send(line);
                    }
                    pending.clear();
                } else {
                    if pending.len().saturating_add(character.len_utf8())
                        <= PROGRESS_LINE_LIMIT_BYTES
                    {
                        pending.push(character);
                    }
                }
            }
        }

        let line = pending.trim().to_owned();
        if !line.is_empty() {
            let _ = progress_tx.try_send(line);
        }

        let exceeded_limit = stderr.len() > COMMAND_OUTPUT_LIMIT_BYTES;
        stderr.truncate(COMMAND_OUTPUT_LIMIT_BYTES);
        Ok(BoundedCommandOutput {
            bytes: stderr,
            exceeded_limit,
        })
    })
}

fn drain_clone_progress<F>(
    operation_id: Option<&OperationId>,
    repository_path: Option<&str>,
    progress: &F,
    progress_rx: &mpsc::Receiver<String>,
) where
    F: Fn(OperationProgressEvent) + ?Sized,
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
    F: Fn(OperationProgressEvent) + ?Sized,
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
    let cancellable = crate::git_ops::active_cancel_token().is_some();

    emit_operation_progress(
        operation_id,
        Some(repository_path.as_str()),
        progress,
        "Updating submodules",
        ProgressState::Indeterminate,
        cancellable,
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
        cancellable,
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
    let cancellable = crate::git_ops::active_cancel_token().is_some();
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
            cancellable,
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
    let plan = runner.git_lfs_command_plan(["ls-files"]);
    let mut command = plan.to_command();
    command.current_dir(submodule);
    let output = command_to_output(command, &plan, operation_name)?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
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
    let plan = runner.git_lfs_command_plan(args);
    let mut command = plan.to_command();
    command.current_dir(submodule);
    command_to_output(command, &plan, operation_name).map(|_| ())
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
    planned_args.push(OsString::from("lfs"));
    planned_args.extend(args.into_iter().map(Into::into));
    let plan = runner.git_command_plan(planned_args);
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
    let cancel_token = crate::git_ops::active_cancel_token();
    if cancel_token.as_ref().is_some_and(CancelToken::is_cancelled) {
        return Err(cancelled_error(operation_name));
    }
    let cancellable = cancel_token.is_some();
    let mut command = plan.to_command();
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::git_ops::prepare_child_process_tree(&mut command);
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut stdout_reader = stdout.map(spawn_output_reader);
    let (progress_tx, progress_rx) = mpsc::sync_channel(128);
    let mut stderr_reader = stderr.map(|stderr| spawn_clone_stderr_reader(stderr, progress_tx));

    let status = loop {
        drain_operation_progress(
            operation_id,
            repository_path,
            progress,
            &progress_rx,
            label_for_line,
            cancellable,
        );
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancel_token.as_ref().is_some_and(CancelToken::is_cancelled) => {
                if let Some(status) = crate::git_ops::terminate_child_process_tree(&mut child)
                    .ok()
                    .filter(|status| status.success())
                {
                    break status;
                }
                discard_output_reader(&mut stdout_reader);
                discard_output_reader(&mut stderr_reader);
                return Err(cancelled_error(operation_name));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => {
                let _ = crate::git_ops::terminate_child_process_tree(&mut child);
                discard_output_reader(&mut stdout_reader);
                discard_output_reader(&mut stderr_reader);
                return Err(spawn_error(&plan, source, operation_name));
            }
        }
    };
    drain_operation_progress(
        operation_id,
        repository_path,
        progress,
        &progress_rx,
        label_for_line,
        cancellable,
    );

    let output_deadline = Instant::now() + OUTPUT_READER_DRAIN_TIMEOUT;
    let stdout = match collect_output_reader(
        &mut stdout_reader,
        "stdout",
        operation_name,
        output_deadline,
        None,
        Some(&plan),
        status.code(),
    ) {
        Ok(output) => output,
        Err(error) => {
            discard_output_reader(&mut stderr_reader);
            return Err(error);
        }
    };
    let stderr = collect_output_reader(
        &mut stderr_reader,
        "stderr",
        operation_name,
        output_deadline,
        None,
        Some(&plan),
        status.code(),
    )?;
    drain_operation_progress(
        operation_id,
        repository_path,
        progress,
        &progress_rx,
        label_for_line,
        cancellable,
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
    cancellable: bool,
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
            cancellable,
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

fn cleanup_clone_target(target: &CloneTarget) -> AppResult<()> {
    if target.path.is_dir() {
        fs::remove_dir_all(&target.path).map_err(|source| {
            logged(AppError::unexpected(
                format!(
                    "failed to remove incomplete clone directory {}: {source}",
                    display_path(&target.path)
                ),
                "cloneRepositoryCleanup",
            ))
        })?;
    }
    Ok(())
}

fn clone_error_after_cleanup(target: &CloneTarget, mut error: AppError) -> AppError {
    if let Err(cleanup_error) = cleanup_clone_target(target) {
        error.summary = format!(
            "{}; the incomplete clone directory could not be removed: {}",
            error.summary, cleanup_error.summary
        );
        return logged(error);
    }
    error
}

fn cancelled_clone_error_after_cleanup(target: &CloneTarget) -> AppError {
    match cleanup_clone_target(target) {
        Ok(()) => cancelled_error("cloneRepository"),
        Err(error) => error,
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

fn reset_bisect_busy_error(error: OperationBusy) -> AppError {
    let summary = match error {
        OperationBusy::WriteBusy => "another write operation is already in progress",
        OperationBusy::BackgroundBusy => "a background operation is already in progress",
    };
    logged(AppError::expected(summary, "resetBisect"))
}

fn operation_registry_error(operation_name: &str) -> AppError {
    logged(AppError::unexpected(
        "operation registry is unavailable",
        operation_name,
    ))
}

fn operation_cancellation_timeout_error(
    operation_id: &OperationId,
    operation_name: &str,
) -> AppError {
    logged(AppError::expected(
        format!(
            "The operation is still finishing its cleanup after {} seconds. Keep this window open and try again. Operation ID: {}",
            CANCEL_COMPLETION_TIMEOUT.as_secs(),
            operation_id.as_str()
        ),
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
            if is_bare_repository_path(runner, path) {
                return logged(AppError::expected(
                    "不是受支持的 Git 项目类型",
                    "openRepository",
                ));
            }
            logged(AppError::expected("不是有效的 Git 项目", "openRepository"))
        } else {
            error
        }
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let root = PathBuf::from(stdout.trim());
    canonicalize_path(&root, "openRepository")
}

fn is_bare_repository_path(runner: &GitRunner, path: &Path) -> bool {
    git_stdout(
        runner,
        Some(path),
        ["rev-parse", "--is-bare-repository"],
        "openRepository",
    )
    .map(|output| output.trim() == "true")
    .unwrap_or(false)
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
    if !repository_has_lfs_rules(root)? {
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
        let remove = read_file_with_limit(&gitdir, WORKTREE_GITDIR_FILE_LIMIT_BYTES)
            .ok()
            .filter(|bytes| bytes.len() <= WORKTREE_GITDIR_FILE_LIMIT_BYTES)
            .and_then(|bytes| String::from_utf8(bytes).ok())
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
            "当前未处于任何分支，可新建分支或切换到已有分支。",
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
            "检测到尚未完成的合并、变基或撤销操作，请先完成或取消。",
        ));
    }
    if health.index_lock.is_some() {
        warnings.push(warning(
            RepositoryOpenWarningKind::IndexLockPresent,
            "项目可能仍被其他 Git 工具占用。确认没有 Git 操作运行后，请手动删除 .git/index.lock。",
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
    let info = read_index_lock_info(git_common_dir)?;
    // Ignore very young locks so health checks do not race with the app's own concurrent
    // repository reads (especially `git status` on large working trees).
    (u64::from(info.age_seconds) >= INDEX_LOCK_RESIDUAL_AGE_SECONDS).then_some(info)
}

fn read_index_lock_info(git_common_dir: &Path) -> Option<IndexLockInfo> {
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
        warning: "项目可能仍被其他 Git 工具占用。确认没有 Git 操作运行后，可手动删除 index.lock。"
            .to_owned(),
    })
}

fn build_summary(
    root: &Path,
    remote_mode: RepositoryRemoteMode,
    has_origin: bool,
    remotes: &[RepositoryRemote],
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
        details: Some(artistic_git_contracts::RepositorySummaryDetails {
            health: health.clone(),
            remotes: remotes.to_vec(),
        }),
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
    let (ahead, behind) = branch_ahead_behind(runner, root, &short_name, current, &entry)?;
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

fn exact_ref_oid(runner: &GitRunner, root: &Path, refname: &str) -> AppResult<Option<String>> {
    let (plan, output) = crate::git_ops::run_git_raw(
        runner,
        Some(root),
        ["show-ref", "--hash", "--verify", refname],
        "listBranches",
    )?;
    if output.status.success() {
        return Ok(
            empty_to_none(String::from_utf8_lossy(&output.stdout).trim()).map(str::to_owned),
        );
    }
    if matches!(output.status.code(), Some(1) | Some(128)) {
        return Ok(None);
    }

    Err(crate::git_ops::command_failure(
        &plan,
        output,
        "listBranches",
    ))
}

fn branch_ahead_behind(
    runner: &GitRunner,
    root: &Path,
    short_name: &str,
    current: bool,
    entry: &BranchAccumulator,
) -> AppResult<(u32, u32)> {
    if entry.local_oid.is_none() {
        return Ok((0, 0));
    }

    let upstream_track = entry
        .upstream
        .as_deref()
        .and(entry.upstream_track.as_deref());
    if let Some(counts) = upstream_track.and_then(parse_upstream_track) {
        return Ok(counts);
    }

    if !current || entry.remote_oid.is_none() {
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

fn parse_upstream_track(track: &str) -> Option<(u32, u32)> {
    let track = track.trim();
    if track.is_empty() {
        return Some((0, 0));
    }

    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(',').map(str::trim) {
        let mut fields = part.split_whitespace();
        let direction = fields.next()?;
        let count = fields.next()?.parse().ok()?;
        if fields.next().is_some() {
            return None;
        }
        match direction {
            "ahead" => ahead = count,
            "behind" => behind = count,
            _ => return None,
        }
    }
    Some((ahead, behind))
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits = parse_log_records(&stdout);
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

#[cfg(test)]
fn parse_stash_record(record: &str) -> Option<StashEntry> {
    let parts = record
        .trim_matches(|value| value == '\n' || value == '\x1e')
        .split('\0')
        .collect::<Vec<_>>();
    if parts.len() < 4 {
        return None;
    }

    let selector = parts[0].to_owned();
    let index = selector
        .strip_prefix("stash@{")
        .and_then(|value| value.strip_suffix('}'))
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    let raw_message = parts[3];
    let message = display_stash_message(raw_message);
    let branch = branch_from_stash_message(raw_message);
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

#[cfg(test)]
fn display_stash_message(message: &str) -> String {
    message
        .strip_prefix("On ")
        .and_then(|value| value.split_once(':').map(|(_, message)| message.trim()))
        .unwrap_or(message)
        .to_owned()
}

#[cfg(test)]
fn branch_from_stash_message(message: &str) -> Option<String> {
    message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))
        .and_then(|value| value.split_once(':').map(|(branch, _)| branch.to_owned()))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalChangeLoadPolicy {
    Batch,
    Detail,
    Historical,
}

impl LocalChangeLoadPolicy {
    fn operation_name(self) -> &'static str {
        match self {
            Self::Batch => "listLocalChanges",
            Self::Detail => "localChangeDetail",
            Self::Historical => "commitFileDetail",
        }
    }

    fn fetch_missing_lfs(self) -> bool {
        matches!(self, Self::Detail)
    }

    fn preview_limit(self, path: &str) -> usize {
        if !matches!(self, Self::Batch) && is_image_preview_path(path) {
            IMAGE_PREVIEW_LIMIT_BYTES
        } else {
            OVERSIZED_TEXT_BYTES
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct LocalChangeDiffContext<'a> {
    root: &'a Path,
    path: &'a str,
    old_path: Option<&'a str>,
    change_kind: DiffChangeKind,
    changed_lines: Option<usize>,
    index_status: &'a str,
    inspect_submodules: bool,
    worktree_status: &'a str,
    load_policy: LocalChangeLoadPolicy,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct LocalChangePreviewSizes {
    new_expected: bool,
    new_size: Option<u64>,
    old_expected: bool,
    old_size: Option<u64>,
}

impl LocalChangePreviewSizes {
    fn exceeds(self, limit: usize) -> bool {
        let limit = limit as u64;
        self.old_size.is_some_and(|size| size > limit)
            || self.new_size.is_some_and(|size| size > limit)
    }
}

#[derive(Debug, Default)]
struct LocalChangePreview {
    sizes: LocalChangePreviewSizes,
    old_content: Option<Vec<u8>>,
    new_content: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalChangePreviewDecision {
    Load,
    Oversized,
    Deferred,
}

#[derive(Debug)]
struct LocalChangePreviewBudget {
    remaining_bytes: usize,
    remaining_files: usize,
}

impl Default for LocalChangePreviewBudget {
    fn default() -> Self {
        Self {
            remaining_bytes: LOCAL_CHANGE_PREVIEW_TOTAL_BYTES,
            remaining_files: LOCAL_CHANGE_PREVIEW_FILE_LIMIT,
        }
    }
}

impl LocalChangePreviewBudget {
    fn metadata_only() -> Self {
        Self {
            remaining_bytes: 0,
            remaining_files: 0,
        }
    }

    fn for_policy(load_policy: LocalChangeLoadPolicy) -> Self {
        let mut budget = Self::default();
        if matches!(load_policy, LocalChangeLoadPolicy::Detail) {
            budget.remaining_bytes = IMAGE_PREVIEW_LIMIT_BYTES.saturating_mul(2);
        }
        budget
    }

    fn exhausted(&self) -> bool {
        self.remaining_files == 0 || self.remaining_bytes == 0
    }

    fn reserve(
        &mut self,
        sizes: LocalChangePreviewSizes,
        per_file_limit: usize,
    ) -> LocalChangePreviewDecision {
        if self.exhausted() {
            return LocalChangePreviewDecision::Deferred;
        }
        self.remaining_files -= 1;

        if sizes.exceeds(per_file_limit) {
            return LocalChangePreviewDecision::Oversized;
        }

        let estimated_bytes = [
            (sizes.old_expected, sizes.old_size),
            (sizes.new_expected, sizes.new_size),
        ]
        .into_iter()
        .filter(|(expected, _)| *expected)
        .map(|(_, size)| {
            size.and_then(|size| usize::try_from(size).ok())
                .unwrap_or(per_file_limit)
        })
        .sum::<usize>();
        if estimated_bytes > self.remaining_bytes {
            return LocalChangePreviewDecision::Deferred;
        }

        self.remaining_bytes -= estimated_bytes;
        LocalChangePreviewDecision::Load
    }
}

fn prepare_local_change_preview(
    runner: &GitRunner,
    context: LocalChangeDiffContext<'_>,
) -> AppResult<LocalChangePreview> {
    let operation_name = context.load_policy.operation_name();
    let mut sizes = local_change_preview_sizes(
        runner,
        context.root,
        context.path,
        context.old_path,
        context.change_kind,
        operation_name,
    );

    let old_content = if sizes.old_size.is_some_and(|size| size <= 1024) {
        optional_git_blob_at_rev_path(
            runner,
            context.root,
            "HEAD",
            context.old_path.unwrap_or(context.path),
            operation_name,
        )?
    } else {
        None
    };
    let new_content = if sizes.new_size.is_some_and(|size| size <= 1024) {
        local_change_new_content(
            runner,
            context.root,
            context.path,
            context.index_status,
            context.worktree_status,
            context.load_policy,
        )?
    } else {
        None
    };

    sizes.new_size = effective_local_change_preview_size(sizes.new_size, new_content.as_deref());
    sizes.old_size = effective_local_change_preview_size(sizes.old_size, old_content.as_deref());

    Ok(LocalChangePreview {
        sizes,
        old_content,
        new_content,
    })
}

fn effective_local_change_preview_size(
    raw_size: Option<u64>,
    content: Option<&[u8]>,
) -> Option<u64> {
    content
        .and_then(parse_lfs_pointer)
        .map(|pointer| pointer.size)
        .or(raw_size)
}

fn local_change_preview_sizes(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    old_path: Option<&str>,
    change_kind: DiffChangeKind,
    operation_name: &str,
) -> LocalChangePreviewSizes {
    let old_expected = !matches!(change_kind, DiffChangeKind::Added);
    let new_expected = !matches!(change_kind, DiffChangeKind::Deleted);
    let old_size = old_expected
        .then(|| {
            git_blob_size(
                runner,
                root,
                "HEAD",
                old_path.unwrap_or(path),
                operation_name,
            )
        })
        .flatten();
    let new_size = new_expected
        .then(|| {
            let worktree_path = repository_relative_path(root, path, operation_name).ok()?;
            fs::metadata(worktree_path)
                .ok()
                .filter(|metadata| metadata.is_file())
                .map(|metadata| metadata.len())
                .or_else(|| git_blob_size(runner, root, "", path, operation_name))
        })
        .flatten();

    LocalChangePreviewSizes {
        new_expected,
        new_size,
        old_expected,
        old_size,
    }
}

fn git_blob_size(
    runner: &GitRunner,
    root: &Path,
    rev: &str,
    path: &str,
    operation_name: &str,
) -> Option<u64> {
    let spec = if rev.is_empty() {
        format!(":{path}")
    } else {
        format!("{rev}:{path}")
    };
    git_stdout(
        runner,
        Some(root),
        ["cat-file".to_owned(), "-s".to_owned(), spec],
        operation_name,
    )
    .ok()?
    .trim()
    .parse()
    .ok()
}

fn local_change_preview_placeholder(
    path: &str,
    old_path: Option<&str>,
    change_kind: DiffChangeKind,
    index_status: &str,
    worktree_status: &str,
    sizes: LocalChangePreviewSizes,
    deferred: bool,
) -> (DiffPayload, DiffContent) {
    let preview_limit = LocalChangeLoadPolicy::Detail.preview_limit(path);
    let mut metadata = BTreeMap::new();
    metadata.insert("indexStatus".to_owned(), index_status.to_owned());
    metadata.insert("worktreeStatus".to_owned(), worktree_status.to_owned());
    metadata.insert("previewLimitBytes".to_owned(), preview_limit.to_string());
    metadata.insert("previewDeferred".to_owned(), "true".to_owned());
    if !deferred {
        metadata.insert("oversized".to_owned(), "true".to_owned());
    }
    if let Some(size) = sizes.old_size {
        metadata.insert("oldBytes".to_owned(), size.to_string());
    }
    if let Some(size) = sizes.new_size {
        metadata.insert("newBytes".to_owned(), size.to_string());
    }

    (
        DiffPayload {
            old_path: old_path.map(ToOwned::to_owned),
            new_path: path.to_owned(),
            change_kind,
            file_kind: if deferred {
                DiffFileKind::Deferred
            } else {
                deferred_large_file_kind(path)
            },
            lfs_lock: None,
            metadata,
        },
        DiffContent::Deferred { message: None },
    )
}

fn deferred_large_file_kind(path: &str) -> DiffFileKind {
    let path = Path::new(path);
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    if matches!(
        extension.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "svg")
    ) {
        return DiffFileKind::Image;
    }
    if matches!(
        extension.as_deref(),
        Some(
            "txt"
                | "md"
                | "markdown"
                | "rs"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "json"
                | "yaml"
                | "yml"
                | "toml"
                | "xml"
                | "html"
                | "css"
                | "scss"
                | "less"
                | "sh"
                | "bash"
                | "zsh"
                | "py"
                | "go"
                | "java"
                | "kt"
                | "kts"
                | "c"
                | "cc"
                | "cpp"
                | "h"
                | "hpp"
                | "cs"
                | "swift"
                | "rb"
                | "php"
                | "sql"
                | "csv"
                | "tsv"
                | "ini"
                | "cfg"
                | "conf"
        )
    ) {
        return DiffFileKind::OversizedText;
    }
    if matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".gitignore" | ".gitattributes" | ".editorconfig")
    ) {
        return DiffFileKind::OversizedText;
    }
    DiffFileKind::Binary
}

fn is_image_preview_path(path: &str) -> bool {
    matches!(deferred_large_file_kind(path), DiffFileKind::Image)
}

fn local_change_diff(
    runner: &GitRunner,
    context: LocalChangeDiffContext<'_>,
    preview_budget: &mut LocalChangePreviewBudget,
) -> AppResult<(DiffPayload, DiffContent)> {
    let LocalChangeDiffContext {
        root,
        path,
        old_path,
        change_kind,
        changed_lines,
        index_status,
        inspect_submodules,
        worktree_status,
        load_policy,
    } = context;
    let preview_limit = load_policy.preview_limit(path);
    let selected_preview_limit = LocalChangeLoadPolicy::Detail.preview_limit(path);
    if inspect_submodules {
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
    }

    if preview_budget.exhausted() {
        return Ok(local_change_preview_placeholder(
            path,
            old_path,
            change_kind,
            index_status,
            worktree_status,
            LocalChangePreviewSizes::default(),
            true,
        ));
    }

    let preview = prepare_local_change_preview(runner, context)?;
    match preview_budget.reserve(preview.sizes, preview_limit) {
        LocalChangePreviewDecision::Load => {}
        LocalChangePreviewDecision::Oversized => {
            let deferred = matches!(load_policy, LocalChangeLoadPolicy::Batch)
                && !preview.sizes.exceeds(selected_preview_limit);
            return Ok(local_change_preview_placeholder(
                path,
                old_path,
                change_kind,
                index_status,
                worktree_status,
                preview.sizes,
                deferred,
            ));
        }
        LocalChangePreviewDecision::Deferred => {
            return Ok(local_change_preview_placeholder(
                path,
                old_path,
                change_kind,
                index_status,
                worktree_status,
                preview.sizes,
                true,
            ));
        }
    }

    let mut contents = local_change_contents(runner, context, preview)?;
    let changed_lines = changed_lines.unwrap_or_else(|| {
        changed_lines_for_content(
            change_kind,
            contents.old_display_content.as_deref(),
            contents.new_display_content.as_deref(),
        )
    });
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

    if let Some(issue) = contents.lfs_issue.take() {
        let fetch_status = match issue.status {
            LfsContentStatus::Missing => "missing",
            LfsContentStatus::Error => "error",
            LfsContentStatus::Loading => "loading",
        };
        metadata.insert("lfsFetchStatus".to_owned(), fetch_status.to_owned());
        if let Some(message) = issue.message.as_ref() {
            metadata.insert("lfsError".to_owned(), message.clone());
        }
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
                status: issue.status,
                message: issue.message,
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
    lfs_issue: Option<LfsDisplayIssue>,
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
        [
            OsString::from("ls-tree"),
            OsString::from("-z"),
            OsString::from(rev),
            OsString::from("--"),
            crate::git_ops::literal_pathspec(path),
        ],
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
        [
            OsString::from("ls-files"),
            OsString::from("-s"),
            OsString::from("-z"),
            OsString::from("--"),
            crate::git_ops::literal_pathspec(path),
        ],
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
    context: LocalChangeDiffContext<'_>,
    preview: LocalChangePreview,
) -> AppResult<LocalChangeContents> {
    let LocalChangeDiffContext {
        root,
        path,
        old_path,
        change_kind,
        index_status,
        worktree_status,
        load_policy,
        ..
    } = context;
    let operation_name = load_policy.operation_name();
    let LocalChangePreview {
        old_content: preview_old_content,
        new_content: preview_new_content,
        ..
    } = preview;
    let old_content = if matches!(change_kind, DiffChangeKind::Added) {
        None
    } else if preview_old_content.is_some() {
        preview_old_content
    } else {
        optional_git_blob_at_rev_path(
            runner,
            root,
            "HEAD",
            old_path.unwrap_or(path),
            operation_name,
        )?
    };
    let new_content = if matches!(change_kind, DiffChangeKind::Deleted) {
        None
    } else if preview_new_content.is_some() {
        preview_new_content
    } else {
        local_change_new_content(
            runner,
            root,
            path,
            index_status,
            worktree_status,
            load_policy,
        )?
    };

    let mut contents = LocalChangeContents {
        old_content,
        new_content,
        ..LocalChangeContents::default()
    };

    if let Some(content) = contents.old_content.as_deref() {
        match display_content_for_side(runner, root, path, DiffSide::Old, content, load_policy)? {
            Ok(resolved) => {
                contents.old_display_content = Some(resolved.content);
                contents.lfs_pointer_seen |= resolved.lfs_pointer;
                contents.lfs_fetch_attempted |= resolved.fetch_attempted;
            }
            Err(issue) => {
                contents.lfs_pointer_seen = true;
                contents.lfs_fetch_attempted |= issue.fetch_attempted;
                contents.lfs_issue = Some(issue);
            }
        }
    }

    if let Some(content) = contents.new_content.as_deref() {
        match display_content_for_side(runner, root, path, DiffSide::New, content, load_policy)? {
            Ok(resolved) => {
                contents.new_display_content = Some(resolved.content);
                contents.lfs_pointer_seen |= resolved.lfs_pointer;
                contents.lfs_fetch_attempted |= resolved.fetch_attempted;
            }
            Err(issue) => {
                contents.lfs_pointer_seen = true;
                contents.lfs_fetch_attempted |= issue.fetch_attempted;
                contents.lfs_issue = Some(issue);
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
    load_policy: LocalChangeLoadPolicy,
) -> AppResult<Option<Vec<u8>>> {
    if index_status == "D" || worktree_status == "D" {
        return Ok(None);
    }

    let operation_name = load_policy.operation_name();
    let worktree_path = repository_relative_path(root, path, operation_name)?;
    if let Ok(bytes) = read_file_with_limit(&worktree_path, load_policy.preview_limit(path)) {
        return Ok(Some(bytes));
    }

    if index_status != " " && index_status != "?" {
        return optional_git_blob_at_rev_path(runner, root, "", path, operation_name);
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
struct LfsDisplayIssue {
    status: LfsContentStatus,
    message: Option<String>,
    fetch_attempted: bool,
}

fn display_content_for_side(
    runner: &GitRunner,
    root: &Path,
    path: &str,
    side: DiffSide,
    content: &[u8],
    load_policy: LocalChangeLoadPolicy,
) -> AppResult<Result<DisplayContent, LfsDisplayIssue>> {
    let Some(pointer) = parse_lfs_pointer(content) else {
        return Ok(Ok(DisplayContent {
            content: content.to_vec(),
            lfs_pointer: false,
            fetch_attempted: false,
        }));
    };

    let preview_limit = load_policy.preview_limit(path);
    if pointer.size > preview_limit as u64 {
        return Ok(Err(LfsDisplayIssue {
            status: LfsContentStatus::Error,
            message: Some(format!(
                "Git LFS {} content for {} is {} bytes, above the {} byte preview limit",
                side.label(),
                path,
                pointer.size,
                preview_limit
            )),
            fetch_attempted: false,
        }));
    }

    match read_local_lfs_object(
        runner,
        root,
        &pointer.oid,
        Some(pointer.size),
        preview_limit,
        load_policy.operation_name(),
    ) {
        Ok(content) => {
            return Ok(Ok(DisplayContent {
                content,
                lfs_pointer: true,
                fetch_attempted: false,
            }));
        }
        Err(LocalLfsObjectReadError::Missing) if !load_policy.fetch_missing_lfs() => {
            return Ok(Err(LfsDisplayIssue {
                status: LfsContentStatus::Missing,
                message: None,
                fetch_attempted: false,
            }));
        }
        Err(LocalLfsObjectReadError::Missing) => {}
        Err(LocalLfsObjectReadError::Error(error)) => {
            if operation_was_cancelled(&error) {
                return Err(error);
            }
            return Ok(Err(LfsDisplayIssue {
                status: LfsContentStatus::Error,
                message: Some(error.summary),
                fetch_attempted: false,
            }));
        }
    }

    if let Err(error) = fetch_lfs_object(runner, root, &pointer.oid, load_policy.operation_name()) {
        if operation_was_cancelled(&error) {
            return Err(error);
        }
        return Ok(Err(LfsDisplayIssue {
            status: LfsContentStatus::Error,
            message: Some(format!(
                "Git LFS {} content for {} is not available locally and fetch failed: {}",
                side.label(),
                path,
                error.summary
            )),
            fetch_attempted: true,
        }));
    }

    match read_local_lfs_object(
        runner,
        root,
        &pointer.oid,
        Some(pointer.size),
        preview_limit,
        load_policy.operation_name(),
    ) {
        Ok(content) => Ok(Ok(DisplayContent {
            content,
            lfs_pointer: true,
            fetch_attempted: true,
        })),
        Err(LocalLfsObjectReadError::Missing) => Ok(Err(LfsDisplayIssue {
            status: LfsContentStatus::Error,
            message: Some(format!(
                "Git LFS {} content for {} is still unavailable after fetch",
                side.label(),
                path
            )),
            fetch_attempted: true,
        })),
        Err(LocalLfsObjectReadError::Error(error)) => {
            if operation_was_cancelled(&error) {
                return Err(error);
            }
            Ok(Err(LfsDisplayIssue {
                status: LfsContentStatus::Error,
                message: Some(format!(
                    "Git LFS {} content for {} is still unavailable after fetch: {}",
                    side.label(),
                    path,
                    error.summary
                )),
                fetch_attempted: true,
            }))
        }
    }
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
        DiffFileKind::Deferred => DiffContent::Deferred { message: None },
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
    operation_name: &str,
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
        operation_name,
    )
}

fn optional_git_blob_at_rev_path(
    runner: &GitRunner,
    root: &Path,
    rev: &str,
    path: &str,
    operation_name: &str,
) -> AppResult<Option<Vec<u8>>> {
    match git_blob_at_rev_path(runner, root, rev, path, operation_name) {
        Ok(content) => Ok(Some(content)),
        Err(error) if operation_was_cancelled(&error) => Err(error),
        Err(_) => Ok(None),
    }
}

fn operation_was_cancelled(error: &AppError) -> bool {
    error.summary == "operation cancelled"
        || crate::git_ops::active_cancel_token().is_some_and(|token| token.is_cancelled())
}

#[derive(Debug)]
enum LocalLfsObjectReadError {
    Missing,
    Error(AppError),
}

fn read_local_lfs_object(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    expected_size: Option<u64>,
    preview_limit: usize,
    operation_name: &str,
) -> Result<Vec<u8>, LocalLfsObjectReadError> {
    let path = local_lfs_object_path(runner, root, oid, operation_name)
        .map_err(LocalLfsObjectReadError::Error)?;
    let read_limit = expected_size
        .and_then(|size| usize::try_from(size).ok())
        .unwrap_or(preview_limit)
        .min(preview_limit);
    let bytes = match read_file_with_limit(&path, read_limit) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Err(LocalLfsObjectReadError::Missing);
        }
        Err(source) => {
            return Err(LocalLfsObjectReadError::Error(logged(AppError::expected(
                format!("failed to read local Git LFS object: {source}"),
                operation_name,
            ))));
        }
    };
    if let Some(expected_size) = expected_size {
        if bytes.len() as u64 != expected_size {
            return Err(LocalLfsObjectReadError::Error(logged(AppError::expected(
                "local Git LFS object size does not match pointer metadata",
                operation_name,
            ))));
        }
    }
    Ok(bytes)
}

fn read_file_with_limit(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
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

    let plan = runner.git_lfs_command_plan([
        OsString::from("fetch"),
        OsString::from("--object-id"),
        OsString::from("origin"),
        OsString::from(oid),
    ]);
    let mut command = plan.to_command();
    command.current_dir(root);
    command_to_output(command, &plan, operation_name).map(|_| ())
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

fn local_change_changed_lines(
    runner: &GitRunner,
    root: &Path,
    path_filters: &[String],
    operation_name: &str,
) -> BTreeMap<String, usize> {
    let mut args = vec![
        OsString::from("diff"),
        OsString::from("--numstat"),
        OsString::from("-z"),
        OsString::from("HEAD"),
    ];
    if !path_filters.is_empty() {
        args.push(OsString::from("--"));
        args.extend(path_filters.iter().map(crate::git_ops::literal_pathspec));
    }
    let Ok(output) = git_output_bytes(runner, Some(root), args, operation_name) else {
        return BTreeMap::new();
    };
    parse_local_change_numstat(&output)
}

fn parse_local_change_numstat(output: &[u8]) -> BTreeMap<String, usize> {
    let mut stats = BTreeMap::new();
    let mut fields = output.split(|byte| *byte == 0);

    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        let mut columns = record.splitn(3, |byte| *byte == b'\t');
        let additions = columns.next().and_then(parse_numstat_usize);
        let deletions = columns.next().and_then(parse_numstat_usize);
        let Some(path) = columns.next() else {
            continue;
        };
        let path = if path.is_empty() {
            let _old_path = fields.next();
            fields.next().unwrap_or_default()
        } else {
            path
        };
        let (Some(additions), Some(deletions)) = (additions, deletions) else {
            continue;
        };
        stats.insert(
            String::from_utf8_lossy(path).into_owned(),
            additions.saturating_add(deletions),
        );
    }

    stats
}

fn parse_numstat_usize(value: &[u8]) -> Option<usize> {
    std::str::from_utf8(value).ok()?.parse().ok()
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
    run_git(runner, root, args, operation_name)
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
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
    run_git(runner, root, args, operation_name).map(|output| output.stdout)
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
    let output =
        command_output_cancellable(plan.to_command(), &plan, operation_name, cancel_token)?;
    if output.status.success() {
        Ok(CommandOutput::from_output(output))
    } else {
        Err(command_failure(&plan, output, operation_name))
    }
}

fn command_to_output(
    command: Command,
    plan: &GitCommandPlan,
    operation_name: &str,
) -> AppResult<CommandOutput> {
    let cancel_token = crate::git_ops::active_cancel_token().unwrap_or_default();
    let output = command_output_cancellable(command, plan, operation_name, &cancel_token)?;
    if output.status.success() {
        Ok(CommandOutput::from_output(output))
    } else {
        Err(command_failure(plan, output, operation_name))
    }
}

fn command_output_cancellable(
    mut command: Command,
    plan: &GitCommandPlan,
    operation_name: &str,
    cancel_token: &CancelToken,
) -> AppResult<Output> {
    if cancel_token.is_cancelled() {
        return Err(cancelled_error(operation_name));
    }

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::git_ops::prepare_child_process_tree(&mut command);
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(plan, source, operation_name))?;
    let mut stdout_reader = child.stdout.take().map(spawn_checked_output_reader);
    let mut stderr_reader = child.stderr.take().map(spawn_checked_output_reader);

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancel_token.is_cancelled() => {
                if let Some(status) = crate::git_ops::terminate_child_process_tree(&mut child)
                    .ok()
                    .filter(|status| status.success())
                {
                    break status;
                }
                discard_checked_output_reader(&mut stdout_reader);
                discard_checked_output_reader(&mut stderr_reader);
                return Err(cancelled_error(operation_name));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => {
                let _ = crate::git_ops::terminate_child_process_tree(&mut child);
                discard_checked_output_reader(&mut stdout_reader);
                discard_checked_output_reader(&mut stderr_reader);
                return Err(spawn_error(plan, source, operation_name));
            }
        }
    };

    let output_deadline = Instant::now() + OUTPUT_READER_DRAIN_TIMEOUT;
    let stdout = collect_checked_output_reader(
        &mut stdout_reader,
        "stdout",
        operation_name,
        output_deadline,
        None,
        Some(plan),
        status.code(),
    )?;
    let stderr = collect_checked_output_reader(
        &mut stderr_reader,
        "stderr",
        operation_name,
        output_deadline,
        None,
        Some(plan),
        status.code(),
    )?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

type CheckedOutputReader = OutputReader;

fn spawn_checked_output_reader<R>(reader: R) -> CheckedOutputReader
where
    R: Read + Send + 'static,
{
    thread::spawn(move || read_bounded_command_output(reader))
}

fn collect_checked_output_reader(
    reader: &mut Option<CheckedOutputReader>,
    stream_name: &str,
    operation_name: &str,
    deadline: Instant,
    cancel_token: Option<&CancelToken>,
    plan: Option<&GitCommandPlan>,
    exit_code: Option<i32>,
) -> AppResult<Vec<u8>> {
    let Some(reader) = reader.take() else {
        return Ok(Vec::new());
    };

    while !reader.is_finished() {
        if cancel_token.is_some_and(CancelToken::is_cancelled) {
            return Err(cancelled_error(operation_name));
        }
        if Instant::now() >= deadline {
            return Err(output_pipe_timeout_error(stream_name, operation_name));
        }
        thread::sleep(Duration::from_millis(10));
    }

    match reader.join() {
        Ok(Ok(output)) if output.exceeded_limit => Err(output_limit_error(
            stream_name,
            operation_name,
            &output.bytes,
            plan,
            exit_code,
        )),
        Ok(Ok(output)) => Ok(output.bytes),
        Ok(Err(source)) => Err(logged(AppError::unexpected(
            format!("failed to read git {stream_name}: {source}"),
            operation_name,
        ))),
        Err(_) => Err(logged(AppError::unexpected(
            format!("git {stream_name} reader thread panicked"),
            operation_name,
        ))),
    }
}

fn discard_checked_output_reader(reader: &mut Option<CheckedOutputReader>) {
    // A Git hook or transport child can retain the pipe after Git is killed.
    reader.take();
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
    let stderr = plan.redact_text(&String::from_utf8_lossy(&output.stderr));
    let stdout = plan.redact_text(&String::from_utf8_lossy(&output.stdout));
    let summary = git_stderr_summary(&stderr)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("git command failed during {operation_name}"));

    logged(
        AppError::expected(summary, operation_name).with_git(GitCommandError {
            command: plan.command_for_error(),
            exit_code: output.status.code(),
            stdout,
            stderr,
        }),
    )
}

fn git_stderr_summary(stderr: &str) -> Option<&str> {
    let first = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    stderr
        .lines()
        .map(str::trim)
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            lower.starts_with("fatal:") || lower.starts_with("error:")
        })
        .or(Some(first))
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

fn repository_has_lfs_rules(root: &Path) -> AppResult<bool> {
    repository_has_lfs_rules_with_limit(root, LFS_RULE_SCAN_ENTRY_LIMIT)
}

fn repository_has_lfs_rules_with_limit(root: &Path, entry_limit: usize) -> AppResult<bool> {
    let mut stack = vec![root.to_path_buf()];
    let mut visited_entries = 0_usize;
    while let Some(dir) = stack.pop() {
        if crate::git_ops::active_cancel_token().is_some_and(|token| token.is_cancelled()) {
            return Err(cancelled_error("openRepository"));
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited_entries = visited_entries.saturating_add(1);
            if visited_entries > entry_limit {
                // Running `git lfs install --local` is cheap and idempotent. Prefer it
                // over an unbounded repository walk when the tree is exceptionally large.
                return Ok(true);
            }
            if crate::git_ops::active_cancel_token().is_some_and(|token| token.is_cancelled()) {
                return Err(cancelled_error("openRepository"));
            }
            let path = entry.path();
            let file_name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
            if file_name == ".git" {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file()
                && file_name == ".gitattributes"
                && read_file_with_limit(&path, LFS_ATTRIBUTES_READ_LIMIT)
                    .map(|content| {
                        String::from_utf8_lossy(
                            &content[..content.len().min(LFS_ATTRIBUTES_READ_LIMIT)],
                        )
                        .contains("filter=lfs")
                    })
                    .unwrap_or(false)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
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
    stdout: Vec<u8>,
}

impl CommandOutput {
    fn from_output(output: std::process::Output) -> Self {
        Self {
            stdout: output.stdout,
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
    upstream_track: Option<String>,
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
        git_dist_manifest_fixture, require_git_dist, write_executable_file,
        write_executable_script, write_git_dist_manifest, TestTempDir,
    };
    use std::{io::Write, sync::Mutex};

    #[cfg(unix)]
    #[test]
    fn clone_cleanup_failure_is_reported_with_the_remaining_path() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TestTempDir::new("ag-clone-cleanup-failure").expect("temp");
        let parent = temp.path().join("parent");
        let path = parent.join("incomplete");
        fs::create_dir_all(&path).expect("create incomplete clone");
        let original_permissions = fs::metadata(&parent)
            .expect("parent metadata")
            .permissions();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o500))
            .expect("make parent read-only");
        let target = CloneTarget {
            directory_name: OsString::from("incomplete"),
            parent: parent.clone(),
            path: path.clone(),
        };

        let result = cleanup_clone_target(&target);
        fs::set_permissions(&parent, original_permissions).expect("restore parent permissions");
        let error = result.expect_err("cleanup should report permission failure");

        assert_eq!(error.context.operation_name, "cloneRepositoryCleanup");
        assert!(error.summary.contains(&display_path(&path)));
        assert!(path.exists());
    }

    #[test]
    fn cancellable_operation_registry_cancels_registered_token() {
        let registry = Arc::new(CancellableOperationRegistry::default());
        let operation_id = OperationId::new("operation-1");
        let (token, _guard) = registry
            .register(&operation_id, "testOperation")
            .expect("register operation");

        assert!(!token.is_cancelled());
        assert!(registry.cancel(&operation_id).expect("cancel operation"));
        assert!(token.is_cancelled());
    }

    #[test]
    fn local_change_preview_budget_bounds_files_and_total_bytes() {
        let mut budget = LocalChangePreviewBudget {
            remaining_bytes: 10,
            remaining_files: 2,
        };
        assert_eq!(
            budget.reserve(
                LocalChangePreviewSizes {
                    new_expected: true,
                    new_size: Some(6),
                    ..LocalChangePreviewSizes::default()
                },
                OVERSIZED_TEXT_BYTES,
            ),
            LocalChangePreviewDecision::Load
        );
        assert_eq!(
            budget.reserve(
                LocalChangePreviewSizes {
                    new_expected: true,
                    new_size: Some(5),
                    ..LocalChangePreviewSizes::default()
                },
                OVERSIZED_TEXT_BYTES,
            ),
            LocalChangePreviewDecision::Deferred
        );
        assert_eq!(
            budget.reserve(LocalChangePreviewSizes::default(), OVERSIZED_TEXT_BYTES),
            LocalChangePreviewDecision::Deferred
        );

        let (payload, diff) = local_change_preview_placeholder(
            "deferred.txt",
            None,
            DiffChangeKind::Modified,
            " ",
            "M",
            LocalChangePreviewSizes::default(),
            true,
        );
        assert_eq!(payload.file_kind, DiffFileKind::Deferred);
        assert!(matches!(diff, DiffContent::Deferred { .. }));

        for (path, expected_kind) in [
            ("large.png", DiffFileKind::Image),
            ("archive.zip", DiffFileKind::Binary),
            ("notes.txt", DiffFileKind::OversizedText),
        ] {
            let (payload, diff) = local_change_preview_placeholder(
                path,
                None,
                DiffChangeKind::Added,
                "?",
                "?",
                LocalChangePreviewSizes {
                    new_expected: true,
                    new_size: Some((OVERSIZED_TEXT_BYTES + 1) as u64),
                    ..LocalChangePreviewSizes::default()
                },
                false,
            );
            assert_eq!(payload.file_kind, expected_kind);
            assert_eq!(payload.metadata["oversized"], "true");
            assert!(matches!(diff, DiffContent::Deferred { .. }));
        }
    }

    #[test]
    fn local_change_preview_budget_charges_lfs_pointer_declared_size() {
        let pointer = concat!(
            "version https://git-lfs.github.com/spec/v1\n",
            "oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
            "size 8\n",
        );
        let mut budget = LocalChangePreviewBudget {
            remaining_bytes: 10,
            remaining_files: 2,
        };
        let charged_size = effective_local_change_preview_size(
            Some(pointer.len() as u64),
            Some(pointer.as_bytes()),
        );

        assert_eq!(charged_size, Some(8));
        assert_eq!(
            budget.reserve(
                LocalChangePreviewSizes {
                    new_expected: true,
                    new_size: charged_size,
                    ..LocalChangePreviewSizes::default()
                },
                OVERSIZED_TEXT_BYTES,
            ),
            LocalChangePreviewDecision::Load
        );
        assert_eq!(budget.remaining_bytes, 2);
        assert_eq!(
            budget.reserve(
                LocalChangePreviewSizes {
                    new_expected: true,
                    new_size: Some(3),
                    ..LocalChangePreviewSizes::default()
                },
                OVERSIZED_TEXT_BYTES,
            ),
            LocalChangePreviewDecision::Deferred
        );
    }

    #[test]
    fn local_change_numstat_parses_regular_renamed_and_binary_records() {
        let stats = parse_local_change_numstat(
            b"3\t2\tsrc/main.rs\0\
              1\t4\t\0old/name.rs\0new/name.rs\0\
              -\t-\tassets/image.bin\0\
              5\t0\tpath\twith-tab.txt\0",
        );

        assert_eq!(stats["src/main.rs"], 5);
        assert_eq!(stats["new/name.rs"], 5);
        assert_eq!(stats["path\twith-tab.txt"], 5);
        assert!(!stats.contains_key("old/name.rs"));
        assert!(!stats.contains_key("assets/image.bin"));
    }

    #[test]
    fn local_change_entry_count_treats_rename_paths_as_one_change() {
        assert_eq!(
            local_change_entry_count_bytes(
                b"R  renamed.txt\0old.txt\0 M tracked.txt\0?? untracked.txt\0"
            ),
            3
        );
    }

    #[test]
    fn local_change_entry_budget_is_shared_across_repositories() {
        let mut budget = LocalChangeEntryBudget {
            used: LOCAL_CHANGE_ENTRY_LIMIT - 1,
        };
        budget
            .reserve(1, Path::new("/repo"))
            .expect("last available entry");
        let error = budget
            .reserve(1, Path::new("/repo/submodule"))
            .expect_err("shared budget should reject the next entry");

        assert!(error.summary.contains("detected at least: 5001"));
    }

    #[test]
    fn repository_output_reader_has_a_bounded_drain_wait() {
        let mut reader = Some(thread::spawn(|| {
            thread::sleep(Duration::from_millis(200));
            Ok(BoundedCommandOutput {
                bytes: Vec::new(),
                exceeded_limit: false,
            })
        }));
        let error = collect_output_reader(
            &mut reader,
            "stdout",
            "boundedDrainTest",
            Instant::now() + Duration::from_millis(20),
            None,
            None,
            None,
        )
        .expect_err("reader wait should time out");

        assert!(error.summary.contains("remained open"));
    }

    #[test]
    fn repository_output_reader_rejects_output_over_the_memory_limit() {
        let mut reader = Some(thread::spawn(|| {
            Ok(BoundedCommandOutput {
                bytes: b"diagnostic".to_vec(),
                exceeded_limit: true,
            })
        }));
        let error = collect_output_reader(
            &mut reader,
            "stderr",
            "boundedOutputTest",
            Instant::now() + Duration::from_secs(1),
            None,
            None,
            None,
        )
        .expect_err("over-limit output should fail explicitly");

        assert!(error.summary.contains("16 MiB output limit"));
        assert_eq!(error.git.expect("git details").stderr, "diagnostic");
    }

    #[test]
    fn repository_output_reader_captures_one_sentinel_byte() {
        let output = read_bounded_command_output_with_limit(io::Cursor::new(vec![b'x'; 64]), 32)
            .expect("bounded output");

        assert!(output.exceeded_limit);
        assert_eq!(output.bytes.len(), 32);
    }

    #[test]
    fn lfs_rule_scan_is_bounded_and_detects_attributes() {
        let temp = TestTempDir::new("ag-lfs-rule-scan").expect("temp");
        fs::create_dir_all(temp.path().join("nested")).expect("nested directory");
        fs::write(
            temp.path().join("nested/.gitattributes"),
            "*.psd filter=lfs diff=lfs merge=lfs -text\n",
        )
        .expect("attributes");

        assert!(repository_has_lfs_rules_with_limit(temp.path(), 10).expect("scan attributes"));
        assert!(repository_has_lfs_rules_with_limit(temp.path(), 0)
            .expect("bounded scan falls back to lfs initialization"));
    }

    #[cfg(unix)]
    #[test]
    fn lfs_rule_scan_does_not_follow_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TestTempDir::new("ag-lfs-rule-symlink").expect("temp");
        let nested = temp.path().join("nested");
        fs::create_dir_all(&nested).expect("nested directory");
        symlink(temp.path(), nested.join("loop")).expect("loop symlink");

        assert!(!repository_has_lfs_rules_with_limit(temp.path(), 10).expect("symlink-safe scan"));
    }

    #[test]
    fn git_failure_summary_skips_clone_progress_for_fatal_error() {
        assert_eq!(
            git_stderr_summary(
                "Cloning into 'local'...\r\nfatal: unable to create temporary file\r\n"
            ),
            Some("fatal: unable to create temporary file")
        );
        assert_eq!(
            git_stderr_summary("Cloning into 'local'...\n"),
            Some("Cloning into 'local'...")
        );
        assert_eq!(git_stderr_summary(" \r\n"), None);
    }

    #[test]
    fn cancellable_operation_guard_unregisters_on_drop() {
        let registry = Arc::new(CancellableOperationRegistry::default());
        let operation_id = OperationId::new("operation-1");
        let (_, guard) = registry
            .register(&operation_id, "testOperation")
            .expect("register operation");

        drop(guard);

        assert!(!registry.cancel(&operation_id).expect("cancel operation"));
    }

    #[test]
    fn cancellable_operation_registry_rejects_duplicate_operation_ids() {
        let registry = Arc::new(CancellableOperationRegistry::default());
        let operation_id = OperationId::new("operation-1");
        let (_, _guard) = registry
            .register(&operation_id, "testOperation")
            .expect("register operation");

        let error = registry
            .register(&operation_id, "testOperation")
            .expect_err("duplicate operation id rejected");

        assert_eq!(error.summary, "operation is already registered");
    }

    #[test]
    fn cancellable_operation_reservation_preserves_an_early_cancel() {
        let registry = Arc::new(CancellableOperationRegistry::default());
        let operation_id = OperationId::new("operation-1");
        let reservation = registry
            .reserve(&operation_id, "testOperation")
            .expect("reserve operation");

        assert!(registry.cancel(&operation_id).expect("cancel reservation"));
        let (token, guard) = registry
            .register(&operation_id, "testOperation")
            .expect("claim reservation");
        assert!(token.is_cancelled());

        drop(reservation);
        assert!(registry.cancel(&operation_id).expect("running operation"));
        drop(guard);
        assert!(!registry.cancel(&operation_id).expect("finished operation"));
    }

    #[test]
    fn unclaimed_cancellable_operation_reservation_unregisters_on_drop() {
        let registry = Arc::new(CancellableOperationRegistry::default());
        let operation_id = OperationId::new("operation-1");
        let reservation = registry
            .reserve(&operation_id, "testOperation")
            .expect("reserve operation");

        drop(reservation);

        assert!(!registry.cancel(&operation_id).expect("dropped reservation"));
    }

    #[test]
    fn backend_cancellable_operation_registers_token_during_action() {
        let (runner, _temp) = fake_runner();
        let backend = RepositoryBackend::new(runner, None);
        let operation_id = OperationId::new("operation-1");

        let response = backend
            .run_cancellable_operation(Some(operation_id.clone()), "testOperation", || {
                backend.cancel_operation(CancelOperationRequest {
                    operation_id: operation_id.clone(),
                })
            })
            .expect("cancel registered operation");

        assert!(response.cancelled);
        assert!(
            !backend
                .cancel_operation(CancelOperationRequest { operation_id })
                .expect("operation guard should unregister after action")
                .cancelled
        );
    }

    #[test]
    fn backend_cancel_and_wait_returns_after_operation_cleanup_finishes() {
        let (runner, _temp) = fake_runner();
        let backend = RepositoryBackend::new(runner, None);
        let worker_backend = backend.clone();
        let operation_id = OperationId::new("operation-wait");
        let worker_operation_id = operation_id.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (cancel_seen_tx, cancel_seen_rx) = std::sync::mpsc::channel();
        let (finish_cleanup_tx, finish_cleanup_rx) = std::sync::mpsc::channel();

        let worker = thread::spawn(move || {
            worker_backend.run_cancellable_operation(
                Some(worker_operation_id),
                "testOperation",
                || {
                    started_tx.send(()).expect("report operation start");
                    while !crate::git_ops::active_cancel_token()
                        .is_some_and(|token| token.is_cancelled())
                    {
                        thread::sleep(Duration::from_millis(5));
                    }
                    cancel_seen_tx.send(()).expect("report cancellation");
                    finish_cleanup_rx.recv().expect("finish cleanup signal");
                    Ok(())
                },
            )
        });

        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("operation started");
        let cancel_backend = backend.clone();
        let cancel_operation_id = operation_id.clone();
        let cancel = thread::spawn(move || {
            cancel_backend.cancel_operation_and_wait(CancelOperationRequest {
                operation_id: cancel_operation_id,
            })
        });

        cancel_seen_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("worker observed cancellation");
        assert!(!cancel.is_finished());
        finish_cleanup_tx.send(()).expect("allow cleanup to finish");

        let response = cancel
            .join()
            .expect("cancel thread")
            .expect("cancel response");
        assert!(response.cancelled);
        worker
            .join()
            .expect("worker thread")
            .expect("worker operation");
        assert!(
            !backend
                .cancel_operation_and_wait(CancelOperationRequest { operation_id })
                .expect("completed operation")
                .cancelled
        );
    }

    #[test]
    fn cancel_commit_operation_kills_git_child_and_restores_index_state() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let original_head = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        let marker = repo.path.join(".git").join("ag-commit-hook-started");
        install_blocking_pre_commit_hook(&repo.path, &marker);
        repo.write("tracked.txt", "two\n");

        let backend = RepositoryBackend::new(runner.clone(), None);
        let thread_backend = backend.clone();
        let operation_id = OperationId::new("commit-cancel-test");
        let thread_operation_id = operation_id.clone();
        let repository_path = display_path(&repo.path);
        let handle = thread::spawn(move || {
            thread_backend.commit_changes(artistic_git_contracts::CommitRequest {
                repository_path,
                paths: vec!["tracked.txt".to_owned()],
                message: "cancelled commit".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: artistic_git_contracts::LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: false,
                operation_id: Some(thread_operation_id),
            })
        });

        wait_for_path(&marker);
        let cancel = backend
            .cancel_operation(CancelOperationRequest { operation_id })
            .expect("cancel commit operation");
        assert!(cancel.cancelled);
        let error = handle
            .join()
            .expect("commit thread")
            .expect_err("commit should be cancelled");

        assert_eq!(error.summary, "operation cancelled");
        assert_eq!(repo.git_output(["rev-parse", "HEAD"]).trim(), original_head);
        assert_eq!(
            repo.git_output(["status", "--short"]).trim(),
            "M tracked.txt"
        );
        assert_eq!(repo.read("tracked.txt"), "two\n");
    }

    #[test]
    fn cancel_revert_operation_kills_git_child_and_restores_auto_stash() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("target.txt", "target\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "add target file"]);
        let target = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.write("later.txt", "later\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "add later file"]);
        let original_head = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.write("draft.txt", "local draft\n");
        let marker = repo.path.join(".git").join("ag-revert-hook-started");
        install_blocking_pre_commit_hook(&repo.path, &marker);

        let backend = RepositoryBackend::new(runner.clone(), None);
        let thread_backend = backend.clone();
        let operation_id = OperationId::new("revert-cancel-test");
        let thread_operation_id = operation_id.clone();
        let repository_path = display_path(&repo.path);
        let handle = thread::spawn(move || {
            thread_backend.revert_commit(artistic_git_contracts::RevertCommitRequest {
                repository_path,
                oid: target,
                push_after_revert: false,
                operation_id: Some(thread_operation_id),
            })
        });

        wait_for_path(&marker);
        let cancel = backend
            .cancel_operation(CancelOperationRequest { operation_id })
            .expect("cancel revert operation");
        assert!(cancel.cancelled);
        let error = handle
            .join()
            .expect("revert thread")
            .expect_err("revert should be cancelled");

        assert_eq!(error.summary, "operation cancelled");
        assert_eq!(repo.git_output(["rev-parse", "HEAD"]).trim(), original_head);
        assert_eq!(repo.read("target.txt"), "target\n");
        assert_eq!(repo.read("later.txt"), "later\n");
        assert_eq!(repo.read("draft.txt"), "local draft\n");
        assert!(repo
            .git_output(["status", "--porcelain"])
            .contains("?? draft.txt"));
        assert!(!repo.path.join(".git").join("REVERT_HEAD").exists());
    }

    fn fake_runner() -> (GitRunner, TestTempDir) {
        let temp = TestTempDir::new("ag-repository-cancel").expect("temp");
        let manifest = git_dist_manifest_fixture();
        write_git_dist_manifest(temp.path(), &manifest).expect("manifest");
        write_executable_file(&temp.path().join(&manifest.paths.git_executable)).expect("git");
        write_executable_file(&temp.path().join(&manifest.paths.git_lfs_executable))
            .expect("git-lfs");
        write_executable_file(&temp.path().join(&manifest.paths.credential_helper))
            .expect("credential helper");
        write_executable_file(&temp.path().join(&manifest.paths.ssh_askpass)).expect("ssh askpass");
        let distribution = GitDistribution::from_root(temp.path()).expect("distribution");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        (runner, temp)
    }

    #[cfg(unix)]
    fn commit_detail_counting_runner(oid: &str, parent: &str) -> (GitRunner, TestTempDir, PathBuf) {
        let temp = TestTempDir::new("ag-commit-detail-count").expect("temp");
        let manifest = git_dist_manifest_fixture();
        write_git_dist_manifest(temp.path(), &manifest).expect("manifest");
        let command_log = temp.path().join("commands.log");
        let unix_git = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {log}\ncase \" $* \" in\n  *\" rev-list \"*) printf '{oid} {parent}\\n' ;;\n  *\" cat-file -s \"*) printf '4\\n' ;;\n  *\" show \"*\"{parent}:tracked.txt\"*) printf 'old\\n' ;;\n  *\" show \"*) printf 'new\\n' ;;\nesac\n",
            log = shell_quote(&command_log),
        );
        write_executable_script(
            &temp.path().join(&manifest.paths.git_executable),
            &unix_git,
            "@echo off\r\nexit /b 1\r\n",
        )
        .expect("git");
        write_executable_file(&temp.path().join(&manifest.paths.git_lfs_executable))
            .expect("git-lfs");
        write_executable_file(&temp.path().join(&manifest.paths.credential_helper))
            .expect("credential helper");
        write_executable_file(&temp.path().join(&manifest.paths.ssh_askpass)).expect("ssh askpass");
        let distribution = GitDistribution::from_manifest(temp.path().to_path_buf(), manifest)
            .expect("distribution");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        (runner, temp, command_log)
    }

    fn lfs_policy_runner() -> (GitRunner, TestTempDir, PathBuf) {
        let temp = TestTempDir::new("ag-local-change-lfs-policy").expect("temp");
        let manifest = git_dist_manifest_fixture();
        write_git_dist_manifest(temp.path(), &manifest).expect("manifest");
        write_executable_script(
            &temp.path().join(&manifest.paths.git_executable),
            "#!/bin/sh\nprintf '.git\\n'\n",
            "@echo off\r\necho .git\r\nexit /b 0\r\n",
        )
        .expect("git");
        let fetch_marker = temp.path().join("lfs-fetch-started");
        let unix_lfs = format!(
            "#!/bin/sh\nprintf started > {marker}\nprintf 'simulated LFS fetch failure\\n' >&2\nexit 1\n",
            marker = shell_quote(&fetch_marker),
        );
        let windows_lfs = format!(
            "@echo off\r\necho started > \"{}\"\r\necho simulated LFS fetch failure 1>&2\r\nexit /b 1\r\n",
            fetch_marker.display(),
        );
        write_executable_script(
            &temp.path().join(&manifest.paths.git_lfs_executable),
            &unix_lfs,
            &windows_lfs,
        )
        .expect("git-lfs");
        write_executable_file(&temp.path().join(&manifest.paths.credential_helper))
            .expect("credential helper");
        write_executable_file(&temp.path().join(&manifest.paths.ssh_askpass)).expect("ssh askpass");
        let distribution = GitDistribution::from_manifest(temp.path().to_path_buf(), manifest)
            .expect("distribution");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        (runner, temp, fetch_marker)
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
    fn parses_for_each_ref_upstream_tracking_counts() {
        assert_eq!(parse_upstream_track(""), Some((0, 0)));
        assert_eq!(parse_upstream_track("ahead 12"), Some((12, 0)));
        assert_eq!(parse_upstream_track("behind 7"), Some((0, 7)));
        assert_eq!(parse_upstream_track("ahead 12, behind 7"), Some((12, 7)));
        assert_eq!(parse_upstream_track("gone"), None);
    }

    #[test]
    fn branch_summary_reuses_upstream_tracking_counts() {
        let (runner, temp) = fake_runner();
        let entry = BranchAccumulator {
            local_oid: Some("local".to_owned()),
            upstream: Some("origin/feature/gallery".to_owned()),
            upstream_track: Some("ahead 8, behind 3".to_owned()),
            ..BranchAccumulator::default()
        };

        assert_eq!(
            branch_ahead_behind(&runner, temp.path(), "feature/gallery", false, &entry,)
                .expect("tracking counts"),
            (8, 3)
        );
    }

    #[test]
    fn branch_summary_does_not_scan_non_current_divergence_without_an_upstream() {
        let (runner, temp) = fake_runner();
        let entry = BranchAccumulator {
            local_oid: Some("local".to_owned()),
            remote_oid: Some("remote".to_owned()),
            ..BranchAccumulator::default()
        };

        assert_eq!(
            branch_ahead_behind(&runner, temp.path(), "feature/gallery", false, &entry)
                .expect("bounded divergence"),
            (0, 0)
        );
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
            &OperationId::new("ssh-test-interactive"),
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
            &OperationId::new("ssh-test-cached"),
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
            &OperationId::new("ssh-test-background"),
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
            &OperationId::new("ssh-test-cancel"),
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
        assert_eq!(entry.message, "Auto Stash: before checkout");
        assert_eq!(entry.origin.as_deref(), Some("auto-stash"));
    }

    #[test]
    fn opens_repository_from_subdirectory_and_reports_no_remote() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);
        repo.write("nested/file.txt", "hello");

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                operation_id: None,
                path: display_path(&repo.path.join("nested")),
                tool_identity: None,
            },
        )
        .expect("open repo");

        assert_same_path(&response.repository_path, &repo.path);
        assert_eq!(response.remote_mode, RepositoryRemoteMode::NoRemote);
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.kind == RepositoryOpenWarningKind::NoRemote));
    }

    #[test]
    fn backend_clones_local_bare_repository_and_reuses_open_flow() {
        let (runner, _dist_temp) = real_runner();
        let source = TestRepo::new(&runner);
        source.init_with_commit();
        let branch = source
            .git_output(["symbolic-ref", "--short", "HEAD"])
            .trim()
            .to_owned();
        let bare = TestTempDir::new("ag-bare-remote").expect("bare remote");
        git_stdout(
            &runner,
            Some(bare.path()),
            ["init", "--bare", "-b", "main"],
            "test",
        )
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
        let backend = RepositoryBackend::new(runner.clone(), None);
        let response = backend
            .clone_repository(CloneRepositoryRequest {
                url: bare_path.clone(),
                branch_name: None,
                target_parent_directory: display_path(parent.path()),
                directory_name: "cloned-art".to_owned(),
                tool_identity: Some(artistic_git_contracts::ToolGitIdentity {
                    name: Some("Artistic Git".to_owned()),
                    email: Some("tool@example.test".to_owned()),
                }),
                operation_id: None,
            })
            .expect("clone repository through backend");
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
    fn probes_remote_branches_and_clones_the_selected_branch() {
        let (runner, _dist_temp) = real_runner();
        let source = TestRepo::new(&runner);
        source.init_with_commit();
        source.git(["switch", "-c", "feature/gallery"]);
        source.write("gallery.txt", "gallery\n");
        source.git(["add", "gallery.txt"]);
        source.git(["commit", "-m", "add gallery"]);
        source.git(["switch", "main"]);

        let bare = TestTempDir::new("ag-bare-remote").expect("bare remote");
        git_stdout(
            &runner,
            Some(bare.path()),
            ["init", "--bare", "-b", "main"],
            "test",
        )
        .expect("init bare remote");
        let bare_path = display_path(bare.path());
        source.git(["remote", "add", "origin", bare_path.as_str()]);
        source.git(["push", "--all", "origin"]);

        let probe = probe_remote_repository(
            &runner,
            RemoteRepositoryProbeRequest {
                url: bare_path.clone(),
                operation_id: None,
                interactive: false,
            },
        )
        .expect("probe remote repository");
        assert_eq!(probe.default_branch.as_deref(), Some("main"));
        assert_eq!(probe.branches, ["feature/gallery", "main"]);
        assert!(!probe.is_empty);
        assert!(!probe.truncated);

        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");
        let response = clone_repository(
            &runner,
            None,
            CloneRepositoryRequest {
                url: bare_path,
                branch_name: Some("feature/gallery".to_owned()),
                target_parent_directory: display_path(parent.path()),
                directory_name: "selected-branch".to_owned(),
                tool_identity: None,
                operation_id: None,
            },
        )
        .expect("clone selected branch");
        let target = parent.path().join("selected-branch");

        assert_eq!(
            response.repository.summary.current_branch.as_deref(),
            Some("feature/gallery")
        );
        assert!(target.join("gallery.txt").exists());
        assert_eq!(
            git_stdout(&runner, Some(&target), ["branch", "--show-current"], "test",)
                .expect("current branch")
                .trim(),
            "feature/gallery"
        );
    }

    #[test]
    fn probe_reports_an_empty_remote_without_failing() {
        let (runner, _dist_temp) = real_runner();
        let bare = TestTempDir::new("ag-empty-bare-remote").expect("bare remote");
        git_stdout(
            &runner,
            Some(bare.path()),
            ["init", "--bare", "-b", "main"],
            "test",
        )
        .expect("init empty bare remote");

        let probe = probe_remote_repository(
            &runner,
            RemoteRepositoryProbeRequest {
                url: display_path(bare.path()),
                operation_id: None,
                interactive: false,
            },
        )
        .expect("probe empty remote");

        assert!(probe.is_empty);
        assert!(probe.branches.is_empty());
        assert_eq!(probe.default_branch, None);
        assert!(!probe.truncated);
    }

    #[test]
    fn probe_parser_ignores_non_branch_refs_and_a_dangling_head() {
        let probe = parse_remote_repository_probe(
            "ref: refs/heads/missing\tHEAD\n\
             aaaaaaaa\tHEAD\n\
             bbbbbbbb\trefs/tags/v1\n\
             cccccccc\trefs/heads/release\n\
             dddddddd\trefs/heads/develop\n\
             cccccccc\trefs/heads/release\n",
        );

        assert_eq!(probe.default_branch, None);
        assert_eq!(probe.branches, ["develop", "release"]);
        assert!(!probe.is_empty);
        assert!(!probe.truncated);
    }

    #[test]
    fn remote_probe_caps_branches_and_keeps_the_default_branch() {
        let mut output = "ref: refs/heads/default-branch\tHEAD\n".to_owned();
        for index in 0..=REMOTE_BRANCH_LIST_ENTRY_LIMIT {
            output.push_str(&format!("{index:040x}\trefs/heads/branch-{index:05}\n"));
        }

        let probe = parse_remote_repository_probe(&output);

        assert_eq!(probe.branches.len(), REMOTE_BRANCH_LIST_ENTRY_LIMIT);
        assert!(probe.truncated);
        assert_eq!(probe.default_branch.as_deref(), Some("default-branch"));
        assert!(probe
            .branches
            .iter()
            .any(|branch| branch == "default-branch"));
    }

    #[test]
    fn remote_url_validation_blocks_embedded_secrets_without_rejecting_username_urls() {
        let username_url = format!(
            "{}://{}@dev.azure.com/team/project/_git/repo",
            "https", "organization"
        );
        let password_url = format!(
            "{}://{}:{}@example.test/repo.git",
            "https", "user", "secret"
        );
        let token_url = format!("{}://{}@example.test/repo.git", "https", "TOKEN");
        let safe_token_url = format!("{}://{}@example.test/repo.git", "https", "[REDACTED]");
        assert!(!url_contains_embedded_credentials_or_parameters(
            &username_url
        ));
        assert!(url_contains_embedded_credentials_or_parameters(
            &password_url
        ));
        assert!(url_contains_embedded_credentials_or_parameters(
            "file:///tmp/repo.git?access_token=TOPSECRET"
        ));
        assert_eq!(diagnostic_remote_url(&token_url), safe_token_url);

        let error = validate_remote_repository_url(
            "file:///tmp/repo.git?access_token=TOPSECRET",
            PROBE_REMOTE_REPOSITORY_OPERATION,
        )
        .expect_err("query credentials must be rejected before Git runs");
        assert!(!error.summary.contains("TOPSECRET"));
        assert!(error.git.is_none());
    }

    #[test]
    fn clone_branch_validation_rejects_reflog_shorthand() {
        let (runner, _dist_temp) = real_runner();

        let error = validate_clone_branch_name(&runner, Some("@{-1}"))
            .expect_err("reflog shorthand is not a remote branch name");

        assert_eq!(error.context.operation_name, "cloneRepository");
        assert!(error.git.is_some());
    }

    #[test]
    fn clone_rejects_a_tag_when_the_selected_branch_disappeared() {
        let (runner, _dist_temp) = real_runner();
        let source = TestRepo::new(&runner);
        source.init_with_commit();
        source.git(["tag", "release"]);
        let bare = TestTempDir::new("ag-tag-only-remote").expect("bare remote");
        git_stdout(
            &runner,
            Some(bare.path()),
            ["init", "--bare", "-b", "main"],
            "test",
        )
        .expect("init bare remote");
        let bare_path = display_path(bare.path());
        source.git(["remote", "add", "origin", bare_path.as_str()]);
        source.git(["push", "origin", "main"]);
        source.git(["push", "origin", "refs/tags/release"]);
        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");

        let error = clone_repository(
            &runner,
            None,
            CloneRepositoryRequest {
                url: bare_path,
                branch_name: Some("release".to_owned()),
                target_parent_directory: display_path(parent.path()),
                directory_name: "tag-is-not-branch".to_owned(),
                tool_identity: None,
                operation_id: None,
            },
        )
        .expect_err("a same-named tag must not satisfy a selected branch");

        assert_eq!(
            error.summary,
            "selected branch is no longer available on the remote"
        );
        assert!(!parent.path().join("tag-is-not-branch").exists());
    }

    #[test]
    fn clone_emits_progress_events_for_local_bare_repository() {
        let (runner, _dist_temp) = real_runner();
        let source = TestRepo::new(&runner);
        source.init_with_commit();
        let branch = source
            .git_output(["symbolic-ref", "--short", "HEAD"])
            .trim()
            .to_owned();
        let bare = TestTempDir::new("ag-bare-remote").expect("bare remote");
        git_stdout(
            &runner,
            Some(bare.path()),
            ["init", "--bare", "-b", "main"],
            "test",
        )
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
                branch_name: None,
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
        assert!(events.iter().all(|event| event.cancellable));
    }

    #[test]
    fn clone_cancellation_remains_active_after_the_clone_process_finishes() {
        let (runner, _dist_temp) = real_runner();
        let source = TestRepo::new(&runner);
        source.init_with_commit();
        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");
        let cancel_token = CancelToken::new();

        let error = clone_repository_with_cancel_and_progress(
            &runner,
            None,
            CloneRepositoryRequest {
                url: display_path(&source.path),
                branch_name: None,
                target_parent_directory: display_path(parent.path()),
                directory_name: "cancel-after-download".to_owned(),
                tool_identity: None,
                operation_id: Some(OperationId::new("clone-open-cancel-test")),
            },
            &cancel_token,
            |event| {
                if event.label == "Clone complete" {
                    cancel_token.cancel();
                }
            },
        )
        .expect_err("clone opening phase should observe the clone cancellation token");

        assert_eq!(error.summary, "operation cancelled");
        assert!(!parent.path().join("cancel-after-download").exists());
    }

    #[test]
    fn cancellable_git_command_drains_large_stdout_and_stderr() {
        let (runner, dist_temp) = fake_runner();
        let manifest = git_dist_manifest_fixture();
        write_executable_script(
            &dist_temp.path().join(&manifest.paths.git_executable),
            "#!/bin/sh\ni=0\nwhile [ $i -lt 12000 ]; do\n  printf 'stdout-%s\\n' \"$i\"\n  printf 'stderr-%s\\n' \"$i\" >&2\n  i=$((i + 1))\ndone\n",
            "@echo off\r\nfor /L %%i in (1,1,12000) do (\r\n  echo stdout-%%i\r\n  echo stderr-%%i 1>&2\r\n)\r\nexit /b 0\r\n",
        )
        .expect("write large-output git");
        let (result_tx, result_rx) = mpsc::channel();

        thread::spawn(move || {
            let result = run_git_cancellable(
                &runner,
                None,
                vec![OsString::from("log")],
                "largeOutputTest",
                &CancelToken::new(),
            );
            let _ = result_tx.send(result);
        });

        let output = result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("large output should be drained while Git is running")
            .expect("large output command");
        assert!(String::from_utf8_lossy(&output.stdout).contains("stdout-11999"));
    }

    #[cfg(unix)]
    #[test]
    fn clone_cancel_does_not_join_readers_held_by_descendants() {
        let (runner, dist_temp) = fake_runner();
        let manifest = git_dist_manifest_fixture();
        let parent = TestTempDir::new("ag-clone-inherited-pipe").expect("clone parent");
        let marker = parent.path().join("clone-started");
        let script = format!(
            "#!/bin/sh\nmkdir inherited-pipe-clone\nprintf started > {marker}\n(sleep 3) &\nwait\n",
            marker = shell_quote(&marker),
        );
        write_executable_script(
            &dist_temp.path().join(&manifest.paths.git_executable),
            &script,
            "@exit /b 1\r\n",
        )
        .expect("write inherited-pipe git");
        let cancel_token = CancelToken::new();
        let thread_token = cancel_token.clone();
        let parent_path = parent.path().to_path_buf();
        let (result_tx, result_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            let target = CloneTarget {
                path: parent_path.join("inherited-pipe-clone"),
                parent: parent_path,
                directory_name: OsString::from("inherited-pipe-clone"),
            };
            let result = run_clone_command(
                &runner,
                "https://example.test/repository.git",
                None,
                &target,
                &thread_token,
                Some(&OperationId::new("clone-inherited-pipe-test")),
                &|_| {},
            );
            let _ = result_tx.send(result);
        });

        wait_for_path(&marker);
        cancel_token.cancel();
        let error = result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("clone cancellation must not join inherited pipe readers")
            .expect_err("clone should be cancelled");
        handle.join().expect("clone thread");

        assert_eq!(error.summary, "operation cancelled");
        assert!(!parent.path().join("inherited-pipe-clone").exists());
    }

    #[cfg(unix)]
    #[test]
    fn submodule_update_uses_active_cancel_token_and_marks_progress_cancellable() {
        let (runner, dist_temp) = fake_runner();
        let manifest = git_dist_manifest_fixture();
        let repository = TestTempDir::new("ag-submodule-cancel").expect("repository");
        fs::write(
            repository.path().join(".gitmodules"),
            "[submodule \"fixture\"]\n",
        )
        .expect("write gitmodules");
        let marker = repository.path().join("submodule-update-started");
        let script = format!(
            "#!/bin/sh\nprintf started > {marker}\n(sleep 3) &\nwait\n",
            marker = shell_quote(&marker),
        );
        write_executable_script(
            &dist_temp.path().join(&manifest.paths.git_executable),
            &script,
            "@exit /b 1\r\n",
        )
        .expect("write blocking submodule git");
        let cancel_token = CancelToken::new();
        let thread_token = cancel_token.clone();
        let root = repository.path().to_path_buf();
        let (progress_tx, progress_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            let result = crate::git_ops::with_cancel_token_for_operation(&thread_token, || {
                update_submodules_after_checkout(
                    &runner,
                    &root,
                    "syncCurrentBranch",
                    Some(&OperationId::new("submodule-cancel-test")),
                    &|event| {
                        let _ = progress_tx.send(event);
                    },
                )
            });
            let _ = result_tx.send(result);
        });

        let progress = progress_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("initial submodule progress");
        assert_eq!(progress.label, "Updating submodules");
        assert!(progress.cancellable);
        wait_for_path(&marker);
        cancel_token.cancel();
        let error = result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("submodule cancellation should stop the running command")
            .expect_err("submodule update should be cancelled");
        handle.join().expect("submodule thread");

        assert_eq!(error.summary, "operation cancelled");
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
    fn opening_existing_repository_does_not_modify_submodules() {
        let (runner, _dist_temp) = real_runner();
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let child = TestRepo::new(&runner);
        child.init_with_commit();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);
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
                operation_id: Some(OperationId::new("open-existing-submodule")),
                path: display_path(&repo.path),
                tool_identity: None,
            },
            |event| events.borrow_mut().push(event),
        )
        .expect("open existing repository with submodule");

        assert!(!repo.path.join("deps/lib/tracked.txt").exists());
        let labels = events
            .borrow()
            .iter()
            .map(|event| event.label.clone())
            .collect::<Vec<_>>();
        assert!(!labels.iter().any(|label| label == "Updating submodules"));
        assert!(!labels.iter().any(|label| label == "Submodules ready"));
        assert!(events.borrow().iter().all(|event| !event.cancellable));
    }

    #[test]
    fn local_changes_render_gitlink_pointer_as_submodule_card() {
        let (runner, _dist_temp) = real_runner();
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let child = TestRepo::new(&runner);
        child.init_with_commit();
        let old_oid = child.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);
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
        let (runner, _dist_temp) = real_runner();
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let child = TestRepo::new(&runner);
        child.init_with_commit();

        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);
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
        assert_eq!(tracked.payload.file_kind, DiffFileKind::Deferred);
        assert!(matches!(tracked.diff, DiffContent::Deferred { .. }));

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

        let detail = local_change_detail(
            &runner,
            LocalChangeDetailRequest {
                repository_path: display_path(&repo.path),
                path: "deps/lib/tracked.txt".to_owned(),
                old_path: None,
                submodule: tracked.submodule.clone(),
                operation_id: None,
            },
        )
        .expect("submodule local change detail");
        assert_eq!(detail.path, "deps/lib/tracked.txt");
        assert!(matches!(
            detail.diff,
            DiffContent::Text {
                old_text: Some(ref old_text),
                new_text: Some(ref new_text),
                ..
            } if old_text == "one\n" && new_text == "two\n"
        ));
    }

    #[test]
    fn clone_rejects_existing_target_directory() {
        let (runner, _dist_temp) = real_runner();
        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");
        fs::create_dir(parent.path().join("existing")).expect("existing target");

        let error = clone_repository(
            &runner,
            None,
            CloneRepositoryRequest {
                url: "https://example.test/art.git".to_owned(),
                branch_name: None,
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
        let (runner, _dist_temp) = real_runner();
        let parent = TestTempDir::new("ag-clone-parent").expect("clone parent");
        let token = CancelToken::new();
        token.cancel();

        let error = clone_repository_with_cancel(
            &runner,
            None,
            CloneRepositoryRequest {
                url: "https://example.test/art.git".to_owned(),
                branch_name: None,
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
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "--bare", "-b", "main"]);

        let error = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                operation_id: None,
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect_err("bare repo should be rejected");

        assert_eq!(error.summary, "不是受支持的 Git 项目类型");
    }

    #[test]
    fn reports_unborn_and_index_lock_health() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);
        let lock_path = repo.path.join(".git/index.lock");
        fs::File::create(&lock_path).expect("index.lock");
        set_index_lock_age(&lock_path, Duration::from_secs(30));

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                operation_id: None,
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect("open unborn repo");

        assert!(matches!(
            response.health.head,
            RepositoryHeadState::Unborn { .. }
        ));
        let index_lock = response
            .health
            .index_lock
            .expect("residual index.lock should be reported");
        assert!(index_lock.age_seconds >= 30);
    }

    #[test]
    fn ignores_transient_index_lock_from_concurrent_reads() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let lock_path = repo.path.join(".git/index.lock");
        fs::File::create(&lock_path).expect("index.lock");
        // Fresh locks are treated as in-flight index refreshes (e.g. git status), not residuals.
        set_index_lock_age(&lock_path, Duration::from_secs(0));

        let summary = repository_summary(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("summary with transient index.lock");

        assert!(summary
            .details
            .as_ref()
            .expect("summary details")
            .health
            .index_lock
            .is_none());
        assert!(!summary.in_progress);
    }

    #[test]
    fn reports_residual_index_lock_once_it_has_aged() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let lock_path = repo.path.join(".git/index.lock");
        fs::File::create(&lock_path).expect("index.lock");
        set_index_lock_age(&lock_path, Duration::from_secs(5));

        let summary = repository_summary(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("summary with residual index.lock");

        let index_lock = summary
            .details
            .as_ref()
            .expect("summary details")
            .health
            .index_lock
            .as_ref()
            .expect("aged index.lock should be reported");
        assert!(index_lock.age_seconds >= 5);
        assert!(summary.in_progress);
    }

    #[test]
    fn resets_bisect_with_the_repository_write_lock() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "second\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "second"]);
        repo.git(["bisect", "start"]);
        repo.git(["bisect", "bad"]);
        repo.git(["bisect", "good", "HEAD~1"]);
        let request = RepositoryPathRequest {
            repository_path: display_path(&repo.path),
        };
        let before = repository_summary(&runner, request.clone()).expect("bisect summary");
        assert!(before
            .details
            .as_ref()
            .expect("summary details")
            .health
            .middle_states
            .iter()
            .any(|state| state.kind == RepositoryMiddleStateKind::Bisect));

        let backend = RepositoryBackend::new(runner.clone(), None);
        let background = runner
            .operation_concurrency()
            .try_begin_background()
            .expect("hold background lock");
        let busy = backend
            .reset_bisect(request.clone())
            .expect_err("background operation must block reset");
        assert!(busy.summary.contains("background operation"));
        drop(background);

        let after = backend.reset_bisect(request).expect("reset bisect");
        assert!(!after.in_progress);
        assert!(after
            .details
            .as_ref()
            .expect("summary details")
            .health
            .middle_states
            .is_empty());
        assert!(!repo.path.join(".git/BISECT_LOG").exists());
    }

    #[test]
    fn lists_local_changes_and_filters_backup_branches() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);
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
        assert!(!branches.truncated);
    }

    #[test]
    fn bounds_branch_ref_enumeration_before_building_summaries() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let old_head = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.git(["branch", "current-old"]);
        repo.write("tracked.txt", "newer\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "newer refs"]);
        let newer_head = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.git(["checkout", "current-old"]);
        let mut packed_refs = "# pack-refs with: peeled fully-peeled sorted\n".to_owned();
        for index in 0..=BRANCH_LIST_ENTRY_LIMIT {
            packed_refs.push_str(&format!("{newer_head} refs/heads/backup/perf-{index:05}\n"));
        }
        for index in 0..=BRANCH_LIST_ENTRY_LIMIT {
            packed_refs.push_str(&format!("{newer_head} refs/heads/perf-{index:05}\n"));
        }
        packed_refs.push_str(&format!("{old_head} refs/remotes/origin/current-old\n"));
        for index in 0..=BRANCH_LIST_ENTRY_LIMIT {
            packed_refs.push_str(&format!(
                "{newer_head} refs/remotes/origin/perf-{index:05}\n"
            ));
        }
        fs::write(repo.path.join(".git/packed-refs"), packed_refs).expect("packed refs");

        let response = list_branches(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("bounded branches");

        assert!(response.truncated);
        assert_eq!(response.branches.len(), BRANCH_LIST_ENTRY_LIMIT);
        let current = response
            .branches
            .iter()
            .find(|branch| branch.current)
            .expect("current branch retained");
        assert_eq!(current.short_name, "current-old");
        assert_eq!(current.head_oid.as_deref(), Some(old_head.as_str()));
        assert_eq!(current.existence, BranchExistence::LocalAndRemote);
        assert!(response
            .branches
            .iter()
            .any(|branch| branch.short_name.starts_with("perf-")));
        assert!(!response
            .branches
            .iter()
            .any(|branch| branch.short_name.starts_with("backup/")));
    }

    #[test]
    fn loads_one_local_change_detail_without_reloading_the_whole_list() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "two\n");
        repo.write("unrelated.txt", "unrelated\n");

        let changes = list_local_changes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("local change metadata");
        assert!(changes.changes.iter().all(|change| {
            change.payload.file_kind == DiffFileKind::Deferred
                && matches!(change.diff, DiffContent::Deferred { .. })
        }));

        let detail = local_change_detail(
            &runner,
            LocalChangeDetailRequest {
                repository_path: display_path(&repo.path),
                path: "tracked.txt".to_owned(),
                old_path: None,
                submodule: None,
                operation_id: None,
            },
        )
        .expect("single local change detail");

        assert_eq!(detail.path, "tracked.txt");
        assert_eq!(detail.payload.file_kind, DiffFileKind::Text);
        assert!(matches!(
            detail.diff,
            DiffContent::Text {
                old_text: Some(ref old_text),
                new_text: Some(ref new_text),
                ..
            } if old_text == "one\n" && new_text == "two\n"
        ));
    }

    #[test]
    fn local_change_detail_preserves_rename_detection_with_both_paths() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["mv", "tracked.txt", "renamed.txt"]);

        let detail = local_change_detail(
            &runner,
            LocalChangeDetailRequest {
                repository_path: display_path(&repo.path),
                path: "renamed.txt".to_owned(),
                old_path: Some("tracked.txt".to_owned()),
                submodule: None,
                operation_id: None,
            },
        )
        .expect("renamed local change detail");

        assert_eq!(detail.change_kind, DiffChangeKind::Renamed);
        assert_eq!(detail.old_path.as_deref(), Some("tracked.txt"));
        assert_eq!(detail.path, "renamed.txt");
    }

    #[test]
    fn local_change_list_defers_oversized_worktree_files() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let path = repo.path.join("oversized.txt");
        fs::write(&path, vec![b'x'; OVERSIZED_TEXT_BYTES + 1]).expect("write oversized file");

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
            .find(|change| change.path == "oversized.txt")
            .expect("oversized change");

        assert_eq!(change.payload.file_kind, DiffFileKind::Deferred);
        assert_eq!(change.payload.metadata["previewDeferred"], "true");
        assert!(!change.payload.metadata.contains_key("newBytes"));
        assert!(!change.payload.metadata.contains_key("oversized"));
        assert!(matches!(change.diff, DiffContent::Deferred { .. }));

        let detail = local_change_detail(
            &runner,
            LocalChangeDetailRequest {
                repository_path: display_path(&repo.path),
                path: "oversized.txt".to_owned(),
                old_path: None,
                submodule: None,
                operation_id: None,
            },
        )
        .expect("oversized local change detail");
        assert_eq!(detail.payload.file_kind, DiffFileKind::OversizedText);
        assert_eq!(
            detail.payload.metadata["newBytes"],
            (OVERSIZED_TEXT_BYTES + 1).to_string()
        );
        assert_eq!(detail.payload.metadata["oversized"], "true");
        assert!(matches!(detail.diff, DiffContent::Deferred { .. }));
    }

    #[test]
    fn local_change_detail_previews_images_above_the_text_limit() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let relative_path = "UnityProject/Assets/AssetRaw/UIRaw/Atlas/GameMainUl/ui_btn_Invite.png";
        let path = repo.path.join(relative_path);
        fs::create_dir_all(path.parent().expect("image parent")).expect("create image parent");
        fs::write(&path, png_fixture(68)).expect("write original image");
        repo.git(["add", relative_path]);
        repo.git(["commit", "-m", "add image"]);
        let png = png_fixture(OVERSIZED_TEXT_BYTES + 1);
        fs::write(&path, &png).expect("write image");

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
            .find(|change| change.path == relative_path)
            .expect("image change");

        assert_eq!(change.payload.file_kind, DiffFileKind::Deferred);
        assert_eq!(change.payload.metadata["previewDeferred"], "true");
        assert!(!change.payload.metadata.contains_key("oversized"));

        let detail = local_change_detail(
            &runner,
            LocalChangeDetailRequest {
                repository_path: display_path(&repo.path),
                path: relative_path.to_owned(),
                old_path: None,
                submodule: None,
                operation_id: None,
            },
        )
        .expect("image detail");

        assert_eq!(detail.payload.file_kind, DiffFileKind::Image);
        let DiffContent::Image {
            old_image: Some(old_asset),
            new_image: Some(asset),
        } = detail.diff
        else {
            panic!("expected image preview");
        };
        assert_eq!(old_asset.mime_type.as_deref(), Some("image/png"));
        assert_eq!(old_asset.size_bytes, Some(68));
        assert_eq!(asset.mime_type.as_deref(), Some("image/png"));
        assert_eq!(asset.size_bytes, Some(png.len() as u32));
        assert!(asset.src.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn batch_local_change_preview_reports_missing_lfs_without_fetching() {
        let (runner, temp, fetch_marker) = lfs_policy_runner();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).expect("repository");
        let pointer = concat!(
            "version https://git-lfs.github.com/spec/v1\n",
            "oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
            "size 16\n",
        );
        fs::write(repo.join("asset.bin"), pointer).expect("LFS pointer");
        let mut budget = LocalChangePreviewBudget::default();

        let (payload, diff) = local_change_diff(
            &runner,
            LocalChangeDiffContext {
                root: &repo,
                path: "asset.bin",
                old_path: None,
                change_kind: DiffChangeKind::Added,
                changed_lines: None,
                index_status: "?",
                inspect_submodules: false,
                worktree_status: "?",
                load_policy: LocalChangeLoadPolicy::Batch,
            },
            &mut budget,
        )
        .expect("batch preview");

        assert_eq!(payload.file_kind, DiffFileKind::LfsPointer);
        assert_eq!(payload.metadata["lfsFetchStatus"], "missing");
        assert!(matches!(
            diff,
            DiffContent::LfsPointer {
                status: LfsContentStatus::Missing,
                message: None,
            }
        ));
        assert!(!fetch_marker.exists());
    }

    #[test]
    fn local_change_detail_fetches_missing_lfs_content() {
        let (runner, temp, fetch_marker) = lfs_policy_runner();
        let repo = temp.path().join("repo");
        fs::create_dir_all(repo.join(".git")).expect("repository");
        let pointer = concat!(
            "version https://git-lfs.github.com/spec/v1\n",
            "oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
            "size 16\n",
        );
        fs::write(repo.join("asset.bin"), pointer).expect("LFS pointer");
        let mut budget = LocalChangePreviewBudget::default();

        let (payload, diff) = local_change_diff(
            &runner,
            LocalChangeDiffContext {
                root: &repo,
                path: "asset.bin",
                old_path: None,
                change_kind: DiffChangeKind::Added,
                changed_lines: None,
                index_status: "?",
                inspect_submodules: false,
                worktree_status: "?",
                load_policy: LocalChangeLoadPolicy::Detail,
            },
            &mut budget,
        )
        .expect("detail preview");

        assert_eq!(payload.file_kind, DiffFileKind::LfsPointer);
        assert_eq!(payload.metadata["lfsFetchStatus"], "error");
        assert!(matches!(
            diff,
            DiffContent::LfsPointer {
                status: LfsContentStatus::Error,
                message: Some(_),
            }
        ));
        assert!(fetch_marker.exists());
    }

    #[test]
    fn local_change_detail_renders_available_lfs_content_instead_of_pointer() {
        let (runner, _dist_temp) = real_runner();
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

        assert_eq!(change.payload.file_kind, DiffFileKind::Deferred);
        assert!(matches!(change.diff, DiffContent::Deferred { .. }));

        let detail = local_change_detail(
            &runner,
            LocalChangeDetailRequest {
                repository_path: display_path(&repo.path),
                path: "asset.bin".to_owned(),
                old_path: None,
                submodule: None,
                operation_id: None,
            },
        )
        .expect("LFS local change detail");
        assert_eq!(detail.payload.file_kind, DiffFileKind::Text);
        assert_eq!(detail.payload.metadata["lfsResolved"], "true");
        assert_eq!(detail.payload.metadata["lfsFetchStatus"], "local");
        match &detail.diff {
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
        let cwd_marker = temp.path().join("lfs-cwd.txt");
        let unix_script = format!(
            "#!/bin/sh\npwd > {cwd_marker}\nprintf '%s\\n' \"$@\" > {marker}\nexit 0\n",
            cwd_marker = shell_quote(&cwd_marker),
            marker = shell_quote(&marker),
        );
        let windows_script = format!(
            "@echo off\r\ncd > \"{}\"\r\necho %* > \"{}\"\r\nexit /b 0\r\n",
            cwd_marker.display(),
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
        let cwd = fs::read_to_string(cwd_marker).expect("read lfs cwd");
        assert_eq!(
            canonical_or_self(Path::new(cwd.trim())),
            canonical_or_self(&repo)
        );
        assert!(!args.contains("-C"));
        assert!(!args.contains(&display_path(&repo)));
        assert!(args.contains("fetch"));
        assert!(args.contains("--object-id"));
        assert!(args.contains("origin"));
        assert!(args.contains(oid));
    }

    #[test]
    fn rejects_linked_worktree() {
        let (runner, _dist_temp) = real_runner();
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
                operation_id: None,
                path: display_path(linked.path()),
                tool_identity: None,
            },
        )
        .expect_err("linked worktree should be rejected");

        assert_eq!(error.summary, "不是受支持的 Git 项目类型");
    }

    #[test]
    fn reports_detached_head_warning() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["checkout", "--detach", "HEAD"]);

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                operation_id: None,
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
        let (runner, _dist_temp) = real_runner();
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
                operation_id: None,
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
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);

        open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                operation_id: None,
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
        let (runner, _dist_temp) = real_runner();
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
                operation_id: None,
                revisions: Vec::new(),
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
                operation_id: None,
                revisions: Vec::new(),
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

    #[test]
    fn loads_real_commit_details_and_selected_file_content() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["mv", "tracked.txt", "renamed.txt"]);
        repo.write("added.txt", "new file\n");
        repo.git(["add", "."]);
        repo.git([
            "commit",
            "-m",
            "rename and add",
            "-m",
            "A useful commit body for the details panel.",
        ]);
        let oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let details = commit_details(
            &runner,
            CommitDetailsRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                limit: Some(5_000),
                operation_id: None,
            },
        )
        .expect("commit details");

        assert_eq!(
            details.body.as_deref(),
            Some("A useful commit body for the details panel.")
        );
        assert!(!details.body_truncated);
        assert!(!details.truncated);
        assert!(details.files.iter().any(|file| {
            file.path == "renamed.txt"
                && file.old_path.as_deref() == Some("tracked.txt")
                && file.change_kind == DiffChangeKind::Renamed
        }));
        assert!(details.files.iter().any(|file| {
            file.path == "added.txt"
                && file.change_kind == DiffChangeKind::Added
                && file.additions == 1
        }));

        let added = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                file: repo.changed_file_at(&oid, "added.txt"),
                operation_id: None,
            },
        )
        .expect("added file detail");
        assert_eq!(added.payload.change_kind, DiffChangeKind::Added);
        assert!(matches!(
            added.diff,
            DiffContent::Text {
                old_text: None,
                new_text: Some(ref value),
                ..
            } if value == "new file\n"
        ));

        let renamed = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                file: repo.changed_file_at(&oid, "renamed.txt"),
                operation_id: None,
            },
        )
        .expect("renamed file detail");
        assert_eq!(renamed.payload.old_path.as_deref(), Some("tracked.txt"));
        assert!(matches!(renamed.diff, DiffContent::Moved { .. }));
    }

    #[test]
    fn loads_root_commit_details_without_a_parent() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let details = commit_details(
            &runner,
            CommitDetailsRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                limit: Some(5_000),
                operation_id: None,
            },
        )
        .expect("root details");
        assert_eq!(details.files.len(), 1);
        assert_eq!(details.files[0].path, "tracked.txt");
        assert_eq!(details.files[0].change_kind, DiffChangeKind::Added);

        let file = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                file: details.files[0].clone(),
                operation_id: None,
            },
        )
        .expect("root file detail");
        assert!(matches!(
            file.diff,
            DiffContent::Text {
                old_text: None,
                new_text: Some(ref value),
                ..
            } if value == "one\n"
        ));
    }

    #[test]
    fn loads_historical_submodule_pointer_without_reading_it_as_a_blob() {
        let (runner, _dist_temp) = real_runner();
        let source = TestRepo::new(&runner);
        source.init_with_commit();
        let source_oid = source.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        let source_path = display_path(&source.path);
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git([
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            source_path.as_str(),
            "module",
        ]);
        repo.git(["commit", "-am", "add submodule"]);
        let oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let detail = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                file: repo.changed_file_at(&oid, "module"),
                operation_id: None,
            },
        )
        .expect("submodule detail");

        assert_eq!(detail.payload.file_kind, DiffFileKind::Binary);
        assert_eq!(
            detail.payload.metadata.get("submodule").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            detail.payload.metadata.get("newOid").map(String::as_str),
            Some(source_oid.as_str())
        );
        assert!(matches!(detail.diff, DiffContent::Moved { .. }));
    }

    #[test]
    fn explains_mode_only_commit_changes() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["update-index", "--chmod=+x", "tracked.txt"]);
        repo.git(["commit", "-m", "make tracked file executable"]);
        let oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let details = commit_details(
            &runner,
            CommitDetailsRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                limit: Some(5_000),
                operation_id: None,
            },
        )
        .expect("mode-only details");
        let file = details
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .expect("mode-only file");
        assert_eq!(file.old_mode.as_deref(), Some("100644"));
        assert_eq!(file.new_mode.as_deref(), Some("100755"));
        assert_eq!(file.additions, 0);
        assert_eq!(file.deletions, 0);

        let detail = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                file: file.clone(),
                operation_id: None,
            },
        )
        .expect("mode-only file detail");
        assert_eq!(detail.payload.metadata["modeChanged"], "true");
        assert_eq!(detail.payload.metadata["contentChanged"], "false");
        assert_eq!(detail.payload.metadata["oldMode"], "100644");
        assert_eq!(detail.payload.metadata["newMode"], "100755");
        assert!(matches!(detail.diff, DiffContent::Moved { .. }));

        repo.write("tracked.txt", "two\n");
        repo.git(["add", "tracked.txt"]);
        repo.git(["update-index", "--chmod=-x", "tracked.txt"]);
        repo.git(["commit", "-m", "change content and remove executable bit"]);
        let content_and_mode_oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        let content_and_mode = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: content_and_mode_oid.clone(),
                file: repo.changed_file_at(&content_and_mode_oid, "tracked.txt"),
                operation_id: None,
            },
        )
        .expect("content and mode file detail");
        assert_eq!(content_and_mode.payload.metadata["modeChanged"], "true");
        assert_eq!(content_and_mode.payload.metadata["contentChanged"], "true");
        assert!(matches!(content_and_mode.diff, DiffContent::Text { .. }));
    }

    #[test]
    fn historical_lfs_uses_local_objects_and_reports_missing_objects() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let old_oid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let new_oid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let missing_oid = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let old_content = b"old LFS text\n";
        let new_content = b"new LFS text\n";
        let old_pointer = format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{old_oid}\nsize {}\n",
            old_content.len()
        );
        let new_pointer = format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{new_oid}\nsize {}\n",
            new_content.len()
        );
        repo.write("asset.dat", &old_pointer);
        repo.write_lfs_object(old_oid, old_content);
        repo.git(["add", "asset.dat"]);
        repo.git(["commit", "-m", "add LFS pointer"]);
        repo.write("asset.dat", &new_pointer);
        repo.write_lfs_object(new_oid, new_content);
        repo.git(["add", "asset.dat"]);
        repo.git(["commit", "-m", "update LFS pointer"]);
        let available_oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let available = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: available_oid.clone(),
                file: repo.changed_file_at(&available_oid, "asset.dat"),
                operation_id: None,
            },
        )
        .expect("available historical LFS detail");
        assert_eq!(available.payload.file_kind, DiffFileKind::Text);
        assert_eq!(available.payload.metadata["lfsResolved"], "true");
        assert_eq!(available.payload.metadata["lfsFetchStatus"], "local");
        assert!(matches!(
            available.diff,
            DiffContent::Text {
                old_text: Some(ref old),
                new_text: Some(ref new),
                ..
            } if old == "old LFS text\n" && new == "new LFS text\n"
        ));

        let missing_pointer = format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{missing_oid}\nsize 12\n"
        );
        repo.write("asset.dat", &missing_pointer);
        repo.git(["add", "asset.dat"]);
        repo.git(["commit", "-m", "reference missing LFS object"]);
        let missing_commit = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        let missing = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: missing_commit.clone(),
                file: repo.changed_file_at(&missing_commit, "asset.dat"),
                operation_id: None,
            },
        )
        .expect("missing historical LFS detail");
        assert_eq!(missing.payload.file_kind, DiffFileKind::LfsPointer);
        assert_eq!(missing.payload.metadata["lfsFetchStatus"], "missing");
        assert_eq!(missing.payload.metadata["lfsResolved"], "false");
        assert!(matches!(
            missing.diff,
            DiffContent::LfsPointer {
                status: LfsContentStatus::Missing,
                ..
            }
        ));
    }

    #[test]
    fn historical_lfs_uses_local_image_objects() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let image_oid = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let png = [
            0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R',
            0, 0, 0, 3, 0, 0, 0, 4,
        ];
        let pointer = format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{image_oid}\nsize {}\n",
            png.len()
        );
        repo.write("asset.png", &pointer);
        repo.write_lfs_object(image_oid, &png);
        repo.git(["add", "asset.png"]);
        repo.git(["commit", "-m", "add LFS image"]);
        let oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let detail = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                file: repo.changed_file_at(&oid, "asset.png"),
                operation_id: None,
            },
        )
        .expect("historical LFS image detail");

        assert_eq!(detail.payload.file_kind, DiffFileKind::Image);
        assert_eq!(detail.payload.metadata["lfsResolved"], "true");
        assert_eq!(detail.payload.metadata["lfsFetchStatus"], "local");
        assert!(matches!(
            detail.diff,
            DiffContent::Image {
                old_image: None,
                new_image: Some(_),
            }
        ));
    }

    #[test]
    fn previews_large_historical_images_above_the_text_limit() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let png = png_fixture(OVERSIZED_TEXT_BYTES + 1);
        fs::write(repo.path.join("large.png"), &png).expect("large image fixture");
        repo.git(["add", "large.png"]);
        repo.git(["commit", "-m", "add large image"]);
        let oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let detail = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid: oid.clone(),
                file: repo.changed_file_at(&oid, "large.png"),
                operation_id: None,
            },
        )
        .expect("large image detail");

        assert_eq!(detail.payload.file_kind, DiffFileKind::Image);
        assert!(!detail.payload.metadata.contains_key("previewDeferred"));
        let DiffContent::Image {
            old_image: None,
            new_image: Some(asset),
        } = detail.diff
        else {
            panic!("expected historical image preview");
        };
        assert_eq!(asset.mime_type.as_deref(), Some("image/png"));
        assert_eq!(asset.size_bytes, Some(png.len() as u32));
        assert_eq!(
            deferred_large_file_kind("archive.zip"),
            DiffFileKind::Binary
        );
        assert_eq!(
            deferred_large_file_kind("notes.txt"),
            DiffFileKind::OversizedText
        );
    }

    #[test]
    fn commit_file_detail_rejects_paths_outside_the_repository() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let error = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repo.path),
                oid,
                file: CommitChangedFile {
                    path: "../outside.txt".to_owned(),
                    old_path: None,
                    old_mode: None,
                    new_mode: Some("100644".to_owned()),
                    change_kind: DiffChangeKind::Added,
                    additions: 1,
                    deletions: 0,
                },
                operation_id: None,
            },
        )
        .expect_err("path traversal must be rejected");

        assert_eq!(
            error.summary,
            "repository path must stay inside the repository"
        );
    }

    #[cfg(unix)]
    #[test]
    fn selected_commit_file_detail_does_not_rescan_the_full_commit() {
        let oid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let parent = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let (runner, temp, command_log) = commit_detail_counting_runner(oid, parent);
        let repository = temp.path().join("repo");
        fs::create_dir_all(&repository).expect("repository fixture");

        let detail = commit_file_detail(
            &runner,
            CommitFileDetailRequest {
                repository_path: display_path(&repository),
                oid: oid.to_owned(),
                file: CommitChangedFile {
                    path: "tracked.txt".to_owned(),
                    old_path: None,
                    old_mode: Some("100644".to_owned()),
                    new_mode: Some("100644".to_owned()),
                    change_kind: DiffChangeKind::Modified,
                    additions: 1,
                    deletions: 1,
                },
                operation_id: None,
            },
        )
        .expect("selected file detail");

        assert!(matches!(detail.diff, DiffContent::Text { .. }));
        let commands = fs::read_to_string(command_log).expect("command log");
        assert_eq!(commands.lines().count(), 6);
        assert!(!commands.contains(" diff "));
        assert!(!commands.contains("diff-tree"));
        assert!(!commands.contains("name-status"));
        assert!(!commands.contains("numstat"));
    }

    #[test]
    fn commit_file_list_parsers_stop_at_the_requested_bound() {
        let statuses = parse_commit_name_status(
            "M\0one.txt\0A\0two.txt\0D\0three.txt\0",
            2,
            "testCommitDetails",
        )
        .expect("statuses");
        let stats = parse_commit_numstat(
            "1\t2\tone.txt\x003\t0\ttwo.txt\x000\t4\tthree.txt\x00",
            2,
            "testCommitDetails",
        )
        .expect("numstat");
        let raw = parse_commit_raw_changes(
            ":100644 100755 aaaaaaa bbbbbbb M\0one.txt\0:000000 100644 0000000 ccccccc A\0two.txt\0",
            2,
            "testCommitDetails",
        )
        .expect("raw changes");

        assert_eq!(statuses.len(), 2);
        assert_eq!(stats.len(), 2);
        assert_eq!(raw[0].old_mode.as_deref(), Some("100644"));
        assert_eq!(raw[0].new_mode.as_deref(), Some("100755"));
        assert_eq!(raw[1].old_mode, None);
    }

    #[test]
    fn history_revisions_follow_branch_reachability() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["switch", "-c", "feature/lookdev"]);
        repo.write("feature.txt", "feature\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "feature branch work"]);
        repo.git(["switch", "main"]);
        repo.write("main.txt", "main\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "main branch work"]);

        let log = log_page_with_cancel(
            &runner,
            LogPageRequest {
                repository_path: display_path(&repo.path),
                after: None,
                limit: Some(200),
                operation_id: None,
                revisions: vec!["refs/heads/feature/lookdev".to_owned()],
            },
            &CancelToken::new(),
        )
        .expect("feature history");
        let subjects = log
            .commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>();
        assert!(subjects.contains(&"feature branch work"));
        assert!(subjects.contains(&"initial"));
        assert!(!subjects.contains(&"main branch work"));

        let search = search_log_with_cancel(
            &runner,
            LogSearchRequest {
                repository_path: display_path(&repo.path),
                grep: Some("branch work".to_owned()),
                author: None,
                pickaxe: None,
                after: None,
                limit: Some(200),
                operation_id: None,
                revisions: vec!["refs/heads/feature/lookdev".to_owned()],
            },
            &CancelToken::new(),
        )
        .expect("feature history search");
        assert_eq!(search.commits.len(), 1);
        assert_eq!(search.commits[0].subject, "feature branch work");
    }

    #[test]
    fn history_revisions_reject_revision_expressions() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();

        let error = log_page_with_cancel(
            &runner,
            LogPageRequest {
                repository_path: display_path(&repo.path),
                after: None,
                limit: Some(200),
                operation_id: None,
                revisions: vec!["refs/heads/main..refs/heads/other".to_owned()],
            },
            &CancelToken::new(),
        )
        .expect_err("revision expression must be rejected");

        assert_eq!(error.summary, "history revision is invalid");
    }

    #[test]
    fn history_revisions_reject_oversized_custom_selections() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let revisions = (0..=MAX_LOG_REVISIONS)
            .map(|index| format!("refs/heads/branch-{index}"))
            .collect();

        let error = log_page_with_cancel(
            &runner,
            LogPageRequest {
                repository_path: display_path(&repo.path),
                after: None,
                limit: Some(200),
                operation_id: None,
                revisions,
            },
            &CancelToken::new(),
        )
        .expect_err("large custom branch selections must be rejected");

        assert_eq!(error.summary, "too many history revisions were requested");
    }

    #[test]
    fn all_history_excludes_internal_safety_backup_refs() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["switch", "-c", "backup/hidden"]);
        repo.write("backup-only.txt", "internal backup commit\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "internal safety backup only"]);
        repo.git(["switch", "main"]);
        repo.git(["branch", "backup/current"]);

        let log = log_page_with_cancel(
            &runner,
            LogPageRequest {
                repository_path: display_path(&repo.path),
                after: None,
                limit: Some(200),
                operation_id: None,
                revisions: Vec::new(),
            },
            &CancelToken::new(),
        )
        .expect("all history");

        assert!(log.commits.iter().any(|commit| commit.subject == "initial"));
        assert!(!log
            .commits
            .iter()
            .any(|commit| commit.subject == "internal safety backup only"));
        assert!(!log.commits.iter().any(|commit| commit
            .refs
            .iter()
            .any(|reference| reference.contains("backup/"))));

        let search = search_log_with_cancel(
            &runner,
            LogSearchRequest {
                repository_path: display_path(&repo.path),
                grep: Some("internal safety backup only".to_owned()),
                author: None,
                pickaxe: None,
                after: None,
                limit: Some(200),
                operation_id: None,
                revisions: Vec::new(),
            },
            &CancelToken::new(),
        )
        .expect("all history search");
        assert!(search.commits.is_empty());
    }

    #[test]
    fn backend_history_requests_claim_an_early_cancel() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let backend = RepositoryBackend::new(runner, None);

        let log_operation_id = OperationId::new("cancel-log-page");
        let _log_reservation = backend
            .reserve_cancellable_operation(Some(&log_operation_id), "logPage")
            .expect("reserve log page")
            .expect("log operation id");
        assert!(
            backend
                .cancel_operation(CancelOperationRequest {
                    operation_id: log_operation_id.clone(),
                })
                .expect("cancel log page")
                .cancelled
        );
        let log_error = backend
            .log_page(LogPageRequest {
                repository_path: display_path(&repo.path),
                after: None,
                limit: Some(200),
                operation_id: Some(log_operation_id),
                revisions: Vec::new(),
            })
            .expect_err("cancelled log page");
        assert_eq!(log_error.summary, "operation cancelled");

        let search_operation_id = OperationId::new("cancel-search-log");
        let _search_reservation = backend
            .reserve_cancellable_operation(Some(&search_operation_id), "searchLog")
            .expect("reserve search log")
            .expect("search operation id");
        assert!(
            backend
                .cancel_operation(CancelOperationRequest {
                    operation_id: search_operation_id.clone(),
                })
                .expect("cancel search log")
                .cancelled
        );
        let search_error = backend
            .search_log(LogSearchRequest {
                repository_path: display_path(&repo.path),
                grep: Some("initial".to_owned()),
                author: None,
                pickaxe: None,
                after: None,
                limit: Some(200),
                operation_id: Some(search_operation_id),
                revisions: Vec::new(),
            })
            .expect_err("cancelled search log");
        assert_eq!(search_error.summary, "operation cancelled");
    }

    fn real_runner() -> (GitRunner, TestTempDir) {
        let dist = require_git_dist().expect("load embedded git distribution");
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-app-runner-home").expect("temp home");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("create runner home");
        let runner = GitRunner::from_distribution(distribution, home);
        (runner, temp)
    }

    fn png_fixture(size: usize) -> Vec<u8> {
        let mut png = vec![
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00,
            0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78,
            0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00, 0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        png.resize(size.max(png.len()), 0);
        png
    }

    fn set_index_lock_age(path: &Path, age: Duration) {
        let file = fs::File::options()
            .write(true)
            .open(path)
            .expect("open index.lock");
        let modified = SystemTime::now()
            .checked_sub(age)
            .expect("index.lock age stays within system time range");
        file.set_modified(modified).expect("set index.lock mtime");
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

    fn assert_same_path(actual: impl AsRef<Path>, expected: impl AsRef<Path>) {
        assert_eq!(
            fs::canonicalize(actual.as_ref()).expect("actual canonical path"),
            fs::canonicalize(expected.as_ref()).expect("expected canonical path")
        );
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
            self.git(["init", "-b", "main"]);
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

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.path.join(relative)).expect("read file")
        }

        fn changed_file_at(&self, oid: &str, path: &str) -> CommitChangedFile {
            commit_details(
                &self.runner,
                CommitDetailsRequest {
                    repository_path: display_path(&self.path),
                    oid: oid.to_owned(),
                    limit: Some(5_000),
                    operation_id: None,
                },
            )
            .expect("commit details for selected file")
            .files
            .into_iter()
            .find(|file| file.path == path)
            .expect("selected commit file")
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

    fn install_blocking_pre_commit_hook(repo: &Path, marker: &Path) {
        let hook = repo.join(".git").join("hooks").join("pre-commit");
        let script = format!(
            "#!/bin/sh\nprintf started > {marker}\nwhile :; do :; done\n",
            marker = shell_quote(marker),
        );
        fs::write(&hook, script).expect("write blocking pre-commit hook");
        make_executable(&hook);
    }

    fn wait_for_path(path: &Path) {
        for _ in 0..500 {
            if path.exists() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {}", path.display());
    }

    fn shell_quote(path: &Path) -> String {
        let value = path.to_string_lossy();
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn make_executable(path: &Path) {
        let _ = path;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).expect("hook metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("mark hook executable");
        }
    }
}
