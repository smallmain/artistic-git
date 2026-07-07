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
            list_local_changes,
            list_stashes,
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
