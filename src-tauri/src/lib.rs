use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
};
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewUrl, WindowEvent,
};

mod updater_runtime;

const MENU_EVENT_NAME: &str = "app-menu";
const APP_HOMEPAGE: &str = "https://github.com/smallmain/artistic-git";
const APP_CHANGELOG: &str = "https://github.com/smallmain/artistic-git/releases";
const START_WINDOW_LABEL_PREFIX: &str = "start-";
const REPOSITORY_WINDOW_LABEL_PREFIX: &str = "repo-";

struct LoggingState {
    _guard: artistic_git_core::logging::LoggingGuard,
}

#[derive(Default)]
struct WindowRegistry {
    inner: Mutex<WindowRegistryInner>,
}

#[derive(Default)]
struct HttpsCredentialPromptState {
    registry: Arc<HttpsCredentialPromptRegistry>,
}

#[derive(Default)]
struct SshPassphrasePromptState {
    registry: Arc<SshPassphrasePromptRegistry>,
}

#[derive(Default)]
struct HttpsCredentialPromptRegistry {
    inner: Mutex<HttpsCredentialPromptRegistryInner>,
}

#[derive(Default)]
struct SshPassphrasePromptRegistry {
    inner: Mutex<SshPassphrasePromptRegistryInner>,
}

#[derive(Default)]
struct HttpsCredentialPromptRegistryInner {
    next_id: u64,
    pending: BTreeMap<String, mpsc::Sender<HttpsCredentialPromptResponse>>,
}

#[derive(Default)]
struct SshPassphrasePromptRegistryInner {
    next_id: u64,
    pending: BTreeMap<String, mpsc::Sender<SshPassphrasePromptResponse>>,
}

enum HttpsCredentialPromptResponse {
    Submit(artistic_git_app::https_auth::HttpsCredentialPromptSubmission),
    Cancel,
}

enum SshPassphrasePromptResponse {
    Submit(artistic_git_app::ssh_auth::SshPassphrasePromptSubmission),
    Cancel,
}

#[derive(Clone)]
struct TauriHttpsCredentialPromptSink {
    app: tauri::AppHandle,
    registry: Arc<HttpsCredentialPromptRegistry>,
}

#[derive(Clone)]
struct TauriSshPassphrasePromptSink {
    app: tauri::AppHandle,
    registry: Arc<SshPassphrasePromptRegistry>,
}

impl artistic_git_app::https_auth::HttpsCredentialPromptSink for TauriHttpsCredentialPromptSink {
    fn prompt_https_credentials(
        &self,
        request: artistic_git_app::HttpsCredentialPromptRequest,
    ) -> artistic_git_app::https_auth::HttpsCredentialPromptResult {
        self.registry.prompt(&self.app, request)
    }
}

impl artistic_git_app::ssh_auth::SshPassphrasePromptSink for TauriSshPassphrasePromptSink {
    fn prompt_ssh_passphrase(
        &self,
        request: artistic_git_app::SshPassphrasePromptRequest,
    ) -> artistic_git_app::ssh_auth::SshPassphrasePromptResult {
        self.registry.prompt(&self.app, request)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpsCredentialPromptEvent {
    prompt_id: String,
    request: artistic_git_app::HttpsCredentialPromptRequest,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SshPassphrasePromptEvent {
    prompt_id: String,
    request: artistic_git_app::SshPassphrasePromptRequest,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitHttpsCredentialPromptRequest {
    prompt_id: String,
    username: Option<String>,
    token: Option<String>,
    scope: Option<artistic_git_app::HttpsCredentialScope>,
    cancelled: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitSshPassphrasePromptRequest {
    prompt_id: String,
    passphrase: Option<String>,
    remember: bool,
    cancelled: bool,
}

impl HttpsCredentialPromptRegistry {
    fn prompt(
        &self,
        app: &tauri::AppHandle,
        request: artistic_git_app::HttpsCredentialPromptRequest,
    ) -> artistic_git_app::https_auth::HttpsCredentialPromptResult {
        let (tx, rx) = mpsc::channel();
        let prompt_id = {
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => {
                    return artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel;
                }
            };
            inner.next_id = inner.next_id.saturating_add(1);
            let prompt_id = format!("https-credential-{}", inner.next_id);
            inner.pending.insert(prompt_id.clone(), tx);
            prompt_id
        };

        let event = HttpsCredentialPromptEvent {
            prompt_id: prompt_id.clone(),
            request,
        };
        if app.emit("https-credential-prompt", event).is_err() {
            self.remove(&prompt_id);
            return artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel;
        }

        match rx.recv() {
            Ok(HttpsCredentialPromptResponse::Submit(submission)) => {
                artistic_git_app::https_auth::HttpsCredentialPromptResult::Submit(submission)
            }
            Ok(HttpsCredentialPromptResponse::Cancel) | Err(_) => {
                artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel
            }
        }
    }

    fn submit(&self, request: SubmitHttpsCredentialPromptRequest) -> Result<(), String> {
        let sender = self.remove(&request.prompt_id).ok_or_else(|| {
            format!(
                "HTTPS credential prompt {} is no longer active",
                request.prompt_id
            )
        })?;

        let response = if request.cancelled {
            HttpsCredentialPromptResponse::Cancel
        } else {
            let username = request
                .username
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "username is required".to_owned())?
                .to_owned();
            let token = request
                .token
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "token is required".to_owned())?;
            HttpsCredentialPromptResponse::Submit(
                artistic_git_app::https_auth::HttpsCredentialPromptSubmission::new(
                    username,
                    token,
                    request
                        .scope
                        .unwrap_or(artistic_git_app::HttpsCredentialScope::Host),
                ),
            )
        };

        sender
            .send(response)
            .map_err(|_| "HTTPS credential prompt receiver was dropped".to_owned())
    }

    fn remove(&self, prompt_id: &str) -> Option<mpsc::Sender<HttpsCredentialPromptResponse>> {
        self.inner.lock().ok()?.pending.remove(prompt_id)
    }
}

impl SshPassphrasePromptRegistry {
    fn prompt(
        &self,
        app: &tauri::AppHandle,
        request: artistic_git_app::SshPassphrasePromptRequest,
    ) -> artistic_git_app::ssh_auth::SshPassphrasePromptResult {
        let (tx, rx) = mpsc::channel();
        let prompt_id = {
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => {
                    return artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel;
                }
            };
            inner.next_id = inner.next_id.saturating_add(1);
            let prompt_id = format!("ssh-passphrase-{}", inner.next_id);
            inner.pending.insert(prompt_id.clone(), tx);
            prompt_id
        };

        let event = SshPassphrasePromptEvent {
            prompt_id: prompt_id.clone(),
            request,
        };
        if app.emit("ssh-passphrase-prompt", event).is_err() {
            self.remove(&prompt_id);
            return artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel;
        }

        match rx.recv() {
            Ok(SshPassphrasePromptResponse::Submit(submission)) => {
                artistic_git_app::ssh_auth::SshPassphrasePromptResult::Submit(submission)
            }
            Ok(SshPassphrasePromptResponse::Cancel) | Err(_) => {
                artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel
            }
        }
    }

    fn submit(&self, request: SubmitSshPassphrasePromptRequest) -> Result<(), String> {
        let sender = self.remove(&request.prompt_id).ok_or_else(|| {
            format!(
                "SSH passphrase prompt {} is no longer active",
                request.prompt_id
            )
        })?;

        let response = if request.cancelled {
            SshPassphrasePromptResponse::Cancel
        } else {
            let passphrase = request
                .passphrase
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "passphrase is required".to_owned())?;
            SshPassphrasePromptResponse::Submit(
                artistic_git_app::ssh_auth::SshPassphrasePromptSubmission::new(
                    passphrase,
                    request.remember,
                ),
            )
        };

        sender
            .send(response)
            .map_err(|_| "SSH passphrase prompt receiver was dropped".to_owned())
    }

    fn remove(&self, prompt_id: &str) -> Option<mpsc::Sender<SshPassphrasePromptResponse>> {
        self.inner.lock().ok()?.pending.remove(prompt_id)
    }
}

