use artistic_git_contracts::{GitDistManifest, ProgressState};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitDistributionError {
    #[error("git distribution manifest is missing at {0}")]
    MissingManifest(PathBuf),
    #[error("failed to read git distribution manifest at {path}: {source}")]
    ReadManifest {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse git distribution manifest at {path}: {source}")]
    ParseManifest {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("git distribution manifest path for {field} must be relative: {path}")]
    AbsoluteManifestPath { field: &'static str, path: PathBuf },
    #[error("git distribution manifest path for {field} escapes the distribution root: {path}")]
    EscapingManifestPath { field: &'static str, path: PathBuf },
    #[error("git distribution executable for {field} is missing at {path}")]
    MissingExecutable { field: &'static str, path: PathBuf },
    #[error("failed to inspect git distribution executable for {field} at {path}: {source}")]
    InspectExecutable {
        field: &'static str,
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("git distribution executable for {field} is not a file at {path}")]
    ExecutableNotFile { field: &'static str, path: PathBuf },
    #[error("git distribution executable for {field} is not executable at {path}")]
    NotExecutable { field: &'static str, path: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDistribution {
    pub root: PathBuf,
    pub manifest: GitDistManifest,
    pub git_executable: PathBuf,
    pub git_lfs_executable: PathBuf,
    pub credential_helper: PathBuf,
    pub ssh_askpass: PathBuf,
    pub windows_ssh_executable: Option<PathBuf>,
}

impl GitDistribution {
    pub fn from_root(root: impl Into<PathBuf>) -> Result<Self, GitDistributionError> {
        let root = root.into();
        Self::from_manifest_path(root.clone(), root.join("manifest.json"))
    }

    pub fn from_manifest_path(
        root: impl Into<PathBuf>,
        manifest_path: impl Into<PathBuf>,
    ) -> Result<Self, GitDistributionError> {
        let manifest_path = manifest_path.into();

        if !manifest_path.exists() {
            return Err(GitDistributionError::MissingManifest(manifest_path));
        }

        let manifest_json = fs::read_to_string(&manifest_path).map_err(|source| {
            GitDistributionError::ReadManifest {
                path: manifest_path.clone(),
                source,
            }
        })?;
        let manifest = serde_json::from_str(&manifest_json).map_err(|source| {
            GitDistributionError::ParseManifest {
                path: manifest_path,
                source,
            }
        })?;

        Self::from_manifest(root, manifest)
    }

    pub fn from_manifest(
        root: impl Into<PathBuf>,
        manifest: GitDistManifest,
    ) -> Result<Self, GitDistributionError> {
        let root = root.into();
        let git_executable =
            resolve_manifest_executable(&root, "gitExecutable", &manifest.paths.git_executable)?;
        let git_lfs_executable = resolve_manifest_executable(
            &root,
            "gitLfsExecutable",
            &manifest.paths.git_lfs_executable,
        )?;
        let credential_helper = resolve_manifest_executable(
            &root,
            "credentialHelper",
            &manifest.paths.credential_helper,
        )?;
        let ssh_askpass =
            resolve_manifest_executable(&root, "sshAskpass", &manifest.paths.ssh_askpass)?;
        let windows_ssh_executable = manifest
            .paths
            .windows_ssh_executable
            .as_deref()
            .map(|path| resolve_manifest_executable(&root, "windowsSshExecutable", path))
            .transpose()?;

        Ok(Self {
            root,
            manifest,
            git_executable,
            git_lfs_executable,
            credential_helper,
            ssh_askpass,
            windows_ssh_executable,
        })
    }
}

#[derive(Debug, Clone)]
pub struct GitRunner {
    distribution: Arc<GitDistribution>,
    environment: CommandEnvironmentPlan,
}

impl GitRunner {
    pub fn from_dist_root(
        root: impl Into<PathBuf>,
        controlled_home: impl Into<PathBuf>,
    ) -> Result<Self, GitDistributionError> {
        let distribution = GitDistribution::from_root(root)?;
        Ok(Self::from_distribution(distribution, controlled_home))
    }

    pub fn from_dist_manifest(
        root: impl Into<PathBuf>,
        manifest: GitDistManifest,
        controlled_home: impl Into<PathBuf>,
    ) -> Result<Self, GitDistributionError> {
        let distribution = GitDistribution::from_manifest(root, manifest)?;
        Ok(Self::from_distribution(distribution, controlled_home))
    }

    pub fn from_distribution(
        distribution: GitDistribution,
        controlled_home: impl Into<PathBuf>,
    ) -> Self {
        let environment = CommandEnvironmentPlan::isolated(controlled_home.into(), &distribution);

        Self {
            distribution: Arc::new(distribution),
            environment,
        }
    }

    pub fn distribution(&self) -> &GitDistribution {
        &self.distribution
    }

    pub fn environment_plan(&self) -> &CommandEnvironmentPlan {
        &self.environment
    }

    pub fn git_command_plan<I, S>(&self, args: I) -> GitCommandPlan
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        GitCommandPlan {
            executable: self.distribution.git_executable.clone(),
            args: args.into_iter().map(Into::into).collect(),
            environment: self.environment.clone(),
        }
    }

    pub fn git_lfs_command_plan<I, S>(&self, args: I) -> GitCommandPlan
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        GitCommandPlan {
            executable: self.distribution.git_lfs_executable.clone(),
            args: args.into_iter().map(Into::into).collect(),
            environment: self.environment.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommandPlan {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub environment: CommandEnvironmentPlan,
}

impl GitCommandPlan {
    pub fn to_command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(&self.args);
        self.environment.apply_to(&mut command);
        command
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandEnvironmentPlan {
    clear_parent_environment: bool,
    variables: BTreeMap<String, OsString>,
}

impl CommandEnvironmentPlan {
    pub fn isolated(controlled_home: PathBuf, distribution: &GitDistribution) -> Self {
        let mut variables = BTreeMap::new();
        variables.insert("GIT_CONFIG_NOSYSTEM".to_owned(), OsString::from("1"));
        variables.insert("GIT_TERMINAL_PROMPT".to_owned(), OsString::from("0"));
        variables.insert("HOME".to_owned(), controlled_home.clone().into_os_string());
        variables.insert(
            "XDG_CONFIG_HOME".to_owned(),
            controlled_home.join(".config").into_os_string(),
        );
        variables.insert(
            "GIT_ASKPASS".to_owned(),
            distribution.ssh_askpass.clone().into_os_string(),
        );
        variables.insert(
            "SSH_ASKPASS".to_owned(),
            distribution.ssh_askpass.clone().into_os_string(),
        );

        #[cfg(windows)]
        {
            variables.insert(
                "USERPROFILE".to_owned(),
                controlled_home.clone().into_os_string(),
            );
            if let Some(system_root) = std::env::var_os("SystemRoot") {
                variables.insert("SystemRoot".to_owned(), system_root);
            }
            if let Some(windir) = std::env::var_os("WINDIR") {
                variables.insert("WINDIR".to_owned(), windir);
            }
        }

        Self {
            clear_parent_environment: true,
            variables,
        }
    }

    pub fn clear_parent_environment(&self) -> bool {
        self.clear_parent_environment
    }

    pub fn variables(&self) -> &BTreeMap<String, OsString> {
        &self.variables
    }

    pub fn variable(&self, key: &str) -> Option<&OsStr> {
        self.variables.get(key).map(OsString::as_os_str)
    }

    pub fn removes_variable(&self, key: &str) -> bool {
        self.clear_parent_environment && !self.variables.contains_key(key)
    }

    pub fn apply_to(&self, command: &mut Command) {
        if self.clear_parent_environment {
            command.env_clear();
        }

        for (key, value) in &self.variables {
            command.env(key, value);
        }
    }
}

#[derive(Debug, Default)]
pub struct OperationConcurrency {
    write_busy: AtomicBool,
    background_busy: AtomicBool,
}

impl OperationConcurrency {
    pub fn try_begin_write(&self) -> Result<WritePermit<'_>, OperationBusy> {
        self.write_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| WritePermit { owner: self })
            .map_err(|_| OperationBusy::WriteBusy)
    }

    pub fn begin_read(&self) -> ReadPermit<'_> {
        ReadPermit { _owner: self }
    }

    pub fn try_begin_background(&self) -> Result<BackgroundPermit<'_>, OperationBusy> {
        if self.write_busy.load(Ordering::Acquire) {
            return Err(OperationBusy::WriteBusy);
        }

        self.background_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| BackgroundPermit { owner: self })
            .map_err(|_| OperationBusy::BackgroundBusy)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationBusy {
    WriteBusy,
    BackgroundBusy,
}

#[derive(Debug)]
pub struct WritePermit<'a> {
    owner: &'a OperationConcurrency,
}

impl Drop for WritePermit<'_> {
    fn drop(&mut self) {
        self.owner.write_busy.store(false, Ordering::Release);
    }
}

#[derive(Debug)]
pub struct ReadPermit<'a> {
    _owner: &'a OperationConcurrency,
}

#[derive(Debug)]
pub struct BackgroundPermit<'a> {
    owner: &'a OperationConcurrency,
}

impl Drop for BackgroundPermit<'_> {
    fn drop(&mut self) {
        self.owner.background_busy.store(false, Ordering::Release);
    }
}

