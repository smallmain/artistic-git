use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use artistic_git_contracts::{AppError, AppResult};
use artistic_git_git_runner::OperationBusy;
use serde::{Deserialize, Serialize};
use tauri::{
    utils::{config::BundleType, platform::bundle_type},
    AppHandle, Emitter, Manager, State, Window,
};
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATE_STATUS_EVENT: &str = "update-status";
const UPDATE_CHECK_OPERATION: &str = "checkForUpdates";
const INSTALL_OPERATION: &str = "installReadyUpdate";
const INSTALL_GATE_OPERATION: &str = "updateInstallGate";
const PROMPT_ROUTE_OPERATION: &str = "updatePromptRoute";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const UPDATE_READ_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct UpdaterRuntimeState {
    next_request_id: AtomicU64,
    active_check: Mutex<Option<ActiveCheck>>,
    ready: Mutex<Option<ReadyUpdate>>,
    ready_prompt: Mutex<Option<UpdateStatusEvent>>,
}

#[derive(Clone)]
struct ReadyUpdate {
    update: Update,
    bytes: Arc<Vec<u8>>,
}

struct ActiveCheck {
    status: UpdateStatusEvent,
    manual_observers: Vec<ManualCheckObserver>,
}

#[derive(Clone)]
struct ManualCheckObserver {
    request_id: String,
    target_window_label: Option<String>,
}

enum BeginCheckOutcome<'a> {
    Started(CheckGuard<'a>),
    Observed(ManualCheckObservation<'a>),
    Busy,
}

struct ManualCheckObservation<'a> {
    _active_check: std::sync::MutexGuard<'a, Option<ActiveCheck>>,
    event: UpdateStatusEvent,
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
    ReleaseAvailable {
        version: String,
        notes: Option<String>,
        reason: UpdateReleasePageReason,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateReleasePageReason {
    LinuxPackageManager,
    UnknownInstallFormat,
    UnsupportedInstallFormat,
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
    CloseGuard,
    NoReadyUpdate,
    UnsupportedInstallFormat,
}

#[tauri::command]
pub async fn check_for_updates(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, UpdaterRuntimeState>,
    request: UpdateCheckRequest,
) -> AppResult<UpdateStatusEvent> {
    let request_id = state.next_request_id();
    let request_window_label = window.label().to_owned();
    let source = request.source;
    let target_window_label = update_status_target_window_label(
        source,
        &request_window_label,
        focused_update_window_label(&app_handle),
    );
    let checking_event = UpdateStatusEvent {
        request_id: request_id.clone(),
        source,
        target_window_label: target_window_label.clone(),
        status: UpdateStatus::Checking,
    };

    let _guard = match state.begin_check(checking_event.clone())? {
        BeginCheckOutcome::Started(guard) => guard,
        BeginCheckOutcome::Observed(observation) => {
            let event = observation.event.clone();
            // Keep the active-check mutex locked until the snapshot is emitted so
            // later progress cannot overtake it and regress the visible status.
            emit_status(&app_handle, &event);
            drop(observation);
            return Ok(event);
        }
        BeginCheckOutcome::Busy => {
            let event = UpdateStatusEvent {
                request_id,
                source,
                target_window_label,
                status: UpdateStatus::Failed {
                    message: "an update check is already in progress".to_owned(),
                    visible: source == UpdateCheckSource::Manual,
                },
            };
            emit_busy_status(&app_handle, &event);
            return Ok(event);
        }
    };

    emit_check_status(&app_handle, &state, &checking_event)?;

    // Local `tauri dev` builds keep a placeholder updater public key and are
    // not installable packages. Skip network checks so development never hits
    // signature/decoding failures from the placeholder key.
    if updates_disabled_in_current_build() {
        return failed_check_status(
            &app_handle,
            &state,
            request_id,
            source,
            target_window_label,
            development_update_disabled_message().to_owned(),
        );
    }

    let updater = match app_handle
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .configure_client(|client| {
            client
                .connect_timeout(UPDATE_CONNECT_TIMEOUT)
                .read_timeout(UPDATE_READ_TIMEOUT)
        })
        .build()
    {
        Ok(updater) => updater,
        Err(error) => {
            return failed_check_status(
                &app_handle,
                &state,
                request_id,
                source,
                target_window_label,
                format!("failed to initialize updater: {error}"),
            );
        }
    };

    let mut update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            state.clear_ready_update()?;
            let event = UpdateStatusEvent {
                request_id,
                source,
                target_window_label,
                status: UpdateStatus::NotAvailable,
            };
            emit_check_status(&app_handle, &state, &event)?;
            return Ok(event);
        }
        Err(error) => {
            return failed_check_status(
                &app_handle,
                &state,
                request_id,
                source,
                target_window_label,
                format!("failed to check for updates: {error}"),
            );
        }
    };
    update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);

    let version = update.version.clone();
    let notes = update.body.clone();

    if let UpdateCapability::ReleasePage { reason } = current_update_capability(&app_handle) {
        state.clear_ready_update()?;
        let event = release_available_status(
            request_id,
            source,
            target_window_label,
            version,
            notes,
            reason,
        );
        emit_check_status(&app_handle, &state, &event)?;
        return Ok(event);
    }

    emit_check_status(
        &app_handle,
        &state,
        &UpdateStatusEvent {
            request_id: request_id.clone(),
            source,
            target_window_label: target_window_label.clone(),
            status: UpdateStatus::Available {
                version: version.clone(),
                notes: notes.clone(),
            },
        },
    )?;

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
                    let event = UpdateStatusEvent {
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
                    };
                    if let Some(runtime_state) = app_handle.try_state::<UpdaterRuntimeState>() {
                        if emit_check_status(&app_handle, &runtime_state, &event).is_err() {
                            emit_status(&app_handle, &event);
                        }
                    } else {
                        emit_status(&app_handle, &event);
                    }
                }
            },
            || {},
        )
        .await;

    let bytes = match download_result {
        Ok(bytes) => bytes,
        Err(error) => {
            return failed_check_status(
                &app_handle,
                &state,
                request_id,
                source,
                target_window_label,
                format!("failed to download update: {error}"),
            );
        }
    };

    let target_window_label = update_status_target_window_label(
        source,
        &request_window_label,
        focused_update_window_label(&app_handle),
    );
    let event = UpdateStatusEvent {
        request_id,
        source,
        target_window_label,
        status: UpdateStatus::Ready { version, notes },
    };
    let observed_events = state.record_check_status(event.clone())?;
    let prompt_event = canonical_prompt_event(&event, &observed_events);
    state.store_ready_update(update, bytes, prompt_event)?;
    emit_recorded_check_status(&app_handle, &event, observed_events);
    Ok(event)
}

