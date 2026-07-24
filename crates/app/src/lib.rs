use artistic_git_contracts::{
    AcceptRemoteHistoryRequest, AcceptRemoteHistoryResponse, AppError, AppErrorCategory, AppResult,
    CommitRequest, CommitResponse, DeleteSafetyBackupRequest, DeleteSafetyBackupResponse,
    OperationContext, OperationProgressEvent, SyncAllBranchesRequest, SyncAllBranchesResponse,
    SyncBranchRequest, SyncBranchResponse, SyncCurrentBranchRequest, SyncCurrentBranchResponse,
};
use artistic_git_core::AppInfo;
use artistic_git_git_runner::{
    BeginWriteError, GitRunner, OperationBusy, WriteOperationRequest, WritePermit,
};
use serde::Serialize;
use specta::Type;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub mod auth_ipc;
pub mod branches;
pub mod commit;
pub mod conflicts;
pub mod fetch;
#[cfg(test)]
mod full_chain_e2e;
pub(crate) mod git_ops;
pub mod https_auth;
#[cfg(test)]
mod phase12_failure_hardening;
pub mod remote;
pub mod repository;
pub mod restore;
pub mod revert;
pub mod review;
pub mod settings;
pub mod ssh_auth;
#[path = "stash.rs"]
mod stash_impl;
pub mod sync;
pub mod stash {
    use artistic_git_contracts::{
        AppResult, CreateAutoStashRequest, CreateStashRequest, CreateStashResponse,
        RestoreStashRequest, RestoreStashResponse,
    };
    use artistic_git_git_runner::GitRunner;

    pub use super::stash_impl::{
        cancel_stash_restore, delete_stash, list_stashes, stash_details, stash_file_detail,
    };

    pub fn create_stash(
        runner: &GitRunner,
        request: CreateStashRequest,
    ) -> AppResult<CreateStashResponse> {
        let _permit =
            super::begin_identity_write(runner, "createStash", &request.repository_path, true)?;
        super::stash_impl::create_stash(runner, request)
    }

    pub fn create_auto_stash(
        runner: &GitRunner,
        request: CreateAutoStashRequest,
    ) -> AppResult<CreateStashResponse> {
        let _permit =
            super::begin_identity_write(runner, "createAutoStash", &request.repository_path, true)?;
        super::stash_impl::create_auto_stash(runner, request)
    }

    pub fn restore_stash(
        runner: &GitRunner,
        request: RestoreStashRequest,
    ) -> AppResult<RestoreStashResponse> {
        let operation_name = request
            .operation_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("restoreStash");
        let requires_identity = super::restore_stash_requires_identity(
            runner,
            &request.repository_path,
            operation_name,
        )?;
        let _permit = super::begin_identity_write(
            runner,
            operation_name,
            &request.repository_path,
            requires_identity,
        )?;
        super::stash_impl::restore_stash(runner, request)
    }
}
pub use branches::{
    checkout_branch, create_branch, delete_branch, delete_safety_backup, list_safety_backups,
    validate_branch_name,
};
pub use fetch::{
    fetch_changed_queries, fetch_repository, plan_scheduled_fetch, FetchScheduleDecision,
    FetchStateStore,
};
pub use https_auth::{
    DeleteHttpsCredentialRequest, HttpsCredentialEntry, HttpsCredentialListResponse,
    HttpsCredentialPromptReason, HttpsCredentialPromptRequest, HttpsCredentialScope,
    SaveHttpsCredentialRequest,
};
pub use remote::{load_remote_settings, save_remote_settings};
pub use repository::{
    clone_repository, clone_repository_with_cancel, commit_details, commit_file_detail,
    list_branches, list_local_changes, list_stashes, local_change_detail, log_page_with_cancel,
    open_repository, probe_remote_repository, repository_summary, reset_bisect,
    search_log_with_cancel, CancellableOperationReservation, RepositoryBackend,
};
pub use restore::restore_changes;
pub use revert::abort_revert;
pub use review::{
    dismiss_review_mode_recovery, exit_review_mode, recover_review_mode_stash,
    review_mode_recovery, start_review_mode, sync_review_mode,
};
pub use settings::{
    apply_author_settings_to_runtime, apply_network_settings_to_runtime, clear_recent_projects,
    forget_recent_project, generate_ssh_key, identity_sources, list_recent_projects,
    load_app_settings, load_gitignore, load_project_settings, load_repository_author_settings,
    save_app_settings, save_gitignore, save_project_settings, save_repository_author_settings,
    settings_snapshot, ssh_key_status, validate_identity_for_write, ForgetRecentProjectRequest,
    GenerateSshKeyRequest, GitignoreFileResponse, GitignoreRequest, IdentitySourcesResponse,
    IdentityValidationRequest, IdentityValidationResponse, ProjectSettingsRequest,
    RecentProjectEntry, RecentProjectsRequest, RepositoryAuthorSettingsRequest,
    RepositoryAuthorSettingsResponse, RepositoryAuthorSource, SaveAppSettingsRequest,
    SaveGitignoreRequest, SaveProjectSettingsRequest, SaveRepositoryAuthorSettingsRequest,
    SettingsSnapshot, SshKeyStatus,
};
pub use ssh_auth::SshPassphrasePromptRequest;
pub use stash::{
    cancel_stash_restore, create_auto_stash, create_stash, delete_stash, restore_stash,
    stash_details, stash_file_detail,
};

