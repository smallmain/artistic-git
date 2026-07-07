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

pub fn health() -> Result<HealthResponse, String> {
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

pub fn open_log_dir(log_dir: impl Into<PathBuf>) -> Result<OpenLogDirResponse, String> {
    let log_dir = log_dir.into();
    if log_dir.as_os_str().is_empty() {
        return Err("log directory path is empty".to_owned());
    }

    Ok(OpenLogDirResponse {
        path: display_path(&log_dir),
        opened: false,
    })
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
}
