use artistic_git_contracts::{
    AppError, AppErrorCategory, AppResult, CommitRequest, CommitResponse, OperationContext,
};
use artistic_git_core::AppInfo;
use artistic_git_git_runner::{
    BeginWriteError, GitRunner, OperationBusy, WriteOperationRequest, WritePermit,
};
use serde::Serialize;
use specta::Type;
use std::path::{Path, PathBuf};

pub mod auth_ipc;
pub mod branches;
pub mod commit;
pub mod conflicts;
pub mod fetch;
pub(crate) mod git_ops;
pub mod remote;
pub mod repository;
pub mod restore;
pub mod revert;
pub mod settings;
#[path = "stash.rs"]
mod stash_impl;
pub mod stash {
    use artistic_git_contracts::{
        AppResult, CreateAutoStashRequest, CreateStashRequest, CreateStashResponse,
        RestoreStashRequest, RestoreStashResponse,
    };
    use artistic_git_git_runner::GitRunner;

    pub use super::stash_impl::{cancel_stash_restore, delete_stash, list_stashes, stash_details};

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
pub use branches::{checkout_branch, create_branch, delete_branch, validate_branch_name};
pub use fetch::{
    fetch_changed_queries, fetch_repository, plan_scheduled_fetch, FetchScheduleDecision,
    FetchStateStore,
};
pub use remote::{load_remote_settings, save_remote_settings};
pub use repository::{
    list_branches, list_local_changes, list_stashes, log_page_with_cancel, open_repository,
    repository_summary, search_log_with_cancel, RepositoryBackend,
};
pub use restore::restore_changes;
pub use revert::{abort_revert, revert_commit};
pub use settings::{
    generate_ssh_key, identity_sources, load_app_settings, load_gitignore, load_project_settings,
    save_app_settings, save_gitignore, save_project_settings, settings_snapshot, ssh_key_status,
    validate_identity_for_write, GenerateSshKeyRequest, GitignoreFileResponse, GitignoreRequest,
    IdentitySourcesResponse, IdentityValidationRequest, IdentityValidationResponse,
    ProjectSettingsRequest, SaveAppSettingsRequest, SaveGitignoreRequest,
    SaveProjectSettingsRequest, SettingsSnapshot, SshKeyStatus,
};
pub use stash::{
    cancel_stash_restore, create_auto_stash, create_stash, delete_stash, restore_stash,
    stash_details,
};

pub fn commit_changes(runner: &GitRunner, request: CommitRequest) -> AppResult<CommitResponse> {
    let _permit = begin_identity_write(runner, "commitChanges", &request.repository_path, true)?;
    commit::commit_changes(runner, request)
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
    fn open_log_dir_reports_placeholder_without_side_effects() {
        let response = open_log_dir("/tmp/artistic-git-logs").expect("open log dir placeholder");

        assert_eq!(response.path, "/tmp/artistic-git-logs");
        assert!(!response.opened);
    }

    #[test]
    fn open_log_dir_returns_app_error_for_empty_path() {
        let error = open_log_dir("").expect_err("empty path should fail");

        assert_eq!(error.category, AppErrorCategory::Expected);
        assert_eq!(error.context.operation_name, "openLogDir");
    }
}