pub fn sync_current_branch(
    runner: &GitRunner,
    request: SyncCurrentBranchRequest,
) -> AppResult<SyncCurrentBranchResponse> {
    sync_current_branch_with_progress(runner, request, |_| {})
}

pub fn sync_current_branch_with_progress<F>(
    runner: &GitRunner,
    request: SyncCurrentBranchRequest,
    progress: F,
) -> AppResult<SyncCurrentBranchResponse>
where
    F: Fn(OperationProgressEvent),
{
    let _permit =
        begin_identity_write(runner, "syncCurrentBranch", &request.repository_path, false)?;
    sync::sync_current_branch_with_progress(runner, request, progress)
}

pub fn sync_branch(
    runner: &GitRunner,
    request: SyncBranchRequest,
) -> AppResult<SyncBranchResponse> {
    sync_branch_with_progress(runner, request, |_| {})
}

pub fn sync_branch_with_progress<F>(
    runner: &GitRunner,
    request: SyncBranchRequest,
    progress: F,
) -> AppResult<SyncBranchResponse>
where
    F: Fn(OperationProgressEvent),
{
    let _permit = begin_identity_write(runner, "syncBranch", &request.repository_path, false)?;
    sync::sync_branch_with_progress(runner, request, progress)
}

pub fn sync_all_branches_with_config<F>(
    runner: &GitRunner,
    config: Option<&artistic_git_core::config::ConfigActor>,
    request: SyncAllBranchesRequest,
    progress: F,
) -> AppResult<SyncAllBranchesResponse>
where
    F: Fn(OperationProgressEvent),
{
    let _permit = begin_identity_write(runner, "syncAllBranches", &request.repository_path, false)?;
    sync::sync_all_branches_with_progress(runner, config, request, progress)
}

pub fn accept_remote_history(
    runner: &GitRunner,
    request: AcceptRemoteHistoryRequest,
) -> AppResult<AcceptRemoteHistoryResponse> {
    let _permit = begin_identity_write(
        runner,
        "acceptRemoteHistory",
        &request.repository_path,
        false,
    )?;
    sync::accept_remote_history(runner, request)
}

pub fn delete_safety_backup_with_lock(
    runner: &GitRunner,
    request: DeleteSafetyBackupRequest,
) -> AppResult<DeleteSafetyBackupResponse> {
    let _permit = begin_identity_write(
        runner,
        "deleteSafetyBackup",
        &request.repository_path,
        false,
    )?;
    branches::delete_safety_backup(runner, request)
}