pub fn parse_git_progress(stderr: &str) -> ProgressState {
    stderr
        .lines()
        .filter_map(parse_percent)
        .next_back()
        .map(|value| ProgressState::Percent { value })
        .unwrap_or(ProgressState::Indeterminate)
}

pub fn parse_git_progress_line(line: &str) -> ProgressState {
    parse_percent(line)
        .map(|value| ProgressState::Percent { value })
        .unwrap_or(ProgressState::Indeterminate)
}

fn resolve_manifest_executable(
    root: &Path,
    field: &'static str,
    relative_path: &str,
) -> Result<PathBuf, GitDistributionError> {
    let relative_path = Path::new(relative_path);
    validate_manifest_relative_path(field, relative_path)?;

    let path = root.join(relative_path);
    validate_executable(field, &path)?;

    Ok(path)
}

fn validate_manifest_relative_path(
    field: &'static str,
    path: &Path,
) -> Result<(), GitDistributionError> {
    if path.is_absolute() {
        return Err(GitDistributionError::AbsoluteManifestPath {
            field,
            path: path.to_path_buf(),
        });
    }

    if path.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    }) {
        return Err(GitDistributionError::EscapingManifestPath {
            field,
            path: path.to_path_buf(),
        });
    }

    Ok(())
}

fn validate_executable(field: &'static str, path: &Path) -> Result<(), GitDistributionError> {
    let metadata = fs::metadata(path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            GitDistributionError::MissingExecutable {
                field,
                path: path.to_path_buf(),
            }
        } else {
            GitDistributionError::InspectExecutable {
                field,
                path: path.to_path_buf(),
                source,
            }
        }
    })?;

    if !metadata.is_file() {
        return Err(GitDistributionError::ExecutableNotFile {
            field,
            path: path.to_path_buf(),
        });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(GitDistributionError::NotExecutable {
                field,
                path: path.to_path_buf(),
            });
        }
    }

    Ok(())
}

