#[tauri::command]
fn health() -> Result<artistic_git_app::HealthResponse, String> {
    artistic_git_app::health()
}

#[tauri::command]
fn open_log_dir(
    app_handle: tauri::AppHandle,
) -> Result<artistic_git_app::OpenLogDirResponse, String> {
    use tauri::Manager;

    let log_dir = app_handle
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed to resolve application log directory: {error}"))?;

    artistic_git_app::open_log_dir(log_dir)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![health, open_log_dir])
        .run(tauri::generate_context!())
        .expect("failed to run Artistic Git");
}
