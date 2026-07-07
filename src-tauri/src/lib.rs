use std::{env, fs, path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager, State};

struct LoggingState {
    _guard: artistic_git_core::logging::LoggingGuard,
}

#[tauri::command]
fn health() -> artistic_git_contracts::AppResult<artistic_git_app::HealthResponse> {
    artistic_git_app::health()
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
    if matches!(
        response,
        artistic_git_contracts::CommitResponse::Committed { .. }
    ) {
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
        artistic_git_contracts::RevertCommitResponse::Conflicted {
            operation_id,
            files,
        } => {
            let conflict = artistic_git_contracts::ConflictEnteredEvent {
                operation_id: operation_id.clone(),
                repository_path: repository_path.clone(),
                operation_name: "revertCommit".to_owned(),
                files: files.clone(),
            };
            let _ = app_handle.emit("conflict-entered", &conflict);
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            app.manage(repository_backend(app)?);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            open_log_dir,
            open_repository,
            clone_repository,
            cancel_clone_repository,
            repository_summary,
            fetch_repository,
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
            validate_identity_for_write
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Artistic Git");
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