fn parse_percent(input: &str) -> Option<f32> {
    input.match_indices('%').find_map(|(percent_index, _)| {
        let prefix = &input[..percent_index];
        let bytes = prefix.as_bytes();
        let mut end = bytes.len();

        while end > 0 && bytes[end - 1].is_ascii_whitespace() {
            end -= 1;
        }

        let mut start = end;
        let mut seen_digit = false;
        let mut seen_dot = false;

        while start > 0 {
            let byte = bytes[start - 1];

            if byte.is_ascii_digit() {
                seen_digit = true;
                start -= 1;
            } else if byte == b'.' && !seen_dot {
                seen_dot = true;
                start -= 1;
            } else {
                break;
            }
        }

        if !seen_digit {
            return None;
        }

        prefix[start..end]
            .parse::<f32>()
            .ok()
            .map(|value| value.clamp(0.0, 100.0))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_test_support::{
        git_dist_manifest_fixture, write_executable_file, write_git_dist_manifest, TestTempDir,
    };

    #[test]
    fn resolves_distribution_paths_from_manifest() {
        let temp = fake_distribution().expect("create fake distribution");

        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");

        assert_eq!(
            distribution.git_executable,
            temp.path()
                .join(distribution.manifest.paths.git_executable.as_str())
        );
        assert_eq!(
            distribution.git_lfs_executable,
            temp.path()
                .join(distribution.manifest.paths.git_lfs_executable.as_str())
        );
        assert_eq!(
            distribution.credential_helper,
            temp.path()
                .join(distribution.manifest.paths.credential_helper.as_str())
        );
        assert_eq!(
            distribution.ssh_askpass,
            temp.path()
                .join(distribution.manifest.paths.ssh_askpass.as_str())
        );
    }

    #[test]
    fn missing_manifest_is_explicit_error_without_path_fallback() {
        let temp = TestTempDir::new("ag-missing-manifest").expect("temp dir");

        let error =
            GitDistribution::from_root(temp.path()).expect_err("missing manifest should fail");

        assert!(matches!(error, GitDistributionError::MissingManifest(_)));
    }

    #[test]
    fn missing_executable_is_explicit_error() {
        let temp = TestTempDir::new("ag-missing-executable").expect("temp dir");
        let manifest = git_dist_manifest_fixture();
        write_git_dist_manifest(temp.path(), &manifest).expect("write manifest");

        let error =
            GitDistribution::from_root(temp.path()).expect_err("missing executable should fail");

        assert!(matches!(
            error,
            GitDistributionError::MissingExecutable {
                field: "gitExecutable",
                ..
            }
        ));
    }

    #[test]
    fn command_environment_plan_is_isolated() {
        let temp = fake_distribution().expect("create fake distribution");
        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");
        let home = temp.path().join("controlled-home");
        let runner = GitRunner::from_distribution(distribution, &home);
        let environment = runner.environment_plan();

        assert!(environment.clear_parent_environment());
        assert_eq!(environment.variable("HOME"), Some(home.as_os_str()));
        assert_eq!(
            environment.variable("GIT_CONFIG_NOSYSTEM"),
            Some(OsStr::new("1"))
        );
        assert!(environment.removes_variable("PATH"));
        assert!(environment.removes_variable("GIT_EXEC_PATH"));
        assert!(environment.variable("GIT_ASKPASS").is_some());
        assert!(environment.variable("SSH_ASKPASS").is_some());

        let command_plan = runner.git_command_plan(["status"]);
        assert_eq!(
            command_plan.executable,
            runner.distribution().git_executable
        );
        assert_eq!(command_plan.args, vec![OsString::from("status")]);
        assert!(command_plan.environment.removes_variable("PATH"));
    }

    #[test]
    fn write_lock_rejects_busy_without_blocking_reads() {
        let concurrency = OperationConcurrency::default();
        let write = concurrency.try_begin_write().expect("first write starts");

        assert_eq!(
            concurrency.try_begin_write().expect_err("busy write fails"),
            OperationBusy::WriteBusy
        );
        let _read = concurrency.begin_read();
        assert_eq!(
            concurrency
                .try_begin_background()
                .expect_err("background skips during write"),
            OperationBusy::WriteBusy
        );

        drop(write);
        let _next_write = concurrency.try_begin_write().expect("write lock released");
    }

    #[test]
    fn background_single_flight_rejects_duplicate_background_work() {
        let concurrency = OperationConcurrency::default();
        let background = concurrency
            .try_begin_background()
            .expect("first background starts");

        assert_eq!(
            concurrency
                .try_begin_background()
                .expect_err("duplicate background fails"),
            OperationBusy::BackgroundBusy
        );

        drop(background);
        let _next_background = concurrency
            .try_begin_background()
            .expect("background lock released");
    }

    #[test]
    fn progress_parser_returns_percent_or_indeterminate() {
        assert_eq!(
            parse_git_progress_line("Receiving objects:  42% (42/100), 12.00 MiB | 1.00 MiB/s"),
            ProgressState::Percent { value: 42.0 }
        );
        assert_eq!(
            parse_git_progress("Counting objects:  12% (1/8)\nResolving deltas: 100% (8/8)"),
            ProgressState::Percent { value: 100.0 }
        );
        assert_eq!(
            parse_git_progress_line("Enumerating objects: 8, done."),
            ProgressState::Indeterminate
        );
    }

    fn fake_distribution() -> Result<TestTempDir, Box<dyn std::error::Error>> {
        let temp = TestTempDir::new("ag-git-dist")?;
        let manifest = git_dist_manifest_fixture();

        write_executable_file(&temp.path().join(&manifest.paths.git_executable))?;
        write_executable_file(&temp.path().join(&manifest.paths.git_lfs_executable))?;
        write_executable_file(&temp.path().join(&manifest.paths.credential_helper))?;
        write_executable_file(&temp.path().join(&manifest.paths.ssh_askpass))?;
        if let Some(windows_ssh_executable) = &manifest.paths.windows_ssh_executable {
            write_executable_file(&temp.path().join(windows_ssh_executable))?;
        }
        write_git_dist_manifest(temp.path(), &manifest)?;

        Ok(temp)
    }
}
