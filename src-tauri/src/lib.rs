use std::{env, fs, path::PathBuf};
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
fn repository_summary(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RepositorySummary> {
    backend.repository_summary(request)
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CreateStashResponse> {
    backend.create_stash(request)
}

#[tauri::command]
fn create_auto_stash(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CreateAutoStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CreateStashResponse> {
    backend.create_auto_stash(request)
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
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::RestoreStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::RestoreStashResponse> {
    backend.restore_stash(request)
}

#[tauri::command]
fn cancel_stash_restore(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::CancelStashRestoreRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::CancelStashRestoreResponse> {
    backend.cancel_stash_restore(request)
}

#[tauri::command]
fn delete_stash(
    backend: State<'_, artistic_git_app::RepositoryBackend>,
    request: artistic_git_contracts::DeleteStashRequest,
) -> artistic_git_contracts::AppResult<artistic_git_contracts::DeleteStashResponse> {
    backend.delete_stash(request)
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

pub fn run() {
    tauri::Builder::default()
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
            repository_summary,
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
            search_log
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

    let _ = app_handle.emit(
        "repo-changed",
        artistic_git_contracts::RepoChangedEvent {
            repository_path: repository_path.clone(),
            changed_queries: vec![
                artistic_git_contracts::RepoQueryKind::Summary,
                artistic_git_contracts::RepoQueryKind::Branches,
                artistic_git_contracts::RepoQueryKind::LocalChanges,
                artistic_git_contracts::RepoQueryKind::Stashes,
                artistic_git_contracts::RepoQueryKind::History,
            ],
        },
    );
}
