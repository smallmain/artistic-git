use artistic_git_contracts::{AppError, AppErrorCategory, AppResult};
use artistic_git_core::AppInfo;
use serde::Serialize;
use specta::Type;
use std::path::{Path, PathBuf};

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