pub fn start_review_mode_with_config(
    runner: &GitRunner,
    config: Option<&artistic_git_core::config::ConfigActor>,
    request: artistic_git_contracts::StartReviewModeRequest,
) -> AppResult<artistic_git_contracts::StartReviewModeResponse> {
    let _permit = begin_identity_write(runner, "startReviewMode", &request.repository_path, true)?;
    review::start_review_mode(runner, config, request)
}

pub fn sync_review_mode_with_lock(
    runner: &GitRunner,
    request: artistic_git_contracts::ReviewModeRequest,
) -> AppResult<artistic_git_contracts::SyncReviewModeResponse> {
    let _permit = begin_identity_write(runner, "syncReviewMode", &request.repository_path, false)?;
    review::sync_review_mode(runner, request)
}

pub fn exit_review_mode_with_config(
    runner: &GitRunner,
    config: Option<&artistic_git_core::config::ConfigActor>,
    request: artistic_git_contracts::ReviewModeRequest,
) -> AppResult<artistic_git_contracts::ExitReviewModeResponse> {
    let _permit = begin_identity_write(runner, "exitReviewMode", &request.repository_path, false)?;
    review::exit_review_mode(runner, config, request)
}

pub fn recover_review_mode_stash_with_config(
    runner: &GitRunner,
    config: Option<&artistic_git_core::config::ConfigActor>,
    request: artistic_git_contracts::ReviewModeRecoveryRequest,
) -> AppResult<artistic_git_contracts::ExitReviewModeResponse> {
    let _permit = begin_identity_write(
        runner,
        "recoverReviewModeStash",
        &request.repository_path,
        false,
    )?;
    review::recover_review_mode_stash(runner, config, request)
}

pub fn commit_changes(runner: &GitRunner, request: CommitRequest) -> AppResult<CommitResponse> {
    let _permit = begin_identity_write(runner, "commitChanges", &request.repository_path, true)?;
    commit::commit_changes(runner, request)
}

pub fn revert_commit(
    runner: &GitRunner,
    request: artistic_git_contracts::RevertCommitRequest,
) -> AppResult<artistic_git_contracts::RevertCommitResponse> {
    let _permit = begin_identity_write(runner, "revertCommit", &request.repository_path, true)?;
    revert::revert_commit(runner, request)
}

fn begin_identity_write<'a>(
    runner: &'a GitRunner,
    operation_name: &str,
    repository_path: impl Into<PathBuf>,
    requires_identity: bool,
) -> AppResult<WritePermit<'a>> {
    let mut request =
        WriteOperationRequest::new(operation_name).with_repository_path(repository_path);
    if requires_identity {
        request = request.requiring_identity();
    }
    let identity_validator = settings::LazyIdentityValidator::new(runner);
    runner
        .operation_concurrency()
        .try_begin_write_with_identity(&request, &identity_validator)
        .map_err(|error| begin_write_error(error, &request))
}

fn restore_stash_requires_identity(
    runner: &GitRunner,
    repository_path: &str,
    operation_name: &str,
) -> AppResult<bool> {
    let root = git_ops::canonical_repository_path(repository_path, operation_name)?;
    git_ops::git_stdout(
        runner,
        Some(&root),
        ["status", "--porcelain=v1"],
        operation_name,
    )
    .map(|output| !output.trim().is_empty())
}

fn begin_write_error(error: BeginWriteError, request: &WriteOperationRequest) -> AppError {
    match error {
        BeginWriteError::Busy(busy) => logged_app_error(
            AppError::expected(write_busy_summary(busy), &request.operation_name)
                .with_context(write_request_context(request)),
        ),
        BeginWriteError::Identity(error) => error,
    }
}

fn write_busy_summary(busy: OperationBusy) -> &'static str {
    match busy {
        OperationBusy::WriteBusy => "another write operation is already in progress",
        OperationBusy::BackgroundBusy => "a background operation is already in progress",
    }
}

