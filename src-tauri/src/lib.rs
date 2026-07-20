use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewUrl, WindowEvent,
};

#[cfg(all(feature = "wdio-e2e", not(debug_assertions)))]
compile_error!("the wdio-e2e feature is restricted to debug E2E builds");

mod updater_runtime;

const MENU_EVENT_NAME: &str = "app-menu";
const APP_HOMEPAGE: &str = "https://github.com/smallmain/artistic-git";
const APP_CHANGELOG: &str = "https://github.com/smallmain/artistic-git/releases";
const START_WINDOW_LABEL_PREFIX: &str = "start-";
const REPOSITORY_WINDOW_LABEL_PREFIX: &str = "repo-";
const AUTH_PROMPT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

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

struct AuthPromptWindowState {
    router: Arc<AuthPromptWindowRouter>,
}

#[derive(Default)]
struct AuthPromptWindowRouter {
    operation_windows: Mutex<BTreeMap<String, String>>,
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
    pending: BTreeMap<String, PendingHttpsCredentialPrompt>,
    ready_windows: BTreeSet<String>,
}

#[derive(Default)]
struct SshPassphrasePromptRegistryInner {
    next_id: u64,
    pending: BTreeMap<String, PendingSshPassphrasePrompt>,
    ready_windows: BTreeSet<String>,
}

struct PendingHttpsCredentialPrompt {
    operation_id: String,
    prompt_id: String,
    sender: mpsc::Sender<HttpsCredentialPromptResponse>,
    window_label: String,
}

struct PendingSshPassphrasePrompt {
    operation_id: String,
    prompt_id: String,
    sender: mpsc::Sender<SshPassphrasePromptResponse>,
    window_label: String,
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
    router: Arc<AuthPromptWindowRouter>,
}

#[derive(Clone)]
struct TauriSshPassphrasePromptSink {
    app: tauri::AppHandle,
    registry: Arc<SshPassphrasePromptRegistry>,
    router: Arc<AuthPromptWindowRouter>,
}

impl artistic_git_app::https_auth::HttpsCredentialPromptSink for TauriHttpsCredentialPromptSink {
    fn prompt_https_credentials(
        &self,
        _request: artistic_git_app::HttpsCredentialPromptRequest,
    ) -> artistic_git_app::https_auth::HttpsCredentialPromptResult {
        artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel
    }

    fn prompt_https_credentials_for_operation(
        &self,
        operation_id: &artistic_git_contracts::OperationId,
        request: artistic_git_app::HttpsCredentialPromptRequest,
    ) -> artistic_git_app::https_auth::HttpsCredentialPromptResult {
        let Some(window_label) = self.router.window_for_operation(operation_id) else {
            return artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel;
        };
        self.registry
            .prompt(&self.app, &window_label, operation_id, request)
    }
}

impl artistic_git_app::ssh_auth::SshPassphrasePromptSink for TauriSshPassphrasePromptSink {
    fn prompt_ssh_passphrase(
        &self,
        _request: artistic_git_app::SshPassphrasePromptRequest,
    ) -> artistic_git_app::ssh_auth::SshPassphrasePromptResult {
        artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel
    }

    fn prompt_ssh_passphrase_for_operation(
        &self,
        operation_id: &artistic_git_contracts::OperationId,
        request: artistic_git_app::SshPassphrasePromptRequest,
    ) -> artistic_git_app::ssh_auth::SshPassphrasePromptResult {
        let Some(window_label) = self.router.window_for_operation(operation_id) else {
            return artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel;
        };
        self.registry
            .prompt(&self.app, &window_label, operation_id, request)
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthPromptDismissedEvent {
    prompt_id: String,
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

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum AuthPromptKind {
    HttpsCredential,
    SshPassphrase,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthPromptListenerReadyRequest {
    kind: AuthPromptKind,
    ready: bool,
}

impl AuthPromptWindowRouter {
    fn register(&self, operation_id: &artistic_git_contracts::OperationId, window_label: &str) {
        if let Ok(mut operation_windows) = self.operation_windows.lock() {
            operation_windows.insert(operation_id.as_str().to_owned(), window_label.to_owned());
        }
    }

    fn unregister(&self, operation_id: &artistic_git_contracts::OperationId) {
        if let Ok(mut operation_windows) = self.operation_windows.lock() {
            operation_windows.remove(operation_id.as_str());
        }
    }

    fn remove_window(&self, window_label: &str) {
        if let Ok(mut operation_windows) = self.operation_windows.lock() {
            operation_windows.retain(|_, label| label != window_label);
        }
    }

    fn window_for_operation(
        &self,
        operation_id: &artistic_git_contracts::OperationId,
    ) -> Option<String> {
        self.operation_windows
            .lock()
            .ok()?
            .get(operation_id.as_str())
            .cloned()
    }
}

impl HttpsCredentialPromptRegistry {
    fn prompt(
        &self,
        app: &tauri::AppHandle,
        window_label: &str,
        operation_id: &artistic_git_contracts::OperationId,
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
            if !inner.ready_windows.contains(window_label) {
                return artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel;
            }
            inner.next_id = inner.next_id.saturating_add(1);
            let prompt_id = format!("https-credential-{}", inner.next_id);
            inner.pending.insert(
                prompt_id.clone(),
                PendingHttpsCredentialPrompt {
                    operation_id: operation_id.as_str().to_owned(),
                    prompt_id: prompt_id.clone(),
                    sender: tx,
                    window_label: window_label.to_owned(),
                },
            );
            prompt_id
        };

        let event = HttpsCredentialPromptEvent {
            prompt_id: prompt_id.clone(),
            request,
        };
        if app.get_webview_window(window_label).is_none()
            || app
                .emit_to(window_label, "https-credential-prompt", event)
                .is_err()
        {
            self.remove(&prompt_id);
            return artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel;
        }

        let result = match rx.recv_timeout(AUTH_PROMPT_RESPONSE_TIMEOUT) {
            Ok(HttpsCredentialPromptResponse::Submit(submission)) => {
                artistic_git_app::https_auth::HttpsCredentialPromptResult::Submit(submission)
            }
            Ok(HttpsCredentialPromptResponse::Cancel) => {
                artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel
            }
            Err(_) => {
                emit_auth_prompt_dismissed(
                    app,
                    window_label,
                    "https-credential-prompt-dismissed",
                    &prompt_id,
                );
                artistic_git_app::https_auth::HttpsCredentialPromptResult::Cancel
            }
        };
        self.remove(&prompt_id);
        result
    }

    fn submit(&self, request: SubmitHttpsCredentialPromptRequest) -> Result<(), String> {
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

        let sender = self.remove(&request.prompt_id).ok_or_else(|| {
            format!(
                "HTTPS credential prompt {} is no longer active",
                request.prompt_id
            )
        })?;

        sender
            .send(response)
            .map_err(|_| "HTTPS credential prompt receiver was dropped".to_owned())
    }

    fn set_window_ready(&self, app: &tauri::AppHandle, window_label: &str, ready: bool) {
        let pending = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            if ready {
                inner.ready_windows.insert(window_label.to_owned());
                Vec::new()
            } else {
                inner.ready_windows.remove(window_label);
                take_https_prompts_matching(&mut inner.pending, |pending| {
                    pending.window_label == window_label
                })
            }
        };
        for prompt in pending {
            emit_auth_prompt_dismissed(
                app,
                &prompt.window_label,
                "https-credential-prompt-dismissed",
                &prompt.prompt_id,
            );
            let _ = prompt.sender.send(HttpsCredentialPromptResponse::Cancel);
        }
    }

    fn cancel_operation(
        &self,
        app: &tauri::AppHandle,
        operation_id: &artistic_git_contracts::OperationId,
    ) {
        let pending = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            take_https_prompts_matching(&mut inner.pending, |pending| {
                pending.operation_id == operation_id.as_str()
            })
        };
        for prompt in pending {
            emit_auth_prompt_dismissed(
                app,
                &prompt.window_label,
                "https-credential-prompt-dismissed",
                &prompt.prompt_id,
            );
            let _ = prompt.sender.send(HttpsCredentialPromptResponse::Cancel);
        }
    }

    fn remove(&self, prompt_id: &str) -> Option<mpsc::Sender<HttpsCredentialPromptResponse>> {
        self.inner
            .lock()
            .ok()?
            .pending
            .remove(prompt_id)
            .map(|pending| pending.sender)
    }
}

impl SshPassphrasePromptRegistry {
    fn prompt(
        &self,
        app: &tauri::AppHandle,
        window_label: &str,
        operation_id: &artistic_git_contracts::OperationId,
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
            if !inner.ready_windows.contains(window_label) {
                return artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel;
            }
            inner.next_id = inner.next_id.saturating_add(1);
            let prompt_id = format!("ssh-passphrase-{}", inner.next_id);
            inner.pending.insert(
                prompt_id.clone(),
                PendingSshPassphrasePrompt {
                    operation_id: operation_id.as_str().to_owned(),
                    prompt_id: prompt_id.clone(),
                    sender: tx,
                    window_label: window_label.to_owned(),
                },
            );
            prompt_id
        };