#[derive(Default)]
struct WindowRegistryInner {
    label_to_repository: BTreeMap<String, String>,
    repository_to_label: BTreeMap<String, String>,
    close_guard_labels: BTreeSet<String>,
    focused_window_labels: VecDeque<String>,
    pending_crashes_by_label: BTreeMap<String, CrashDialogPayload>,
    pending_exit_after_close_guards: bool,
    update_install_closing_windows: bool,
    next_window_id: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenRepositoryWindowRequest {
    repository_path: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowCloseGuardRequest {
    active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowCloseBlockedEvent {
    reason: WindowCloseBlockedReason,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashDialogPayload {
    summary: String,
    details: String,
    source: CrashDialogSource,
    window_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum CrashDialogSource {
    Renderer,
    RustPanic,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RendererCrashInjectionRequest {
    summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum WindowCloseBlockedReason {
    CloseWindow,
    Quit,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowContextResponse {
    label: String,
    repository_path: Option<String>,
    pending_crash: Option<CrashDialogPayload>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRepositoryWindowResponse {
    action: OpenRepositoryWindowAction,
    label: String,
    repository_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum OpenRepositoryWindowAction {
    UseCurrent,
    FocusedExisting,
    Created,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NewWindowResponse {
    label: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppMenuEvent {
    id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SecondInstanceForward {
    args: Vec<String>,
    cwd: String,
    repository_path: Option<String>,
}

#[tauri::command]
fn health() -> artistic_git_contracts::AppResult<artistic_git_app::HealthResponse> {
    artistic_git_app::health()
}

#[tauri::command]
fn window_context(
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
) -> artistic_git_contracts::AppResult<WindowContextResponse> {
    let label = window.label().to_owned();
    let repository_path = registry
        .inner
        .lock()
        .map_err(|_| window_command_error("window registry lock poisoned", "windowContext"))?
        .label_to_repository
        .get(&label)
        .cloned();
    let pending_crash = registry_peek_pending_crash(&registry, &label);

    Ok(WindowContextResponse {
        label,
        repository_path,
        pending_crash,
    })
}

#[tauri::command]
fn new_project_window(
    app_handle: tauri::AppHandle,
    registry: State<'_, WindowRegistry>,
) -> artistic_git_contracts::AppResult<NewWindowResponse> {
    create_start_window(&app_handle, &registry)
}

#[tauri::command]
fn open_repository_window(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: OpenRepositoryWindowRequest,
) -> artistic_git_contracts::AppResult<OpenRepositoryWindowResponse> {
    let project_settings =
        backend.load_project_settings(artistic_git_app::ProjectSettingsRequest {
            repository_path: request.repository_path,
        })?;
    let repository_path = project_settings.path;
    let current_label = window.label().to_owned();

    let decision = {
        let mut inner = registry.inner.lock().map_err(|_| {
            window_command_error("window registry lock poisoned", "openRepositoryWindow")
        })?;

        if let Some(existing_label) = inner.repository_to_label.get(&repository_path).cloned() {
            if existing_label != current_label {
                Some((OpenRepositoryWindowAction::FocusedExisting, existing_label))
            } else {
                Some((
                    OpenRepositoryWindowAction::UseCurrent,
                    current_label.clone(),
                ))
            }
        } else if !inner.label_to_repository.contains_key(&current_label) {
            inner
                .label_to_repository
                .insert(current_label.clone(), repository_path.clone());
            inner
                .repository_to_label
                .insert(repository_path.clone(), current_label.clone());
            Some((
                OpenRepositoryWindowAction::UseCurrent,
                current_label.clone(),
            ))
        } else {
            None
        }
    };

    if let Some((action, label)) = decision {
        if matches!(action, OpenRepositoryWindowAction::FocusedExisting) {
            focus_window(&app_handle, &label);
            let _ = registry_mark_focused(&registry, &label);
        }
        return Ok(OpenRepositoryWindowResponse {
            action,
            label,
            repository_path,
        });
    }

    let label = next_repository_window_label(&registry)?;
    let window = build_repository_window(
        &app_handle,
        &label,
        &repository_path,
        project_settings.window_geometry,
    )?;
    registry_register(&registry, label.clone(), repository_path.clone())?;
    let _ = window.set_focus();
    let _ = registry_mark_focused(&registry, &label);

    Ok(OpenRepositoryWindowResponse {
        action: OpenRepositoryWindowAction::Created,
        label,
        repository_path,
    })
}

#[tauri::command]
fn register_window_repository(
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: OpenRepositoryWindowRequest,
) -> artistic_git_contracts::AppResult<WindowContextResponse> {
    let project_settings =
        backend.load_project_settings(artistic_git_app::ProjectSettingsRequest {
            repository_path: request.repository_path,
        })?;
    let label = window.label().to_owned();
    registry_register(&registry, label.clone(), project_settings.path.clone())?;

    Ok(WindowContextResponse {
        label,
        pending_crash: None,
        repository_path: Some(project_settings.path),
    })
}

#[tauri::command]
fn save_window_geometry(
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: OpenRepositoryWindowRequest,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::ProjectSettings> {
    let geometry = current_window_geometry(&window)?;
    backend.save_project_window_geometry(request.repository_path, geometry)
}

#[tauri::command]
fn close_current_window(window: tauri::Window) -> artistic_git_contracts::AppResult<()> {
    window.close().map_err(|error| {
        window_command_error(
            format!("failed to close current window: {error}"),
            "closeCurrentWindow",
        )
    })
}

#[tauri::command]
fn set_window_close_guard(
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
    request: WindowCloseGuardRequest,
) -> artistic_git_contracts::AppResult<()> {
    registry_set_close_guard(&registry, window.label(), request.active)
}

#[tauri::command]
fn cancel_pending_window_exit(
    registry: State<'_, WindowRegistry>,
) -> artistic_git_contracts::AppResult<()> {
    registry_set_pending_exit_after_close_guards(&registry, false)
}

#[tauri::command]
fn inject_renderer_crash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
    request: RendererCrashInjectionRequest,
) -> artistic_git_contracts::AppResult<()> {
    handle_renderer_crash(
        &app_handle,
        &registry,
        window.label(),
        request
            .summary
            .unwrap_or_else(default_renderer_crash_summary),
    )
}

#[tauri::command]
fn acknowledge_renderer_crash(
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
) -> artistic_git_contracts::AppResult<()> {
    registry_clear_pending_crash(&registry, window.label())
}

#[tauri::command]
fn open_log_dir(
    app_handle: tauri::AppHandle,
) -> artistic_git_contracts::AppResult<artistic_git_app::OpenLogDirResponse> {
    let log_dir = app_handle.path().app_log_dir().map_err(|error| {
        artistic_git_app::unexpected_command_error(
            format!("failed to resolve application log directory: {error}"),
            "openLogDir",
        )
    })?;

    artistic_git_app::open_log_dir(log_dir)
}

#[tauri::command]
fn open_update_release_page() -> artistic_git_contracts::AppResult<()> {
    open_url(APP_CHANGELOG);
    Ok(())
}

#[tauri::command]
fn open_repository(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::OpenRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::OpenRepositoryResponse> {
    let repository_path = request.path.clone();
    let window_label = window.label().to_owned();
    backend.open_repository_with_progress(request, |event| {
        emit_operation_progress(
            &app_handle,
            event,
            Some(repository_path.as_str()),
            window_label.as_str(),
        );
    })
}

#[tauri::command]
fn clone_repository(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CloneRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CloneRepositoryResponse> {
    let repository_path = clone_repository_target_path(&request);
    let window_label = window.label().to_owned();
    backend.clone_repository_with_progress(request, |event| {
        emit_operation_progress(
            &app_handle,
            event,
            Some(repository_path.as_str()),
            window_label.as_str(),
        );
    })
}

#[tauri::command]
fn cancel_clone_repository(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CancelCloneRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CancelCloneRepositoryResponse> {
    backend.cancel_clone_repository(request)
}

#[tauri::command]
fn cancel_operation(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CancelOperationRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CancelOperationResponse> {
    backend.cancel_operation(request)
}

#[tauri::command]
fn repository_summary(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RepositorySummary> {
    backend.repository_summary(request)
}

#[tauri::command]
fn fetch_repository(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::FetchRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::FetchRepositoryResponse> {
    let repository_path = request.repository_path.clone();
    let started = backend.fetch_started_event(&repository_path);
    emit_fetch_state(&app_handle, &started);

    match backend.fetch_repository(request) {
        Ok(response) => {
            emit_fetch_state(&app_handle, &response.event);
            let changed_queries = artistic_git_app::fetch_changed_queries(&response);
            if !changed_queries.is_empty() {
                emit_repo_changed(
                    &app_handle,
                    response.event.repository_path.clone(),
                    changed_queries,
                );
            }
            Ok(response)
        }
        Err(error) => {
            let failed = backend.fetch_state_event(&repository_path);
            emit_fetch_state(&app_handle, &failed);
            Err(error)
        }
    }
}

#[tauri::command]
fn sync_current_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SyncCurrentBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncCurrentBranchResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Syncing",
    );
    let result = backend.sync_current_branch_with_progress(request, |event| {
        emit_operation_progress(
            &app_handle,
            event,
            Some(repository_path.as_str()),
            window_label.as_str(),
        );
    });
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Sync complete",
    );
    let response = result?;
    if let Some(conflict) = response.conflict.as_ref() {
        let _ = app_handle.emit("conflict-entered", conflict);
    }
    emit_repo_changed(
        &app_handle,
        response.repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::History,
            artistic_git_contracts::RepoQueryKind::LocalChanges,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn sync_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SyncBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncBranchResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Syncing",
    );
    let result = backend.sync_branch_with_progress(request, |event| {
        emit_operation_progress(
            &app_handle,
            event,
            Some(repository_path.as_str()),
            window_label.as_str(),
        );
    });
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Sync complete",
    );
    let response = result?;
    if let Some(conflict) = response.conflict.as_ref() {
        let _ = app_handle.emit("conflict-entered", conflict);
    }
    emit_repo_changed(
        &app_handle,
        response.repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::History,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn sync_all_branches(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SyncAllBranchesRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncAllBranchesResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Syncing",
    );
    let result = backend.sync_all_branches_with_progress(request, |event| {
        emit_operation_progress(
            &app_handle,
            event,
            Some(repository_path.as_str()),
            window_label.as_str(),
        );
    });
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Sync complete",
    );
    let response = result?;
    if let Some(conflict) = response.conflict.as_ref() {
        let _ = app_handle.emit("conflict-entered", conflict);
    }
    emit_repo_changed(
        &app_handle,
        response.repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::History,
            artistic_git_contracts::RepoQueryKind::LocalChanges,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn accept_remote_history(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::AcceptRemoteHistoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::AcceptRemoteHistoryResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Accepting remote history",
    );
    let result = backend.accept_remote_history(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Remote history accepted",
    );
    let response = result?;
    if let Some(conflict) = response.conflict.as_ref() {
        let _ = app_handle.emit("conflict-entered", conflict);
    }
    emit_repo_changed(
        &app_handle,
        response.repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::History,
            artistic_git_contracts::RepoQueryKind::LocalChanges,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn start_review_mode(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::StartReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::StartReviewModeResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Starting review mode",
    );
    let result = backend.start_review_mode(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Review mode ready",
    );
    let response = result?;
    emit_repo_changed(
        &app_handle,
        response.state.repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::History,
            artistic_git_contracts::RepoQueryKind::LocalChanges,
            artistic_git_contracts::RepoQueryKind::Stashes,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn sync_review_mode(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncReviewModeResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Syncing review mode",
    );
    let result = backend.sync_review_mode(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Review mode synced",
    );
    let response = result?;
    emit_repo_changed(
        &app_handle,
        response.state.repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::History,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn exit_review_mode(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ExitReviewModeResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Exiting review mode",
    );
    let result = backend.exit_review_mode(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Review mode exited",
    );
    let response = result?;
    emit_review_exit_events(&app_handle, &response);
    Ok(response)
}

#[tauri::command]
fn review_mode_recovery(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRecoveryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ReviewModeRecoveryResponse> {
    backend.review_mode_recovery(request)
}

#[tauri::command]
fn recover_review_mode_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRecoveryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ExitReviewModeResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Recovering review mode",
    );
    let result = backend.recover_review_mode_stash(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Review mode recovered",
    );
    let response = result?;
    emit_review_exit_events(&app_handle, &response);
    Ok(response)
}

#[tauri::command]
fn dismiss_review_mode_recovery(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRecoveryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ReviewModeRecoveryResponse> {
    backend.dismiss_review_mode_recovery(request)
}

#[tauri::command]
fn load_remote_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RemoteSettingsResponse> {
    backend.load_remote_settings(request)
}

#[tauri::command]
fn save_remote_settings(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SaveRemoteSettingsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RemoteSettingsResponse> {
    let response = backend.save_remote_settings(request)?;
    emit_repo_changed(
        &app_handle,
        response.repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::History,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn list_branches(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchListResponse> {
    backend.list_branches(request)
}

#[tauri::command]
fn list_safety_backups(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SafetyBackupListResponse> {
    backend.list_safety_backups(request)
}

#[tauri::command]
fn validate_branch_name(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::BranchNameValidationRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchNameValidationResponse> {
    backend.validate_branch_name(request)
}

#[tauri::command]
fn create_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Updating branch",
    );
    let result = backend.create_branch(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Branch updated",
    );
    let response = result?;
    emit_branch_operation_events(&app_handle, &response);
    Ok(response)
}

#[tauri::command]
fn checkout_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CheckoutBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Updating branch",
    );
    let result = backend.checkout_branch(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Branch updated",
    );
    let response = result?;
    emit_branch_operation_events(&app_handle, &response);
    Ok(response)
}

#[tauri::command]
fn delete_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Updating branch",
    );
    let result = backend.delete_branch(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Branch updated",
    );
    let response = result?;
    emit_branch_operation_events(&app_handle, &response);
    Ok(response)
}

#[tauri::command]
fn delete_safety_backup(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteSafetyBackupRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::DeleteSafetyBackupResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Deleting backup branch",
    );
    let result = backend.delete_safety_backup(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Backup branch deleted",
    );
    let response = result?;
    emit_repo_changed(
        &app_handle,
        response.repository_path.clone(),
        vec![artistic_git_contracts::RepoQueryKind::Branches],
    );
    Ok(response)
}

#[tauri::command]
fn list_local_changes(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::LocalChangesResponse> {
    backend.list_local_changes(request)
}

#[tauri::command]
fn preview_renormalize(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RenormalizePreviewRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RenormalizePreviewResponse> {
    backend.preview_renormalize(request)
}

#[tauri::command]
fn list_stashes(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::StashListResponse> {
    backend.list_stashes(request)
}

#[tauri::command]
fn create_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CreateStashResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Updating stash",
    );
    let result = backend.create_stash(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Stash updated",
    );
    let response = result?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![
            artistic_git_contracts::RepoQueryKind::LocalChanges,
            artistic_git_contracts::RepoQueryKind::Stashes,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn create_auto_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateAutoStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CreateStashResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Updating stash",
    );
    let result = backend.create_auto_stash(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Stash updated",
    );
    let response = result?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![
            artistic_git_contracts::RepoQueryKind::LocalChanges,
            artistic_git_contracts::RepoQueryKind::Stashes,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn stash_details(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::StashDetailsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::StashDetailsResponse> {
    backend.stash_details(request)
}

#[tauri::command]
fn restore_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RestoreStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RestoreStashResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Updating stash",
    );
    let result = backend.restore_stash(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Stash updated",
    );
    let response = result?;
    if let artistic_git_contracts::StashRestoreOutcome::Conflicts { conflict } = &response.outcome {
        let _ = app_handle.emit("conflict-entered", conflict);
    }
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![
            artistic_git_contracts::RepoQueryKind::LocalChanges,
            artistic_git_contracts::RepoQueryKind::Stashes,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn cancel_stash_restore(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CancelStashRestoreRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CancelStashRestoreResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.cancel_stash_restore(request)?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![
            artistic_git_contracts::RepoQueryKind::LocalChanges,
            artistic_git_contracts::RepoQueryKind::Stashes,
        ],
    );
    Ok(response)
}

#[tauri::command]
fn delete_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::DeleteStashResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Updating stash",
    );
    let result = backend.delete_stash(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Stash updated",
    );
    let response = result?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![artistic_git_contracts::RepoQueryKind::Stashes],
    );
    Ok(response)
}

#[tauri::command]
fn log_page(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::LogPageRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::LogPageResponse> {
    backend.log_page(request)
}

#[tauri::command]
fn search_log(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::LogSearchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::LogPageResponse> {
    backend.search_log(request)
}

#[tauri::command]
fn list_conflicts(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictListRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictListResponse> {
    backend.list_conflicts(request)
}

#[tauri::command]
fn conflict_detail(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictDetailResponse> {
    backend.conflict_detail(request)
}

#[tauri::command]
fn select_conflict_side(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictSelectSideRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictSelectSideResponse> {
    backend.select_conflict_side(request)
}

#[tauri::command]
fn save_conflict_resolution(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictSaveResolutionRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictSaveResolutionResponse> {
    backend.save_conflict_resolution(request)
}

#[tauri::command]
fn complete_conflict_resolution(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictCompleteRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictCompleteResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.complete_conflict_resolution(request)?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
    );
    Ok(response)
}

#[tauri::command]
fn cancel_conflict_resolution(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictCancelRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictCancelResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.cancel_conflict_resolution(request)?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
    );
    Ok(response)
}

#[tauri::command]
fn commit_changes(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CommitRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CommitResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Committing changes",
    );
    let result = backend.commit_changes(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Commit complete",
    );
    let response = result?;
    match &response {
        artistic_git_contracts::CommitResponse::Committed { .. }
        | artistic_git_contracts::CommitResponse::Conflicts { .. } => {
            if let artistic_git_contracts::CommitResponse::Conflicts { conflict, .. } = &response {
                let _ = app_handle.emit("conflict-entered", conflict);
            }
            emit_repo_changed(
                &app_handle,
                repository_path,
                vec![
                    artistic_git_contracts::RepoQueryKind::LocalChanges,
                    artistic_git_contracts::RepoQueryKind::History,
                    artistic_git_contracts::RepoQueryKind::Summary,
                ],
            );
        }
        _ => {}
    }
    Ok(response)
}

#[tauri::command]
fn restore_changes(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RestoreChangesRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RestoreChangesResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.restore_changes(request)?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
    );
    Ok(response)
}

#[tauri::command]
fn revert_commit(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RevertCommitRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RevertCommitResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    emit_operation_started(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Reverting commit",
    );
    let result = backend.revert_commit(request);
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Revert complete",
    );
    let response = result?;
    match &response {
        artistic_git_contracts::RevertCommitResponse::Reverted { .. } => {
            emit_repo_changed(
                &app_handle,
                repository_path,
                vec![
                    artistic_git_contracts::RepoQueryKind::LocalChanges,
                    artistic_git_contracts::RepoQueryKind::History,
                    artistic_git_contracts::RepoQueryKind::Summary,
                ],
            );
        }
        artistic_git_contracts::RevertCommitResponse::Conflicted { conflict, .. } => {
            let _ = app_handle.emit("conflict-entered", conflict);
            emit_repo_changed(
                &app_handle,
                repository_path,
                vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
            );
        }
        artistic_git_contracts::RevertCommitResponse::Disabled { .. } => {}
    }
    Ok(response)
}

#[tauri::command]
fn abort_revert(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::AbortRevertRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::AbortRevertResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.abort_revert(request)?;
    if response.aborted {
        emit_repo_changed(
            &app_handle,
            repository_path,
            vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
        );
    }
    Ok(response)
}

#[tauri::command]
fn settings_snapshot(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> artistic_git_contracts::AppResult<artistic_git_app::SettingsSnapshot> {
    backend.settings_snapshot()
}

#[tauri::command]
fn load_app_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::AppSettings> {
    backend.load_app_settings()
}

#[tauri::command]
fn save_app_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::SaveAppSettingsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::AppSettings> {
    backend.save_app_settings(request)
}

#[tauri::command]
fn load_project_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::ProjectSettingsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::ProjectSettings> {
    backend.load_project_settings(request)
}

#[tauri::command]
fn save_project_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::SaveProjectSettingsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::ProjectSettings> {
    backend.save_project_settings(request)
}

#[tauri::command]
fn load_gitignore(
    request: artistic_git_app::GitignoreRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::GitignoreFileResponse> {
    artistic_git_app::load_gitignore(request)
}

#[tauri::command]
fn save_gitignore(
    request: artistic_git_app::SaveGitignoreRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::GitignoreFileResponse> {
    artistic_git_app::save_gitignore(request)
}

#[tauri::command]
fn ssh_key_status() -> artistic_git_contracts::AppResult<artistic_git_app::SshKeyStatus> {
    artistic_git_app::ssh_key_status()
}

#[tauri::command]
fn generate_ssh_key(
    request: artistic_git_app::GenerateSshKeyRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::SshKeyStatus> {
    artistic_git_app::generate_ssh_key(request)
}

#[tauri::command]
fn validate_identity_for_write(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::IdentityValidationRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::IdentityValidationResponse> {
    backend.validate_identity_for_write(request)
}

#[tauri::command]
fn list_https_credentials(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> artistic_git_contracts::AppResult<artistic_git_app::HttpsCredentialListResponse> {
    backend.list_https_credentials()
}

#[tauri::command]
fn save_https_credential(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::SaveHttpsCredentialRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::HttpsCredentialEntry> {
    backend.save_https_credential(request)
}

#[tauri::command]
fn delete_https_credential(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::DeleteHttpsCredentialRequest,
) -> artistic_git_contracts::AppResult<()> {
    backend.delete_https_credential(request)
}

#[tauri::command]
fn submit_https_credential_prompt(
    state: State<'_, HttpsCredentialPromptState>,
    request: SubmitHttpsCredentialPromptRequest,
) -> artistic_git_contracts::AppResult<()> {
    state.registry.submit(request).map_err(|message| {
        artistic_git_app::logged_app_error(artistic_git_contracts::AppError::expected(
            message,
            "submitHttpsCredentialPrompt",
        ))
    })
}

#[tauri::command]
fn submit_ssh_passphrase_prompt(
    state: State<'_, SshPassphrasePromptState>,
    request: SubmitSshPassphrasePromptRequest,
) -> artistic_git_contracts::AppResult<()> {
    state.registry.submit(request).map_err(|message| {
        artistic_git_app::logged_app_error(artistic_git_contracts::AppError::expected(
            message,
            "submitSshPassphrasePrompt",
        ))
    })
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(handle_second_instance))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(build_app_menu)
        .on_menu_event(handle_menu_event)
        .on_window_event(handle_window_event);

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = builder.on_web_content_process_terminate(handle_web_content_process_terminate);

    builder
        .setup(|app| {
            let _native_renderer_crash_hook_gate = native_renderer_crash_hook_gate();
            let log_dir = app.path().app_log_dir()?;
            let logging_config = artistic_git_core::logging::LoggingConfig::new(log_dir);
            let logging_guard = artistic_git_core::logging::initialize_logging(&logging_config)?;
            let app_handle = app.handle().clone();
            artistic_git_core::logging::install_panic_hook_with_reporter(move |report| {
                let _ = app_handle.emit("crash-reported", crash_payload_from_panic_report(report));
            });
            app.manage(LoggingState {
                _guard: logging_guard,
            });
            app.manage(WindowRegistry::default());
            app.manage(updater_runtime::UpdaterRuntimeState::default());
            let credential_prompts = Arc::new(HttpsCredentialPromptRegistry::default());
            let ssh_passphrase_prompts = Arc::new(SshPassphrasePromptRegistry::default());
            app.manage(HttpsCredentialPromptState {
                registry: Arc::clone(&credential_prompts),
            });
            app.manage(SshPassphrasePromptState {
                registry: Arc::clone(&ssh_passphrase_prompts),
            });
            app.manage(repository_backend(
                app,
                credential_prompts,
                ssh_passphrase_prompts,
            )?);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            window_context,
            new_project_window,
            open_repository_window,
            register_window_repository,
            save_window_geometry,
            close_current_window,
            set_window_close_guard,
            cancel_pending_window_exit,
            inject_renderer_crash,
            acknowledge_renderer_crash,
            open_log_dir,
            open_update_release_page,
            open_repository,
            clone_repository,
            cancel_clone_repository,
            cancel_operation,
            repository_summary,
            fetch_repository,
            sync_current_branch,
            sync_branch,
            sync_all_branches,
            accept_remote_history,
            start_review_mode,
            sync_review_mode,
            exit_review_mode,
            review_mode_recovery,
            recover_review_mode_stash,
            dismiss_review_mode_recovery,
            load_remote_settings,
            save_remote_settings,
            list_branches,
            list_safety_backups,
            validate_branch_name,
            create_branch,
            checkout_branch,
            delete_branch,
            delete_safety_backup,
            list_local_changes,
            preview_renormalize,
            list_stashes,
            create_stash,
            create_auto_stash,
            stash_details,
            restore_stash,
            cancel_stash_restore,
            delete_stash,
            log_page,
            search_log,
            list_conflicts,
            conflict_detail,
            select_conflict_side,
            save_conflict_resolution,
            complete_conflict_resolution,
            cancel_conflict_resolution,
            commit_changes,
            restore_changes,
            revert_commit,
            abort_revert,
            settings_snapshot,
            load_app_settings,
            save_app_settings,
            load_project_settings,
            save_project_settings,
            load_gitignore,
            save_gitignore,
            ssh_key_status,
            generate_ssh_key,
            validate_identity_for_write,
            list_https_credentials,
            save_https_credential,
            delete_https_credential,
            submit_https_credential_prompt,
            submit_ssh_passphrase_prompt,
            updater_runtime::check_for_updates,
            updater_runtime::update_install_gate,
            updater_runtime::install_ready_update
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Artistic Git")
        .run(handle_run_event);
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn handle_web_content_process_terminate(webview: &tauri::Webview<tauri::Wry>) {
    let label = webview.label().to_owned();
    let app = webview.app_handle().clone();
    if let Some(registry) = app.try_state::<WindowRegistry>() {
        let _ = handle_renderer_crash(&app, &registry, &label, default_renderer_crash_summary());
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn native_renderer_crash_hook_gate() -> &'static str {
    "native-webview-process-terminate-hook:supported:macos-ios"
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn native_renderer_crash_hook_gate() -> &'static str {
    "native-webview-process-terminate-hook:unsupported:windows-linux:requires-tauri-driver-crash-injection-evidence"
}

fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "Artistic Git",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some("About Artistic Git"),
                Some(AboutMetadata {
                    name: Some("Artistic Git".to_owned()),
                    version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                    website: Some(APP_HOMEPAGE.to_owned()),
                    website_label: Some("Project Homepage".to_owned()),
                    ..AboutMetadata::default()
                }),
            )?,
            &MenuItem::with_id(
                app,
                "check-updates",
                "Check for Updates...",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "open-settings",
                "Settings...",
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit Artistic Git"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new-window", "New Window", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(
                app,
                "open-project",
                "Open Project...",
                true,
                Some("CmdOrCtrl+O"),
            )?,
            &MenuItem::with_id(app, "clone-project", "Clone Project...", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "close-window",
                "Close Window",
                true,
                Some("CmdOrCtrl+W"),
            )?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Undo"))?,
            &PredefinedMenuItem::redo(app, Some("Redo"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Cut"))?,
            &PredefinedMenuItem::copy(app, Some("Copy"))?,
            &PredefinedMenuItem::paste(app, Some("Paste"))?,
            &PredefinedMenuItem::select_all(app, Some("Select All"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "view-history", "History", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "view-local-changes",
                "Local Changes",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-theme", "Toggle Theme", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "toggle-devtools",
                "Toggle Developer Tools",
                cfg!(debug_assertions),
                None::<&str>,
            )?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(
                app,
                "open-log-dir",
                "Open Log Directory",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, "open-changelog", "View Changelog", true, None::<&str>)?,
            &MenuItem::with_id(app, "open-homepage", "Project Homepage", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &help])
}

fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();
    match id {
        "new-window" => {
            if let Some(registry) = app.try_state::<WindowRegistry>() {
                let _ = create_start_window(app, &registry);
            }
        }
        "close-window" => {
            if let Some(window) = focused_webview_window(app) {
                if let Some(registry) = app.try_state::<WindowRegistry>() {
                    if let Some(event) = close_guard_block_event(
                        &registry,
                        window.label(),
                        WindowCloseBlockedReason::CloseWindow,
                    ) {
                        let _ = window.emit("window-close-blocked", event);
                        return;
                    }
                }
                let _ = window.close();
            }
        }
        "open-homepage" => {
            open_url(APP_HOMEPAGE);
        }
        "open-changelog" => {
            open_url(APP_CHANGELOG);
        }
        "toggle-devtools" => {
            toggle_focused_devtools(app);
        }
        _ => emit_menu_event_to_focused_window(app, id),
    }
}

fn emit_menu_event_to_focused_window(app: &tauri::AppHandle, id: &str) {
    let event = AppMenuEvent { id: id.to_owned() };
    if let Some(window) = focused_webview_window(app) {
        let _ = window.emit(MENU_EVENT_NAME, event);
    } else {
        let _ = app.emit(MENU_EVENT_NAME, event);
    }
}

fn focused_webview_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
}

fn toggle_focused_devtools(app: &tauri::AppHandle) {
    #[cfg(not(debug_assertions))]
    let _ = app;

    #[cfg(debug_assertions)]
    if let Some(window) = focused_webview_window(app) {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
}

fn create_start_window(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
) -> artistic_git_contracts::AppResult<NewWindowResponse> {
    let label = next_start_window_label(registry)?;
    tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Artistic Git")
        .inner_size(
            artistic_git_core::config::DEFAULT_WINDOW_WIDTH as f64,
            artistic_git_core::config::DEFAULT_WINDOW_HEIGHT as f64,
        )
        .min_inner_size(960.0, 600.0)
        .build()
        .map_err(|error| {
            window_command_error(
                format!("failed to create start window: {error}"),
                "newProjectWindow",
            )
        })?;
    let _ = registry_mark_focused(registry, &label);

    Ok(NewWindowResponse { label })
}

fn build_repository_window(
    app: &tauri::AppHandle,
    label: &str,
    repository_path: &str,
    geometry: Option<artistic_git_core::config::WindowGeometry>,
) -> artistic_git_contracts::AppResult<tauri::WebviewWindow> {
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(
            format!(
                "index.html?repository={}",
                encode_url_component(repository_path)
            )
            .into(),
        ),
    )
    .title("Artistic Git")
    .min_inner_size(960.0, 600.0);

    let geometry = geometry.unwrap_or_default();
    builder = builder
        .inner_size(geometry.width as f64, geometry.height as f64)
        .maximized(geometry.maximized);
    if let (Some(x), Some(y)) = (geometry.x, geometry.y) {
        builder = builder.position(x as f64, y as f64);
    }

    builder.build().map_err(|error| {
        window_command_error(
            format!("failed to create repository window: {error}"),
            "openRepositoryWindow",
        )
    })
}

fn next_start_window_label(registry: &WindowRegistry) -> artistic_git_contracts::AppResult<String> {
    next_window_label(registry, START_WINDOW_LABEL_PREFIX, "newProjectWindow")
}

fn next_repository_window_label(
    registry: &WindowRegistry,
) -> artistic_git_contracts::AppResult<String> {
    next_window_label(
        registry,
        REPOSITORY_WINDOW_LABEL_PREFIX,
        "openRepositoryWindow",
    )
}

fn next_window_label(
    registry: &WindowRegistry,
    prefix: &str,
    operation: &'static str,
) -> artistic_git_contracts::AppResult<String> {
    next_window_label_inner(registry, prefix, operation)
}

fn next_window_label_inner(
    registry: &WindowRegistry,
    prefix: &str,
    operation: &'static str,
) -> artistic_git_contracts::AppResult<String> {
    let mut inner = registry
        .inner
        .lock()
        .map_err(|_| window_command_error("window registry lock poisoned", operation))?;
    inner.next_window_id += 1;
    Ok(format!("{prefix}{}", inner.next_window_id))
}

fn registry_register(
    registry: &WindowRegistry,
    label: String,
    repository_path: String,
) -> artistic_git_contracts::AppResult<()> {
    let mut inner = registry.inner.lock().map_err(|_| {
        window_command_error("window registry lock poisoned", "registerWindowRepository")
    })?;

    if let Some(previous_repository) = inner
        .label_to_repository
        .insert(label.clone(), repository_path.clone())
    {
        inner.repository_to_label.remove(&previous_repository);
    }
    inner.repository_to_label.insert(repository_path, label);
    Ok(())
}

fn registry_unregister(registry: &WindowRegistry, label: &str) {
    if let Ok(mut inner) = registry.inner.lock() {
        if let Some(repository_path) = inner.label_to_repository.remove(label) {
            inner.repository_to_label.remove(&repository_path);
        }
        inner.close_guard_labels.remove(label);
        inner
            .focused_window_labels
            .retain(|focused_label| focused_label != label);
    }
}

fn registry_mark_focused(
    registry: &WindowRegistry,
    label: &str,
) -> artistic_git_contracts::AppResult<()> {
    let mut inner = registry
        .inner
        .lock()
        .map_err(|_| window_command_error("window registry lock poisoned", "focusWindow"))?;
    inner
        .focused_window_labels
        .retain(|focused_label| focused_label != label);
    inner.focused_window_labels.push_front(label.to_owned());
    Ok(())
}

fn registry_recent_focused_label(registry: &WindowRegistry) -> Option<String> {
    registry
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.focused_window_labels.front().cloned())
}

fn registry_set_close_guard(
    registry: &WindowRegistry,
    label: &str,
    active: bool,
) -> artistic_git_contracts::AppResult<()> {
    let mut inner = registry.inner.lock().map_err(|_| {
        window_command_error("window registry lock poisoned", "setWindowCloseGuard")
    })?;
    if active {
        inner.close_guard_labels.insert(label.to_owned());
    } else {
        inner.close_guard_labels.remove(label);
    }
    Ok(())
}

fn registry_close_guarded(registry: &WindowRegistry, label: &str) -> bool {
    registry
        .inner
        .lock()
        .map(|inner| inner.close_guard_labels.contains(label))
        .unwrap_or(false)
}

fn close_guard_block_event(
    registry: &WindowRegistry,
    label: &str,
    reason: WindowCloseBlockedReason,
) -> Option<WindowCloseBlockedEvent> {
    registry_close_guarded(registry, label).then_some(WindowCloseBlockedEvent { reason })
}

fn registry_close_guard_labels(registry: &WindowRegistry) -> Vec<String> {
    registry
        .inner
        .lock()
        .map(|inner| inner.close_guard_labels.iter().cloned().collect())
        .unwrap_or_default()
}

fn registry_set_pending_exit_after_close_guards(
    registry: &WindowRegistry,
    pending: bool,
) -> artistic_git_contracts::AppResult<()> {
    let mut inner = registry.inner.lock().map_err(|_| {
        window_command_error("window registry lock poisoned", "cancelPendingWindowExit")
    })?;
    inner.pending_exit_after_close_guards = pending;
    Ok(())
}

fn registry_pending_exit_after_close_guards(registry: &WindowRegistry) -> bool {
    registry
        .inner
        .lock()
        .map(|inner| inner.pending_exit_after_close_guards)
        .unwrap_or(false)
}

pub(crate) fn registry_has_close_guards(registry: &WindowRegistry) -> bool {
    registry
        .inner
        .lock()
        .map(|inner| !inner.close_guard_labels.is_empty())
        .unwrap_or(false)
}

pub(crate) fn registry_set_update_install_closing_windows(
    registry: &WindowRegistry,
    closing: bool,
) -> artistic_git_contracts::AppResult<()> {
    let mut inner = registry
        .inner
        .lock()
        .map_err(|_| window_command_error("window registry lock poisoned", "installReadyUpdate"))?;
    inner.update_install_closing_windows = closing;
    Ok(())
}

fn registry_update_install_closing_windows(registry: &WindowRegistry) -> bool {
    registry
        .inner
        .lock()
        .map(|inner| inner.update_install_closing_windows)
        .unwrap_or(false)
}

fn registry_set_pending_crash(
    registry: &WindowRegistry,
    label: &str,
    crash: CrashDialogPayload,
) -> artistic_git_contracts::AppResult<()> {
    let mut inner = registry
        .inner
        .lock()
        .map_err(|_| window_command_error("window registry lock poisoned", "rendererCrash"))?;
    inner
        .pending_crashes_by_label
        .insert(label.to_owned(), crash);
    Ok(())
}

fn registry_peek_pending_crash(
    registry: &WindowRegistry,
    label: &str,
) -> Option<CrashDialogPayload> {
    registry
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.pending_crashes_by_label.get(label).cloned())
}

fn registry_clear_pending_crash(
    registry: &WindowRegistry,
    label: &str,
) -> artistic_git_contracts::AppResult<()> {
    let mut inner = registry
        .inner
        .lock()
        .map_err(|_| window_command_error("window registry lock poisoned", "rendererCrash"))?;
    inner.pending_crashes_by_label.remove(label);
    Ok(())
}

fn handle_renderer_crash(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
    label: &str,
    summary: String,
) -> artistic_git_contracts::AppResult<()> {
    let crash = renderer_crash_payload(label, summary);
    registry_set_pending_crash(registry, label, crash)?;

    let Some(window) = app.get_webview_window(label) else {
        return Err(window_command_error(
            format!("failed to reload crashed window {label}: window not found"),
            "rendererCrash",
        ));
    };

    window.reload().map_err(|error| {
        window_command_error(
            format!("failed to reload crashed window {label}: {error}"),
            "rendererCrash",
        )
    })
}

fn renderer_crash_payload(label: &str, summary: String) -> CrashDialogPayload {
    CrashDialogPayload {
        details: format!(
            "Renderer process for window `{label}` was reported unhealthy. The window was reloaded to isolate the crash from other windows."
        ),
        source: CrashDialogSource::Renderer,
        summary,
        window_label: Some(label.to_owned()),
    }
}

fn default_renderer_crash_summary() -> String {
    "Renderer process crashed; this window was reloaded.".to_owned()
}

fn crash_payload_from_panic_report(
    report: artistic_git_core::logging::PanicReport,
) -> CrashDialogPayload {
    CrashDialogPayload {
        details: format!(
            "Rust panic crossed a runtime boundary.\n\nLocation: {}\nPayload: {}",
            report.location, report.payload
        ),
        source: CrashDialogSource::RustPanic,
        summary: format!("Rust panic: {}", report.payload),
        window_label: None,
    }
}

fn registry_label_for_repository(
    registry: &WindowRegistry,
    repository_path: &str,
) -> artistic_git_contracts::AppResult<Option<String>> {
    let inner = registry
        .inner
        .lock()
        .map_err(|_| window_command_error("window registry lock poisoned", "focusRepository"))?;
    Ok(inner.repository_to_label.get(repository_path).cloned())
}

fn focus_window(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn current_window_geometry(
    window: &tauri::Window,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::WindowGeometry> {
    let size = window.outer_size().unwrap_or(PhysicalSize::new(
        artistic_git_core::config::DEFAULT_WINDOW_WIDTH,
        artistic_git_core::config::DEFAULT_WINDOW_HEIGHT,
    ));
    let position = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 0));
    let maximized = window.is_maximized().unwrap_or(false);

    Ok(artistic_git_core::config::WindowGeometry {
        width: size.width,
        height: size.height,
        x: Some(position.x),
        y: Some(position.y),
        maximized,
    })
}

fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    let repository_path = repository_path_from_args(&args, Some(&cwd));
    if let Some(repository_path) = repository_path.clone() {
        if open_second_instance_repository(app, repository_path).is_err() {
            focus_or_create_start_window(app);
        }
    } else {
        focus_or_create_start_window(app);
    }

    let _ = app.emit(
        "second-instance-forwarded",
        SecondInstanceForward {
            args,
            cwd,
            repository_path,
        },
    );
}

fn open_second_instance_repository(
    app: &tauri::AppHandle,
    repository_path: String,
) -> artistic_git_contracts::AppResult<()> {
    let registry = app
        .try_state::<WindowRegistry>()
        .ok_or_else(|| window_command_error("window registry unavailable", "secondInstance"))?;
    let backend = app
        .try_state::<artistic_git_app::RepositoryBackend>()
        .ok_or_else(|| window_command_error("repository backend unavailable", "secondInstance"))?;
    let project_settings = backend
        .load_project_settings(artistic_git_app::ProjectSettingsRequest { repository_path })?;
    open_or_focus_repository_from_settings(app, &registry, project_settings).map(|_| ())
}

fn open_or_focus_repository_from_settings(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
    project_settings: artistic_git_core::config::ProjectSettings,
) -> artistic_git_contracts::AppResult<OpenRepositoryWindowResponse> {
    let repository_path = project_settings.path;
    if let Some(existing_label) = registry_label_for_repository(registry, &repository_path)? {
        focus_window(app, &existing_label);
        let _ = registry_mark_focused(registry, &existing_label);
        return Ok(OpenRepositoryWindowResponse {
            action: OpenRepositoryWindowAction::FocusedExisting,
            label: existing_label,
            repository_path,
        });
    }

    let label = next_repository_window_label(registry)?;
    let window = build_repository_window(
        app,
        &label,
        &repository_path,
        project_settings.window_geometry,
    )?;
    registry_register(registry, label.clone(), repository_path.clone())?;
    let _ = window.set_focus();
    let _ = registry_mark_focused(registry, &label);

    Ok(OpenRepositoryWindowResponse {
        action: OpenRepositoryWindowAction::Created,
        label,
        repository_path,
    })
}

fn focus_or_create_start_window(app: &tauri::AppHandle) {
    if let Some(window) =
        focused_webview_window(app).or_else(|| app.webview_windows().into_values().next())
    {
        focus_window(app, window.label());
        return;
    }

    if let Some(registry) = app.try_state::<WindowRegistry>() {
        let _ = create_start_window(app, &registry);
    }
}

fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    match event {
        WindowEvent::Focused(true) => {
            let label = window.label().to_owned();
            if let Some(registry) = app.try_state::<WindowRegistry>() {
                let _ = registry_mark_focused(&registry, &label);
            }
            updater_runtime::route_unassigned_ready_update_prompt(app, &label);
        }
        WindowEvent::CloseRequested { api, .. } => {
            if let Some(registry) = app.try_state::<WindowRegistry>() {
                if let Some(event) = close_guard_block_event(
                    &registry,
                    window.label(),
                    WindowCloseBlockedReason::CloseWindow,
                ) {
                    api.prevent_close();
                    let _ = window.emit("window-close-blocked", event);
                }
            }
        }
        WindowEvent::Destroyed => {
            let label = window.label().to_owned();
            let mut next_update_prompt_label = None;
            let mut update_install_closing_windows = false;
            if let Some(registry) = app.try_state::<WindowRegistry>() {
                registry_unregister(&registry, &label);
                next_update_prompt_label = registry_recent_focused_label(&registry);
                update_install_closing_windows = registry_update_install_closing_windows(&registry);
                if !update_install_closing_windows
                    && registry_pending_exit_after_close_guards(&registry)
                    && !registry_has_close_guards(&registry)
                {
                    app.exit(0);
                    return;
                }
            }
            updater_runtime::retarget_ready_update_prompt(app, &label, next_update_prompt_label);
            if !update_install_closing_windows {
                exit_if_last_window_closed(app, &label);
            }
        }
        _ => {}
    }
}

fn handle_run_event(app: &tauri::AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, .. } = event {
        if let Some(registry) = app.try_state::<WindowRegistry>() {
            let guarded_labels = registry_close_guard_labels(&registry);
            if guarded_labels.is_empty() {
                return;
            }

            api.prevent_exit();
            let _ = registry_set_pending_exit_after_close_guards(&registry, true);
            emit_close_guard_request(app, guarded_labels, WindowCloseBlockedReason::Quit);
        }
    }
}

fn emit_close_guard_request(
    app: &tauri::AppHandle,
    labels: Vec<String>,
    reason: WindowCloseBlockedReason,
) {
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.emit(
                "window-close-blocked",
                WindowCloseBlockedEvent {
                    reason: reason.clone(),
                },
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn exit_if_last_window_closed(_app: &tauri::AppHandle, _destroyed_label: &str) {}

#[cfg(not(target_os = "macos"))]
fn exit_if_last_window_closed(app: &tauri::AppHandle, destroyed_label: &str) {
    let has_remaining_window = app
        .webview_windows()
        .keys()
        .any(|label| label.as_str() != destroyed_label);
    if !has_remaining_window {
        app.exit(0);
    }
}

fn repository_path_from_args(args: &[String], cwd: Option<&str>) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .find_map(|arg| {
            let path = PathBuf::from(arg);
            let candidate = if path.is_absolute() {
                path
            } else {
                cwd.map(PathBuf::from)
                    .or_else(|| env::current_dir().ok())
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(path)
            };
            fs::metadata(&candidate)
                .ok()
                .filter(|metadata| metadata.is_dir())
                .map(|_| display_path(&candidate))
        })
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn encode_url_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn open_url(url: &str) {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.arg("/C").arg("start").arg("");
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    let _ = command.arg(url).spawn();
}

fn window_command_error(
    message: impl Into<String>,
    operation: &'static str,
) -> artistic_git_contracts::AppError {
    artistic_git_app::unexpected_command_error(message.into(), operation)
}

fn repository_backend(
    app: &tauri::App,
    credential_prompts: Arc<HttpsCredentialPromptRegistry>,
    ssh_passphrase_prompts: Arc<SshPassphrasePromptRegistry>,
) -> Result<artistic_git_app::RepositoryBackend, Box<dyn std::error::Error>> {
    let dist_root = git_dist_root(app)?;
    let app_data_dir = app.path().app_data_dir()?;
    let app_config_dir = app.path().app_config_dir()?;
    fs::create_dir_all(&app_data_dir)?;
    fs::create_dir_all(&app_config_dir)?;

    let runner = artistic_git_git_runner::GitRunner::from_dist_root(
        dist_root,
        app_data_dir.join("git-home"),
    )?;
    runner
        .run_runtime_self_check()
        .map_err(|error| boxed_setup_error(error.summary))?;

    let config =
        artistic_git_core::config::ConfigActor::load(artistic_git_core::config::ConfigPaths::new(
            app_config_dir.join("settings.json"),
            app_data_dir.join("projects.json"),
        ))?;
    let app_handle = app.handle().clone();
    config.subscribe(Arc::new(move |event| {
        let _ = app_handle.emit("config-change", &event);
    }))?;

    Ok(artistic_git_app::RepositoryBackend::with_auth_prompt_sinks(
        runner,
        Some(config),
        Arc::new(TauriHttpsCredentialPromptSink {
            app: app.handle().clone(),
            registry: credential_prompts,
        }),
        Arc::new(TauriSshPassphrasePromptSink {
            app: app.handle().clone(),
            registry: ssh_passphrase_prompts,
        }),
    ))
}

fn git_dist_root(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(path) = env::var_os("ARTISTIC_GIT_DIST_DIR") {
        return Ok(PathBuf::from(path));
    }

    Ok(app.path().resource_dir()?.join("git-dist"))
}

fn boxed_setup_error(message: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(message))
}

fn emit_branch_operation_events(
    app_handle: &tauri::AppHandle,
    response: &artistic_git_contracts::BranchOperationResponse,
) {
    let repository_path = match response {
        artistic_git_contracts::BranchOperationResponse::Completed {
            repository_path, ..
        } => repository_path,
        artistic_git_contracts::BranchOperationResponse::Conflicts {
            repository_path,
            conflict,
            ..
        } => {
            let _ = app_handle.emit("conflict-entered", conflict);
            repository_path
        }
    };

    emit_repo_changed(
        app_handle,
        repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::LocalChanges,
            artistic_git_contracts::RepoQueryKind::Stashes,
            artistic_git_contracts::RepoQueryKind::History,
        ],
    );
}

fn emit_review_exit_events(
    app_handle: &tauri::AppHandle,
    response: &artistic_git_contracts::ExitReviewModeResponse,
) {
    if let Some(conflict) = response.conflict.as_ref() {
        let _ = app_handle.emit("conflict-entered", conflict);
    }
    emit_repo_changed(
        app_handle,
        response.repository_path.clone(),
        vec![
            artistic_git_contracts::RepoQueryKind::Summary,
            artistic_git_contracts::RepoQueryKind::Branches,
            artistic_git_contracts::RepoQueryKind::History,
            artistic_git_contracts::RepoQueryKind::LocalChanges,
            artistic_git_contracts::RepoQueryKind::Stashes,
        ],
    );
}

fn emit_repo_changed(
    app_handle: &tauri::AppHandle,
    repository_path: String,
    changed_queries: Vec<artistic_git_contracts::RepoQueryKind>,
) {
    let _ = app_handle.emit(
        "repo-changed",
        artistic_git_contracts::RepoChangedEvent {
            repository_path,
            changed_queries,
        },
    );
}

fn emit_operation_progress(
    app_handle: &tauri::AppHandle,
    mut event: artistic_git_contracts::OperationProgressEvent,
    repository_path: Option<&str>,
    window_label: &str,
) {
    if let Some(repository_path) = repository_path {
        event.repository_path = Some(repository_path.to_owned());
    }
    event.window_label = Some(window_label.to_owned());

    let _ = app_handle.emit("operation-progress", &event);
}

fn emit_operation_started(
    app_handle: &tauri::AppHandle,
    operation_id: Option<&artistic_git_contracts::OperationId>,
    repository_path: &str,
    window_label: &str,
    label: impl Into<String>,
) {
    let Some(operation_id) = operation_id else {
        return;
    };

    emit_operation_progress(
        app_handle,
        artistic_git_contracts::OperationProgressEvent {
            operation_id: operation_id.clone(),
            label: label.into(),
            progress: artistic_git_contracts::ProgressState::Indeterminate,
            cancellable: true,
            repository_path: None,
            window_label: None,
        },
        Some(repository_path),
        window_label,
    );
}

fn emit_operation_finished(
    app_handle: &tauri::AppHandle,
    operation_id: Option<&artistic_git_contracts::OperationId>,
    repository_path: &str,
    window_label: &str,
    label: impl Into<String>,
) {
    let Some(operation_id) = operation_id else {
        return;
    };

    emit_operation_progress(
        app_handle,
        artistic_git_contracts::OperationProgressEvent {
            operation_id: operation_id.clone(),
            label: label.into(),
            progress: artistic_git_contracts::ProgressState::Percent { value: 100.0 },
            cancellable: false,
            repository_path: None,
            window_label: None,
        },
        Some(repository_path),
        window_label,
    );
}

fn clone_repository_target_path(
    request: &artistic_git_contracts::CloneRepositoryRequest,
) -> String {
    PathBuf::from(request.target_parent_directory.trim())
        .join(request.directory_name.trim())
        .to_string_lossy()
        .into_owned()
}

fn emit_fetch_state(
    app_handle: &tauri::AppHandle,
    event: &artistic_git_contracts::FetchStateEvent,
) {
    let _ = app_handle.emit("fetch-state", event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_menu_url_encoding_keeps_safe_path_characters() {
        assert_eq!(
            encode_url_component("/Users/artist/Project A"),
            "%2FUsers%2Fartist%2FProject%20A"
        );
    }

    #[test]
    fn window_menu_second_instance_ignores_flags() {
        let args = vec![
            "artistic-git".to_owned(),
            "--flag".to_owned(),
            "/definitely/not/a/real/repo".to_owned(),
        ];

        assert_eq!(repository_path_from_args(&args, None), None);
    }

    #[test]
    fn window_menu_second_instance_resolves_relative_repository_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        fs::create_dir(&repo).expect("repo dir");
        let args = vec!["artistic-git".to_owned(), "repo".to_owned()];

        assert_eq!(
            repository_path_from_args(&args, Some(&display_path(dir.path()))),
            Some(display_path(&repo))
        );
    }

    #[test]
    fn window_menu_registry_labels_are_monotonic() {
        let registry = WindowRegistry::default();

        assert_eq!(
            next_window_label_inner(&registry, "repo-", "test").expect("first label"),
            "repo-1"
        );
        assert_eq!(
            next_window_label_inner(&registry, "repo-", "test").expect("second label"),
            "repo-2"
        );
    }

    #[test]
    fn window_menu_registry_unregister_removes_repository_mapping() {
        let registry = WindowRegistry::default();
        registry_register(&registry, "repo-1".to_owned(), "/tmp/project".to_owned())
            .expect("register");

        assert_eq!(
            registry_label_for_repository(&registry, "/tmp/project").expect("lookup"),
            Some("repo-1".to_owned())
        );
        registry_unregister(&registry, "repo-1");
        assert_eq!(
            registry_label_for_repository(&registry, "/tmp/project").expect("lookup"),
            None
        );
    }

    #[test]
    fn window_menu_focus_order_tracks_most_recent_window() {
        let registry = WindowRegistry::default();

        registry_mark_focused(&registry, "repo-1").expect("focus first");
        registry_mark_focused(&registry, "repo-2").expect("focus second");
        registry_mark_focused(&registry, "repo-1").expect("refocus first");

        assert_eq!(
            registry_recent_focused_label(&registry),
            Some("repo-1".to_owned())
        );

        registry_unregister(&registry, "repo-1");
        assert_eq!(
            registry_recent_focused_label(&registry),
            Some("repo-2".to_owned())
        );
    }

    #[test]
    fn window_menu_close_guard_tracks_window_labels() {
        let registry = WindowRegistry::default();
        registry_set_close_guard(&registry, "repo-1", true).expect("set guard");
        assert!(registry_close_guarded(&registry, "repo-1"));

        registry_set_close_guard(&registry, "repo-1", false).expect("clear guard");
        assert!(!registry_close_guarded(&registry, "repo-1"));

        registry_set_close_guard(&registry, "repo-2", true).expect("set guard");
        registry_unregister(&registry, "repo-2");
        assert!(!registry_close_guarded(&registry, "repo-2"));
    }

    #[test]
    fn window_menu_close_guard_lists_guarded_labels() {
        let registry = WindowRegistry::default();
        registry_set_close_guard(&registry, "repo-2", true).expect("set guard");
        registry_set_close_guard(&registry, "repo-1", true).expect("set guard");

        assert_eq!(
            registry_close_guard_labels(&registry),
            vec!["repo-1".to_owned(), "repo-2".to_owned()]
        );
        assert!(registry_has_close_guards(&registry));

        registry_unregister(&registry, "repo-1");
        assert!(registry_has_close_guards(&registry));

        registry_unregister(&registry, "repo-2");
        assert!(!registry_has_close_guards(&registry));
    }

    #[test]
    fn window_menu_registry_tracks_updater_install_window_close() {
        let registry = WindowRegistry::default();
        assert!(!registry_update_install_closing_windows(&registry));

        registry_set_update_install_closing_windows(&registry, true).expect("set install close");
        assert!(registry_update_install_closing_windows(&registry));

        registry_set_update_install_closing_windows(&registry, false).expect("clear install close");
        assert!(!registry_update_install_closing_windows(&registry));
    }

    #[test]
    fn window_menu_close_guard_builds_block_event_for_guarded_window() {
        let registry = WindowRegistry::default();
        registry_set_close_guard(&registry, "repo-1", true).expect("set guard");

        assert_eq!(
            close_guard_block_event(&registry, "repo-1", WindowCloseBlockedReason::CloseWindow),
            Some(WindowCloseBlockedEvent {
                reason: WindowCloseBlockedReason::CloseWindow,
            })
        );
        assert_eq!(
            close_guard_block_event(&registry, "repo-1", WindowCloseBlockedReason::Quit),
            Some(WindowCloseBlockedEvent {
                reason: WindowCloseBlockedReason::Quit,
            })
        );
        assert_eq!(
            close_guard_block_event(&registry, "repo-2", WindowCloseBlockedReason::CloseWindow),
            None
        );
    }

    #[test]
    fn window_menu_pending_exit_waits_for_explicit_cancel() {
        let registry = WindowRegistry::default();
        assert!(!registry_pending_exit_after_close_guards(&registry));

        registry_set_pending_exit_after_close_guards(&registry, true).expect("set pending exit");
        assert!(registry_pending_exit_after_close_guards(&registry));

        registry_unregister(&registry, "repo-1");
        assert!(registry_pending_exit_after_close_guards(&registry));

        registry_set_pending_exit_after_close_guards(&registry, false)
            .expect("cancel pending exit");
        assert!(!registry_pending_exit_after_close_guards(&registry));
    }

    #[test]
    fn window_menu_close_guard_pending_exit_is_ready_after_last_guard_clears() {
        let registry = WindowRegistry::default();
        registry_set_close_guard(&registry, "repo-1", true).expect("guard first");
        registry_set_close_guard(&registry, "repo-2", true).expect("guard second");
        registry_set_pending_exit_after_close_guards(&registry, true).expect("set pending exit");

        registry_unregister(&registry, "repo-1");
        assert!(registry_pending_exit_after_close_guards(&registry));
        assert!(registry_has_close_guards(&registry));

        registry_unregister(&registry, "repo-2");
        assert!(registry_pending_exit_after_close_guards(&registry));
        assert!(!registry_has_close_guards(&registry));
    }

    #[test]
    fn window_menu_renderer_crash_payload_is_peeked_until_acknowledged() {
        let registry = WindowRegistry::default();
        let crash = renderer_crash_payload("repo-1", "Renderer crashed".to_owned());

        registry_set_pending_crash(&registry, "repo-1", crash.clone()).expect("set crash");

        assert_eq!(
            registry_peek_pending_crash(&registry, "repo-1"),
            Some(crash.clone())
        );
        assert_eq!(
            registry_peek_pending_crash(&registry, "repo-1"),
            Some(crash)
        );
        registry_clear_pending_crash(&registry, "repo-1").expect("ack crash");
        assert_eq!(registry_peek_pending_crash(&registry, "repo-1"), None);
    }

    #[test]
    fn window_menu_unregister_preserves_pending_renderer_crash_for_reload() {
        let registry = WindowRegistry::default();
        let crash = renderer_crash_payload("repo-1", "Renderer crashed".to_owned());
        registry_set_pending_crash(&registry, "repo-1", crash.clone()).expect("set crash");

        registry_unregister(&registry, "repo-1");

        assert_eq!(
            registry_peek_pending_crash(&registry, "repo-1"),
            Some(crash)
        );
        registry_clear_pending_crash(&registry, "repo-1").expect("ack crash");
        assert_eq!(registry_peek_pending_crash(&registry, "repo-1"), None);
    }

    #[test]
    fn window_menu_panic_report_maps_to_crash_dialog_payload() {
        let payload = crash_payload_from_panic_report(artistic_git_core::logging::PanicReport {
            location: "src-tauri/src/lib.rs:1:1".to_owned(),
            payload: "panic payload".to_owned(),
        });

        assert_eq!(payload.source, CrashDialogSource::RustPanic);
        assert_eq!(payload.summary, "Rust panic: panic payload");
        assert!(payload.details.contains("src-tauri/src/lib.rs:1:1"));
        assert!(payload.details.contains("panic payload"));
    }

    #[test]
    fn window_menu_native_renderer_crash_hook_gate_is_platform_explicit() {
        let gate = native_renderer_crash_hook_gate();

        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            assert!(gate.contains("supported:macos-ios"));
        }

        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            assert!(gate.contains("unsupported:windows-linux"));
            assert!(gate.contains("requires-tauri-driver-crash-injection-evidence"));
        }
    }
}
