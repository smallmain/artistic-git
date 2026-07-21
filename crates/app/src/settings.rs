use artistic_git_contracts::{AppError, AppResult, GitCommandError, OperationContext};
use artistic_git_core::config::{
    normalize_project_path_key, AppSettings, ConfigActor, GitUserSettings, LargeFileCheckSettings,
    LocalChangesViewMode, ProjectSettings, SidebarLayoutSettings, WindowGeometry,
};
use artistic_git_git_runner::{GitRunner, IdentityValidationHook, WriteOperationRequest};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::BTreeSet,
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

const GITIGNORE_FILE_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const AUTO_TRACKING_RULE_LIMIT: usize = 100;
const SSH_PUBLIC_KEY_LIMIT_BYTES: usize = 64 * 1024;
const SSH_KEYGEN_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;
const SSH_KEYGEN_TIMEOUT: Duration = Duration::from_secs(30);
const PROCESS_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const SSH_KEY_COMMENT_LIMIT_BYTES: usize = 1_024;
const SSH_KEY_PASSPHRASE_LIMIT_BYTES: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub app_version: String,
    pub settings: AppSettings,
    pub identity_sources: IdentitySourcesResponse,
    pub identity_sources_error: Option<AppError>,
    pub ssh_key: SshKeyStatus,
    pub ssh_key_error: Option<AppError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectsRequest {
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectEntry {
    pub path: String,
    pub display_name: String,
    pub last_opened_at: String,
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForgetRecentProjectRequest {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveAppSettingsRequest {
    pub settings: AppSettings,
    #[serde(default)]
    pub open_repository_paths: Vec<String>,
    #[serde(default)]
    pub validate_identity: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsRequest {
    pub repository_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectSettingsRequest {
    pub repository_path: String,
    pub large_file_check: LargeFileCheckSettings,
    #[serde(default)]
    pub auto_tracking_rules: Vec<artistic_git_core::config::AutoTrackingRule>,
    pub sidebar: Option<SidebarLayoutSettings>,
    pub local_changes_view_mode: Option<LocalChangesViewMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreRequest {
    pub repository_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveGitignoreRequest {
    pub repository_path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreFileResponse {
    pub repository_path: String,
    pub path: String,
    pub content: String,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IdentitySourcesResponse {
    pub settings: GitUserSettings,
    pub global_gitconfig: GitUserSettings,
    pub global_gitconfig_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IdentitySource {
    Repository,
    GlobalGitconfig,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IdentityField {
    Name,
    Email,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedGitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    pub source: IdentitySource,
    pub complete: bool,
    pub email_valid: bool,
    pub missing: Vec<IdentityField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IdentityValidationRequest {
    pub repository_path: Option<String>,
    pub operation_name: String,
    #[serde(default)]
    pub requires_identity: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IdentityValidationResponse {
    pub operation_name: String,
    pub requires_identity: bool,
    pub identity: ResolvedGitIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyStatus {
    pub private_key_path: Option<String>,
    pub public_key_path: Option<String>,
    pub public_key: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSshKeyRequest {
    pub comment: Option<String>,
    pub passphrase: Option<String>,
}

pub fn settings_snapshot(
    config: Option<&ConfigActor>,
    _runner: &GitRunner,
) -> AppResult<SettingsSnapshot> {
    let settings = require_config(config, "loadAppSettings")?
        .settings()
        .map_err(|source| config_error(source, "loadAppSettings"))?;
    let (identity_sources, identity_sources_error) = match identity_sources(config) {
        Ok(sources) => (sources, None),
        Err(error) => (
            IdentitySourcesResponse {
                settings: settings.git.user.clone(),
                global_gitconfig: GitUserSettings::default(),
                global_gitconfig_path: real_global_gitconfig_path().as_deref().map(display_path),
            },
            Some(error),
        ),
    };
    let (ssh_key, ssh_key_error) = match ssh_key_status() {
        Ok(status) => (status, None),
        Err(error) => (
            SshKeyStatus {
                private_key_path: default_ssh_private_key_path().as_deref().map(display_path),
                public_key_path: None,
                public_key: None,
                exists: false,
            },
            Some(error),
        ),
    };
    Ok(SettingsSnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        settings,
        identity_sources,
        identity_sources_error,
        ssh_key,
        ssh_key_error,
    })
}

pub fn load_app_settings(config: Option<&ConfigActor>) -> AppResult<AppSettings> {
    require_config(config, "loadAppSettings")?
        .settings()
        .map_err(|source| config_error(source, "loadAppSettings"))
}

pub fn list_recent_projects(
    config: Option<&ConfigActor>,
    request: RecentProjectsRequest,
) -> AppResult<Vec<RecentProjectEntry>> {
    let projects = require_config(config, "listRecentProjects")?
        .projects()
        .map_err(|source| config_error(source, "listRecentProjects"))?;
    Ok(projects
        .recent_projects(usize::from(request.limit.min(200)))
        .into_iter()
        .filter_map(|project| {
            let last_opened_at = project.last_opened_at?;
            let path = project.path;
            let display_name = project
                .display_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| display_name_from_path(&path));
            Some(RecentProjectEntry {
                missing: !Path::new(&path).is_dir(),
                path,
                display_name,
                last_opened_at,
            })
        })
        .collect())
}

pub fn forget_recent_project(
    config: Option<&ConfigActor>,
    request: ForgetRecentProjectRequest,
) -> AppResult<()> {
    require_config(config, "forgetRecentProject")?
        .forget_recent_project(&request.path)
        .map_err(|source| config_error(source, "forgetRecentProject"))?;
    Ok(())
}

pub fn clear_recent_projects(config: Option<&ConfigActor>) -> AppResult<()> {
    require_config(config, "clearRecentProjects")?
        .clear_recent_projects()
        .map_err(|source| config_error(source, "clearRecentProjects"))?;
    Ok(())
}

pub fn save_app_settings(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: SaveAppSettingsRequest,
) -> AppResult<AppSettings> {
    let config = require_config(config, "saveAppSettings")?;
    let mut next_settings = request.settings;
    next_settings.git.user = clean_identity(next_settings.git.user);
    crate::fetch::validate_fetch_interval_seconds(
        next_settings.git.fetch_interval_seconds,
        "saveAppSettings",
    )?;
    validate_network_settings(&next_settings.network, "saveAppSettings")?;
    let previous_settings = config
        .settings()
        .map_err(|source| config_error(source, "saveAppSettings"))?;
    let identity_changed = previous_settings.git.user != next_settings.git.user;
    let should_apply_identity = request.validate_identity || identity_changed;
    if should_apply_identity {
        validate_identity_for_settings(&next_settings.git.user, "saveAppSettings")?;
    }

    let settings = config
        .update_settings(|settings| {
            *settings = next_settings.clone();
        })
        .map_err(|source| config_error(source, "saveAppSettings"))?;

    apply_network_settings_to_runtime(runner, &settings.network);

    if should_apply_identity {
        let mut seen_paths = BTreeSet::new();
        for repository_path in request.open_repository_paths {
            let repository_path = repository_path.trim();
            if !repository_path.is_empty() && seen_paths.insert(repository_path.to_owned()) {
                crate::repository::apply_git_user_settings_to_repository(
                    runner,
                    repository_path,
                    &settings.git.user,
                    "saveAppSettings",
                )?;
            }
        }
    }

    Ok(settings)
}

pub fn apply_network_settings_to_runtime(
    runner: &GitRunner,
    network: &artistic_git_core::network::NetworkSettings,
) {
    let resolved = artistic_git_core::network::resolve_proxy_environment(network);
    runner.apply_proxy_environment(resolved.as_os_map(), resolved.force_http1);
    artistic_git_core::network::apply_process_proxy_environment(&resolved);
}

fn validate_network_settings(
    network: &artistic_git_core::network::NetworkSettings,
    operation_name: &str,
) -> AppResult<()> {
    use artistic_git_core::network::{validate_proxy_url, ProxyMode};

    if network.proxy_mode != ProxyMode::Custom {
        return Ok(());
    }
    for (label, value) in [
        ("HTTP", network.http_proxy.as_deref()),
        ("HTTPS", network.https_proxy.as_deref()),
        ("SOCKS/all", network.all_proxy.as_deref()),
    ] {
        if let Some(value) = value {
            if !validate_proxy_url(value) {
                return Err(crate::logged_app_error(AppError::expected(
                    format!("invalid {label} proxy URL"),
                    operation_name,
                )));
            }
        }
    }
    Ok(())
}

pub fn load_project_settings(
    config: Option<&ConfigActor>,
    request: ProjectSettingsRequest,
) -> AppResult<ProjectSettings> {
    let config = require_config(config, "loadProjectSettings")?;
    let project_key = normalize_project_path_key(&request.repository_path)
        .map_err(|source| config_error(source, "loadProjectSettings"))?;

    config
        .store()
        .project(&project_key)
        .map_err(|source| config_error(source, "loadProjectSettings"))
        .map(|project| project.unwrap_or_else(|| ProjectSettings::new(project_key)))
        .and_then(|project| {
            validate_auto_tracking_rule_count(&project.auto_tracking_rules, "loadProjectSettings")?;
            Ok(project)
        })
}

pub fn save_project_settings(
    config: Option<&ConfigActor>,
    request: SaveProjectSettingsRequest,
) -> AppResult<ProjectSettings> {
    let config = require_config(config, "saveProjectSettings")?;
    validate_auto_tracking_rule_count(&request.auto_tracking_rules, "saveProjectSettings")?;
    crate::sync::validate_auto_tracking_rules(&request.auto_tracking_rules)?;
    config
        .update_project(request.repository_path, |project| {
            project.large_file_check = request.large_file_check;
            project.auto_tracking_rules = request.auto_tracking_rules;
            if let Some(sidebar) = request.sidebar {
                project.sidebar = sidebar;
            }
            if let Some(local_changes_view_mode) = request.local_changes_view_mode {
                project.local_changes_view_mode = local_changes_view_mode;
            }
        })
        .map_err(|source| config_error(source, "saveProjectSettings"))
}

fn validate_auto_tracking_rule_count(
    rules: &[artistic_git_core::config::AutoTrackingRule],
    operation_name: &str,
) -> AppResult<()> {
    if rules.len() > AUTO_TRACKING_RULE_LIMIT {
        return Err(crate::logged_app_error(AppError::expected(
            format!(
                "Automatic branch updates support at most {AUTO_TRACKING_RULE_LIMIT} rules. Remove some rules before continuing."
            ),
            operation_name,
        )));
    }
    Ok(())
}

pub fn save_project_window_geometry(
    config: Option<&ConfigActor>,
    repository_path: String,
    window_geometry: WindowGeometry,
) -> AppResult<ProjectSettings> {
    let config = require_config(config, "saveWindowGeometry")?;
    config
        .update_project(repository_path, |project| {
            project.window_geometry = Some(window_geometry);
        })
        .map_err(|source| config_error(source, "saveWindowGeometry"))
}

pub fn load_gitignore(request: GitignoreRequest) -> AppResult<GitignoreFileResponse> {
    let (repository_path, gitignore_path) =
        gitignore_path(&request.repository_path, "loadGitignore")?;
    match read_utf8_file_with_limit(&gitignore_path, GITIGNORE_FILE_LIMIT_BYTES) {
        Ok(content) => Ok(GitignoreFileResponse {
            repository_path,
            path: display_path(&gitignore_path),
            content,
            exists: true,
        }),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(GitignoreFileResponse {
            repository_path,
            path: display_path(&gitignore_path),
            content: String::new(),
            exists: false,
        }),
        Err(source) => Err(crate::logged_app_error(AppError::expected(
            format!("failed to read .gitignore: {source}"),
            "loadGitignore",
        ))),
    }
}

pub fn save_gitignore(request: SaveGitignoreRequest) -> AppResult<GitignoreFileResponse> {
    let (repository_path, gitignore_path) =
        gitignore_path(&request.repository_path, "saveGitignore")?;
    if request.content.len() > GITIGNORE_FILE_LIMIT_BYTES {
        return Err(crate::logged_app_error(AppError::expected(
            format!(
                ".gitignore is too large to edit safely (limit: {GITIGNORE_FILE_LIMIT_BYTES} bytes)"
            ),
            "saveGitignore",
        )));
    }
    fs::write(&gitignore_path, request.content).map_err(|source| {
        crate::logged_app_error(AppError::expected(
            format!("failed to save .gitignore: {source}"),
            "saveGitignore",
        ))
    })?;
    load_gitignore(GitignoreRequest { repository_path })
}

fn read_utf8_file_with_limit(path: &Path, limit_bytes: usize) -> io::Result<String> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(limit_bytes.min(64 * 1024));
    file.take(limit_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("file exceeds the {limit_bytes}-byte application safety limit"),
        ));
    }
    String::from_utf8(bytes).map_err(|source| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("file is not valid UTF-8: {source}"),
        )
    })
}

pub fn identity_sources(config: Option<&ConfigActor>) -> AppResult<IdentitySourcesResponse> {
    let settings = config
        .map(|config| config.settings())
        .transpose()
        .map_err(|source| config_error(source, "loadIdentitySources"))?
        .unwrap_or_default();
    let global_gitconfig_path = real_global_gitconfig_path();
    let global_gitconfig = global_gitconfig_path
        .as_deref()
        .map(|path| read_global_gitconfig_user(path, "loadIdentitySources"))
        .transpose()?
        .unwrap_or_default();

    Ok(IdentitySourcesResponse {
        settings: settings.git.user,
        global_gitconfig,
        global_gitconfig_path: global_gitconfig_path.as_deref().map(display_path),
    })
}

pub fn validate_identity_for_write(
    runner: &GitRunner,
    request: IdentityValidationRequest,
) -> AppResult<IdentityValidationResponse> {
    let identity = if request.requires_identity {
        let repository = request
            .repository_path
            .as_deref()
            .map(|repository_path| {
                crate::repository::read_local_git_identity(
                    runner,
                    repository_path,
                    "validateIdentityForWrite",
                )
            })
            .transpose()?;
        resolve_identity(
            repository.unwrap_or_default(),
            read_real_global_gitconfig_user("validateIdentityForWrite")?,
        )
    } else {
        ResolvedGitIdentity {
            name: None,
            email: None,
            source: IdentitySource::Missing,
            complete: true,
            email_valid: true,
            missing: Vec::new(),
        }
    };

    Ok(IdentityValidationResponse {
        operation_name: request.operation_name,
        requires_identity: request.requires_identity,
        identity,
    })
}

pub fn ssh_key_status() -> AppResult<SshKeyStatus> {
    let Some(private_key_path) = existing_or_default_ssh_private_key_path() else {
        return Ok(SshKeyStatus {
            private_key_path: None,
            public_key_path: None,
            public_key: None,
            exists: false,
        });
    };
    let public_key_path = private_key_path.with_extension("pub");
    let public_key = match read_utf8_file_with_limit(&public_key_path, SSH_PUBLIC_KEY_LIMIT_BYTES) {
        Ok(value) => {
            let value = value.trim().to_owned();
            (!value.is_empty()).then_some(value)
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(crate::logged_app_error(AppError::expected(
                format!("failed to read SSH public key safely: {source}"),
                "sshKeyStatus",
            )))
        }
    };

    Ok(SshKeyStatus {
        private_key_path: Some(display_path(&private_key_path)),
        public_key_path: Some(display_path(&public_key_path)),
        exists: public_key.is_some(),
        public_key,
    })
}

pub fn generate_ssh_key(request: GenerateSshKeyRequest) -> AppResult<SshKeyStatus> {
    let Some(private_key_path) = default_ssh_private_key_path() else {
        return Err(crate::logged_app_error(AppError::expected(
            "home directory is unavailable; cannot generate SSH key",
            "generateSshKey",
        )));
    };
    let public_key_path = private_key_path.with_extension("pub");

    if public_key_path.exists() {
        return ssh_key_status();
    }
    if private_key_path.exists() {
        return Err(crate::logged_app_error(AppError::expected(
            "an ed25519 private key exists but its public key is missing; regenerate the public key manually",
            "generateSshKey",
        )));
    }

    if let Some(parent) = private_key_path.parent() {
        fs::create_dir_all(parent).map_err(|source| {
            crate::logged_app_error(AppError::expected(
                format!("failed to create SSH directory: {source}"),
                "generateSshKey",
            ))
        })?;
    }

    let comment = request
        .comment
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "artistic-git".to_owned());
    let passphrase = request.passphrase.unwrap_or_default();
    if comment.len() > SSH_KEY_COMMENT_LIMIT_BYTES {
        return Err(crate::logged_app_error(AppError::expected(
            format!("SSH key comment is too long (limit: {SSH_KEY_COMMENT_LIMIT_BYTES} bytes)"),
            "generateSshKey",
        )));
    }
    if passphrase.len() > SSH_KEY_PASSPHRASE_LIMIT_BYTES {
        return Err(crate::logged_app_error(AppError::expected(
            format!(
                "SSH key passphrase is too long (limit: {SSH_KEY_PASSPHRASE_LIMIT_BYTES} bytes)"
            ),
            "generateSshKey",
        )));
    }
    let command_for_error = vec![
        "ssh-keygen".to_owned(),
        "-t".to_owned(),
        "ed25519".to_owned(),
        "-C".to_owned(),
        comment.clone(),
        "-f".to_owned(),
        display_path(&private_key_path),
        "-N".to_owned(),
        "<redacted>".to_owned(),
    ];
    let mut command = Command::new("ssh-keygen");
    command
        .arg("-t")
        .arg("ed25519")
        .arg("-C")
        .arg(comment)
        .arg("-f")
        .arg(&private_key_path)
        .arg("-N")
        .arg(passphrase);
    let output = run_bounded_process(
        command,
        command_for_error.clone(),
        "generateSshKey",
        SSH_KEYGEN_TIMEOUT,
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let summary = stderr
            .lines()
            .next()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("ssh-keygen failed")
            .to_owned();
        return Err(crate::logged_app_error(
            AppError::expected(summary, "generateSshKey").with_git(GitCommandError {
                command: command_for_error,
                exit_code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }),
        ));
    }

    ssh_key_status()
}

#[derive(Debug)]
struct BoundedProcessStream {
    bytes: Vec<u8>,
    exceeded_limit: bool,
}

type ProcessOutputReader = thread::JoinHandle<io::Result<BoundedProcessStream>>;

fn run_bounded_process(
    mut command: Command,
    command_for_error: Vec<String>,
    operation_name: &str,
    timeout: Duration,
) -> AppResult<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::git_ops::prepare_child_process_tree(&mut command);
    let mut child = command.spawn().map_err(|source| {
        crate::logged_app_error(
            AppError::expected(format!("failed to start command: {source}"), operation_name)
                .with_git(GitCommandError {
                    command: command_for_error.clone(),
                    exit_code: None,
                    stdout: String::new(),
                    stderr: source.to_string(),
                }),
        )
    })?;
    let mut stdout_reader = child.stdout.take().map(spawn_process_output_reader);
    let mut stderr_reader = child.stderr.take().map(spawn_process_output_reader);
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None)
                if crate::git_ops::active_cancel_token()
                    .is_some_and(|token| token.is_cancelled()) =>
            {
                let status = crate::git_ops::terminate_child_process_tree(&mut child).ok();
                if let Some(status) = status.filter(ExitStatus::success) {
                    break status;
                }
                let (stdout, stderr) = collect_process_output_pair(
                    &mut stdout_reader,
                    &mut stderr_reader,
                    operation_name,
                )?;
                return Err(process_diagnostic_error(
                    "command was cancelled",
                    operation_name,
                    command_for_error,
                    status,
                    stdout.bytes,
                    stderr.bytes,
                ));
            }
            Ok(None) if Instant::now() >= deadline => {
                let status = crate::git_ops::terminate_child_process_tree(&mut child).ok();
                let (stdout, stderr) = collect_process_output_pair(
                    &mut stdout_reader,
                    &mut stderr_reader,
                    operation_name,
                )?;
                return Err(process_diagnostic_error(
                    &format!("command timed out after {} seconds", timeout.as_secs()),
                    operation_name,
                    command_for_error,
                    status,
                    stdout.bytes,
                    stderr.bytes,
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => {
                let _ = crate::git_ops::terminate_child_process_tree(&mut child);
                return Err(crate::logged_app_error(
                    AppError::unexpected(
                        format!("failed to query command status: {source}"),
                        operation_name,
                    )
                    .with_git(GitCommandError {
                        command: command_for_error,
                        exit_code: None,
                        stdout: String::new(),
                        stderr: source.to_string(),
                    }),
                ));
            }
        }
    };

    let (stdout, stderr) =
        collect_process_output_pair(&mut stdout_reader, &mut stderr_reader, operation_name)?;
    if stdout.exceeded_limit || stderr.exceeded_limit {
        return Err(process_diagnostic_error(
            &format!(
                "command output exceeded the {SSH_KEYGEN_OUTPUT_LIMIT_BYTES}-byte per-stream limit"
            ),
            operation_name,
            command_for_error,
            Some(status),
            stdout.bytes,
            stderr.bytes,
        ));
    }

    Ok(Output {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

fn spawn_process_output_reader<R>(mut reader: R) -> ProcessOutputReader
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        const READ_CHUNK_BYTES: usize = 8 * 1024;

        let capture_limit = SSH_KEYGEN_OUTPUT_LIMIT_BYTES.saturating_add(1);
        let mut bytes = Vec::with_capacity(capture_limit.min(READ_CHUNK_BYTES));
        let mut buffer = [0_u8; READ_CHUNK_BYTES];
        loop {
            let bytes_read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(bytes_read) => bytes_read,
                Err(source) if source.kind() == io::ErrorKind::Interrupted => continue,
                Err(source) => return Err(source),
            };
            let captured_bytes = bytes_read.min(capture_limit.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&buffer[..captured_bytes]);
        }
        let exceeded_limit = bytes.len() > SSH_KEYGEN_OUTPUT_LIMIT_BYTES;
        bytes.truncate(SSH_KEYGEN_OUTPUT_LIMIT_BYTES);
        Ok(BoundedProcessStream {
            bytes,
            exceeded_limit,
        })
    })
}

fn collect_process_output_pair(
    stdout_reader: &mut Option<ProcessOutputReader>,
    stderr_reader: &mut Option<ProcessOutputReader>,
    operation_name: &str,
) -> AppResult<(BoundedProcessStream, BoundedProcessStream)> {
    let deadline = Instant::now() + PROCESS_OUTPUT_DRAIN_TIMEOUT;
    let stdout = collect_process_output_reader(stdout_reader, "stdout", operation_name, deadline)?;
    let stderr = collect_process_output_reader(stderr_reader, "stderr", operation_name, deadline)?;
    Ok((stdout, stderr))
}

fn collect_process_output_reader(
    reader: &mut Option<ProcessOutputReader>,
    stream_name: &str,
    operation_name: &str,
    deadline: Instant,
) -> AppResult<BoundedProcessStream> {
    let Some(reader) = reader.take() else {
        return Ok(BoundedProcessStream {
            bytes: Vec::new(),
            exceeded_limit: false,
        });
    };
    while !reader.is_finished() {
        if Instant::now() >= deadline {
            return Err(crate::logged_app_error(AppError::unexpected(
                format!("command {stream_name} remained open after the process exited"),
                operation_name,
            )));
        }
        thread::sleep(Duration::from_millis(10));
    }
    match reader.join() {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(source)) => Err(crate::logged_app_error(AppError::unexpected(
            format!("failed to read command {stream_name}: {source}"),
            operation_name,
        ))),
        Err(_) => Err(crate::logged_app_error(AppError::unexpected(
            format!("command {stream_name} reader thread panicked"),
            operation_name,
        ))),
    }
}

fn process_diagnostic_error(
    summary: &str,
    operation_name: &str,
    command: Vec<String>,
    status: Option<ExitStatus>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> AppError {
    crate::logged_app_error(
        AppError::expected(summary, operation_name).with_git(GitCommandError {
            command,
            exit_code: status.and_then(|status| status.code()),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        }),
    )
}

#[derive(Debug)]
pub struct LazyIdentityValidator<'a> {
    runner: &'a GitRunner,
}

impl<'a> LazyIdentityValidator<'a> {
    pub fn new(runner: &'a GitRunner) -> Self {
        Self { runner }
    }
}

impl IdentityValidationHook for LazyIdentityValidator<'_> {
    fn validate_write_entry(&self, request: &WriteOperationRequest) -> Result<(), AppError> {
        if !request.requires_identity {
            return Ok(());
        }

        let repository_path = request
            .repository_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        let response = validate_identity_for_write(
            self.runner,
            IdentityValidationRequest {
                repository_path,
                operation_name: request.operation_name.clone(),
                requires_identity: true,
            },
        )?;

        if response.identity.complete && response.identity.email_valid {
            return Ok(());
        }

        Err(crate::logged_app_error(
            AppError::expected("Git author identity is required", &request.operation_name)
                .with_context(identity_operation_context(request)),
        ))
    }
}

pub fn parse_gitconfig_user(content: &str) -> GitUserSettings {
    let mut in_user_section = false;
    let mut user = GitUserSettings::default();

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            in_user_section = line
                .trim_matches(['[', ']'])
                .split_whitespace()
                .next()
                .is_some_and(|section| section.eq_ignore_ascii_case("user"));
            continue;
        }

        if !in_user_section {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = clean_config_value(value);
        match key.trim().to_ascii_lowercase().as_str() {
            "name" if !value.is_empty() => user.name = Some(value),
            "email" if !value.is_empty() => user.email = Some(value),
            _ => {}
        }
    }

    user
}

pub fn is_valid_email(email: &str) -> bool {
    let email = email.trim();
    if email.is_empty() || email.chars().any(char::is_whitespace) {
        return false;
    }

    let mut parts = email.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(domain) = parts.next() else {
        return false;
    };
    parts.next().is_none() && !local.is_empty() && domain.contains('.') && !domain.ends_with('.')
}

fn resolve_identity(repository: GitUserSettings, global: GitUserSettings) -> ResolvedGitIdentity {
    let has_repository_identity = repository.name.is_some() || repository.email.is_some();
    let name = repository.name.or(global.name);
    let email = repository.email.or(global.email);
    let email_valid = email.as_deref().map(is_valid_email).unwrap_or(false);
    let mut missing = Vec::new();
    if name.as_deref().is_none_or(|value| value.trim().is_empty()) {
        missing.push(IdentityField::Name);
    }
    if email.as_deref().is_none_or(|value| value.trim().is_empty()) || !email_valid {
        missing.push(IdentityField::Email);
    }

    let source = if name.is_some() || email.is_some() {
        if has_repository_identity {
            IdentitySource::Repository
        } else {
            IdentitySource::GlobalGitconfig
        }
    } else {
        IdentitySource::Missing
    };

    ResolvedGitIdentity {
        name,
        email,
        source,
        complete: missing.is_empty(),
        email_valid,
        missing,
    }
}

fn clean_identity(identity: GitUserSettings) -> GitUserSettings {
    GitUserSettings {
        name: identity.name.and_then(clean_optional_value),
        email: identity.email.and_then(clean_optional_value),
    }
}

fn validate_identity_for_settings(
    identity: &GitUserSettings,
    operation_name: &str,
) -> AppResult<()> {
    let resolved = resolve_identity(identity.clone(), GitUserSettings::default());
    if resolved.complete && resolved.email_valid {
        return Ok(());
    }

    Err(crate::logged_app_error(AppError::expected(
        "Git author identity requires a name and valid email",
        operation_name,
    )))
}

fn clean_optional_value(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn read_real_global_gitconfig_user(operation_name: &str) -> AppResult<GitUserSettings> {
    real_global_gitconfig_path()
        .as_deref()
        .map(|path| read_global_gitconfig_user(path, operation_name))
        .transpose()
        .map(|identity| identity.unwrap_or_default())
}

fn read_global_gitconfig_user(path: &Path, operation_name: &str) -> AppResult<GitUserSettings> {
    match read_utf8_file_with_limit(path, GITIGNORE_FILE_LIMIT_BYTES) {
        Ok(content) => Ok(parse_gitconfig_user(&content)),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(GitUserSettings::default()),
        Err(source) => Err(crate::logged_app_error(AppError::expected(
            format!(
                "failed to read global Git configuration at {}: {source}",
                display_path(path)
            ),
            operation_name,
        ))),
    }
}

fn real_global_gitconfig_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .map(|home| home.join(".gitconfig"))
}

fn default_ssh_private_key_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .map(|home| home.join(".ssh").join("id_ed25519"))
}

fn existing_or_default_ssh_private_key_path() -> Option<PathBuf> {
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))?;

    ["id_ed25519", "id_rsa", "id_ecdsa"]
        .into_iter()
        .map(|name| home.join(".ssh").join(name))
        .find(|path| path.exists() || path.with_extension("pub").exists())
        .or_else(|| Some(home.join(".ssh").join("id_ed25519")))
}

