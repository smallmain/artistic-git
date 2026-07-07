use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

use artistic_git_contracts::{AppError, AppResult};
use artistic_git_git_runner::OperationBusy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, Window};
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATE_STATUS_EVENT: &str = "update-status";
const INSTALL_OPERATION: &str = "installReadyUpdate";
const INSTALL_GATE_OPERATION: &str = "updateInstallGate";

#[derive(Default)]
pub struct UpdaterRuntimeState {
    checking: AtomicBool,
    next_request_id: AtomicU64,
    ready: Mutex<Option<ReadyUpdate>>,
}

#[derive(Clone)]
struct ReadyUpdate {
    update: Update,
    bytes: Arc<Vec<u8>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckRequest {
    #[serde(default)]
    pub source: UpdateCheckSource,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateCheckSource {
    #[default]
    Manual,
    Automatic,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusEvent {
    pub request_id: String,
    pub source: UpdateCheckSource,
    pub target_window_label: Option<String>,
    pub status: UpdateStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateStatus {
    Checking,
    Available {
        version: String,
        notes: Option<String>,
    },
    Downloading {
        version: String,
        notes: Option<String>,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        progress: Option<f64>,
    },
    Ready {
        version: String,
        notes: Option<String>,
    },
    NotAvailable,
    Failed {
        message: String,
        visible: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallGateResponse {
    pub blocked: bool,
    pub reason: Option<UpdateInstallBlockedReason>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateInstallBlockedReason {
    GitOperation,
    BackgroundOperation,
    NoReadyUpdate,
}

#[tauri::command]
pub async fn check_for_updates(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, UpdaterRuntimeState>,
    request: UpdateCheckRequest,
) -> AppResult<UpdateStatusEvent> {
    let request_id = state.next_request_id();
    let target_window_label = Some(window.label().to_owned());
    let source = request.source;

    let Some(_guard) = state.try_begin_check() else {
        let event = UpdateStatusEvent {
            request_id,
            source,
            target_window_label,
            status: UpdateStatus::Failed {
                message: "an update check is already in progress".to_owned(),
                visible: source == UpdateCheckSource::Manual,
            },
        };
        emit_manual_or_success_status(&app_handle, &event);
        return Ok(event);
    };

    emit_status(
        &app_handle,
        &UpdateStatusEvent {
            request_id: request_id.clone(),
            source,
            target_window_label: target_window_label.clone(),
            status: UpdateStatus::Checking,
        },
    );

    let updater = match app_handle.updater() {
        Ok(updater) => updater,
        Err(error) => {
            return Ok(failed_status(
                &app_handle,
                request_id,
                source,
                target_window_label,
                format!("failed to initialize updater: {error}"),
            ));
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            state.clear_ready_update()?;
            let event = UpdateStatusEvent {
                request_id,
                source,
                target_window_label,
                status: UpdateStatus::NotAvailable,
            };
            emit_status(&app_handle, &event);
            return Ok(event);
        }
        Err(error) => {
            return Ok(failed_status(
                &app_handle,
                request_id,
                source,
                target_window_label,
                format!("failed to check for updates: {error}"),
            ));
        }
    };

    let version = update.version.clone();
    let notes = update.body.clone();
    emit_status(
        &app_handle,
        &UpdateStatusEvent {
            request_id: request_id.clone(),
            source,
            target_window_label: target_window_label.clone(),
            status: UpdateStatus::Available {
                version: version.clone(),
                notes: notes.clone(),
            },
        },
    );

    let mut downloaded_bytes = 0_u64;
    let download_result = update
        .download(
            {
                let app_handle = app_handle.clone();
                let request_id = request_id.clone();
                let target_window_label = target_window_label.clone();
                let version = version.clone();
                let notes = notes.clone();
                move |chunk_bytes, total_bytes| {
                    downloaded_bytes = downloaded_bytes.saturating_add(chunk_bytes as u64);
                    let progress = total_bytes
                        .filter(|total| *total > 0)
                        .map(|total| (downloaded_bytes as f64 / total as f64).min(1.0));
                    emit_status(
                        &app_handle,
                        &UpdateStatusEvent {
                            request_id: request_id.clone(),
                            source,
                            target_window_label: target_window_label.clone(),
                            status: UpdateStatus::Downloading {
                                version: version.clone(),
                                notes: notes.clone(),
                                downloaded_bytes,
                                total_bytes,
                                progress,
                            },
                        },
                    );
                }
            },
            || {},
        )
        .await;

    let bytes = match download_result {
        Ok(bytes) => bytes,
        Err(error) => {
            return Ok(failed_status(
                &app_handle,
                request_id,
                source,
                target_window_label,
                format!("failed to download update: {error}"),
            ));
        }
    };

    state.store_ready_update(update, bytes)?;
    let event = UpdateStatusEvent {
        request_id,
        source,
        target_window_label,
        status: UpdateStatus::Ready { version, notes },
    };
    emit_status(&app_handle, &event);
    Ok(event)
}

#[tauri::command]
pub fn update_install_gate(
    state: State<'_, UpdaterRuntimeState>,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> AppResult<UpdateInstallGateResponse> {
    install_gate_response(&state, &backend)
}

#[tauri::command]
pub fn install_ready_update(
    state: State<'_, UpdaterRuntimeState>,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> AppResult<()> {
    let ready = state.ready_update()?;
    let Some(ready) = ready else {
        return Err(artistic_git_app::logged_app_error(AppError::expected(
            "no downloaded update is ready to install",
            INSTALL_OPERATION,
        )));
    };

    let _permit = backend
        .runner()
        .operation_concurrency()
        .try_begin_exclusive()
        .map_err(|busy| install_busy_error(busy, INSTALL_OPERATION))?;

    ready
        .update
        .install(ready.bytes.as_slice())
        .map_err(|error| {
            artistic_git_app::unexpected_command_error(
                format!("failed to install update: {error}"),
                INSTALL_OPERATION,
            )
        })
}

fn install_gate_response(
    state: &UpdaterRuntimeState,
    backend: &artistic_git_app::RepositoryBackend,
) -> AppResult<UpdateInstallGateResponse> {
    if !state.has_ready_update()? {
        return Ok(UpdateInstallGateResponse {
            blocked: true,
            reason: Some(UpdateInstallBlockedReason::NoReadyUpdate),
            message: Some("no downloaded update is ready to install".to_owned()),
        });
    }

    match backend.runner().operation_concurrency().busy_state() {
        Some(busy) => Ok(UpdateInstallGateResponse {
            blocked: true,
            reason: Some(install_block_reason(busy)),
            message: Some(install_busy_message(busy).to_owned()),
        }),
        None => Ok(UpdateInstallGateResponse {
            blocked: false,
            reason: None,
            message: None,
        }),
    }
}

fn failed_status(
    app_handle: &AppHandle,
    request_id: String,
    source: UpdateCheckSource,
    target_window_label: Option<String>,
    message: String,
) -> UpdateStatusEvent {
    let event = UpdateStatusEvent {
        request_id,
        source,
        target_window_label,
        status: UpdateStatus::Failed {
            message,
            visible: source == UpdateCheckSource::Manual,
        },
    };
    emit_manual_or_success_status(app_handle, &event);
    event
}

fn emit_manual_or_success_status(app_handle: &AppHandle, event: &UpdateStatusEvent) {
    if event.source == UpdateCheckSource::Manual
        || !matches!(event.status, UpdateStatus::Failed { .. })
    {
        emit_status(app_handle, event);
    }
}

fn emit_status(app_handle: &AppHandle, event: &UpdateStatusEvent) {
    let _ = app_handle.emit(UPDATE_STATUS_EVENT, event);
}

fn install_busy_error(busy: OperationBusy, operation_name: &str) -> AppError {
    artistic_git_app::logged_app_error(AppError::expected(
        install_busy_message(busy),
        operation_name,
    ))
}

fn install_busy_message(busy: OperationBusy) -> &'static str {
    match busy {
        OperationBusy::WriteBusy => {
            "restart update is blocked because a git operation is in progress"
        }
        OperationBusy::BackgroundBusy => {
            "restart update is blocked because a background git operation is in progress"
        }
    }
}

fn install_block_reason(busy: OperationBusy) -> UpdateInstallBlockedReason {
    match busy {
        OperationBusy::WriteBusy => UpdateInstallBlockedReason::GitOperation,
        OperationBusy::BackgroundBusy => UpdateInstallBlockedReason::BackgroundOperation,
    }
}

impl UpdaterRuntimeState {
    fn next_request_id(&self) -> String {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1;
        format!("update-check-{id}")
    }

    fn try_begin_check(&self) -> Option<CheckGuard<'_>> {
        self.checking
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| CheckGuard { state: self })
    }

    fn clear_ready_update(&self) -> AppResult<()> {
        *self.ready_lock()? = None;
        Ok(())
    }

    fn store_ready_update(&self, update: Update, bytes: Vec<u8>) -> AppResult<()> {
        *self.ready_lock()? = Some(ReadyUpdate {
            update,
            bytes: Arc::new(bytes),
        });
        Ok(())
    }

    fn ready_update(&self) -> AppResult<Option<ReadyUpdate>> {
        Ok(self.ready_lock()?.clone())
    }

    fn has_ready_update(&self) -> AppResult<bool> {
        Ok(self.ready_lock()?.is_some())
    }

    fn ready_lock(&self) -> AppResult<std::sync::MutexGuard<'_, Option<ReadyUpdate>>> {
        self.ready.lock().map_err(|_| {
            artistic_git_app::unexpected_command_error(
                "update runtime state is unavailable",
                INSTALL_GATE_OPERATION,
            )
        })
    }
}

struct CheckGuard<'a> {
    state: &'a UpdaterRuntimeState,
}

impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        self.state.checking.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use tauri_plugin_updater::RemoteRelease;

    #[test]
    fn latest_json_static_shape_parses_for_tauri_updater() {
        let summary = parse_latest_json_summary(
            r#"{
              "version": "0.2.0",
              "notes": "Release notes",
              "pub_date": "2026-07-07T00:00:00Z",
              "platforms": {
                "darwin-aarch64": {
                  "signature": "macsig",
                  "url": "https://github.com/smallmain/artistic-git/releases/download/v0.2.0/Artistic.Git.app.tar.gz"
                },
                "windows-x86_64": {
                  "signature": "winsig",
                  "url": "https://github.com/smallmain/artistic-git/releases/download/v0.2.0/Artistic.Git_0.2.0_x64-setup.exe.zip"
                }
              }
            }"#,
            "darwin-aarch64",
        )
        .expect("latest.json parses");

        assert_eq!(summary.version, "0.2.0");
        assert_eq!(summary.notes.as_deref(), Some("Release notes"));
        assert_eq!(summary.signature, "macsig");
        assert_eq!(
            summary.url,
            "https://github.com/smallmain/artistic-git/releases/download/v0.2.0/Artistic.Git.app.tar.gz"
        );
    }

    #[test]
    fn latest_json_reports_missing_platform_target() {
        let error = parse_latest_json_summary(
            r#"{
              "version": "0.2.0",
              "platforms": {
                "darwin-aarch64": {
                  "signature": "macsig",
                  "url": "https://example.test/update.tar.gz"
                }
              }
            }"#,
            "linux-x86_64",
        )
        .expect_err("missing target should fail");

        assert!(error.contains("linux-x86_64"));
    }

    #[derive(Debug, PartialEq, Eq)]
    struct LatestJsonSummary {
        version: String,
        notes: Option<String>,
        signature: String,
        url: String,
    }

    fn parse_latest_json_summary(
        latest_json: &str,
        target: &str,
    ) -> Result<LatestJsonSummary, String> {
        let release = serde_json::from_str::<RemoteRelease>(latest_json)
            .map_err(|error| error.to_string())?;
        let signature = release
            .signature(target)
            .map_err(|error| error.to_string())?
            .clone();
        let url = release
            .download_url(target)
            .map_err(|error| error.to_string())?
            .to_string();

        Ok(LatestJsonSummary {
            version: release.version.to_string(),
            notes: release.notes,
            signature,
            url,
        })
    }
}
