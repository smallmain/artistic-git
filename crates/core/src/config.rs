use serde::{de::DeserializeOwned, Deserialize, Serialize};
use specta::Type;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tempfile::NamedTempFile;
use thiserror::Error;

pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_RECENT_PROJECT_LIMIT: u16 = 20;
pub const DEFAULT_FETCH_INTERVAL_SECONDS: u64 = 300;
pub const DEFAULT_LOG_RETENTION_DAYS: u16 = 14;
pub const DEFAULT_DEBOUNCE_DELAY: Duration = Duration::from_millis(250);

pub type ConfigStoreResult<T> = Result<T, ConfigStoreError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u32,
    pub appearance: AppearanceSettings,
    pub git: GitSettings,
    pub logging: LoggingSettings,
    pub recent_project_limit: u16,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            appearance: AppearanceSettings::default(),
            git: GitSettings::default(),
            logging: LoggingSettings::default(),
            recent_project_limit: DEFAULT_RECENT_PROJECT_LIMIT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct GitSettings {
    pub auto_fetch: bool,
    pub fetch_interval_seconds: u64,
}

impl Default for GitSettings {
    fn default() -> Self {
        Self {
            auto_fetch: true,
            fetch_interval_seconds: DEFAULT_FETCH_INTERVAL_SECONDS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub path: String,
    pub display_name: Option<String>,
    pub pinned: bool,
    pub last_opened_at: Option<String>,
    pub last_branch: Option<String>,
}

impl ProjectSettings {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            display_name: None,
            pinned: false,
            last_opened_at: None,
            last_branch: None,
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

#[derive(Debug, Clone)]
pub struct ConfigActor {
    store: Arc<ConfigStore>,
}

impl ConfigActor {
    pub fn load(paths: ConfigPaths) -> ConfigStoreResult<Self> {
        Ok(Self {
            store: Arc::new(ConfigStore::load(paths)?),
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

    pub fn update_settings(
        &self,
        update: impl FnOnce(&mut AppSettings),
    ) -> ConfigStoreResult<AppSettings> {
        self.store.update_settings(update)
    }

    pub fn update_project(
        &self,
        project_path: impl Into<String>,
        update: impl FnOnce(&mut ProjectSettings),
    ) -> ConfigStoreResult<ProjectSettings> {
        self.store.update_project(project_path, update)
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
        Ok(self
            .lock_state()?
            .projects
            .projects
            .get(project_path)
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
        let project_path = project_path.into();
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
        let mut state = self.lock_state()?;
        let mut next_projects = state.projects.clone();
        let removed_project = next_projects.projects.remove(project_path);

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

fn read_json_or_default<T>(path: &Path) -> ConfigStoreResult<T>
where
    T: DeserializeOwned + Default,
{
    match File::open(path) {
        Ok(file) => serde_json::from_reader(file).map_err(|source| ConfigStoreError::Parse {
            path: path.to_path_buf(),
            source,
        }),
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
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn settings_and_projects_have_default_values() {
        let settings = AppSettings::default();
        let projects = ProjectsDocument::default();

        assert_eq!(settings.schema_version, CONFIG_SCHEMA_VERSION);
        assert_eq!(settings.appearance.theme, ThemePreference::System);
        assert!(settings.git.auto_fetch);
        assert_eq!(
            settings.git.fetch_interval_seconds,
            DEFAULT_FETCH_INTERVAL_SECONDS
        );
        assert_eq!(settings.logging.level, LogLevelPreference::Info);
        assert_eq!(settings.recent_project_limit, DEFAULT_RECENT_PROJECT_LIMIT);
        assert_eq!(projects.schema_version, CONFIG_SCHEMA_VERSION);
        assert!(projects.projects.is_empty());
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
    fn updating_one_project_preserves_other_project_entries() {
        let temp_dir = tempdir().expect("create temp dir");
        let paths = ConfigPaths::new(
            temp_dir.path().join("settings.json"),
            temp_dir.path().join("projects.json"),
        );
        let store = ConfigStore::load(paths.clone()).expect("load store");

        store
            .update_project("/repo/one", |project| {
                project.display_name = Some("One".to_owned());
                project.pinned = true;
            })
            .expect("insert first project");
        store
            .update_project("/repo/two", |project| {
                project.display_name = Some("Two".to_owned());
            })
            .expect("insert second project");
        store
            .update_project("/repo/one", |project| {
                project.last_branch = Some("main".to_owned());
            })
            .expect("update first project");

        let reloaded = ConfigStore::load(paths).expect("reload store");
        let projects = reloaded.projects().expect("read projects");
        let one = projects.projects.get("/repo/one").expect("first project");
        let two = projects.projects.get("/repo/two").expect("second project");

        assert_eq!(projects.projects.len(), 2);
        assert_eq!(one.display_name.as_deref(), Some("One"));
        assert_eq!(one.last_branch.as_deref(), Some("main"));
        assert_eq!(two.display_name.as_deref(), Some("Two"));
        assert_eq!(two.last_branch, None);
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