#[tauri::command]
pub fn update_install_gate(
    app_handle: AppHandle,
    state: State<'_, UpdaterRuntimeState>,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> AppResult<UpdateInstallGateResponse> {
    install_gate_response(&app_handle, &state, &backend)
}

#[tauri::command]
pub fn install_ready_update(
    app_handle: AppHandle,
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

    if let UpdateCapability::ReleasePage { reason } = current_update_capability(&app_handle) {
        return Err(artistic_git_app::logged_app_error(AppError::expected(
            release_page_only_message(reason),
            INSTALL_OPERATION,
        )));
    }

    let _permit = backend
        .runner()
        .operation_concurrency()
        .try_begin_exclusive()
        .map_err(|busy| install_busy_error(busy, INSTALL_OPERATION))?;

    if let Some(blocker) = close_guard_install_gate_response(&app_handle) {
        return Err(install_gate_error(blocker, INSTALL_OPERATION));
    }

    close_all_windows_for_update_install(&app_handle)?;
    if let Some(blocker) = close_guard_install_gate_response(&app_handle) {
        let _ = set_update_install_closing_windows(&app_handle, false);
        return Err(install_gate_error(blocker, INSTALL_OPERATION));
    }

    let install_result = ready
        .update
        .install(ready.bytes.as_slice())
        .map_err(|error| {
            artistic_git_app::unexpected_command_error(
                format!("failed to install update: {error}"),
                INSTALL_OPERATION,
            )
        });
    if let Err(error) = install_result {
        let _ = set_update_install_closing_windows(&app_handle, false);
        return Err(error);
    }

    app_handle.restart();
}

pub(crate) fn retarget_ready_update_prompt(
    app_handle: &AppHandle,
    closed_window_label: &str,
    next_window_label: Option<String>,
) {
    let Some(state) = app_handle.try_state::<UpdaterRuntimeState>() else {
        return;
    };
    let Ok(Some(event)) =
        state.retarget_ready_prompt_after_closed(closed_window_label, next_window_label)
    else {
        return;
    };

    emit_status(app_handle, &event);
}

pub(crate) fn route_unassigned_ready_update_prompt(
    app_handle: &AppHandle,
    target_window_label: &str,
) {
    let Some(state) = app_handle.try_state::<UpdaterRuntimeState>() else {
        return;
    };
    let Ok(Some(event)) = state.route_unassigned_ready_prompt(target_window_label.to_owned())
    else {
        return;
    };

    emit_status(app_handle, &event);
}

fn install_gate_response(
    app_handle: &AppHandle,
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

    if let UpdateCapability::ReleasePage { reason } = current_update_capability(app_handle) {
        return Ok(UpdateInstallGateResponse {
            blocked: true,
            reason: Some(UpdateInstallBlockedReason::UnsupportedInstallFormat),
            message: Some(release_page_only_message(reason).to_owned()),
        });
    }

    match backend.runner().operation_concurrency().busy_state() {
        Some(busy) => Ok(UpdateInstallGateResponse {
            blocked: true,
            reason: Some(install_block_reason(busy)),
            message: Some(install_busy_message(busy).to_owned()),
        }),
        None => Ok(close_guard_install_gate_response(app_handle).unwrap_or_else(allowed_gate)),
    }
}

fn release_available_status(
    request_id: String,
    source: UpdateCheckSource,
    target_window_label: Option<String>,
    version: String,
    notes: Option<String>,
    reason: UpdateReleasePageReason,
) -> UpdateStatusEvent {
    UpdateStatusEvent {
        request_id,
        source,
        target_window_label,
        status: UpdateStatus::ReleaseAvailable {
            version,
            notes,
            reason,
        },
    }
}

