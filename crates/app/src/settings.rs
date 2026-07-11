use artistic_git_contracts::{AppError, AppResult, OperationContext};
use artistic_git_core::config::{
    normalize_project_path_key, AppSettings, ConfigActor, GitUserSettings, LargeFileCheckSettings,
    LocalChangesViewMode, ProjectSettings, SidebarLayoutSettings, WindowGeometry,
};
use artistic_git_git_runner::{GitRunner, IdentityValidationHook, WriteOperationRequest};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::BTreeSet,
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub app_version: String,
    pub settings: AppSettings,
    pub identity_sources: IdentitySourcesResponse,
    pub ssh_key: SshKeyStatus,
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
    Ok(SettingsSnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        settings: require_config(config, "loadAppSettings")?
            .settings()
            .map_err(|source| config_error(source, "loadAppSettings"))?,
        identity_sources: identity_sources(config)?,
        ssh_key: ssh_key_status()?,
    })
}

pub fn load_app_settings(config: Option<&ConfigActor>) -> AppResult<AppSettings> {
    require_config(config, "loadAppSettings")?
        .settings()
        .map_err(|source| config_error(source, "loadAppSettings"))
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
}

pub fn save_project_settings(
    config: Option<&ConfigActor>,
    request: SaveProjectSettingsRequest,
) -> AppResult<ProjectSettings> {
    let config = require_config(config, "saveProjectSettings")?;
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
    match fs::read_to_string(&gitignore_path) {
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
    fs::write(&gitignore_path, request.content).map_err(|source| {
        crate::logged_app_error(AppError::expected(
            format!("failed to save .gitignore: {source}"),
            "saveGitignore",
        ))
    })?;
    load_gitignore(GitignoreRequest { repository_path })
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
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|content| parse_gitconfig_user(&content))
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
            read_real_global_gitconfig_user(),
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
    let public_key = fs::read_to_string(&public_key_path)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

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
    let output = Command::new("ssh-keygen")
        .arg("-t")
        .arg("ed25519")
        .arg("-C")
        .arg(comment)
        .arg("-f")
        .arg(&private_key_path)
        .arg("-N")
        .arg(passphrase)
        .output()
        .map_err(|source| {
            crate::logged_app_error(AppError::expected(
                format!("failed to start ssh-keygen: {source}"),
                "generateSshKey",
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let summary = stderr
            .lines()
            .next()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("ssh-keygen failed");
        return Err(crate::logged_app_error(AppError::expected(
            summary,
            "generateSshKey",
        )));
    }

    ssh_key_status()
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

fn read_real_global_gitconfig_user() -> GitUserSettings {
    real_global_gitconfig_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|content| parse_gitconfig_user(&content))
        .unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_contracts::AppErrorCategory;
    use artistic_git_core::config::{ConfigChangeEvent, ConfigPaths};
    use artistic_git_git_runner::GitDistribution;
    use artistic_git_test_support::{require_git_dist, TestTempDir};
    use std::{
        ffi::OsString,
        sync::{Arc, Mutex},
    };

    static ENV_LOCK: Mutex<()> = Mutex::new(());

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