        let event = SshPassphrasePromptEvent {
            prompt_id: prompt_id.clone(),
            request,
        };
        if app.get_webview_window(window_label).is_none()
            || app
                .emit_to(window_label, "ssh-passphrase-prompt", event)
                .is_err()
        {
            self.remove(&prompt_id);
            return artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel;
        }

        let result = match rx.recv_timeout(AUTH_PROMPT_RESPONSE_TIMEOUT) {
            Ok(SshPassphrasePromptResponse::Submit(submission)) => {
                artistic_git_app::ssh_auth::SshPassphrasePromptResult::Submit(submission)
            }
            Ok(SshPassphrasePromptResponse::Cancel) => {
                artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel
            }
            Err(_) => {
                emit_auth_prompt_dismissed(
                    app,
                    window_label,
                    "ssh-passphrase-prompt-dismissed",
                    &prompt_id,
                );
                artistic_git_app::ssh_auth::SshPassphrasePromptResult::Cancel
            }
        };
        self.remove(&prompt_id);
        result
    }

    fn submit(&self, request: SubmitSshPassphrasePromptRequest) -> Result<(), String> {
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

        let sender = self.remove(&request.prompt_id).ok_or_else(|| {
            format!(
                "SSH passphrase prompt {} is no longer active",
                request.prompt_id
            )
        })?;

        sender
            .send(response)
            .map_err(|_| "SSH passphrase prompt receiver was dropped".to_owned())
    }

    fn set_window_ready(&self, app: &tauri::AppHandle, window_label: &str, ready: bool) {
        let pending = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            if ready {
                inner.ready_windows.insert(window_label.to_owned());
                Vec::new()
            } else {
                inner.ready_windows.remove(window_label);
                take_ssh_prompts_matching(&mut inner.pending, |pending| {
                    pending.window_label == window_label
                })
            }
        };
        for prompt in pending {
            emit_auth_prompt_dismissed(
                app,
                &prompt.window_label,
                "ssh-passphrase-prompt-dismissed",
                &prompt.prompt_id,
            );
            let _ = prompt.sender.send(SshPassphrasePromptResponse::Cancel);
        }
    }

    fn cancel_operation(
        &self,
        app: &tauri::AppHandle,
        operation_id: &artistic_git_contracts::OperationId,
    ) {
        let pending = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            take_ssh_prompts_matching(&mut inner.pending, |pending| {
                pending.operation_id == operation_id.as_str()
            })
        };
        for prompt in pending {
            emit_auth_prompt_dismissed(
                app,
                &prompt.window_label,
                "ssh-passphrase-prompt-dismissed",
                &prompt.prompt_id,
            );
            let _ = prompt.sender.send(SshPassphrasePromptResponse::Cancel);
        }
    }

    fn remove(&self, prompt_id: &str) -> Option<mpsc::Sender<SshPassphrasePromptResponse>> {
        self.inner
            .lock()
            .ok()?
            .pending
            .remove(prompt_id)
            .map(|pending| pending.sender)
    }
}

fn take_https_prompts_matching(
    pending: &mut BTreeMap<String, PendingHttpsCredentialPrompt>,
    matches: impl Fn(&PendingHttpsCredentialPrompt) -> bool,
) -> Vec<PendingHttpsCredentialPrompt> {
    let prompt_ids = pending
        .iter()
        .filter_map(|(prompt_id, prompt)| matches(prompt).then_some(prompt_id.clone()))
        .collect::<Vec<_>>();
    prompt_ids
        .into_iter()
        .filter_map(|prompt_id| pending.remove(&prompt_id))
        .collect()
}

fn take_ssh_prompts_matching(
    pending: &mut BTreeMap<String, PendingSshPassphrasePrompt>,
    matches: impl Fn(&PendingSshPassphrasePrompt) -> bool,
) -> Vec<PendingSshPassphrasePrompt> {
    let prompt_ids = pending
        .iter()
        .filter_map(|(prompt_id, prompt)| matches(prompt).then_some(prompt_id.clone()))
        .collect::<Vec<_>>();
    prompt_ids
        .into_iter()
        .filter_map(|prompt_id| pending.remove(&prompt_id))
        .collect()
}