fn failed_check_status(
    app_handle: &AppHandle,
    state: &UpdaterRuntimeState,
    request_id: String,
    source: UpdateCheckSource,
    target_window_label: Option<String>,
    message: String,
) -> AppResult<UpdateStatusEvent> {
    let event = UpdateStatusEvent {
        request_id,
        source,
        target_window_label,
        status: UpdateStatus::Failed {
            message,
            visible: source == UpdateCheckSource::Manual,
        },
    };
    emit_check_status(app_handle, state, &event)?;
    Ok(event)
}

fn emit_check_status(
    app_handle: &AppHandle,
    state: &UpdaterRuntimeState,
    event: &UpdateStatusEvent,
) -> AppResult<()> {
    let observed_events = state.record_check_status(event.clone())?;
    emit_recorded_check_status(app_handle, event, observed_events);
    Ok(())
}

fn emit_recorded_check_status(
    app_handle: &AppHandle,
    event: &UpdateStatusEvent,
    observed_events: Vec<UpdateStatusEvent>,
) {
    if should_emit_primary_check_status(event, !observed_events.is_empty()) {
        emit_status(app_handle, event);
    }
    for observed_event in observed_events {
        emit_status(app_handle, &observed_event);
    }
}

fn should_emit_primary_check_status(event: &UpdateStatusEvent, has_observers: bool) -> bool {
    !(has_observers
        && event.source == UpdateCheckSource::Automatic
        && matches!(
            event.status,
            UpdateStatus::Ready { .. } | UpdateStatus::ReleaseAvailable { .. }
        ))
}

fn canonical_prompt_event(
    event: &UpdateStatusEvent,
    observed_events: &[UpdateStatusEvent],
) -> UpdateStatusEvent {
    observed_events
        .last()
        .cloned()
        .unwrap_or_else(|| event.clone())
}

fn observed_manual_status(
    event: &UpdateStatusEvent,
    observer: &ManualCheckObserver,
) -> UpdateStatusEvent {
    let mut status = event.status.clone();
    if let UpdateStatus::Failed { visible, .. } = &mut status {
        *visible = true;
    }

    UpdateStatusEvent {
        request_id: observer.request_id.clone(),
        source: UpdateCheckSource::Manual,
        target_window_label: observer.target_window_label.clone(),
        status,
    }
}

fn emit_busy_status(app_handle: &AppHandle, event: &UpdateStatusEvent) {
    if should_emit_busy_status(event) {
        emit_status(app_handle, event);
    }
}

fn should_emit_busy_status(event: &UpdateStatusEvent) -> bool {
    event.source == UpdateCheckSource::Manual
}

fn emit_status(app_handle: &AppHandle, event: &UpdateStatusEvent) {
    let _ = app_handle.emit(UPDATE_STATUS_EVENT, event);
}

fn focused_update_window_label(app_handle: &AppHandle) -> Option<String> {
    app_handle
        .try_state::<crate::WindowRegistry>()
        .and_then(|registry| crate::registry_recent_focused_label(&registry))
        .filter(|label| app_handle.get_webview_window(label).is_some())
        .or_else(|| {
            crate::focused_webview_window(app_handle).map(|window| window.label().to_owned())
        })
}

fn update_status_target_window_label(
    source: UpdateCheckSource,
    request_window_label: &str,
    focused_window_label: Option<String>,
) -> Option<String> {
    match source {
        UpdateCheckSource::Manual => Some(request_window_label.to_owned()),
        UpdateCheckSource::Automatic => {
            focused_window_label.or_else(|| Some(request_window_label.to_owned()))
        }
    }
}

fn updates_disabled_in_current_build() -> bool {
    cfg!(debug_assertions)
}