fn write_request_context(request: &WriteOperationRequest) -> OperationContext {
    let mut context = OperationContext::new(&request.operation_name);
    if let Some(repository_path) = &request.repository_path {
        context = context.with_repository_path(repository_path.to_string_lossy().into_owned());
    }
    context
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub app: AppInfo,
    pub status: &'static str,
}

pub fn health() -> AppResult<HealthResponse> {
    Ok(HealthResponse {
        app: AppInfo::current(),
        status: "ok",
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenLogDirResponse {
    pub path: String,
    pub opened: bool,
}

pub fn open_log_dir(log_dir: impl Into<PathBuf>) -> AppResult<OpenLogDirResponse> {
    let log_dir = log_dir.into();
    if log_dir.as_os_str().is_empty() {
        return Err(logged_app_error(AppError::expected(
            "log directory path is empty",
            "openLogDir",
        )));
    }
    fs::create_dir_all(&log_dir).map_err(|source| {
        logged_app_error(AppError::unexpected(
            format!("failed to create application log directory: {source}"),
            "openLogDir",
        ))
    })?;

    Ok(OpenLogDirResponse {
        path: display_path(&log_dir),
        opened: false,
    })
}

pub fn unexpected_command_error(
    summary: impl Into<String>,
    operation_name: impl Into<String>,
) -> AppError {
    logged_app_error(AppError::unexpected(summary, operation_name))
}

pub fn logged_app_error(error: AppError) -> AppError {
    log_app_error(&error);
    error
}

pub fn log_app_error(error: &AppError) {
    let context = &error.context;
    if let Some(git) = &error.git {
        match error.category {
            AppErrorCategory::Expected => tracing::warn!(
                category = ?error.category,
                operation = %context.operation_name,
                operation_id = ?context.operation_id,
                window_label = ?context.window_label,
                repository_path = ?context.repository_path,
                summary = %error.summary,
                git_command = ?git.command,
                git_exit_code = ?git.exit_code,
                git_stdout = %git.stdout,
                git_stderr = %git.stderr,
                "command returned expected error"
            ),
            AppErrorCategory::Unexpected | AppErrorCategory::Fatal => tracing::error!(
                category = ?error.category,
                operation = %context.operation_name,
                operation_id = ?context.operation_id,
                window_label = ?context.window_label,
                repository_path = ?context.repository_path,
                summary = %error.summary,
                git_command = ?git.command,
                git_exit_code = ?git.exit_code,
                git_stdout = %git.stdout,
                git_stderr = %git.stderr,
                "command failed"
            ),
        }
    } else {
        match error.category {
            AppErrorCategory::Expected => tracing::warn!(
                category = ?error.category,
                operation = %context.operation_name,
                operation_id = ?context.operation_id,
                window_label = ?context.window_label,
                repository_path = ?context.repository_path,
                summary = %error.summary,
                "command returned expected error"
            ),
            AppErrorCategory::Unexpected | AppErrorCategory::Fatal => tracing::error!(
                category = ?error.category,
                operation = %context.operation_name,
                operation_id = ?context.operation_id,
                window_label = ?context.window_label,
                repository_path = ?context.repository_path,
                summary = %error.summary,
                "command failed"
            ),
        }
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_reports_ok() {
        let response = health().expect("health command should succeed");

        assert_eq!(response.status, "ok");
        assert_eq!(response.app.product_name, "Artistic Git");
    }

    #[test]
    fn open_log_dir_creates_the_directory_before_opening() {
        let path =
            std::env::temp_dir().join(format!("artistic-git-open-logs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        let response = open_log_dir(&path).expect("prepare log dir");

        assert_eq!(response.path, display_path(&path));
        assert!(!response.opened);
        assert!(path.is_dir());
        fs::remove_dir_all(path).expect("remove test log dir");
    }

    #[test]
    fn open_log_dir_returns_app_error_for_empty_path() {
        let error = open_log_dir("").expect_err("empty path should fail");

        assert_eq!(error.category, AppErrorCategory::Expected);
        assert_eq!(error.context.operation_name, "openLogDir");
    }
}
