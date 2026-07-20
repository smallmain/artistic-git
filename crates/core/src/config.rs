use serde::{de::DeserializeOwned, Deserialize, Serialize};
use specta::Type;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tempfile::NamedTempFile;
use thiserror::Error;

pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_RECENT_PROJECT_LIMIT: u16 = 20;
pub const DEFAULT_FETCH_INTERVAL_SECONDS: u32 = 60;
pub const DEFAULT_LOG_RETENTION_DAYS: u16 = 30;
pub const DEFAULT_WINDOW_WIDTH: u32 = 1280;
pub const DEFAULT_WINDOW_HEIGHT: u32 = 720;
pub const DEFAULT_SIDEBAR_WIDTH_PX: u16 = 280;
pub const DEFAULT_BRANCH_SECTION_RATIO_PERCENT: u8 = 60;
pub const DEFAULT_LARGE_FILE_THRESHOLD_MB: u32 = 50;
pub const DEFAULT_DEBOUNCE_DELAY: Duration = Duration::from_millis(250);
const CONFIG_FILE_LIMIT_BYTES: usize = 8 * 1024 * 1024;

pub type ConfigStoreResult<T> = Result<T, ConfigStoreError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u32,
    pub language: LanguagePreference,
    pub appearance: AppearanceSettings,
    pub git: GitSettings,
    pub updates: UpdateSettings,
    pub privacy: PrivacySettings,
    pub onboarding: OnboardingSettings,
    pub window: GlobalWindowSettings,
    pub paths: PathSettings,
    pub logging: LoggingSettings,
    pub recent_project_limit: u16,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            language: LanguagePreference::System,
            appearance: AppearanceSettings::default(),
            git: GitSettings::default(),
            updates: UpdateSettings::default(),
            privacy: PrivacySettings::default(),
            onboarding: OnboardingSettings::default(),
            window: GlobalWindowSettings::default(),
            paths: PathSettings::default(),
            logging: LoggingSettings::default(),
            recent_project_limit: DEFAULT_RECENT_PROJECT_LIMIT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LanguagePreference {
    System,
    ZhCn,
    EnUs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub theme: ThemePreference,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitSettings {
    pub auto_fetch: bool,
    pub fetch_interval_seconds: u32,
    pub user: GitUserSettings,
    pub remember_ssh_passphrase: bool,
}

impl Default for GitSettings {
    fn default() -> Self {
        Self {
            auto_fetch: true,
            fetch_interval_seconds: DEFAULT_FETCH_INTERVAL_SECONDS,
            user: GitUserSettings::default(),
            remember_ssh_passphrase: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitUserSettings {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateSettings {
    pub auto_check: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self { auto_check: true }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacySettings {
    pub gravatar_enabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct OnboardingSettings {
    pub onboarded: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GlobalWindowSettings {
    pub default_geometry: WindowGeometry,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct PathSettings {
    pub last_clone_parent_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LoggingSettings {
    pub level: LogLevelPreference,
    pub retain_days: u16,
}

impl Default for LoggingSettings {
    fn default() -> Self {
        Self {
            level: LogLevelPreference::Info,
            retain_days: DEFAULT_LOG_RETENTION_DAYS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogLevelPreference {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectsDocument {
    pub schema_version: u32,
    pub projects: BTreeMap<String, ProjectSettings>,
}

impl Default for ProjectsDocument {
    fn default() -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            projects: BTreeMap::new(),
        }
    }
}

impl ProjectsDocument {
    pub fn recent_projects(&self, limit: usize) -> Vec<ProjectSettings> {
        let mut projects = self.projects.values().cloned().collect::<Vec<_>>();
        projects.sort_by(|left, right| {
            right
                .last_opened_at
                .cmp(&left.last_opened_at)
                .then_with(|| left.path.cmp(&right.path))
        });
        projects.truncate(limit);
        projects
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectSettings {
    pub path: String,
    pub display_name: Option<String>,
    pub pinned: bool,
    pub last_opened_at: Option<String>,
    pub last_branch: Option<String>,
    pub auto_tracking_rules: Vec<AutoTrackingRule>,
    pub sidebar: SidebarLayoutSettings,
    pub local_changes_view_mode: LocalChangesViewMode,
    pub window_geometry: Option<WindowGeometry>,
    pub review_mode_crash: Option<ReviewModeCrashMarker>,
    pub large_file_check: LargeFileCheckSettings,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            path: String::new(),
            display_name: None,
            pinned: false,
            last_opened_at: None,
            last_branch: None,
            auto_tracking_rules: Vec::new(),
            sidebar: SidebarLayoutSettings::default(),
            local_changes_view_mode: LocalChangesViewMode::Flat,
            window_geometry: None,
            review_mode_crash: None,
            large_file_check: LargeFileCheckSettings::default(),
        }
    }
}

impl ProjectSettings {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoTrackingRule {
    pub source_branch: String,
    pub target_branch: String,
}

impl AutoTrackingRule {
    pub fn new(source_branch: impl Into<String>, target_branch: impl Into<String>) -> Self {
        Self {
            source_branch: source_branch.into(),
            target_branch: target_branch.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SidebarLayoutSettings {
    pub width_px: u16,
    pub branch_section_ratio_percent: u8,
    pub branches_collapsed: bool,
    pub stashes_collapsed: bool,
}

impl Default for SidebarLayoutSettings {
    fn default() -> Self {
        Self {
            width_px: DEFAULT_SIDEBAR_WIDTH_PX,
            branch_section_ratio_percent: DEFAULT_BRANCH_SECTION_RATIO_PERCENT,
            branches_collapsed: false,
            stashes_collapsed: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LocalChangesViewMode {
    Flat,
    Tree,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewModeCrashMarker {
    pub auto_stash_ref: Option<String>,
    pub entered_at: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LargeFileCheckSettings {
    pub enabled: bool,
    pub threshold_mb: u32,
}

impl Default for LargeFileCheckSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_mb: DEFAULT_LARGE_FILE_THRESHOLD_MB,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigPaths {
    pub settings_path: PathBuf,
    pub projects_path: PathBuf,
}

impl ConfigPaths {
    pub fn new(settings_path: impl Into<PathBuf>, projects_path: impl Into<PathBuf>) -> Self {
        Self {
            settings_path: settings_path.into(),
            projects_path: projects_path.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConfigChangeEvent {
    SettingsUpdated {
        settings: AppSettings,
    },
    ProjectUpdated {
        #[serde(rename = "projectKey")]
        project_key: String,
        project: ProjectSettings,
    },
    ProjectRemoved {
        #[serde(rename = "projectKey")]
        project_key: String,
        project: Option<ProjectSettings>,
    },
}

pub trait ConfigChangeSubscriber: Send + Sync + 'static {
    fn on_config_change(&self, event: ConfigChangeEvent);
}

impl<F> ConfigChangeSubscriber for F
where
    F: Fn(ConfigChangeEvent) + Send + Sync + 'static,
{
    fn on_config_change(&self, event: ConfigChangeEvent) {
        self(event);
    }
}

#[derive(Clone)]
pub struct ConfigActor {
    store: Arc<ConfigStore>,
    subscribers: Arc<Mutex<Vec<Arc<dyn ConfigChangeSubscriber>>>>,
}

impl ConfigActor {
    pub fn load(paths: ConfigPaths) -> ConfigStoreResult<Self> {
        Ok(Self {
            store: Arc::new(ConfigStore::load(paths)?),
            subscribers: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn store(&self) -> Arc<ConfigStore> {
        Arc::clone(&self.store)
    }

    pub fn settings(&self) -> ConfigStoreResult<AppSettings> {
        self.store.settings()
    }

    pub fn projects(&self) -> ConfigStoreResult<ProjectsDocument> {
        self.store.projects()
    }

    pub fn subscribe(&self, subscriber: Arc<dyn ConfigChangeSubscriber>) -> ConfigStoreResult<()> {
        self.subscribers
            .lock()
            .map_err(|_| ConfigStoreError::LockPoisoned)?
            .push(subscriber);
        Ok(())
    }

    pub fn update_settings(
        &self,
        update: impl FnOnce(&mut AppSettings),
    ) -> ConfigStoreResult<AppSettings> {
        let settings = self.store.update_settings(update)?;
        self.broadcast(ConfigChangeEvent::SettingsUpdated {
            settings: settings.clone(),
        })?;
        Ok(settings)
    }

    pub fn update_project(
        &self,
        project_path: impl Into<String>,
        update: impl FnOnce(&mut ProjectSettings),
    ) -> ConfigStoreResult<ProjectSettings> {
        let project = self.store.update_project(project_path, update)?;
        self.broadcast(ConfigChangeEvent::ProjectUpdated {
            project_key: project.path.clone(),
            project: project.clone(),
        })?;
        Ok(project)
    }

    pub fn remove_project(&self, project_path: &str) -> ConfigStoreResult<Option<ProjectSettings>> {
        let project_key = normalize_project_path_key(project_path)?;
        let project = self.store.remove_project(&project_key)?;
        self.broadcast(ConfigChangeEvent::ProjectRemoved {
            project_key,
            project: project.clone(),
        })?;
        Ok(project)
    }

    fn broadcast(&self, event: ConfigChangeEvent) -> ConfigStoreResult<()> {
        let subscribers = self
            .subscribers
            .lock()
            .map_err(|_| ConfigStoreError::LockPoisoned)?
            .clone();

        for subscriber in subscribers {
            subscriber.on_config_change(event.clone());
        }

        Ok(())
    }
}

#[derive(Debug)]
pub struct ConfigStore {
    paths: ConfigPaths,
    state: Mutex<ConfigState>,
}

impl ConfigStore {
    pub fn load(paths: ConfigPaths) -> ConfigStoreResult<Self> {
        let settings = read_json_or_default(&paths.settings_path)?;
        let projects = read_json_or_default(&paths.projects_path)?;

        Ok(Self {
            paths,
            state: Mutex::new(ConfigState { settings, projects }),
        })
    }

    pub fn paths(&self) -> &ConfigPaths {
        &self.paths
    }

    pub fn settings(&self) -> ConfigStoreResult<AppSettings> {
        Ok(self.lock_state()?.settings.clone())
    }

    pub fn projects(&self) -> ConfigStoreResult<ProjectsDocument> {
        Ok(self.lock_state()?.projects.clone())
    }

    pub fn project(&self, project_path: &str) -> ConfigStoreResult<Option<ProjectSettings>> {
        let project_key = normalize_project_path_key(project_path)?;
        Ok(self
            .lock_state()?
            .projects
            .projects
            .get(&project_key)
            .cloned())
    }

    pub fn update_settings(
        &self,
        update: impl FnOnce(&mut AppSettings),
    ) -> ConfigStoreResult<AppSettings> {
        let mut state = self.lock_state()?;
        let mut next_settings = state.settings.clone();
        update(&mut next_settings);

        atomic_write_json(&self.paths.settings_path, &next_settings)?;
        state.settings = next_settings.clone();

        tracing::debug!(
            path = %self.paths.settings_path.display(),
            "updated application settings"
        );

        Ok(next_settings)
    }

    pub fn update_project(
        &self,
        project_path: impl Into<String>,
        update: impl FnOnce(&mut ProjectSettings),
    ) -> ConfigStoreResult<ProjectSettings> {
        let project_path = normalize_project_path_key(project_path.into())?;
        let mut state = self.lock_state()?;
        let mut next_projects = state.projects.clone();
        let entry = next_projects
            .projects
            .entry(project_path.clone())
            .or_insert_with(|| ProjectSettings::new(project_path));
        update(entry);
        let updated_project = entry.clone();

        atomic_write_json(&self.paths.projects_path, &next_projects)?;
        state.projects = next_projects;

        tracing::debug!(
            path = %self.paths.projects_path.display(),
            project = %updated_project.path,
            "updated project settings"
        );

        Ok(updated_project)
    }

    pub fn remove_project(&self, project_path: &str) -> ConfigStoreResult<Option<ProjectSettings>> {
        let project_key = normalize_project_path_key(project_path)?;
        let mut state = self.lock_state()?;
        let mut next_projects = state.projects.clone();
        let removed_project = next_projects.projects.remove(&project_key);

        atomic_write_json(&self.paths.projects_path, &next_projects)?;
        state.projects = next_projects;

        Ok(removed_project)
    }

    pub fn flush(&self) -> ConfigStoreResult<()> {
        let state = self.lock_state()?;
        atomic_write_json(&self.paths.settings_path, &state.settings)?;
        atomic_write_json(&self.paths.projects_path, &state.projects)?;
        Ok(())
    }

    fn lock_state(&self) -> ConfigStoreResult<MutexGuard<'_, ConfigState>> {
        self.state
            .lock()
            .map_err(|_| ConfigStoreError::LockPoisoned)
    }
}

#[derive(Debug, Clone)]
struct ConfigState {
    settings: AppSettings,
    projects: ProjectsDocument,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DebouncePolicy {
    delay: Duration,
}

impl DebouncePolicy {
    pub fn new(delay: Duration) -> Self {
        Self { delay }
    }

    pub fn delay(&self) -> Duration {
        self.delay
    }

    pub fn next_deadline(&self, changed_at: Instant) -> Instant {
        changed_at + self.delay
    }
}

impl Default for DebouncePolicy {
    fn default() -> Self {
        Self {
            delay: DEFAULT_DEBOUNCE_DELAY,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebouncedFlush {
    policy: DebouncePolicy,
    deadline: Option<Instant>,
}

impl DebouncedFlush {
    pub fn new(policy: DebouncePolicy) -> Self {
        Self {
            policy,
            deadline: None,
        }
    }

    pub fn record_change(&mut self, changed_at: Instant) -> Instant {
        let deadline = self.policy.next_deadline(changed_at);
        self.deadline = Some(deadline);
        deadline
    }

    pub fn should_flush(&self, now: Instant) -> bool {
        self.deadline.is_some_and(|deadline| now >= deadline)
    }

    pub fn mark_flushed(&mut self) {
        self.deadline = None;
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
}

#[derive(Debug, Error)]
pub enum ConfigStoreError {
    #[error("invalid config file path: {path}")]
    InvalidPath { path: PathBuf },
    #[error("failed to resolve current directory: {source}")]
    CurrentDir { source: io::Error },
    #[error("failed to read config file {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("failed to parse config file {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to serialize config file {path}: {source}")]
    Serialize {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("failed to create config directory {path}: {source}")]
    CreateDir { path: PathBuf, source: io::Error },
    #[error("failed to create temporary config file for {path}: {source}")]
    CreateTemp { path: PathBuf, source: io::Error },
    #[error("failed to write config file {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("failed to persist config file {path}: {source}")]
    Persist { path: PathBuf, source: io::Error },
    #[error("config store lock poisoned")]
    LockPoisoned,
}

pub fn normalize_project_path_key(path: impl AsRef<Path>) -> ConfigStoreResult<String> {
    let path = path.as_ref();
    if path.as_os_str().is_empty() {
        return Err(ConfigStoreError::InvalidPath {
            path: path.to_path_buf(),
        });
    }

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| ConfigStoreError::CurrentDir { source })?
            .join(path)
    };

    let canonicalized = std::fs::canonicalize(&absolute).unwrap_or(absolute);

    let mut normalized = PathBuf::new();
    for component in canonicalized.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }

    let key = normalized.to_string_lossy().into_owned();
    #[cfg(windows)]
    let key = key.replace('\\', "/");

    Ok(key)
}

fn read_json_or_default<T>(path: &Path) -> ConfigStoreResult<T>
where
    T: DeserializeOwned + Default,
{
    match File::open(path) {
        Ok(file) => {
            let mut bytes = Vec::with_capacity(CONFIG_FILE_LIMIT_BYTES.min(64 * 1024));
            file.take(CONFIG_FILE_LIMIT_BYTES.saturating_add(1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|source| ConfigStoreError::Read {
                    path: path.to_path_buf(),
                    source,
                })?;
            if bytes.len() > CONFIG_FILE_LIMIT_BYTES {
                return Err(ConfigStoreError::Read {
                    path: path.to_path_buf(),
                    source: io::Error::new(
                        ErrorKind::InvalidData,
                        format!(
                            "config file exceeds the {CONFIG_FILE_LIMIT_BYTES}-byte application safety limit"
                        ),
                    ),
                });
            }
            serde_json::from_slice(&bytes).map_err(|source| ConfigStoreError::Parse {
                path: path.to_path_buf(),
                source,
            })
        }
        Err(source) if source.kind() == ErrorKind::NotFound => Ok(T::default()),
        Err(source) => Err(ConfigStoreError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn atomic_write_json<T>(path: &Path, value: &T) -> ConfigStoreResult<()>
where
    T: Serialize,
{
    if path.file_name().is_none() {
        return Err(ConfigStoreError::InvalidPath {
            path: path.to_path_buf(),
        });
    }

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    fs::create_dir_all(parent).map_err(|source| ConfigStoreError::CreateDir {
        path: parent.to_path_buf(),
        source,
    })?;

    let mut temp_file =
        NamedTempFile::new_in(parent).map_err(|source| ConfigStoreError::CreateTemp {
            path: path.to_path_buf(),
            source,
        })?;

    serde_json::to_writer_pretty(&mut temp_file, value).map_err(|source| {
        ConfigStoreError::Serialize {
            path: path.to_path_buf(),
            source,
        }
    })?;
    temp_file
        .write_all(b"\n")
        .map_err(|source| ConfigStoreError::Write {
            path: path.to_path_buf(),
            source,
        })?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|source| ConfigStoreError::Write {
            path: path.to_path_buf(),
            source,
        })?;

    temp_file
        .persist(path)
        .map_err(|error| ConfigStoreError::Persist {
            path: path.to_path_buf(),
            source: error.error,
        })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };
    use tempfile::tempdir;

    #[test]
    fn settings_and_projects_have_default_values() {
        let settings = AppSettings::default();
        let projects = ProjectsDocument::default();

        assert_eq!(settings.schema_version, CONFIG_SCHEMA_VERSION);
        assert_eq!(settings.language, LanguagePreference::System);
        assert_eq!(settings.appearance.theme, ThemePreference::System);
        assert!(settings.git.auto_fetch);
        assert_eq!(
            settings.git.fetch_interval_seconds,
            DEFAULT_FETCH_INTERVAL_SECONDS
        );
        assert_eq!(settings.git.user, GitUserSettings::default());
        assert!(!settings.git.remember_ssh_passphrase);
        assert!(settings.updates.auto_check);
        assert!(!settings.privacy.gravatar_enabled);
        assert!(!settings.onboarding.onboarded);
        assert_eq!(
            settings.window.default_geometry,
            WindowGeometry {
                width: DEFAULT_WINDOW_WIDTH,
                height: DEFAULT_WINDOW_HEIGHT,
                x: None,
                y: None,
                maximized: false,
            }
        );
        assert_eq!(settings.paths.last_clone_parent_dir, None);
        assert_eq!(settings.logging.level, LogLevelPreference::Info);
        assert_eq!(settings.logging.retain_days, DEFAULT_LOG_RETENTION_DAYS);
        assert_eq!(settings.recent_project_limit, DEFAULT_RECENT_PROJECT_LIMIT);
        assert_eq!(projects.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(projects.projects.is_empty());

        let project = ProjectSettings::new("/repo/project");
        assert_eq!(project.sidebar, SidebarLayoutSettings::default());
        assert_eq!(project.local_changes_view_mode, LocalChangesViewMode::Flat);
        assert_eq!(project.window_geometry, None);
        assert_eq!(project.review_mode_crash, None);
        assert_eq!(project.large_file_check, LargeFileCheckSettings::default());
    }

    #[test]
    fn store_writes_atomically_and_reads_back_settings() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = ConfigPaths::new(
            temp_dir.path().join("settings.json"),
            temp_dir.path().join("projects.json"),
        );
        let store = ConfigStore::load(paths.clone()).expect("load default store");

        store
            .update_settings(|settings| {
                settings.appearance.theme = ThemePreference::Dark;
                settings.git.auto_fetch = false;
            })
            .expect("update settings");

        let reloaded = ConfigStore::load(paths).expect("reload store");
        let settings = reloaded.settings().expect("read settings");

        assert_eq!(settings.appearance.theme, ThemePreference::Dark);
        assert!(!settings.git.auto_fetch);
    }

    #[test]
    fn oversized_config_is_rejected_before_json_parsing() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = ConfigPaths::new(
            temp_dir.path().join("settings.json"),
            temp_dir.path().join("projects.json"),
        );
        std::fs::write(
            &paths.settings_path,
            vec![b' '; CONFIG_FILE_LIMIT_BYTES + 1],
        )
        .expect("write oversized config");

        let error = ConfigStore::load(paths).expect_err("oversized config should fail");

        assert!(matches!(
            error,
            ConfigStoreError::Read { source, .. }
                if source.kind() == ErrorKind::InvalidData
        ));
    }

    #[test]
    fn updating_one_project_preserves_other_project_entries() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = ConfigPaths::new(
            temp_dir.path().join("settings.json"),
            temp_dir.path().join("projects.json"),
        );
        let store = ConfigStore::load(paths.clone()).expect("load store");
        let repo_one = temp_dir.path().join("repo").join("one");
        let repo_two = temp_dir.path().join("repo").join("two");
        let repo_one_key = normalize_project_path_key(&repo_one).expect("normalize first repo");
        let repo_two_key = normalize_project_path_key(&repo_two).expect("normalize second repo");

        store
            .update_project(repo_one_key.clone(), |project| {
                project.display_name = Some("One".to_owned());
                project.pinned = true;
            })
            .expect("insert first project");
        store
            .update_project(repo_two_key.clone(), |project| {
                project.display_name = Some("Two".to_owned());
            })
            .expect("insert second project");
        store
            .update_project(repo_one_key.clone(), |project| {
                project.last_branch = Some("main".to_owned());
            })
            .expect("update first project");

        let reloaded = ConfigStore::load(paths).expect("reload store");
        let projects = reloaded.projects().expect("read projects");
        let one = projects.projects.get(&repo_one_key).expect("first project");
        let two = projects
            .projects
            .get(&repo_two_key)
            .expect("second project");

        assert_eq!(projects.projects.len(), 2);
        assert_eq!(one.display_name.as_deref(), Some("One"));
        assert_eq!(one.last_branch.as_deref(), Some("main"));
        assert_eq!(two.display_name.as_deref(), Some("Two"));
        assert_eq!(two.last_branch, None);
    }

    #[test]
    fn deserializes_old_settings_with_new_defaults() {
        let settings: AppSettings = serde_json::from_str(
            r#"{
              "schemaVersion": 1,
              "appearance": { "theme": "dark" },
              "git": { "autoFetch": false, "fetchIntervalSeconds": 120 },
              "logging": { "level": "info", "retainDays": 14 },
              "recentProjectLimit": 10
            }"#,
        )
        .expect("deserialize settings");

        assert_eq!(settings.appearance.theme, ThemePreference::Dark);
        assert!(!settings.git.auto_fetch);
        assert_eq!(settings.git.user, GitUserSettings::default());
        assert!(!settings.privacy.gravatar_enabled);
        assert!(!settings.onboarding.onboarded);
        assert_eq!(settings.window.default_geometry.width, DEFAULT_WINDOW_WIDTH);
    }

    #[test]
    fn project_keys_are_normalized_absolute_paths() {
        let relative_key =
            normalize_project_path_key("fixtures/../repo").expect("normalize relative project");

        assert!(Path::new(&relative_key).is_absolute());
        assert!(relative_key.ends_with("/repo"));
        assert!(!relative_key.contains("/../"));
    }

    #[test]
    fn concurrent_project_updates_do_not_drop_fields() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = ConfigPaths::new(
            temp_dir.path().join("settings.json"),
            temp_dir.path().join("projects.json"),
        );
        let store = Arc::new(ConfigStore::load(paths).expect("load store"));
        let repo = temp_dir.path().join("repo");
        let repo_key = repo.to_string_lossy().into_owned();

        let first_store = Arc::clone(&store);
        let first_repo = repo_key.clone();
        let first = thread::spawn(move || {
            first_store
                .update_project(first_repo, |project| {
                    project.display_name = Some("Project".to_owned());
                    project
                        .auto_tracking_rules
                        .push(AutoTrackingRule::new("feature", "main"));
                })
                .expect("first update");
        });

        let second_store = Arc::clone(&store);
        let second_repo = repo_key.clone();
        let second = thread::spawn(move || {
            second_store
                .update_project(second_repo, |project| {
                    project.last_branch = Some("feature".to_owned());
                    project.sidebar.stashes_collapsed = true;
                })
                .expect("second update");
        });

        first.join().expect("join first thread");
        second.join().expect("join second thread");

        let project = store
            .project(&repo_key)
            .expect("read project")
            .expect("project exists");

        assert_eq!(project.display_name.as_deref(), Some("Project"));
        assert_eq!(project.last_branch.as_deref(), Some("feature"));
        assert_eq!(project.auto_tracking_rules.len(), 1);
        assert!(project.sidebar.stashes_collapsed);
    }

    #[test]
    fn recent_projects_are_derived_from_last_opened_at() {
        let mut document = ProjectsDocument::default();
        document.projects.insert(
            "/repo/old".to_owned(),
            ProjectSettings {
                path: "/repo/old".to_owned(),
                last_opened_at: Some("2026-01-01T00:00:00Z".to_owned()),
                ..ProjectSettings::default()
            },
        );
        document.projects.insert(
            "/repo/new".to_owned(),
            ProjectSettings {
                path: "/repo/new".to_owned(),
                last_opened_at: Some("2026-02-01T00:00:00Z".to_owned()),
                ..ProjectSettings::default()
            },
        );

        let recent = document.recent_projects(1);

        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].path, "/repo/new");
    }

    #[test]
    fn config_actor_broadcasts_changes_to_subscribers() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = ConfigPaths::new(
            temp_dir.path().join("settings.json"),
            temp_dir.path().join("projects.json"),
        );
        let actor = ConfigActor::load(paths).expect("load actor");
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);

        actor
            .subscribe(Arc::new(move |event| {
                captured_events.lock().expect("lock events").push(event);
            }))
            .expect("subscribe");

        actor
            .update_settings(|settings| settings.language = LanguagePreference::EnUs)
            .expect("update settings");
        actor
            .update_project("/repo/one", |project| {
                project.local_changes_view_mode = LocalChangesViewMode::Tree;
            })
            .expect("update project");

        let events = events.lock().expect("lock events");
        assert!(matches!(
            events.first(),
            Some(ConfigChangeEvent::SettingsUpdated { .. })
        ));
        assert!(matches!(
            events.get(1),
            Some(ConfigChangeEvent::ProjectUpdated { project, .. })
                if project.local_changes_view_mode == LocalChangesViewMode::Tree
        ));
    }

    #[test]
    fn debounce_flush_tracks_deadline() {
        let mut debounce = DebouncedFlush::new(DebouncePolicy::new(Duration::from_millis(25)));
        let now = Instant::now();
        let deadline = debounce.record_change(now);

        assert_eq!(deadline, now + Duration::from_millis(25));
        assert!(!debounce.should_flush(now + Duration::from_millis(24)));
        assert!(debounce.should_flush(now + Duration::from_millis(25)));

        debounce.mark_flushed();

        assert_eq!(debounce.deadline(), None);
    }
}
