use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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
struct WindowRegistryInner {
    label_to_repository: BTreeMap<String, String>,
    repository_to_label: BTreeMap<String, String>,
    close_guard_labels: BTreeSet<String>,
    pending_exit_after_close_guards: bool,
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowCloseBlockedEvent {
    reason: WindowCloseBlockedReason,
}

#[derive(Debug, Clone, serde::Serialize)]
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

    Ok(WindowContextResponse {
        label,
        repository_path,
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
fn open_repository(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::OpenRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::OpenRepositoryResponse> {
    backend.open_repository(request)
}

#[tauri::command]
fn clone_repository(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CloneRepositoryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CloneRepositoryResponse> {
    backend.clone_repository_with_progress(request, |event| {
        let _ = app_handle.emit("operation-progress", &event);
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SyncCurrentBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncCurrentBranchResponse> {
    let response = backend.sync_current_branch(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::SyncBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncBranchResponse> {
    let response = backend.sync_branch(request)?;
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
fn start_review_mode(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::StartReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::StartReviewModeResponse> {
    let response = backend.start_review_mode(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::SyncReviewModeResponse> {
    let response = backend.sync_review_mode(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ExitReviewModeResponse> {
    let response = backend.exit_review_mode(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::ReviewModeRecoveryRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::ExitReviewModeResponse> {
    let response = backend.recover_review_mode_stash(request)?;
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
fn validate_branch_name(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::BranchNameValidationRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchNameValidationResponse> {
    backend.validate_branch_name(request)
}

#[tauri::command]
fn create_branch(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let response = backend.create_branch(request)?;
    emit_branch_operation_events(&app_handle, &response);
    Ok(response)
}

#[tauri::command]
fn checkout_branch(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CheckoutBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let response = backend.checkout_branch(request)?;
    emit_branch_operation_events(&app_handle, &response);
    Ok(response)
}

#[tauri::command]
fn delete_branch(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteBranchRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::BranchOperationResponse> {
    let response = backend.delete_branch(request)?;
    emit_branch_operation_events(&app_handle, &response);
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
fn list_stashes(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::StashListResponse> {
    backend.list_stashes(request)
}

#[tauri::command]
fn create_stash(
    app_handle: tauri::AppHandle,
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CreateStashResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.create_stash(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateAutoStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CreateStashResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.create_auto_stash(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RestoreStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RestoreStashResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.restore_stash(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::DeleteStashResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.delete_stash(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CommitRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CommitResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.commit_changes(request)?;
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RevertCommitRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RevertCommitResponse> {
    let repository_path = request.repository_path.clone();
    let response = backend.revert_commit(request)?;
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
fn delete_https_credential(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_app::DeleteHttpsCredentialRequest,
) -> artistic_git_contracts::AppResult<()> {
    backend.delete_https_credential(request)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(handle_second_instance))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(build_app_menu)
        .on_menu_event(handle_menu_event)
        .on_window_event(handle_window_event)
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            let logging_config = artistic_git_core::logging::LoggingConfig::new(log_dir);
            let logging_guard = artistic_git_core::logging::initialize_logging(&logging_config)?;
            let app_handle = app.handle().clone();
            artistic_git_core::logging::install_panic_hook_with_reporter(move |report| {
                let _ = app_handle.emit("crash-reported", &report);
            });
            app.manage(LoggingState {
                _guard: logging_guard,
            });
            app.manage(WindowRegistry::default());
            app.manage(updater_runtime::UpdaterRuntimeState::default());
            app.manage(repository_backend(app)?);

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
            open_log_dir,
            open_repository,
            clone_repository,
            cancel_clone_repository,
            repository_summary,
            fetch_repository,
            sync_current_branch,
            sync_branch,
            start_review_mode,
            sync_review_mode,
            exit_review_mode,
            review_mode_recovery,
            recover_review_mode_stash,
            dismiss_review_mode_recovery,
            load_remote_settings,
            save_remote_settings,
            list_branches,
            validate_branch_name,
            create_branch,
            checkout_branch,
            delete_branch,
            list_local_changes,
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
            delete_https_credential,
            updater_runtime::check_for_updates,
            updater_runtime::update_install_gate,
            updater_runtime::install_ready_update
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Artistic Git")
        .run(handle_run_event);
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
    }
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

fn registry_has_close_guards(registry: &WindowRegistry) -> bool {
    registry
        .inner
        .lock()
        .map(|inner| !inner.close_guard_labels.is_empty())
        .unwrap_or(false)
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
        WindowEvent::CloseRequested { api, .. } => {
            if let Some(registry) = app.try_state::<WindowRegistry>() {
                if registry_close_guarded(&registry, window.label()) {
                    api.prevent_close();
                    let _ = window.emit(
                        "window-close-blocked",
                        WindowCloseBlockedEvent {
                            reason: WindowCloseBlockedReason::CloseWindow,
                        },
                    );
                }
            }
        }
        WindowEvent::Destroyed => {
            let label = window.label().to_owned();
            if let Some(registry) = app.try_state::<WindowRegistry>() {
                registry_unregister(&registry, &label);
                if registry_pending_exit_after_close_guards(&registry)
                    && !registry_has_close_guards(&registry)
                {
                    app.exit(0);
                    return;
                }
            }
            exit_if_last_window_closed(app, &label);
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

    Ok(artistic_git_app::RepositoryBackend::new(
        runner,
        Some(config),
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
}