fn gitignore_path(repository_path: &str, operation_name: &str) -> AppResult<(String, PathBuf)> {
    let root = fs::canonicalize(repository_path).map_err(|source| {
        crate::logged_app_error(AppError::expected(
            format!("failed to resolve repository path: {source}"),
            operation_name,
        ))
    })?;
    Ok((display_path(&root), root.join(".gitignore")))
}

fn clean_config_value(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1].to_owned()
    } else {
        value.to_owned()
    }
}

fn identity_operation_context(request: &WriteOperationRequest) -> OperationContext {
    let mut context = OperationContext::new(&request.operation_name);
    if let Some(repository_path) = &request.repository_path {
        context = context.with_repository_path(repository_path.to_string_lossy().into_owned());
    }
    context
}

fn require_config<'a>(
    config: Option<&'a ConfigActor>,
    operation_name: &str,
) -> AppResult<&'a ConfigActor> {
    config.ok_or_else(|| {
        crate::logged_app_error(AppError::fatal(
            "configuration store is unavailable",
            operation_name,
        ))
    })
}

fn config_error(
    source: artistic_git_core::config::ConfigStoreError,
    operation_name: &str,
) -> AppError {
    crate::logged_app_error(AppError::unexpected(
        format!("failed to update settings: {source}"),
        operation_name,
    ))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn display_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_contracts::AppErrorCategory;
    use artistic_git_core::config::{AutoTrackingRule, ConfigChangeEvent, ConfigPaths};
    use artistic_git_git_runner::GitDistribution;
    use artistic_git_test_support::{require_git_dist, TestTempDir};
    use std::{
        ffi::OsString,
        sync::{Arc, Mutex},
    };

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn bounded_text_reader_rejects_oversized_files() {
        let temp = TestTempDir::new("ag-settings-bounded-text").expect("temp");
        let path = temp.path().join("settings.txt");
        fs::write(&path, b"12345").expect("write fixture");

        let error = read_utf8_file_with_limit(&path, 4).expect_err("oversized file");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("4-byte"));
    }

    #[test]
    fn missing_global_gitconfig_is_treated_as_empty() {
        let temp = TestTempDir::new("ag-settings-missing-gitconfig").expect("temp");
        let identity = read_global_gitconfig_user(
            &temp.path().join("missing.gitconfig"),
            "loadIdentitySources",
        )
        .expect("missing config should be empty");

        assert_eq!(identity, GitUserSettings::default());
    }

    #[test]
    fn invalid_global_gitconfig_preserves_the_read_error() {
        let temp = TestTempDir::new("ag-settings-invalid-gitconfig").expect("temp");
        let path = temp.path().join("invalid.gitconfig");
        fs::write(&path, [0xff, 0xfe]).expect("write invalid UTF-8 fixture");

        let error = read_global_gitconfig_user(&path, "loadIdentitySources")
            .expect_err("invalid config should fail");

        assert_eq!(error.context.operation_name, "loadIdentitySources");
        assert!(error.summary.contains("invalid.gitconfig"));
        assert!(error.summary.contains("UTF-8"));
    }

    #[test]
    fn automatic_branch_update_rule_count_is_bounded() {
        let rules = (0..=AUTO_TRACKING_RULE_LIMIT)
            .map(|index| AutoTrackingRule {
                source_branch: format!("source-{index}"),
                target_branch: "main".to_owned(),
            })
            .collect::<Vec<_>>();

        let error = validate_auto_tracking_rule_count(&rules, "loadProjectSettings")
            .expect_err("too many rules should fail");

        assert!(error.summary.contains("at most 100 rules"));
        assert_eq!(error.context.operation_name, "loadProjectSettings");
    }

    #[cfg(unix)]
    #[test]
    fn bounded_process_times_out_and_reaps_the_process_group() {
        let started = Instant::now();
        let error = run_bounded_process(
            {
                let mut command = Command::new("sh");
                command.args(["-c", "sleep 5"]);
                command
            },
            vec!["sh".to_owned(), "-c".to_owned(), "sleep 5".to_owned()],
            "boundedProcessTimeoutTest",
            Duration::from_millis(20),
        )
        .expect_err("command should time out");

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(error.summary.contains("timed out"));
        assert_eq!(error.context.operation_name, "boundedProcessTimeoutTest");
    }

    #[cfg(unix)]
    #[test]
    fn bounded_process_rejects_unbounded_output_with_diagnostics() {
        let error = run_bounded_process(
            {
                let mut command = Command::new("sh");
                command.args([
                    "-c",
                    "i=0; while [ $i -lt 70000 ]; do printf x; i=$((i + 1)); done",
                ]);
                command
            },
            vec!["fixture-output-command".to_owned()],
            "boundedProcessOutputTest",
            Duration::from_secs(5),
        )
        .expect_err("command output should be bounded");

        assert!(error.summary.contains("per-stream limit"));
        let details = error.git.expect("bounded command diagnostics");
        assert_eq!(details.command, vec!["fixture-output-command"]);
        assert_eq!(details.stdout.len(), SSH_KEYGEN_OUTPUT_LIMIT_BYTES);
    }

    #[test]
    fn parses_real_gitconfig_user_section_only() {
        let parsed = parse_gitconfig_user(
            r#"
            [core]
              email = ignored@example.test
            [user]
              name = "Art User"
              email = art@example.test
            "#,
        );

        assert_eq!(parsed.name.as_deref(), Some("Art User"));
        assert_eq!(parsed.email.as_deref(), Some("art@example.test"));
    }

    #[test]
    fn validates_email_shape_for_author_identity() {
        assert!(is_valid_email("artist@example.test"));
        assert!(!is_valid_email("artist"));
        assert!(!is_valid_email("artist@"));
        assert!(!is_valid_email("artist@example"));
        assert!(!is_valid_email("artist @example.test"));
    }

    #[test]
    fn validates_identity_for_settings_save() {
        assert!(validate_identity_for_settings(
            &GitUserSettings {
                name: Some("Art User".to_owned()),
                email: Some("art@example.test".to_owned()),
            },
            "saveAppSettings",
        )
        .is_ok());

        let missing =
            validate_identity_for_settings(&GitUserSettings::default(), "saveAppSettings")
                .expect_err("missing identity should fail");
        assert_eq!(missing.context.operation_name, "saveAppSettings");

        assert!(validate_identity_for_settings(
            &GitUserSettings {
                name: Some("Art User".to_owned()),
                email: Some("not-an-email".to_owned()),
            },
            "saveAppSettings",
        )
        .is_err());
    }

    #[test]
    fn resolves_repository_identity_before_global_fallback() {
        let identity = resolve_identity(
            GitUserSettings {
                name: Some("Repo User".to_owned()),
                email: None,
            },
            GitUserSettings {
                name: Some("Global User".to_owned()),
                email: Some("global@example.test".to_owned()),
            },
        );

        assert_eq!(identity.name.as_deref(), Some("Repo User"));
        assert_eq!(identity.email.as_deref(), Some("global@example.test"));
        assert_eq!(identity.source, IdentitySource::Repository);
        assert!(identity.complete);
    }

    #[test]
    fn validate_identity_for_write_skips_non_identity_operations() {
        let (runner, _dist_temp) = real_runner();

        let response = validate_identity_for_write(
            &runner,
            IdentityValidationRequest {
                repository_path: Some("/definitely/missing/repository".to_owned()),
                operation_name: "listBranches".to_owned(),
                requires_identity: false,
            },
        )
        .expect("non-identity validation should not read repository");

        assert!(!response.requires_identity);
        assert!(response.identity.complete);
        assert_eq!(response.identity.source, IdentitySource::Missing);
    }

    #[test]
    fn window_menu_save_project_window_geometry_updates_only_geometry() {
        let config_dir = TestTempDir::new("ag-settings-window-geometry").expect("temp config");
        let config = ConfigActor::load(ConfigPaths::new(
            config_dir.path().join("settings.json"),
            config_dir.path().join("projects.json"),
        ))
        .expect("load config actor");

        let geometry = WindowGeometry {
            width: 1440,
            height: 900,
            x: Some(20),
            y: Some(40),
            maximized: true,
        };
        let saved =
            save_project_window_geometry(Some(&config), "/repo/art".to_owned(), geometry.clone())
                .expect("save window geometry");

        assert_eq!(saved.window_geometry, Some(geometry.clone()));

        let loaded = load_project_settings(
            Some(&config),
            ProjectSettingsRequest {
                repository_path: "/repo/art".to_owned(),
            },
        )
        .expect("load project settings");

        assert_eq!(loaded.window_geometry, Some(geometry));
    }

    #[test]
    fn validate_identity_for_write_reads_real_global_gitconfig_fallback() {
        let (runner, _dist_temp) = real_runner();
        let _env_lock = ENV_LOCK.lock().expect("lock env");
        let real_home = TestTempDir::new("ag-settings-real-home").expect("temp home");
        fs::write(
            real_home.path().join(".gitconfig"),
            "[user]\n  name = Global User\n  email = global@example.test\n",
        )
        .expect("write real global gitconfig");
        let _home = EnvGuard::set("HOME", real_home.path().as_os_str());
        let repo = TestRepo::new(&runner);
        repo.init();

        let response = validate_identity_for_write(
            &runner,
            IdentityValidationRequest {
                repository_path: Some(display_path(&repo.path)),
                operation_name: "commitChanges".to_owned(),
                requires_identity: true,
            },
        )
        .expect("validate identity");

        assert_eq!(response.identity.name.as_deref(), Some("Global User"));
        assert_eq!(
            response.identity.email.as_deref(),
            Some("global@example.test")
        );
        assert_eq!(response.identity.source, IdentitySource::GlobalGitconfig);
        assert!(response.identity.complete);
    }

    #[test]
    fn lazy_identity_validator_blocks_missing_identity() {
        let (runner, _dist_temp) = real_runner();
        let _env_lock = ENV_LOCK.lock().expect("lock env");
        let real_home = TestTempDir::new("ag-settings-empty-home").expect("temp home");
        let _home = EnvGuard::set("HOME", real_home.path().as_os_str());
        let repo = TestRepo::new(&runner);
        repo.init();

        let validator = LazyIdentityValidator::new(&runner);
        let request = WriteOperationRequest::new("commitChanges")
            .with_repository_path(&repo.path)
            .requiring_identity();
        let error = validator
            .validate_write_entry(&request)
            .expect_err("missing identity blocks write");

        assert_eq!(error.category, AppErrorCategory::Expected);
        assert_eq!(error.summary, "Git author identity is required");
        assert_eq!(error.context.operation_name, "commitChanges");
        let repo_path = display_path(&repo.path);
        assert_eq!(
            error.context.repository_path.as_deref(),
            Some(repo_path.as_str())
        );
    }

    #[test]
    fn save_app_settings_broadcasts_and_applies_identity_to_open_repositories() {
        let (runner, _dist_temp) = real_runner();
        let _env_lock = ENV_LOCK.lock().expect("lock env");
        let real_home = TestTempDir::new("ag-settings-save-home").expect("temp home");
        let _home = EnvGuard::set("HOME", real_home.path().as_os_str());
        let config_dir = TestTempDir::new("ag-settings-config").expect("temp config");
        let config = ConfigActor::load(ConfigPaths::new(
            config_dir.path().join("settings.json"),
            config_dir.path().join("projects.json"),
        ))
        .expect("load config actor");
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);
        config
            .subscribe(Arc::new(move |event| {
                captured_events.lock().expect("events lock").push(event);
            }))
            .expect("subscribe");
        let repo_one = TestRepo::new(&runner);
        repo_one.init();
        let repo_two = TestRepo::new(&runner);
        repo_two.init();

        let mut settings = AppSettings::default();
        settings.git.user = GitUserSettings {
            name: Some("Art User".to_owned()),
            email: Some("art@example.test".to_owned()),
        };
        let saved = save_app_settings(
            &runner,
            Some(&config),
            SaveAppSettingsRequest {
                settings,
                open_repository_paths: vec![
                    display_path(&repo_one.path),
                    "  ".to_owned(),
                    display_path(&repo_two.path),
                    display_path(&repo_one.path),
                ],
                validate_identity: true,
            },
        )
        .expect("save app settings");

        assert_eq!(saved.git.user.name.as_deref(), Some("Art User"));
        assert_eq!(saved.git.user.email.as_deref(), Some("art@example.test"));
        assert_eq!(
            repo_one.local_config("user.name").as_deref(),
            Some("Art User")
        );
        assert_eq!(
            repo_one.local_config("user.email").as_deref(),
            Some("art@example.test")
        );
        assert_eq!(
            repo_two.local_config("user.name").as_deref(),
            Some("Art User")
        );
        assert_eq!(
            repo_two.local_config("user.email").as_deref(),
            Some("art@example.test")
        );
        assert!(
            !real_home.path().join(".gitconfig").exists(),
            "settings save must not write the user's global gitconfig"
        );
        let events = events.lock().expect("events lock");
        assert!(matches!(
            events.as_slice(),
            [ConfigChangeEvent::SettingsUpdated { settings }]
                if settings.git.user.name.as_deref() == Some("Art User")
        ));
    }

    fn real_runner() -> (GitRunner, TestTempDir) {
        let dist = require_git_dist().expect("load embedded git distribution");
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-settings-runner-home").expect("temp home");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        (runner, temp)
    }

    struct EnvGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &std::ffi::OsStr) -> Self {
            let previous = env::var_os(key);
            env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                env::set_var(self.key, previous);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    struct TestRepo {
        path: PathBuf,
        _temp: TestTempDir,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-settings-repo").expect("temp repo");
            Self {
                path: temp.path().to_path_buf(),
                _temp: temp,
                runner: runner.clone(),
            }
        }

        fn init(&self) {
            self.git(["init", "-b", "main"]);
        }

        fn local_config(&self, key: &str) -> Option<String> {
            let output = self
                .runner
                .git_command_builder()
                .args([OsString::from("-C"), self.path.as_os_str().to_owned()])
                .args(["config", "--local", "--get", key].map(OsString::from))
                .build()
                .to_command()
                .output()
                .expect("run git config");
            output
                .status
                .success()
                .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                .filter(|value| !value.is_empty())
        }

        fn git<const N: usize>(&self, args: [&str; N]) {
            let output = self
                .runner
                .git_command_builder()
                .args([OsString::from("-C"), self.path.as_os_str().to_owned()])
                .args(args.map(OsString::from))
                .build()
                .to_command()
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