fn development_update_disabled_message() -> &'static str {
    "updates are disabled in development builds"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdateCapability {
    InApp,
    ReleasePage { reason: UpdateReleasePageReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeOperatingSystem {
    Linux,
    Macos,
    Windows,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdateInstallFormat {
    AppImage,
    Deb,
    Rpm,
    MacApp,
    MacDmg,
    WindowsMsi,
    WindowsNsis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UpdateInstallSignals {
    operating_system: RuntimeOperatingSystem,
    install_format: Option<UpdateInstallFormat>,
    appimage_env_present: bool,
}

fn current_update_capability(app_handle: &AppHandle) -> UpdateCapability {
    update_capability_for_signals(UpdateInstallSignals {
        operating_system: current_operating_system(),
        install_format: current_install_format(),
        appimage_env_present: appimage_env_present(app_handle),
    })
}

fn update_capability_for_signals(signals: UpdateInstallSignals) -> UpdateCapability {
    match signals.operating_system {
        RuntimeOperatingSystem::Linux => match signals.install_format {
            Some(UpdateInstallFormat::AppImage) => UpdateCapability::InApp,
            Some(UpdateInstallFormat::Deb | UpdateInstallFormat::Rpm) => {
                UpdateCapability::ReleasePage {
                    reason: UpdateReleasePageReason::LinuxPackageManager,
                }
            }
            None if signals.appimage_env_present => UpdateCapability::InApp,
            None => UpdateCapability::ReleasePage {
                reason: UpdateReleasePageReason::UnknownInstallFormat,
            },
            Some(_) => UpdateCapability::ReleasePage {
                reason: UpdateReleasePageReason::UnsupportedInstallFormat,
            },
        },
        RuntimeOperatingSystem::Macos => match signals.install_format {
            Some(UpdateInstallFormat::MacApp) => UpdateCapability::InApp,
            None => UpdateCapability::ReleasePage {
                reason: UpdateReleasePageReason::UnknownInstallFormat,
            },
            Some(_) => UpdateCapability::ReleasePage {
                reason: UpdateReleasePageReason::UnsupportedInstallFormat,
            },
        },
        RuntimeOperatingSystem::Windows => match signals.install_format {
            Some(UpdateInstallFormat::WindowsMsi | UpdateInstallFormat::WindowsNsis) => {
                UpdateCapability::InApp
            }
            None => UpdateCapability::ReleasePage {
                reason: UpdateReleasePageReason::UnknownInstallFormat,
            },
            Some(_) => UpdateCapability::ReleasePage {
                reason: UpdateReleasePageReason::UnsupportedInstallFormat,
            },
        },
        RuntimeOperatingSystem::Other => UpdateCapability::ReleasePage {
            reason: UpdateReleasePageReason::UnsupportedInstallFormat,
        },
    }
}

fn current_install_format() -> Option<UpdateInstallFormat> {
    bundle_type().map(|bundle| match bundle {
        BundleType::App => UpdateInstallFormat::MacApp,
        BundleType::AppImage => UpdateInstallFormat::AppImage,
        BundleType::Deb => UpdateInstallFormat::Deb,
        BundleType::Dmg => UpdateInstallFormat::MacDmg,
        BundleType::Msi => UpdateInstallFormat::WindowsMsi,
        BundleType::Nsis => UpdateInstallFormat::WindowsNsis,
        BundleType::Rpm => UpdateInstallFormat::Rpm,
    })
}

fn current_operating_system() -> RuntimeOperatingSystem {
    if cfg!(target_os = "linux") {
        RuntimeOperatingSystem::Linux
    } else if cfg!(target_os = "macos") {
        RuntimeOperatingSystem::Macos
    } else if cfg!(target_os = "windows") {
        RuntimeOperatingSystem::Windows
    } else {
        RuntimeOperatingSystem::Other
    }
}

fn appimage_env_present(_app_handle: &AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        _app_handle.env().appimage.is_some() || std::env::var_os("APPIMAGE").is_some()
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn release_page_only_message(reason: UpdateReleasePageReason) -> &'static str {
    match reason {
        UpdateReleasePageReason::LinuxPackageManager => {
            "this installation is managed by the operating system package manager; download the latest release from GitHub Releases"
        }
        UpdateReleasePageReason::UnknownInstallFormat => {
            "this installation format cannot be confirmed for safe in-app updates; download the latest release from GitHub Releases"
        }
        UpdateReleasePageReason::UnsupportedInstallFormat => {
            "this installation format does not support safe in-app updates; download the latest release from GitHub Releases"
        }
    }
}

fn allowed_gate() -> UpdateInstallGateResponse {
    UpdateInstallGateResponse {
        blocked: false,
        reason: None,
        message: None,
    }
}

fn close_guard_install_gate_response(app_handle: &AppHandle) -> Option<UpdateInstallGateResponse> {
    let blocked = app_handle
        .try_state::<crate::WindowRegistry>()
        .map(|registry| crate::registry_has_close_guards(&registry))
        .unwrap_or(false);

    close_guard_install_gate_response_for_blocked(blocked)
}

fn close_guard_install_gate_response_for_blocked(
    blocked: bool,
) -> Option<UpdateInstallGateResponse> {
    blocked.then(|| UpdateInstallGateResponse {
        blocked: true,
        reason: Some(UpdateInstallBlockedReason::CloseGuard),
        message: Some(close_guard_install_message().to_owned()),
    })
}

fn close_guard_install_message() -> &'static str {
    "restart update is blocked because a window has an operation or recovery prompt that must finish before closing"
}

fn install_gate_error(blocker: UpdateInstallGateResponse, operation_name: &str) -> AppError {
    artistic_git_app::logged_app_error(AppError::expected(
        blocker
            .message
            .as_deref()
            .unwrap_or("restart update is blocked"),
        operation_name,
    ))
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

fn close_all_windows_for_update_install(app_handle: &AppHandle) -> AppResult<()> {
    set_update_install_closing_windows(app_handle, true)?;

    let windows = app_handle.webview_windows();
    let labels = windows.keys().cloned().collect::<Vec<_>>();

    if let Err(message) = close_update_install_windows(labels, |label| {
        let Some(window) = windows.get(label) else {
            return Ok(());
        };

        window
            .close()
            .map_err(|error| format!("failed to close window {label}: {error}"))
    }) {
        let _ = set_update_install_closing_windows(app_handle, false);
        return Err(artistic_git_app::unexpected_command_error(
            message,
            INSTALL_OPERATION,
        ));
    }

    Ok(())
}

fn set_update_install_closing_windows(app_handle: &AppHandle, closing: bool) -> AppResult<()> {
    if let Some(registry) = app_handle.try_state::<crate::WindowRegistry>() {
        crate::registry_set_update_install_closing_windows(&registry, closing)?;
    }

    Ok(())
}

fn close_update_install_windows<F>(
    labels: Vec<String>,
    mut close_window: F,
) -> Result<Vec<String>, String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    for label in &labels {
        close_window(label)?;
    }

    Ok(labels)
}

impl UpdaterRuntimeState {
    fn next_request_id(&self) -> String {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1;
        format!("update-check-{id}")
    }

    fn begin_check(&self, status: UpdateStatusEvent) -> AppResult<BeginCheckOutcome<'_>> {
        let mut active_check_guard = self.active_check_lock()?;
        if let Some(active_check) = active_check_guard.as_mut() {
            if status.source != UpdateCheckSource::Manual {
                return Ok(BeginCheckOutcome::Busy);
            }

            let observer = ManualCheckObserver {
                request_id: status.request_id,
                target_window_label: status.target_window_label,
            };
            let event = observed_manual_status(&active_check.status, &observer);
            active_check
                .manual_observers
                .retain(|existing| existing.target_window_label != observer.target_window_label);
            active_check.manual_observers.push(observer);
            return Ok(BeginCheckOutcome::Observed(ManualCheckObservation {
                _active_check: active_check_guard,
                event,
            }));
        }

        *active_check_guard = Some(ActiveCheck {
            status,
            manual_observers: Vec::new(),
        });
        Ok(BeginCheckOutcome::Started(CheckGuard { state: self }))
    }

    fn record_check_status(&self, status: UpdateStatusEvent) -> AppResult<Vec<UpdateStatusEvent>> {
        let mut active_check = self.active_check_lock()?;
        let Some(active_check) = active_check.as_mut() else {
            return Ok(Vec::new());
        };
        active_check.status = status;
        Ok(active_check
            .manual_observers
            .iter()
            .map(|observer| observed_manual_status(&active_check.status, observer))
            .collect())
    }

    fn active_check_lock(&self) -> AppResult<std::sync::MutexGuard<'_, Option<ActiveCheck>>> {
        self.active_check.lock().map_err(|_| {
            artistic_git_app::unexpected_command_error(
                "update check state is unavailable",
                UPDATE_CHECK_OPERATION,
            )
        })
    }

    fn clear_ready_update(&self) -> AppResult<()> {
        let mut ready = self.ready_lock()?;
        let mut prompt = self.ready_prompt_lock()?;
        *ready = None;
        *prompt = None;
        Ok(())
    }

    fn store_ready_update(
        &self,
        update: Update,
        bytes: Vec<u8>,
        prompt_event: UpdateStatusEvent,
    ) -> AppResult<()> {
        let mut ready = self.ready_lock()?;
        let mut prompt = self.ready_prompt_lock()?;
        *ready = Some(ReadyUpdate {
            update,
            bytes: Arc::new(bytes),
        });
        *prompt = Some(prompt_event);
        Ok(())
    }

    #[cfg(test)]
    fn store_ready_prompt_event(&self, prompt_event: UpdateStatusEvent) -> AppResult<()> {
        *self.ready_prompt_lock()? = Some(prompt_event);
        Ok(())
    }

    fn retarget_ready_prompt_after_closed(
        &self,
        closed_window_label: &str,
        next_window_label: Option<String>,
    ) -> AppResult<Option<UpdateStatusEvent>> {
        let mut prompt = self.ready_prompt_lock()?;
        let Some(event) = prompt.as_mut() else {
            return Ok(None);
        };

        if event.target_window_label.as_deref() != Some(closed_window_label) {
            return Ok(None);
        }

        event.target_window_label = next_window_label;
        Ok(event.target_window_label.as_ref().map(|_| event.clone()))
    }

    fn route_unassigned_ready_prompt(
        &self,
        target_window_label: String,
    ) -> AppResult<Option<UpdateStatusEvent>> {
        let mut prompt = self.ready_prompt_lock()?;
        let Some(event) = prompt.as_mut() else {
            return Ok(None);
        };

        if event.target_window_label.is_some() {
            return Ok(None);
        }

        event.target_window_label = Some(target_window_label);
        Ok(Some(event.clone()))
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

    fn ready_prompt_lock(&self) -> AppResult<std::sync::MutexGuard<'_, Option<UpdateStatusEvent>>> {
        self.ready_prompt.lock().map_err(|_| {
            artistic_git_app::unexpected_command_error(
                "update prompt route state is unavailable",
                PROMPT_ROUTE_OPERATION,
            )
        })
    }
}

struct CheckGuard<'a> {
    state: &'a UpdaterRuntimeState,
}

impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active_check) = self.state.active_check.lock() {
            *active_check = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn development_builds_disable_updater_network_checks() {
        assert_eq!(
            development_update_disabled_message(),
            "updates are disabled in development builds"
        );
        assert_eq!(updates_disabled_in_current_build(), cfg!(debug_assertions));
    }

    #[test]
    fn automatic_status_targets_recently_focused_window() {
        assert_eq!(
            update_status_target_window_label(
                UpdateCheckSource::Automatic,
                "repo-1",
                Some("repo-2".to_owned())
            ),
            Some("repo-2".to_owned())
        );
    }

    #[test]
    fn manual_status_stays_on_requesting_window() {
        assert_eq!(
            update_status_target_window_label(
                UpdateCheckSource::Manual,
                "repo-1",
                Some("repo-2".to_owned())
            ),
            Some("repo-1".to_owned())
        );
    }

    #[test]
    fn check_guard_releases_the_active_check() {
        let state = UpdaterRuntimeState::default();
        let guard = match state
            .begin_check(checking_status_event(
                "auto-1",
                UpdateCheckSource::Automatic,
            ))
            .expect("begin automatic check")
        {
            BeginCheckOutcome::Started(guard) => guard,
            _ => panic!("first check should start"),
        };

        assert!(matches!(
            state
                .begin_check(checking_status_event(
                    "auto-2",
                    UpdateCheckSource::Automatic,
                ))
                .expect("reject overlapping automatic check"),
            BeginCheckOutcome::Busy
        ));

        drop(guard);
        assert!(matches!(
            state
                .begin_check(checking_status_event("manual-1", UpdateCheckSource::Manual,))
                .expect("begin check after guard drop"),
            BeginCheckOutcome::Started(_)
        ));
    }

    #[test]
    fn manual_check_observes_automatic_download_progress() {
        let state = UpdaterRuntimeState::default();
        let _guard = match state
            .begin_check(checking_status_event(
                "auto-1",
                UpdateCheckSource::Automatic,
            ))
            .expect("begin automatic check")
        {
            BeginCheckOutcome::Started(guard) => guard,
            _ => panic!("automatic check should start"),
        };
        let progress = downloading_status_event("auto-1", 25, 100);

        assert_eq!(
            state
                .record_check_status(progress.clone())
                .expect("record automatic progress"),
            Vec::new()
        );
        let observation = match state
            .begin_check(checking_status_event("manual-2", UpdateCheckSource::Manual))
            .expect("observe active check")
        {
            BeginCheckOutcome::Observed(observation) => observation,
            _ => panic!("manual check should observe the automatic check"),
        };
        let observed = observation.event.clone();

        assert_eq!(observed.request_id, "manual-2");
        assert_eq!(observed.source, UpdateCheckSource::Manual);
        assert_eq!(observed.target_window_label.as_deref(), Some("main"));
        assert_eq!(observed.status, progress.status);
        assert!(matches!(
            state.active_check.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        drop(observation);

        let next_progress = downloading_status_event("auto-1", 50, 100);
        let mirrored = state
            .record_check_status(next_progress.clone())
            .expect("record observed progress");
        assert_eq!(mirrored.len(), 1);
        let mirrored = &mirrored[0];
        assert_eq!(mirrored.request_id, "manual-2");
        assert_eq!(mirrored.source, UpdateCheckSource::Manual);
        assert_eq!(mirrored.status, next_progress.status);
    }

    #[test]
    fn active_check_mirrors_progress_to_each_observing_window() {
        let state = UpdaterRuntimeState::default();
        let _guard = match state
            .begin_check(checking_status_event(
                "auto-1",
                UpdateCheckSource::Automatic,
            ))
            .expect("begin automatic check")
        {
            BeginCheckOutcome::Started(guard) => guard,
            _ => panic!("automatic check should start"),
        };

        for (request_id, target_window_label) in [("manual-1", "repo-1"), ("manual-2", "repo-2")] {
            let mut request = checking_status_event(request_id, UpdateCheckSource::Manual);
            request.target_window_label = Some(target_window_label.to_owned());
            let observation = match state.begin_check(request).expect("observe active check") {
                BeginCheckOutcome::Observed(observation) => observation,
                _ => panic!("manual check should observe the automatic check"),
            };
            drop(observation);
        }

        let mirrored = state
            .record_check_status(downloading_status_event("auto-1", 75, 100))
            .expect("record observed progress");
        assert_eq!(mirrored.len(), 2);
        assert_eq!(mirrored[0].request_id, "manual-1");
        assert_eq!(mirrored[0].target_window_label.as_deref(), Some("repo-1"));
        assert_eq!(mirrored[1].request_id, "manual-2");
        assert_eq!(mirrored[1].target_window_label.as_deref(), Some("repo-2"));
    }

    #[test]
    fn latest_manual_check_replaces_the_observer_for_its_window() {
        let state = UpdaterRuntimeState::default();
        let _guard = match state
            .begin_check(checking_status_event(
                "auto-1",
                UpdateCheckSource::Automatic,
            ))
            .expect("begin automatic check")
        {
            BeginCheckOutcome::Started(guard) => guard,
            _ => panic!("automatic check should start"),
        };

        for request_id in ["manual-1", "manual-2"] {
            let observation = match state
                .begin_check(checking_status_event(request_id, UpdateCheckSource::Manual))
                .expect("observe active check")
            {
                BeginCheckOutcome::Observed(observation) => observation,
                _ => panic!("manual check should observe the automatic check"),
            };
            drop(observation);
        }

        let mirrored = state
            .record_check_status(downloading_status_event("auto-1", 75, 100))
            .expect("record observed progress");
        assert_eq!(mirrored.len(), 1);
        assert_eq!(mirrored[0].request_id, "manual-2");
    }

    #[test]
    fn observed_automatic_failure_is_visible_to_manual_check() {
        let state = UpdaterRuntimeState::default();
        let _guard = match state
            .begin_check(checking_status_event(
                "auto-1",
                UpdateCheckSource::Automatic,
            ))
            .expect("begin automatic check")
        {
            BeginCheckOutcome::Started(guard) => guard,
            _ => panic!("automatic check should start"),
        };
        let observation = match state
            .begin_check(checking_status_event("manual-2", UpdateCheckSource::Manual))
            .expect("observe active check")
        {
            BeginCheckOutcome::Observed(observation) => observation,
            _ => panic!("manual check should observe the automatic check"),
        };
        drop(observation);

        let events = state
            .record_check_status(UpdateStatusEvent {
                request_id: "auto-1".to_owned(),
                source: UpdateCheckSource::Automatic,
                target_window_label: Some("main".to_owned()),
                status: UpdateStatus::Failed {
                    message: "download timed out".to_owned(),
                    visible: false,
                },
            })
            .expect("record automatic failure");
        assert_eq!(events.len(), 1);
        let event = &events[0];

        assert_eq!(event.source, UpdateCheckSource::Manual);
        assert!(matches!(
            event.status,
            UpdateStatus::Failed { visible: true, .. }
        ));
    }

    #[test]
    fn actual_automatic_failure_remains_a_primary_status() {
        let event = failed_status_event("auto-1", UpdateCheckSource::Automatic);

        assert!(should_emit_primary_check_status(&event, false));
        assert!(should_emit_primary_check_status(&event, true));
    }

    #[test]
    fn overlapping_automatic_check_failure_remains_silent() {
        let automatic = failed_status_event("auto-2", UpdateCheckSource::Automatic);
        let manual = failed_status_event("manual-2", UpdateCheckSource::Manual);

        assert!(!should_emit_busy_status(&automatic));
        assert!(should_emit_busy_status(&manual));
    }

    #[test]
    fn observed_automatic_ready_status_suppresses_the_original_prompt() {
        let event = ready_prompt_event(Some("repo-1"));
        assert_eq!(event.source, UpdateCheckSource::Automatic);

        assert!(should_emit_primary_check_status(&event, false));
        assert!(!should_emit_primary_check_status(&event, true));
    }

    #[test]
    fn latest_manual_observer_is_the_canonical_ready_prompt() {
        let automatic = ready_prompt_event(Some("repo-1"));
        let observed = vec![
            UpdateStatusEvent {
                request_id: "manual-1".to_owned(),
                source: UpdateCheckSource::Manual,
                target_window_label: Some("repo-2".to_owned()),
                status: automatic.status.clone(),
            },
            UpdateStatusEvent {
                request_id: "manual-2".to_owned(),
                source: UpdateCheckSource::Manual,
                target_window_label: Some("repo-3".to_owned()),
                status: automatic.status.clone(),
            },
        ];

        let canonical = canonical_prompt_event(&automatic, &observed);
        assert_eq!(canonical.request_id, "manual-2");
        assert_eq!(canonical.source, UpdateCheckSource::Manual);
        assert_eq!(canonical.target_window_label.as_deref(), Some("repo-3"));
    }

    #[test]
    fn ready_prompt_retargets_when_target_window_closes() {
        let state = UpdaterRuntimeState::default();
        state
            .store_ready_prompt_event(ready_prompt_event(Some("repo-1")))
            .expect("store prompt");

        let event = state
            .retarget_ready_prompt_after_closed("repo-1", Some("repo-2".to_owned()))
            .expect("retarget prompt")
            .expect("retargeted event");

        assert_eq!(event.target_window_label, Some("repo-2".to_owned()));
    }

    #[test]
    fn ready_prompt_does_not_retarget_unrelated_window_close() {
        let state = UpdaterRuntimeState::default();
        state
            .store_ready_prompt_event(ready_prompt_event(Some("repo-1")))
            .expect("store prompt");

        assert_eq!(
            state
                .retarget_ready_prompt_after_closed("repo-2", Some("repo-3".to_owned()))
                .expect("retarget prompt"),
            None
        );
    }

    #[test]
    fn unassigned_ready_prompt_routes_to_next_focused_window() {
        let state = UpdaterRuntimeState::default();
        state
            .store_ready_prompt_event(ready_prompt_event(None))
            .expect("store prompt");

        let event = state
            .route_unassigned_ready_prompt("repo-2".to_owned())
            .expect("route prompt")
            .expect("routed event");

        assert_eq!(event.target_window_label, Some("repo-2".to_owned()));
    }

    #[test]
    fn close_guard_install_gate_blocks_update_install() {
        let gate = close_guard_install_gate_response_for_blocked(true)
            .expect("close guard should block install");

        assert!(gate.blocked);
        assert_eq!(gate.reason, Some(UpdateInstallBlockedReason::CloseGuard));
        assert_eq!(gate.message.as_deref(), Some(close_guard_install_message()));
    }

    #[test]
    fn close_guard_install_gate_allows_when_no_window_is_guarded() {
        assert_eq!(close_guard_install_gate_response_for_blocked(false), None);
    }

    #[test]
    fn update_install_closes_every_window_before_install() {
        let mut closed = Vec::new();
        let labels = vec![
            "repo-1".to_owned(),
            "repo-2".to_owned(),
            "start-3".to_owned(),
        ];

        let attempted = close_update_install_windows(labels.clone(), |label| {
            closed.push(label.to_owned());
            Ok(())
        })
        .expect("close windows");

        assert_eq!(attempted, labels);
        assert_eq!(closed, vec!["repo-1", "repo-2", "start-3"]);
    }

    #[test]
    fn linux_appimage_installation_supports_in_app_update() {
        assert_eq!(
            update_capability_for_signals(UpdateInstallSignals {
                operating_system: RuntimeOperatingSystem::Linux,
                install_format: Some(UpdateInstallFormat::AppImage),
                appimage_env_present: false,
            }),
            UpdateCapability::InApp
        );
    }

    #[test]
    fn linux_appimage_environment_supports_in_app_update_when_bundle_type_is_unknown() {
        assert_eq!(
            update_capability_for_signals(UpdateInstallSignals {
                operating_system: RuntimeOperatingSystem::Linux,
                install_format: None,
                appimage_env_present: true,
            }),
            UpdateCapability::InApp
        );
    }

    #[test]
    fn linux_deb_installation_falls_back_to_release_page() {
        assert_eq!(
            update_capability_for_signals(UpdateInstallSignals {
                operating_system: RuntimeOperatingSystem::Linux,
                install_format: Some(UpdateInstallFormat::Deb),
                appimage_env_present: false,
            }),
            UpdateCapability::ReleasePage {
                reason: UpdateReleasePageReason::LinuxPackageManager
            }
        );
    }

    #[test]
    fn linux_unknown_installation_fails_safe_to_release_page() {
        assert_eq!(
            update_capability_for_signals(UpdateInstallSignals {
                operating_system: RuntimeOperatingSystem::Linux,
                install_format: None,
                appimage_env_present: false,
            }),
            UpdateCapability::ReleasePage {
                reason: UpdateReleasePageReason::UnknownInstallFormat
            }
        );
    }

    #[test]
    fn release_available_status_serializes_for_frontend() {
        let event = release_available_status(
            "update-check-1".to_owned(),
            UpdateCheckSource::Manual,
            Some("main".to_owned()),
            "0.2.0".to_owned(),
            Some("Release notes".to_owned()),
            UpdateReleasePageReason::LinuxPackageManager,
        );
        let json = serde_json::to_value(event).expect("serialize event");

        assert_eq!(json["status"]["state"], "releaseAvailable");
        assert_eq!(json["status"]["reason"], "linuxPackageManager");
        assert_eq!(json["status"]["version"], "0.2.0");
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

    fn ready_prompt_event(target_window_label: Option<&str>) -> UpdateStatusEvent {
        UpdateStatusEvent {
            request_id: "update-check-1".to_owned(),
            source: UpdateCheckSource::Automatic,
            target_window_label: target_window_label.map(str::to_owned),
            status: UpdateStatus::Ready {
                version: "0.2.0".to_owned(),
                notes: Some("Release notes".to_owned()),
            },
        }
    }

    fn checking_status_event(request_id: &str, source: UpdateCheckSource) -> UpdateStatusEvent {
        UpdateStatusEvent {
            request_id: request_id.to_owned(),
            source,
            target_window_label: Some("main".to_owned()),
            status: UpdateStatus::Checking,
        }
    }

    fn downloading_status_event(
        request_id: &str,
        downloaded_bytes: u64,
        total_bytes: u64,
    ) -> UpdateStatusEvent {
        UpdateStatusEvent {
            request_id: request_id.to_owned(),
            source: UpdateCheckSource::Automatic,
            target_window_label: Some("main".to_owned()),
            status: UpdateStatus::Downloading {
                version: "0.2.0".to_owned(),
                notes: Some("Release notes".to_owned()),
                downloaded_bytes,
                total_bytes: Some(total_bytes),
                progress: Some(downloaded_bytes as f64 / total_bytes as f64),
            },
        }
    }

    fn failed_status_event(request_id: &str, source: UpdateCheckSource) -> UpdateStatusEvent {
        UpdateStatusEvent {
            request_id: request_id.to_owned(),
            source,
            target_window_label: Some("main".to_owned()),
            status: UpdateStatus::Failed {
                message: "update check failed".to_owned(),
                visible: source == UpdateCheckSource::Manual,
            },
        }
    }
}