fn emit_auth_prompt_dismissed(
    app: &tauri::AppHandle,
    window_label: &str,
    event_name: &str,
    prompt_id: &str,
) {
    let _ = app.emit_to(
        window_label,
        event_name,
        AuthPromptDismissedEvent {
            prompt_id: prompt_id.to_owned(),
        },
    );
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

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewWindowRequest {
    initial_action: Option<String>,
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

struct SecondInstanceDispatch {
    args: Vec<String>,
    cwd: String,
}

struct SecondInstanceDispatchState {
    sender: mpsc::Sender<SecondInstanceDispatch>,
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
    request: Option<NewWindowRequest>,
) -> artistic_git_contracts::AppResult<NewWindowResponse> {
    create_start_window(
        &app_handle,
        &registry,
        request
            .as_ref()
            .and_then(|request| request.initial_action.as_deref()),
    )
}

#[tauri::command]
async fn open_repository_window(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: OpenRepositoryWindowRequest,
) -> artistic_git_contracts::AppResult<OpenRepositoryWindowResponse> {
    let current_label = window.label().to_owned();
    let backend = backend.inner().clone();
    let project_settings = run_blocking_command("openRepositoryWindow", move || {
        backend.load_project_settings(artistic_git_app::ProjectSettingsRequest {
            repository_path: request.repository_path,
        })
    })
    .await?;
    ensure_webview_window_exists(&app_handle, &current_label, "openRepositoryWindow")?;
    let repository_path = project_settings.path;

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
async fn register_window_repository(
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: OpenRepositoryWindowRequest,
) -> artistic_git_contracts::AppResult<WindowContextResponse> {
    let app_handle = window.app_handle().clone();
    let label = window.label().to_owned();
    let backend = backend.inner().clone();
    let project_settings = run_blocking_command("registerWindowRepository", move || {
        backend.load_project_settings(artistic_git_app::ProjectSettingsRequest {
            repository_path: request.repository_path,
        })
    })
    .await?;
    ensure_webview_window_exists(&app_handle, &label, "registerWindowRepository")?;
    registry_register(&registry, label.clone(), project_settings.path.clone())?;

    Ok(WindowContextResponse {
        label,
        pending_crash: None,
        repository_path: Some(project_settings.path),
    })
}

#[tauri::command]
async fn save_window_geometry(
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: OpenRepositoryWindowRequest,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::ProjectSettings> {
    let geometry = current_window_geometry(&window)?;
    let backend = backend.inner().clone();
    run_blocking_command("saveWindowGeometry", move || {
        backend.save_project_window_geometry(request.repository_path, geometry)
    })
    .await
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

    let mut response = artistic_git_app::open_log_dir(log_dir)?;
    open_external_target(&response.path, "openLogDir")?;
    response.opened = true;
    Ok(response)
}

#[tauri::command]
fn open_update_release_page() -> artistic_git_contracts::AppResult<()> {
    open_external_target(APP_CHANGELOG, "openUpdateReleasePage")
}

#[tauri::command]
async fn open_repository(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::OpenRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::OpenRepositoryResponse> {
    let repository_path = request.path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "openRepository",
        "Opening repository",
    )?;
    let worker_backend = backend.inner().clone();
    let progress_app_handle = app_handle.clone();
    let progress_repository_path = repository_path.clone();
    let progress_window_label = window_label.clone();
    let result = run_blocking_command("openRepository", move || {
        let _operation_reservation = operation_reservation;
        worker_backend.open_repository_with_progress(request, |event| {
            emit_operation_progress(
                &progress_app_handle,
                event,
                Some(progress_repository_path.as_str()),
                progress_window_label.as_str(),
            );
        })
    })
    .await;
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Repository opened",
    );
    result
}

#[tauri::command]
async fn probe_remote_repository(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RemoteRepositoryProbeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RemoteRepositoryProbeResponse> {
    let operation_id = request.operation_id.clone();
    let operation_reservation = backend
        .inner()
        .reserve_cancellable_operation(request.operation_id.as_ref(), "probeRemoteRepository")?;
    register_auth_prompt_window(&app_handle, operation_id.as_ref(), window.label());
    let backend = backend.inner().clone();
    let result = run_blocking_command("probeRemoteRepository", move || {
        let _operation_reservation = operation_reservation;
        backend.probe_remote_repository(request)
    })
    .await;
    finish_auth_prompt_operation(&app_handle, operation_id.as_ref());
    result
}

#[tauri::command]
async fn clone_repository(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CloneRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CloneRepositoryResponse> {
    let repository_path = clone_repository_target_path(&request);
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "cloneRepository",
        "Cloning repository",
    )?;
    let worker_backend = backend.inner().clone();
    let progress_app_handle = app_handle.clone();
    let progress_repository_path = repository_path.clone();
    let progress_window_label = window_label.clone();
    let result = run_blocking_command("cloneRepository", move || {
        let _operation_reservation = operation_reservation;
        worker_backend.clone_repository_with_progress(request, |event| {
            emit_operation_progress(
                &progress_app_handle,
                event,
                Some(progress_repository_path.as_str()),
                progress_window_label.as_str(),
            );
        })
    })
    .await;
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Clone complete",
    );
    result
}

#[tauri::command]
async fn cancel_clone_repository(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CancelCloneRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CancelCloneRepositoryResponse> {
    cancel_auth_prompt_waiters(&app_handle, &request.operation_id);
    let backend = backend.inner().clone();
    run_blocking_command("cancelCloneRepository", move || {
        backend.cancel_clone_repository_and_wait(request)
    })
    .await
}

#[tauri::command]
async fn cancel_operation(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CancelOperationRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CancelOperationResponse> {
    cancel_auth_prompt_waiters(&app_handle, &request.operation_id);
    let backend = backend.inner().clone();
    run_blocking_command("cancelOperation", move || {
        backend.cancel_operation_and_wait(request)
    })
    .await
}

#[tauri::command]
async fn repository_summary(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RepositorySummary> {
    let backend = backend.inner().clone();
    run_blocking_command("repositorySummary", move || {
        backend.repository_summary(request)
    })
    .await
}

#[tauri::command]
async fn reset_bisect(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RepositorySummary> {
    let repository_path = request.repository_path.clone();
    let backend = backend.inner().clone();
    let response =
        run_blocking_command("resetBisect", move || backend.reset_bisect(request)).await?;
    emit_repo_changed(
        &app_handle,
        repository_path,
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
async fn fetch_repository(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::FetchRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::FetchRepositoryResponse> {
    let repository_path = request.repository_path.clone();
    let backend = backend.inner().clone();
    let started = backend.fetch_started_event(&repository_path);
    emit_fetch_state(&app_handle, &started);
    let worker_backend = backend.clone();

    match run_blocking_command("fetchRepository", move || {
        worker_backend.fetch_repository(request)
    })
    .await
    {
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
            let failed = backend.fetch_failed_event(&repository_path, error.summary.clone());
            emit_fetch_state(&app_handle, &failed);
            Err(error)
        }
    }
}

#[tauri::command]
async fn sync_current_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SyncCurrentBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncCurrentBranchResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "syncCurrentBranch",
        "Syncing",
    )?;
    let worker_backend = backend.inner().clone();
    let progress_app_handle = app_handle.clone();
    let progress_repository_path = repository_path.clone();
    let progress_window_label = window_label.clone();
    let result = run_blocking_command("syncCurrentBranch", move || {
        let _operation_reservation = operation_reservation;
        worker_backend.sync_current_branch_with_progress(request, |event| {
            emit_operation_progress(
                &progress_app_handle,
                event,
                Some(progress_repository_path.as_str()),
                progress_window_label.as_str(),
            );
        })
    })
    .await;
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Sync complete",
    );
    let response = result?;
    if response.status != artistic_git_contracts::SyncCurrentBranchStatus::Failed {
        let fetch_state = backend.fetch_succeeded_event(&response.repository_path);
        emit_fetch_state(&app_handle, &fetch_state);
    }
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
async fn sync_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SyncBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncBranchResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "syncBranch",
        "Syncing",
    )?;
    let worker_backend = backend.inner().clone();
    let progress_app_handle = app_handle.clone();
    let progress_repository_path = repository_path.clone();
    let progress_window_label = window_label.clone();
    let result = run_blocking_command("syncBranch", move || {
        let _operation_reservation = operation_reservation;
        worker_backend.sync_branch_with_progress(request, |event| {
            emit_operation_progress(
                &progress_app_handle,
                event,
                Some(progress_repository_path.as_str()),
                progress_window_label.as_str(),
            );
        })
    })
    .await;
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Sync complete",
    );
    let response = result?;
    if response.status != artistic_git_contracts::SyncCurrentBranchStatus::Failed {
        let fetch_state = backend.fetch_succeeded_event(&response.repository_path);
        emit_fetch_state(&app_handle, &fetch_state);
    }
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
async fn sync_all_branches(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SyncAllBranchesRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncAllBranchesResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "syncAllBranches",
        "Syncing",
    )?;
    let worker_backend = backend.inner().clone();
    let progress_app_handle = app_handle.clone();
    let progress_repository_path = repository_path.clone();
    let progress_window_label = window_label.clone();
    let result = run_blocking_command("syncAllBranches", move || {
        let _operation_reservation = operation_reservation;
        worker_backend.sync_all_branches_with_progress(request, |event| {
            emit_operation_progress(
                &progress_app_handle,
                event,
                Some(progress_repository_path.as_str()),
                progress_window_label.as_str(),
            );
        })
    })
    .await;
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Sync complete",
    );
    let response = result?;
    let fetch_state = backend.fetch_succeeded_event(&response.repository_path);
    emit_fetch_state(&app_handle, &fetch_state);
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
async fn accept_remote_history(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::AcceptRemoteHistoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::AcceptRemoteHistoryResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "acceptRemoteHistory",
        "Accepting remote history",
    )?;
    let worker_backend = backend.inner().clone();
    let result = run_blocking_command("acceptRemoteHistory", move || {
        let _operation_reservation = operation_reservation;
        worker_backend.accept_remote_history(request)
    })
    .await;
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Remote history accepted",
    );
    let response = result?;
    let fetch_state = backend.fetch_succeeded_event(&response.repository_path);
    emit_fetch_state(&app_handle, &fetch_state);
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
async fn start_review_mode(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::StartReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::StartReviewModeResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "startReviewMode",
        "Starting review mode",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("startReviewMode", move || {
        let _operation_reservation = operation_reservation;
        backend.start_review_mode(request)
    })
    .await;
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
async fn sync_review_mode(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncReviewModeResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "syncReviewMode",
        "Syncing review mode",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("syncReviewMode", move || {
        let _operation_reservation = operation_reservation;
        backend.sync_review_mode(request)
    })
    .await;
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
async fn exit_review_mode(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ExitReviewModeResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "exitReviewMode",
        "Exiting review mode",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("exitReviewMode", move || {
        let _operation_reservation = operation_reservation;
        backend.exit_review_mode(request)
    })
    .await;
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
async fn review_mode_recovery(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRecoveryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ReviewModeRecoveryResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("reviewModeRecovery", move || {
        backend.review_mode_recovery(request)
    })
    .await
}

#[tauri::command]
async fn recover_review_mode_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRecoveryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ExitReviewModeResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "recoverReviewModeStash",
        "Recovering review mode",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("recoverReviewModeStash", move || {
        let _operation_reservation = operation_reservation;
        backend.recover_review_mode_stash(request)
    })
    .await;
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
async fn dismiss_review_mode_recovery(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRecoveryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ReviewModeRecoveryResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("dismissReviewModeRecovery", move || {
        backend.dismiss_review_mode_recovery(request)
    })
    .await
}

#[tauri::command]
async fn load_remote_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RemoteSettingsResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("loadRemoteSettings", move || {
        backend.load_remote_settings(request)
    })
    .await
}

#[tauri::command]
async fn save_remote_settings(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SaveRemoteSettingsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RemoteSettingsResponse> {
    let backend = backend.inner().clone();
    let response = run_blocking_command("saveRemoteSettings", move || {
        backend.save_remote_settings(request)
    })
    .await?;
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
async fn list_branches(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchListResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("listBranches", move || backend.list_branches(request)).await
}

#[tauri::command]
async fn list_safety_backups(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SafetyBackupListResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("listSafetyBackups", move || {
        backend.list_safety_backups(request)
    })
    .await
}

#[tauri::command]
async fn validate_branch_name(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::BranchNameValidationRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchNameValidationResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("validateBranchName", move || {
        backend.validate_branch_name(request)
    })
    .await
}

#[tauri::command]
async fn create_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "createBranch",
        "Creating branch",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("createBranch", move || {
        let _operation_reservation = operation_reservation;
        backend.create_branch(request)
    })
    .await;
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
async fn checkout_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CheckoutBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "checkoutBranch",
        "Switching branch",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("checkoutBranch", move || {
        let _operation_reservation = operation_reservation;
        backend.checkout_branch(request)
    })
    .await;
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
async fn delete_branch(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "deleteBranch",
        "Deleting branch",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("deleteBranch", move || {
        let _operation_reservation = operation_reservation;
        backend.delete_branch(request)
    })
    .await;
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
async fn delete_safety_backup(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteSafetyBackupRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::DeleteSafetyBackupResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "deleteSafetyBackup",
        "Deleting safety backup",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("deleteSafetyBackup", move || {
        let _operation_reservation = operation_reservation;
        backend.delete_safety_backup(request)
    })
    .await;
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
async fn list_local_changes(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::LocalChangesResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("listLocalChanges", move || {
        backend.list_local_changes(request)
    })
    .await
}

#[tauri::command]
async fn local_change_detail(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::LocalChangeDetailRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::LocalChange> {
    let operation_reservation = backend
        .inner()
        .reserve_cancellable_operation(request.operation_id.as_ref(), "localChangeDetail")?;
    let backend = backend.inner().clone();
    run_blocking_command("localChangeDetail", move || {
        let _operation_reservation = operation_reservation;
        backend.local_change_detail(request)
    })
    .await
}

#[tauri::command]
async fn preview_renormalize(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RenormalizePreviewRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RenormalizePreviewResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("previewRenormalize", move || {
        backend.preview_renormalize(request)
    })
    .await
}

#[tauri::command]
async fn list_stashes(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::StashListResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("listStashes", move || backend.list_stashes(request)).await
}

#[tauri::command]
async fn create_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CreateStashResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "createStash",
        "Creating stash",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("createStash", move || {
        let _operation_reservation = operation_reservation;
        backend.create_stash(request)
    })
    .await;
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
async fn create_auto_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateAutoStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CreateStashResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "createAutoStash",
        "Creating stash",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("createAutoStash", move || {
        let _operation_reservation = operation_reservation;
        backend.create_auto_stash(request)
    })
    .await;
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
async fn stash_details(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::StashDetailsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::StashDetailsResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("stashDetails", move || backend.stash_details(request)).await
}

#[tauri::command]
async fn restore_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RestoreStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RestoreStashResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "restoreStash",
        "Applying stash",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("restoreStash", move || {
        let _operation_reservation = operation_reservation;
        backend.restore_stash(request)
    })
    .await;
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
async fn cancel_stash_restore(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CancelStashRestoreRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CancelStashRestoreResponse> {
    let repository_path = request.repository_path.clone();
    let backend = backend.inner().clone();
    let response = run_blocking_command("cancelStashRestore", move || {
        backend.cancel_stash_restore(request)
    })
    .await?;
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
async fn delete_stash(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::DeleteStashResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "deleteStash",
        "Deleting stash",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("deleteStash", move || {
        let _operation_reservation = operation_reservation;
        backend.delete_stash(request)
    })
    .await;
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
async fn log_page(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::LogPageRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::LogPageResponse> {
    let operation_id = request.operation_id.clone();
    let operation_reservation =
        backend.reserve_cancellable_operation(operation_id.as_ref(), "logPage")?;
    let backend = backend.inner().clone();
    run_blocking_command("logPage", move || {
        let _operation_reservation = operation_reservation;
        backend.log_page(request)
    })
    .await
}

#[tauri::command]
async fn search_log(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::LogSearchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::LogPageResponse> {
    let operation_id = request.operation_id.clone();
    let operation_reservation =
        backend.reserve_cancellable_operation(operation_id.as_ref(), "searchLog")?;
    let backend = backend.inner().clone();
    run_blocking_command("searchLog", move || {
        let _operation_reservation = operation_reservation;
        backend.search_log(request)
    })
    .await
}

#[tauri::command]
async fn commit_details(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CommitDetailsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CommitDetailsResponse> {
    let operation_id = request.operation_id.clone();
    let operation_reservation =
        backend.reserve_cancellable_operation(operation_id.as_ref(), "commitDetails")?;
    let backend = backend.inner().clone();
    run_blocking_command("commitDetails", move || {
        let _operation_reservation = operation_reservation;
        backend.commit_details(request)
    })
    .await
}

#[tauri::command]
async fn commit_file_detail(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CommitFileDetailRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CommitFileDetailResponse> {
    let operation_id = request.operation_id.clone();
    let operation_reservation =
        backend.reserve_cancellable_operation(operation_id.as_ref(), "commitFileDetail")?;
    let backend = backend.inner().clone();
    run_blocking_command("commitFileDetail", move || {
        let _operation_reservation = operation_reservation;
        backend.commit_file_detail(request)
    })
    .await
}

#[tauri::command]
async fn list_conflicts(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictListRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictListResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("listConflicts", move || backend.list_conflicts(request)).await
}

#[tauri::command]
async fn conflict_detail(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictDetailResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("conflictDetail", move || backend.conflict_detail(request)).await
}

#[tauri::command]
async fn select_conflict_side(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictSelectSideRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictSelectSideResponse> {
    let repository_path = request.repository_path.clone();
    let operation_id = request.operation_id.clone();
    let window_label = window.label().to_owned();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "selectConflictSide",
        "Applying conflict selection",
    )?;
    let worker_backend = backend.inner().clone();
    let result = run_blocking_command("selectConflictSide", move || {
        let _operation_reservation = operation_reservation;
        worker_backend.select_conflict_side(request)
    })
    .await;
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Conflict selection complete",
    );
    let response = result?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
    );
    Ok(response)
}

#[tauri::command]
async fn save_conflict_resolution(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictSaveResolutionRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictSaveResolutionResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("saveConflictResolution", move || {
        backend.save_conflict_resolution(request)
    })
    .await
}

#[tauri::command]
async fn complete_conflict_resolution(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictCompleteRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictCompleteResponse> {
    let repository_path = request.repository_path.clone();
    let backend = backend.inner().clone();
    let response = run_blocking_command("completeConflictResolution", move || {
        backend.complete_conflict_resolution(request)
    })
    .await?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
    );
    Ok(response)
}

#[tauri::command]
async fn cancel_conflict_resolution(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ConflictCancelRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ConflictCancelResponse> {
    let repository_path = request.repository_path.clone();
    let backend = backend.inner().clone();
    let response = run_blocking_command("cancelConflictResolution", move || {
        backend.cancel_conflict_resolution(request)
    })
    .await?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
    );
    Ok(response)
}

#[tauri::command]
async fn commit_changes(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CommitRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CommitResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "commitChanges",
        "Committing changes",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("commitChanges", move || {
        let _operation_reservation = operation_reservation;
        backend.commit_changes(request)
    })
    .await;
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
async fn restore_changes(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RestoreChangesRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RestoreChangesResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "restoreChanges",
        "Restoring changes",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("restoreChanges", move || {
        let _operation_reservation = operation_reservation;
        backend.restore_changes(request)
    })
    .await;
    emit_operation_finished(
        &app_handle,
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "Changes restored",
    );
    let response = result?;
    emit_repo_changed(
        &app_handle,
        repository_path,
        vec![artistic_git_contracts::RepoQueryKind::LocalChanges],
    );
    Ok(response)
}

#[tauri::command]
async fn revert_commit(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RevertCommitRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RevertCommitResponse> {
    let repository_path = request.repository_path.clone();
    let window_label = window.label().to_owned();
    let operation_id = request.operation_id.clone();
    let operation_reservation = reserve_and_emit_operation_started(
        &app_handle,
        backend.inner(),
        operation_id.as_ref(),
        repository_path.as_str(),
        window_label.as_str(),
        "revertCommit",
        "Reverting commit",
    )?;
    let backend = backend.inner().clone();
    let result = run_blocking_command("revertCommit", move || {
        let _operation_reservation = operation_reservation;
        backend.revert_commit(request)
    })
    .await;
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
async fn abort_revert(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::AbortRevertRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::AbortRevertResponse> {
    let repository_path = request.repository_path.clone();
    let backend = backend.inner().clone();
    let response =
        run_blocking_command("abortRevert", move || backend.abort_revert(request)).await?;
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
async fn settings_snapshot(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> artistic_git_contracts::AppResult<artistic_git_app::SettingsSnapshot> {
    let backend = backend.inner().clone();
    run_blocking_command("settingsSnapshot", move || backend.settings_snapshot()).await
}

#[tauri::command]
async fn load_app_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::AppSettings> {
    let backend = backend.inner().clone();
    run_blocking_command("loadAppSettings", move || backend.load_app_settings()).await
}

#[tauri::command]
async fn list_recent_projects(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::RecentProjectsRequest,
) -> artistic_git_contracts::AppResult<Vec<artistic_git_app::RecentProjectEntry>> {
    let backend = backend.inner().clone();
    run_blocking_command("listRecentProjects", move || {
        backend.list_recent_projects(request)
    })
    .await
}

#[tauri::command]
async fn forget_recent_project(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::ForgetRecentProjectRequest,
) -> artistic_git_contracts::AppResult<()> {
    let backend = backend.inner().clone();
    run_blocking_command("forgetRecentProject", move || {
        backend.forget_recent_project(request)
    })
    .await
}

#[tauri::command]
async fn clear_recent_projects(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> artistic_git_contracts::AppResult<()> {
    let backend = backend.inner().clone();
    run_blocking_command("clearRecentProjects", move || {
        backend.clear_recent_projects()
    })
    .await
}

#[tauri::command]
async fn save_app_settings(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::SaveAppSettingsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::AppSettings> {
    let backend = backend.inner().clone();
    let settings = run_blocking_command("saveAppSettings", move || {
        backend.save_app_settings(request)
    })
    .await?;
    match build_app_menu_for_language(&app_handle, resolved_menu_language(settings.language)) {
        Ok(menu) => {
            if let Err(error) = app_handle.set_menu(menu) {
                emit_native_app_error(
                    &app_handle,
                    artistic_git_app::unexpected_command_error(
                        format!("settings were saved, but the application menu could not be updated: {error}"),
                        "saveAppSettings",
                    ),
                );
            }
        }
        Err(error) => emit_native_app_error(
            &app_handle,
            artistic_git_app::unexpected_command_error(
                format!(
                    "settings were saved, but the application menu could not be rebuilt: {error}"
                ),
                "saveAppSettings",
            ),
        ),
    }
    Ok(settings)
}

#[tauri::command]
async fn load_project_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::ProjectSettingsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::ProjectSettings> {
    let backend = backend.inner().clone();
    run_blocking_command("loadProjectSettings", move || {
        backend.load_project_settings(request)
    })
    .await
}

#[tauri::command]
async fn save_project_settings(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::SaveProjectSettingsRequest,
) -> artistic_git_contracts::AppResult<artistic_git_core::config::ProjectSettings> {
    let backend = backend.inner().clone();
    run_blocking_command("saveProjectSettings", move || {
        backend.save_project_settings(request)
    })
    .await
}

#[tauri::command]
async fn load_gitignore(
    request: artistic_git_app::GitignoreRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::GitignoreFileResponse> {
    run_blocking_command("loadGitignore", move || {
        artistic_git_app::load_gitignore(request)
    })
    .await
}

#[tauri::command]
async fn save_gitignore(
    request: artistic_git_app::SaveGitignoreRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::GitignoreFileResponse> {
    run_blocking_command("saveGitignore", move || {
        artistic_git_app::save_gitignore(request)
    })
    .await
}

#[tauri::command]
async fn ssh_key_status() -> artistic_git_contracts::AppResult<artistic_git_app::SshKeyStatus> {
    run_blocking_command("sshKeyStatus", artistic_git_app::ssh_key_status).await
}

#[tauri::command]
async fn generate_ssh_key(
    request: artistic_git_app::GenerateSshKeyRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::SshKeyStatus> {
    run_blocking_command("generateSshKey", move || {
        artistic_git_app::generate_ssh_key(request)
    })
    .await
}

#[tauri::command]
async fn validate_identity_for_write(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::IdentityValidationRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::IdentityValidationResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("validateIdentityForWrite", move || {
        backend.validate_identity_for_write(request)
    })
    .await
}

#[tauri::command]
async fn list_https_credentials(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
) -> artistic_git_contracts::AppResult<artistic_git_app::HttpsCredentialListResponse> {
    let backend = backend.inner().clone();
    run_blocking_command("listHttpsCredentials", move || {
        backend.list_https_credentials()
    })
    .await
}

#[tauri::command]
async fn save_https_credential(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::SaveHttpsCredentialRequest,
) -> artistic_git_contracts::AppResult<artistic_git_app::HttpsCredentialEntry> {
    let backend = backend.inner().clone();
    run_blocking_command("saveHttpsCredential", move || {
        backend.save_https_credential(request)
    })
    .await
}

#[tauri::command]
async fn delete_https_credential(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::DeleteHttpsCredentialRequest,
) -> artistic_git_contracts::AppResult<()> {
    let backend = backend.inner().clone();
    run_blocking_command("deleteHttpsCredential", move || {
        backend.delete_https_credential(request)
    })
    .await
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

#[tauri::command]
fn set_auth_prompt_listener_ready(
    window: tauri::Window,
    https_state: State<'_, HttpsCredentialPromptState>,
    ssh_state: State<'_, SshPassphrasePromptState>,
    request: AuthPromptListenerReadyRequest,
) -> artistic_git_contracts::AppResult<()> {
    match request.kind {
        AuthPromptKind::HttpsCredential => https_state.registry.set_window_ready(
            window.app_handle(),
            window.label(),
            request.ready,
        ),
        AuthPromptKind::SshPassphrase => {
            ssh_state
                .registry
                .set_window_ready(window.app_handle(), window.label(), request.ready)
        }
    }
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(handle_second_instance))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(build_app_menu)
        .on_menu_event(handle_menu_event)
        .on_window_event(handle_window_event);

    #[cfg(feature = "wdio-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio::init());

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = builder.on_web_content_process_terminate(handle_web_content_process_terminate);

    builder
        .setup(|app| {
            let _native_renderer_crash_hook_gate = native_renderer_crash_hook_gate();
            let log_dir = app.path().app_log_dir()?;
            let logging_config = artistic_git_core::logging::LoggingConfig::new(log_dir);
            #[cfg(not(feature = "wdio-e2e"))]
            let logging_guard = artistic_git_core::logging::initialize_logging(&logging_config)?;
            #[cfg(feature = "wdio-e2e")]
            let logging_guard =
                artistic_git_core::logging::initialize_logging_with_existing_log_logger(
                    &logging_config,
                )?;
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
            let auth_prompt_router = Arc::new(AuthPromptWindowRouter::default());
            app.manage(HttpsCredentialPromptState {
                registry: Arc::clone(&credential_prompts),
            });
            app.manage(SshPassphrasePromptState {
                registry: Arc::clone(&ssh_passphrase_prompts),
            });
            app.manage(AuthPromptWindowState {
                router: Arc::clone(&auth_prompt_router),
            });
            let backend = repository_backend(
                app,
                credential_prompts,
                ssh_passphrase_prompts,
                auth_prompt_router,
            )?;
            app.manage(backend);
            app.manage(second_instance_dispatch_state(app.handle())?);

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
            probe_remote_repository,
            clone_repository,
            cancel_clone_repository,
            cancel_operation,
            repository_summary,
            reset_bisect,
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
            local_change_detail,
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
            commit_details,
            commit_file_detail,
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
            list_recent_projects,
            forget_recent_project,
            clear_recent_projects,
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
            set_auth_prompt_listener_ready,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeMenuLanguage {
    English,
    Chinese,
}

struct NativeMenuLabels {
    about: &'static str,
    check_updates: &'static str,
    settings: &'static str,
    quit: &'static str,
    file: &'static str,
    new_window: &'static str,
    open_project: &'static str,
    clone_project: &'static str,
    close_window: &'static str,
    edit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    view: &'static str,
    history: &'static str,
    local_changes: &'static str,
    toggle_theme: &'static str,
    toggle_devtools: &'static str,
    help: &'static str,
    open_log_dir: &'static str,
    changelog: &'static str,
    homepage: &'static str,
}

const ENGLISH_MENU_LABELS: NativeMenuLabels = NativeMenuLabels {
    about: "About Artistic Git",
    check_updates: "Check for Updates...",
    settings: "Settings...",
    quit: "Quit Artistic Git",
    file: "File",
    new_window: "New Window",
    open_project: "Open Project...",
    clone_project: "Clone Project...",
    close_window: "Close Window",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    view: "View",
    history: "History",
    local_changes: "Local Changes",
    toggle_theme: "Toggle Theme",
    toggle_devtools: "Toggle Developer Tools",
    help: "Help",
    open_log_dir: "Open Log Directory",
    changelog: "View Changelog",
    homepage: "Project Homepage",
};

const CHINESE_MENU_LABELS: NativeMenuLabels = NativeMenuLabels {
    about: "关于 Artistic Git",
    check_updates: "检查更新...",
    settings: "设置...",
    quit: "退出 Artistic Git",
    file: "文件",
    new_window: "新建窗口",
    open_project: "打开项目...",
    clone_project: "克隆项目...",
    close_window: "关闭窗口",
    edit: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    select_all: "全选",
    view: "视图",
    history: "历史",
    local_changes: "本地更改",
    toggle_theme: "切换主题",
    toggle_devtools: "切换开发者工具",
    help: "帮助",
    open_log_dir: "打开日志目录",
    changelog: "查看更新记录",
    homepage: "项目主页",
};

fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    build_app_menu_for_language(app, initial_menu_language(app))
}

fn build_app_menu_for_language(
    app: &tauri::AppHandle,
    language: NativeMenuLanguage,
) -> tauri::Result<Menu<tauri::Wry>> {
    let labels = match language {
        NativeMenuLanguage::Chinese => &CHINESE_MENU_LABELS,
        NativeMenuLanguage::English => &ENGLISH_MENU_LABELS,
    };
    let app_menu = Submenu::with_items(
        app,
        "Artistic Git",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some(labels.about),
                Some(AboutMetadata {
                    name: Some("Artistic Git".to_owned()),
                    version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                    website: Some(APP_HOMEPAGE.to_owned()),
                    website_label: Some(labels.homepage.to_owned()),
                    ..AboutMetadata::default()
                }),
            )?,
            &MenuItem::with_id(
                app,
                "check-updates",
                labels.check_updates,
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "open-settings",
                labels.settings,
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(labels.quit))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        labels.file,
        true,
        &[
            &MenuItem::with_id(
                app,
                "new-window",
                labels.new_window,
                true,
                Some("CmdOrCtrl+N"),
            )?,
            &MenuItem::with_id(
                app,
                "open-project",
                labels.open_project,
                true,
                Some("CmdOrCtrl+O"),
            )?,
            &MenuItem::with_id(
                app,
                "clone-project",
                labels.clone_project,
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "close-window",
                labels.close_window,
                true,
                Some("CmdOrCtrl+W"),
            )?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        labels.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(labels.undo))?,
            &PredefinedMenuItem::redo(app, Some(labels.redo))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(labels.cut))?,
            &PredefinedMenuItem::copy(app, Some(labels.copy))?,
            &PredefinedMenuItem::paste(app, Some(labels.paste))?,
            &PredefinedMenuItem::select_all(app, Some(labels.select_all))?,
        ],
    )?;
    let view = build_view_menu(app, labels)?;
    let help = Submenu::with_items(
        app,
        labels.help,
        true,
        &[
            &MenuItem::with_id(app, "open-log-dir", labels.open_log_dir, true, None::<&str>)?,
            &MenuItem::with_id(app, "open-changelog", labels.changelog, true, None::<&str>)?,
            &MenuItem::with_id(app, "open-homepage", labels.homepage, true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &help])
}

#[cfg(debug_assertions)]
fn build_view_menu(
    app: &tauri::AppHandle,
    labels: &NativeMenuLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    Submenu::with_items(
        app,
        labels.view,
        true,
        &[
            &MenuItem::with_id(app, "view-history", labels.history, true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "view-local-changes",
                labels.local_changes,
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-theme", labels.toggle_theme, true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "toggle-devtools",
                labels.toggle_devtools,
                true,
                None::<&str>,
            )?,
        ],
    )
}

#[cfg(not(debug_assertions))]
fn build_view_menu(
    app: &tauri::AppHandle,
    labels: &NativeMenuLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    Submenu::with_items(
        app,
        labels.view,
        true,
        &[
            &MenuItem::with_id(app, "view-history", labels.history, true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "view-local-changes",
                labels.local_changes,
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-theme", labels.toggle_theme, true, None::<&str>)?,
        ],
    )
}

fn initial_menu_language(app: &tauri::AppHandle) -> NativeMenuLanguage {
    let saved_language = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|directory| fs::read_to_string(directory.join("settings.json")).ok())
        .and_then(|content| {
            serde_json::from_str::<artistic_git_core::config::AppSettings>(&content).ok()
        })
        .map(|settings| settings.language)
        .unwrap_or(artistic_git_core::config::LanguagePreference::System);
    resolved_menu_language(saved_language)
}

fn resolved_menu_language(
    preference: artistic_git_core::config::LanguagePreference,
) -> NativeMenuLanguage {
    match preference {
        artistic_git_core::config::LanguagePreference::ZhCn => NativeMenuLanguage::Chinese,
        artistic_git_core::config::LanguagePreference::EnUs => NativeMenuLanguage::English,
        artistic_git_core::config::LanguagePreference::System => {
            let is_chinese = system_primary_language()
                .map(|value| value.to_ascii_lowercase().starts_with("zh"))
                .unwrap_or(false);
            if is_chinese {
                NativeMenuLanguage::Chinese
            } else {
                NativeMenuLanguage::English
            }
        }
    }
}

fn system_primary_language() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
        {
            if output.status.success() {
                let value = String::from_utf8_lossy(&output.stdout);
                if let Some(language) = parse_apple_primary_language(&value) {
                    return Some(language.to_owned());
                }
            }
        }
    }

    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
}

#[cfg(target_os = "macos")]
fn parse_apple_primary_language(value: &str) -> Option<&str> {
    value.lines().find_map(|line| {
        let language = line.trim().trim_end_matches(',').trim_matches('"');
        (!language.is_empty() && language != "(" && language != ")").then_some(language)
    })
}

fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();
    match id {
        "new-window" => {
            if let Some(registry) = app.try_state::<WindowRegistry>() {
                if let Err(error) = create_start_window(app, &registry, None) {
                    emit_native_app_error(app, error);
                }
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
                if let Err(error) = window.close() {
                    emit_native_app_error(
                        app,
                        window_command_error(
                            format!("failed to close current window: {error}"),
                            "closeCurrentWindow",
                        ),
                    );
                }
            }
        }
        "open-homepage" => {
            if let Err(error) = open_external_target(APP_HOMEPAGE, "openHomepage") {
                emit_native_app_error(app, error);
            }
        }
        "open-changelog" => {
            if let Err(error) = open_external_target(APP_CHANGELOG, "openChangelog") {
                emit_native_app_error(app, error);
            }
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
        if let Err(error) = window.emit(MENU_EVENT_NAME, event) {
            emit_native_app_error(
                app,
                window_command_error(
                    format!("failed to deliver menu action {id}: {error}"),
                    "appMenu",
                ),
            );
        }
    } else {
        if let Err(error) = app.emit(MENU_EVENT_NAME, event) {
            emit_native_app_error(
                app,
                window_command_error(
                    format!("failed to deliver menu action {id}: {error}"),
                    "appMenu",
                ),
            );
        }
    }
}

fn emit_native_app_error(app: &tauri::AppHandle, error: artistic_git_contracts::AppError) {
    if let Some(window) = focused_webview_window(app) {
        let _ = window.emit("app-error", error);
    } else {
        let _ = app.emit("app-error", error);
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
    initial_action: Option<&str>,
) -> artistic_git_contracts::AppResult<NewWindowResponse> {
    let label = next_start_window_label(registry)?;
    let route = match initial_action {
        Some("open") => "index.html?action=open",
        Some("clone") => "index.html?action=clone",
        _ => "index.html",
    };
    tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::App(route.into()))
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

fn registry_exit_guard_labels(registry: &WindowRegistry) -> Vec<String> {
    if registry_update_install_closing_windows(registry) {
        Vec::new()
    } else {
        registry_close_guard_labels(registry)
    }
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

fn registry_repository_for_label(registry: &WindowRegistry, label: &str) -> Option<String> {
    registry
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.label_to_repository.get(label).cloned())
}

fn focus_window(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn ensure_webview_window_exists(
    app: &tauri::AppHandle,
    label: &str,
    operation: &'static str,
) -> artistic_git_contracts::AppResult<()> {
    if app.get_webview_window(label).is_some() {
        Ok(())
    } else {
        Err(artistic_git_app::logged_app_error(
            artistic_git_contracts::AppError::expected(
                "the requesting window was closed before the operation completed",
                operation,
            ),
        ))
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

fn persist_window_geometry_before_close(window: &tauri::Window) {
    let app = window.app_handle();
    let Some(registry) = app.try_state::<WindowRegistry>() else {
        return;
    };
    let Some(repository_path) = registry_repository_for_label(&registry, window.label()) else {
        return;
    };
    let Ok(geometry) = current_window_geometry(window) else {
        return;
    };
    let Some(backend) = app.try_state::<artistic_git_app::RepositoryBackend>() else {
        return;
    };
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = backend.save_project_window_geometry(repository_path, geometry);
    });
}

fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    let dispatch = SecondInstanceDispatch { args, cwd };
    let Some(state) = app.try_state::<SecondInstanceDispatchState>() else {
        focus_or_create_start_window(app);
        return;
    };
    if state.sender.send(dispatch).is_err() {
        focus_or_create_start_window(app);
    }
}

fn second_instance_dispatch_state(
    app: &tauri::AppHandle,
) -> std::io::Result<SecondInstanceDispatchState> {
    let (sender, receiver) = mpsc::channel();
    let app = app.clone();
    std::thread::Builder::new()
        .name("second-instance-dispatch".to_owned())
        .spawn(move || {
            run_serial_dispatch(receiver, |dispatch| {
                process_second_instance(&app, dispatch);
            });
        })?;
    Ok(SecondInstanceDispatchState { sender })
}

fn run_serial_dispatch<T>(receiver: mpsc::Receiver<T>, mut dispatch: impl FnMut(T)) {
    while let Ok(request) = receiver.recv() {
        dispatch(request);
    }
}

fn process_second_instance(app: &tauri::AppHandle, dispatch: SecondInstanceDispatch) {
    let SecondInstanceDispatch { args, cwd } = dispatch;
    let repository_path = repository_path_from_args(&args, Some(&cwd));
    if let Some(repository_path) = repository_path.clone() {
        if let Err(error) = open_second_instance_repository(app, repository_path) {
            emit_native_app_error(app, error);
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
    let backend = app
        .try_state::<artistic_git_app::RepositoryBackend>()
        .ok_or_else(|| window_command_error("repository backend unavailable", "secondInstance"))?
        .inner()
        .clone();
    let opened = backend.open_repository(artistic_git_contracts::OpenRepositoryRequest {
        path: repository_path,
        tool_identity: None,
        operation_id: None,
    })?;
    let project_settings =
        backend.load_project_settings(artistic_git_app::ProjectSettingsRequest {
            repository_path: opened.repository_path,
        })?;
    let registry = app
        .try_state::<WindowRegistry>()
        .ok_or_else(|| window_command_error("window registry unavailable", "secondInstance"))?;
    open_or_focus_repository_from_settings(app, &registry, project_settings)?;
    for error in opened.non_fatal_errors {
        emit_native_app_error(app, error);
    }
    Ok(())
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
        let _ = create_start_window(app, &registry, None);
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
            persist_window_geometry_before_close(window);
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
            if let Some(state) = app.try_state::<HttpsCredentialPromptState>() {
                state.registry.set_window_ready(app, &label, false);
            }
            if let Some(state) = app.try_state::<SshPassphrasePromptState>() {
                state.registry.set_window_ready(app, &label, false);
            }
            if let Some(state) = app.try_state::<AuthPromptWindowState>() {
                state.router.remove_window(&label);
            }
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
            let guarded_labels = registry_exit_guard_labels(&registry);
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

fn open_external_target(
    target: &str,
    operation_name: &str,
) -> artistic_git_contracts::AppResult<()> {
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

    command.arg(target).spawn().map(|_| ()).map_err(|source| {
        artistic_git_app::unexpected_command_error(
            format!("failed to open {target}: {source}"),
            operation_name,
        )
    })
}

fn window_command_error(
    message: impl Into<String>,
    operation: &'static str,
) -> artistic_git_contracts::AppError {
    artistic_git_app::unexpected_command_error(message.into(), operation)
}

async fn run_blocking_command<T, F>(
    operation: &'static str,
    action: F,
) -> artistic_git_contracts::AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> artistic_git_contracts::AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|error| {
            artistic_git_app::unexpected_command_error(
                format!("{operation} blocking worker failed: {error}"),
                operation,
            )
        })?
}

fn repository_backend(
    app: &tauri::App,
    credential_prompts: Arc<HttpsCredentialPromptRegistry>,
    ssh_passphrase_prompts: Arc<SshPassphrasePromptRegistry>,
    auth_prompt_router: Arc<AuthPromptWindowRouter>,
) -> Result<artistic_git_app::RepositoryBackend, Box<dyn std::error::Error>> {
    let dist_root = git_dist_root(app)?;
    let storage_dirs = application_storage_dirs(app)?;
    let app_data_dir = storage_dirs.data;
    let app_config_dir = storage_dirs.config;
    fs::create_dir_all(&app_data_dir)?;
    fs::create_dir_all(&app_config_dir)?;

    let runner = artistic_git_git_runner::GitRunner::from_dist_root(
        dist_root,
        app_data_dir.join("git-home"),
    )?;
    runner
        .run_runtime_self_check()
        .map_err(boxed_app_setup_error)?;

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
            router: Arc::clone(&auth_prompt_router),
        }),
        Arc::new(TauriSshPassphrasePromptSink {
            app: app.handle().clone(),
            registry: ssh_passphrase_prompts,
            router: auth_prompt_router,
        }),
    ))
}

#[derive(Debug, PartialEq, Eq)]
struct ApplicationStorageDirs {
    config: PathBuf,
    data: PathBuf,
}

fn application_storage_dirs(
    app: &tauri::App,
) -> Result<ApplicationStorageDirs, Box<dyn std::error::Error>> {
    #[cfg(all(feature = "wdio-e2e", debug_assertions))]
    if let Some(storage_dirs) = e2e_storage_directory_override(
        env::var_os(E2E_APP_CONFIG_DIR_ENV),
        env::var_os(E2E_APP_DATA_DIR_ENV),
    )? {
        return Ok(storage_dirs);
    }

    Ok(ApplicationStorageDirs {
        config: app.path().app_config_dir()?,
        data: app.path().app_data_dir()?,
    })
}

#[cfg(any(all(feature = "wdio-e2e", debug_assertions), test))]
const E2E_APP_CONFIG_DIR_ENV: &str = "ARTISTIC_GIT_E2E_APP_CONFIG_DIR";
#[cfg(any(all(feature = "wdio-e2e", debug_assertions), test))]
const E2E_APP_DATA_DIR_ENV: &str = "ARTISTIC_GIT_E2E_APP_DATA_DIR";

#[cfg(any(all(feature = "wdio-e2e", debug_assertions), test))]
fn e2e_storage_directory_override(
    config: Option<std::ffi::OsString>,
    data: Option<std::ffi::OsString>,
) -> Result<Option<ApplicationStorageDirs>, std::io::Error> {
    let config = non_empty_e2e_directory(config);
    let data = non_empty_e2e_directory(data);

    match (config, data) {
        (Some(config), Some(data)) => Ok(Some(ApplicationStorageDirs { config, data })),
        (None, None) => Ok(None),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "{E2E_APP_CONFIG_DIR_ENV} and {E2E_APP_DATA_DIR_ENV} must either both be set or both be unset"
            ),
        )),
    }
}

#[cfg(any(all(feature = "wdio-e2e", debug_assertions), test))]
fn non_empty_e2e_directory(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value.and_then(|value| {
        if value.to_string_lossy().trim().is_empty() {
            None
        } else {
            Some(PathBuf::from(value))
        }
    })
}

fn git_dist_root(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;

    #[cfg(target_os = "linux")]
    {
        Ok(linux_bundled_git_dist_root(&resource_dir)?)
    }

    #[cfg(not(target_os = "linux"))]
    {
        Ok(resource_dir.join("git-dist"))
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_bundled_git_dist_root(resource_dir: &Path) -> Result<PathBuf, std::io::Error> {
    let usr_dir = resource_dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| {
            std::io::Error::other(format!(
                "Linux resource directory is not under usr/lib: {}",
                resource_dir.display()
            ))
        })?;

    let shared_dist = usr_dir.join("share").join("artistic-git").join("git-dist");
    if shared_dist.is_dir() {
        Ok(shared_dist)
    } else {
        Ok(resource_dir.join("git-dist"))
    }
}

fn boxed_setup_error(message: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(message))
}

fn boxed_app_setup_error(error: artistic_git_contracts::AppError) -> Box<dyn std::error::Error> {
    let details = serde_json::to_string_pretty(&error).unwrap_or_else(|_| error.summary.clone());
    boxed_setup_error(details)
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

    let _ = app_handle.emit_to(window_label, "operation-progress", &event);
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

fn reserve_and_emit_operation_started(
    app_handle: &tauri::AppHandle,
    backend: &artistic_git_app::RepositoryBackend,
    operation_id: Option<&artistic_git_contracts::OperationId>,
    repository_path: &str,
    window_label: &str,
    operation_name: &'static str,
    label: &'static str,
) -> artistic_git_contracts::AppResult<Option<artistic_git_app::CancellableOperationReservation>> {
    let reservation = backend.reserve_cancellable_operation(operation_id, operation_name)?;
    register_auth_prompt_window(app_handle, operation_id, window_label);
    emit_operation_started(
        app_handle,
        operation_id,
        repository_path,
        window_label,
        label,
    );
    Ok(reservation)
}

fn emit_operation_finished(
    app_handle: &tauri::AppHandle,
    operation_id: Option<&artistic_git_contracts::OperationId>,
    repository_path: &str,
    window_label: &str,
    label: impl Into<String>,
) {
    finish_auth_prompt_operation(app_handle, operation_id);
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

fn register_auth_prompt_window(
    app_handle: &tauri::AppHandle,
    operation_id: Option<&artistic_git_contracts::OperationId>,
    window_label: &str,
) {
    let (Some(operation_id), Some(state)) = (
        operation_id,
        app_handle.try_state::<AuthPromptWindowState>(),
    ) else {
        return;
    };
    state.router.register(operation_id, window_label);
}

fn finish_auth_prompt_operation(
    app_handle: &tauri::AppHandle,
    operation_id: Option<&artistic_git_contracts::OperationId>,
) {
    let Some(operation_id) = operation_id else {
        return;
    };
    cancel_auth_prompt_waiters(app_handle, operation_id);
    if let Some(state) = app_handle.try_state::<AuthPromptWindowState>() {
        state.router.unregister(operation_id);
    }
}

fn cancel_auth_prompt_waiters(
    app_handle: &tauri::AppHandle,
    operation_id: &artistic_git_contracts::OperationId,
) {
    if let Some(state) = app_handle.try_state::<HttpsCredentialPromptState>() {
        state.registry.cancel_operation(app_handle, operation_id);
    }
    if let Some(state) = app_handle.try_state::<SshPassphrasePromptState>() {
        state.registry.cancel_operation(app_handle, operation_id);
    }
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
    fn blocking_commands_run_outside_the_calling_thread() {
        let caller_thread = std::thread::current().id();
        let worker_thread = tauri::async_runtime::block_on(run_blocking_command(
            "blockingCommandThreadTest",
            || Ok(std::thread::current().id()),
        ))
        .expect("blocking command");

        assert_ne!(worker_thread, caller_thread);
    }

    #[test]
    fn blocking_commands_preserve_application_errors() {
        let expected =
            artistic_git_contracts::AppError::expected("expected worker failure", "innerOperation");
        let returned = tauri::async_runtime::block_on(run_blocking_command("outerOperation", {
            let expected = expected.clone();
            move || Err::<(), _>(expected)
        }))
        .expect_err("worker error");

        assert_eq!(returned, expected);
    }

    #[test]
    fn setup_errors_preserve_structured_git_diagnostics() {
        let error = artistic_git_contracts::AppError::fatal(
            "embedded Git self-check failed",
            "gitRuntimeSelfCheck",
        )
        .with_git(artistic_git_contracts::GitCommandError {
            command: vec!["git".to_owned(), "--version".to_owned()],
            exit_code: Some(1),
            stdout: "git version fixture".to_owned(),
            stderr: "fixture stderr".to_owned(),
        });

        let rendered = boxed_app_setup_error(error).to_string();

        assert!(rendered.contains("gitRuntimeSelfCheck"));
        assert!(rendered.contains("fixture stderr"));
        assert!(rendered.contains("git version fixture"));
    }

    #[test]
    fn tauri_commands_only_stay_synchronous_when_explicitly_allowlisted() {
        assert_only_allowlisted_commands_are_synchronous(
            include_str!("lib.rs"),
            &[
                "health",
                "window_context",
                "new_project_window",
                "close_current_window",
                "set_window_close_guard",
                "cancel_pending_window_exit",
                "inject_renderer_crash",
                "acknowledge_renderer_crash",
                "open_log_dir",
                "open_update_release_page",
                "submit_https_credential_prompt",
                "submit_ssh_passphrase_prompt",
                "set_auth_prompt_listener_ready",
            ],
        );
        assert_only_allowlisted_commands_are_synchronous(
            include_str!("updater_runtime.rs"),
            &["update_install_gate"],
        );
    }

    fn assert_only_allowlisted_commands_are_synchronous(source: &str, allowlist: &[&str]) {
        let declarations = tauri_command_declarations(source);

        for (name, asynchronous) in &declarations {
            assert!(
                *asynchronous || allowlist.contains(&name.as_str()),
                "Tauri command `{name}` must use an async blocking worker or be explicitly allowlisted"
            );
        }

        for allowed in allowlist {
            assert!(
                declarations
                    .iter()
                    .any(|(name, asynchronous)| name == allowed && !asynchronous),
                "synchronous Tauri command allowlist entry `{allowed}` is stale"
            );
        }
    }

    fn tauri_command_declarations(source: &str) -> Vec<(String, bool)> {
        let mut declarations = Vec::new();
        let mut awaiting_declaration = false;

        for line in source.lines() {
            let line = line.trim();
            if line == "#[tauri::command]" {
                awaiting_declaration = true;
                continue;
            }
            if !awaiting_declaration {
                continue;
            }

            let (prefix, asynchronous) = if line.starts_with("pub async fn ") {
                ("pub async fn ", true)
            } else if line.starts_with("async fn ") {
                ("async fn ", true)
            } else if line.starts_with("pub fn ") {
                ("pub fn ", false)
            } else if line.starts_with("fn ") {
                ("fn ", false)
            } else {
                continue;
            };
            let name = line[prefix.len()..]
                .split('(')
                .next()
                .expect("command name")
                .to_owned();
            declarations.push((name, asynchronous));
            awaiting_declaration = false;
        }

        declarations
    }

    #[test]
    fn e2e_storage_override_accepts_exact_paired_directories() {
        let storage_dirs = e2e_storage_directory_override(
            Some(std::ffi::OsString::from("e2e/config")),
            Some(std::ffi::OsString::from("e2e/data")),
        )
        .expect("valid override")
        .expect("present override");

        assert_eq!(storage_dirs.config, PathBuf::from("e2e/config"));
        assert_eq!(storage_dirs.data, PathBuf::from("e2e/data"));
    }

    #[test]
    fn e2e_storage_override_falls_back_when_both_values_are_absent_or_blank() {
        assert_eq!(
            e2e_storage_directory_override(None, None).expect("absent override"),
            None
        );
        assert_eq!(
            e2e_storage_directory_override(
                Some(std::ffi::OsString::from("  ")),
                Some(std::ffi::OsString::from("")),
            )
            .expect("blank override"),
            None
        );
    }

    #[test]
    fn e2e_storage_override_rejects_partial_values() {
        let config_only =
            e2e_storage_directory_override(Some(std::ffi::OsString::from("e2e/config")), None)
                .expect_err("partial override must fail");
        assert_eq!(config_only.kind(), std::io::ErrorKind::InvalidInput);
        assert!(config_only.to_string().contains(E2E_APP_CONFIG_DIR_ENV));
        assert!(config_only.to_string().contains(E2E_APP_DATA_DIR_ENV));

        let data_only = e2e_storage_directory_override(
            Some(std::ffi::OsString::from(" ")),
            Some(std::ffi::OsString::from("e2e/data")),
        )
        .expect_err("blank config with data must fail");
        assert_eq!(data_only.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn linux_git_dist_root_uses_packaged_usr_share_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let resource_dir = temp.path().join("usr/lib/Artistic Git");
        let shared_dist = temp.path().join("usr/share/artistic-git/git-dist");
        fs::create_dir_all(&resource_dir).expect("resource dir");
        fs::create_dir_all(&shared_dist).expect("shared git-dist");

        assert_eq!(
            linux_bundled_git_dist_root(&resource_dir).expect("Linux resource path"),
            shared_dist
        );
    }

    #[test]
    fn linux_git_dist_root_falls_back_to_development_resource_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let resource_dir = temp.path().join("target/debug");
        fs::create_dir_all(&resource_dir).expect("resource dir");

        assert_eq!(
            linux_bundled_git_dist_root(&resource_dir).expect("Linux resource path"),
            resource_dir.join("git-dist")
        );
    }

    #[test]
    fn window_menu_url_encoding_keeps_safe_path_characters() {
        assert_eq!(
            encode_url_component("/Users/artist/Project A"),
            "%2FUsers%2Fartist%2FProject%20A"
        );
    }

    #[test]
    fn window_menu_explicit_language_preferences_are_respected() {
        assert!(matches!(
            resolved_menu_language(artistic_git_core::config::LanguagePreference::ZhCn),
            NativeMenuLanguage::Chinese
        ));
        assert!(matches!(
            resolved_menu_language(artistic_git_core::config::LanguagePreference::EnUs),
            NativeMenuLanguage::English
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn window_menu_uses_the_first_macos_language() {
        let languages = "(\n    \"zh-Hans-CN\",\n    \"en-CN\"\n)\n";

        assert_eq!(parse_apple_primary_language(languages), Some("zh-Hans-CN"));
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
    fn second_instance_dispatch_preserves_request_order() {
        let (sender, receiver) = mpsc::channel();
        sender.send("first").expect("first request");
        sender.send("second").expect("second request");
        drop(sender);
        let mut observed = Vec::new();

        run_serial_dispatch(receiver, |request| observed.push(request));

        assert_eq!(observed, vec!["first", "second"]);
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
        assert_eq!(
            registry_repository_for_label(&registry, "repo-1"),
            Some("/tmp/project".to_owned())
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
    fn updater_install_exit_ignores_late_close_guards() {
        let registry = WindowRegistry::default();
        registry_set_close_guard(&registry, "repo-1", true).expect("set close guard");
        assert_eq!(registry_exit_guard_labels(&registry), vec!["repo-1"]);

        registry_set_update_install_closing_windows(&registry, true).expect("start install close");
        assert!(registry_exit_guard_labels(&registry).is_empty());
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
