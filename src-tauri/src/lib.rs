use tauri::{Emitter, Manager};

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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![health, open_log_dir])
        .run(tauri::generate_context!())
        .expect("failed to run Artistic Git");
}
