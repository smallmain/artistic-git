use artistic_git_contracts::{
    AppError, AppEvent, GitCommandError, GitDistManifest, OperationContext, ProgressState,
    GIT_DIST_MANIFEST_SCHEMA_VERSION,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitDistributionError {
    #[error("unsupported git distribution manifest schema {actual}; expected {expected}")]
    UnsupportedSchemaVersion { actual: u32, expected: u32 },
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
        if manifest.schema_version != GIT_DIST_MANIFEST_SCHEMA_VERSION {
            return Err(GitDistributionError::UnsupportedSchemaVersion {
                actual: manifest.schema_version,
                expected: GIT_DIST_MANIFEST_SCHEMA_VERSION,
            });
        }

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

    fn git_exec_path(&self) -> Option<PathBuf> {
        first_existing_dist_dir(
            &self.root,
            &[
                "git/libexec/git-core",
                "git/mingw64/libexec/git-core",
                "git/usr/libexec/git-core",
            ],
        )
    }

    fn git_template_dir(&self) -> Option<PathBuf> {
        first_existing_dist_dir(
            &self.root,
            &[
                "git/share/git-core/templates",
                "git/mingw64/share/git-core/templates",
            ],
        )
    }

    fn git_perl_dirs(&self) -> Vec<PathBuf> {
        existing_dist_dirs(&self.root, &["git/share/perl5", "git/mingw64/share/perl5"])
    }

    fn command_path_entries(&self) -> Vec<PathBuf> {
        let mut entries = Vec::new();
        push_parent_dir(&mut entries, &self.git_executable);
        if let Some(exec_path) = self.git_exec_path() {
            push_unique_path(&mut entries, exec_path);
        }
        push_parent_dir(&mut entries, &self.git_lfs_executable);
        for directory in
            existing_dist_dirs(&self.root, &["git/cmd", "git/mingw64/bin", "git/usr/bin"])
        {
            push_unique_path(&mut entries, directory);
        }
        push_platform_tool_path_entries(&mut entries);
        entries
    }
}

fn first_existing_dist_dir(root: &Path, relative_paths: &[&str]) -> Option<PathBuf> {
    existing_dist_dirs(root, relative_paths).into_iter().next()
}

fn existing_dist_dirs(root: &Path, relative_paths: &[&str]) -> Vec<PathBuf> {
    relative_paths
        .iter()
        .map(|relative_path| join_valid_relative_path(root, Path::new(relative_path)))
        .filter(|path| path.is_dir())
        .collect()
}

fn join_valid_relative_path(root: &Path, relative_path: &Path) -> PathBuf {
    let mut path = root.to_path_buf();
    for component in relative_path.components() {
        match component {
            Component::Normal(segment) => path.push(segment),
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                path.push(component.as_os_str());
            }
        }
    }
    path
}

fn push_parent_dir(entries: &mut Vec<PathBuf>, path: &Path) {
    if let Some(parent) = path.parent() {
        push_unique_path(entries, parent.to_path_buf());
    }
}

fn push_unique_path(entries: &mut Vec<PathBuf>, path: PathBuf) {
    if !entries.iter().any(|entry| entry == &path) {
        entries.push(path);
    }
}

fn push_platform_tool_path_entries(entries: &mut Vec<PathBuf>) {
    #[cfg(unix)]
    {
        for directory in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            let path = PathBuf::from(directory);
            if path.is_dir() {
                push_unique_path(entries, path);
            }
        }
    }

    #[cfg(windows)]
    {
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            push_unique_path(entries, PathBuf::from(system_root).join("System32"));
        }
    }
}

#[derive(Debug, Clone)]
pub struct GitRunner {
    distribution: Arc<GitDistribution>,
    environment: CommandEnvironmentPlan,
    concurrency: Arc<OperationConcurrency>,
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
            concurrency: Arc::new(OperationConcurrency::default()),
        }
    }

    pub fn distribution(&self) -> &GitDistribution {
        &self.distribution
    }

    pub fn environment_plan(&self) -> &CommandEnvironmentPlan {
        &self.environment
    }

    pub fn operation_concurrency(&self) -> &OperationConcurrency {
        &self.concurrency
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

    pub fn git_command_builder(&self) -> GitCommandBuilder<'_> {
        GitCommandBuilder::new(self)
    }

    pub fn runtime_self_check_plan(&self) -> RuntimeSelfCheckPlan {
        RuntimeSelfCheckPlan {
            expected_git_version: self.distribution.manifest.git_version.clone(),
            expected_git_lfs_version: self.distribution.manifest.git_lfs_version.clone(),
            commands: vec![
                SelfCheckCommandPlan {
                    kind: SelfCheckCommandKind::GitVersion,
                    command: self.git_command_plan(["--version"]),
                },
                SelfCheckCommandPlan {
                    kind: SelfCheckCommandKind::GitLfsVersion,
                    command: self.git_lfs_command_plan(["version"]),
                },
            ],
        }
    }

    pub fn run_runtime_self_check(&self) -> Result<RuntimeSelfCheckResult, AppError> {
        self.runtime_self_check_plan().execute()
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

    pub fn command_for_error(&self) -> Vec<String> {
        std::iter::once(display_os_str(self.executable.as_os_str()))
            .chain(self.args.iter().map(|arg| display_os_str(arg.as_os_str())))
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct GitCommandBuilder<'a> {
    runner: &'a GitRunner,
    args: Vec<OsString>,
    config: Vec<GitConfigInjection>,
    progress: bool,
}

impl<'a> GitCommandBuilder<'a> {
    pub fn new(runner: &'a GitRunner) -> Self {
        Self {
            runner,
            args: Vec::new(),
            config: Vec::new(),
            progress: false,
        }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn config(mut self, key: impl Into<String>, value: impl Into<OsString>) -> Self {
        self.config.push(GitConfigInjection {
            key: key.into(),
            value: value.into(),
        });
        self
    }

    pub fn credential_helper(self, helper: impl Into<OsString>) -> Self {
        self.config("credential.helper", helper)
    }

    pub fn enable_credential_path_matching(self) -> Self {
        self.config("credential.useHttpPath", "true")
    }

    pub fn default_credential_helper(self) -> Self {
        let helper = self
            .runner
            .distribution
            .credential_helper
            .clone()
            .into_os_string();
        self.credential_helper(helper)
            .enable_credential_path_matching()
    }

    pub fn ssh_command(self, command: impl Into<OsString>) -> Self {
        self.config("core.sshCommand", command)
    }

    pub fn enable_rename_detection(self) -> Self {
        self.config("diff.renames", "true")
            .config("status.renames", "true")
    }

    pub fn enable_windows_longpaths(self) -> Self {
        self.enable_windows_longpaths_for_platform(GitCommandPlatform::current())
    }

    pub fn enable_windows_longpaths_for_platform(self, platform: GitCommandPlatform) -> Self {
        if platform.enables_longpaths() {
            self.config("core.longpaths", "true")
        } else {
            self
        }
    }

    pub fn with_progress(mut self) -> Self {
        self.progress = true;
        self
    }

    pub fn build(self) -> GitCommandPlan {
        let mut args = Vec::with_capacity(self.config.len() * 2 + self.args.len() + 1);

        for config in self.config {
            args.push(OsString::from("-c"));
            args.push(config.as_git_arg());
        }

        args.extend(self.args);

        if self.progress
            && !args
                .iter()
                .any(|arg| arg.as_os_str() == OsStr::new("--progress"))
        {
            args.push(OsString::from("--progress"));
        }

        self.runner.git_command_plan(args)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitConfigInjection {
    pub key: String,
    pub value: OsString,
}

impl GitConfigInjection {
    fn as_git_arg(&self) -> OsString {
        let mut arg = OsString::from(&self.key);
        arg.push("=");
        arg.push(&self.value);
        arg
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitCommandPlatform {
    Current,
    Windows,
    Other,
}

impl GitCommandPlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }

    fn enables_longpaths(self) -> bool {
        match self {
            Self::Current => Self::current().enables_longpaths(),
            Self::Windows => true,
            Self::Other => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSelfCheckPlan {
    pub expected_git_version: String,
    pub expected_git_lfs_version: String,
    pub commands: Vec<SelfCheckCommandPlan>,
}

impl RuntimeSelfCheckPlan {
    pub fn execute(&self) -> Result<RuntimeSelfCheckResult, AppError> {
        let mut commands = Vec::with_capacity(self.commands.len());

        for command in &self.commands {
            let output = command
                .command
                .to_command()
                .output()
                .map_err(|source| self_check_spawn_error(command, source))?;
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let exit_code = output.status.code();

            if !output.status.success() {
                return Err(self_check_command_error(
                    command,
                    format!(
                        "embedded {} self-check command exited unsuccessfully",
                        command.kind.display_name()
                    ),
                    exit_code,
                    stdout,
                    stderr,
                ));
            }

            let expected = match command.kind {
                SelfCheckCommandKind::GitVersion => &self.expected_git_version,
                SelfCheckCommandKind::GitLfsVersion => &self.expected_git_lfs_version,
            };
            let observed = stdout.trim().to_owned();
            let version_matches = self_check_version_matches(command.kind, expected, &observed);

            if !version_matches {
                return Err(self_check_command_error(
                    command,
                    format!(
                        "embedded {} version mismatch: expected `{}`, got `{}`",
                        command.kind.display_name(),
                        expected,
                        observed
                    ),
                    exit_code,
                    stdout,
                    stderr,
                ));
            }

            commands.push(SelfCheckCommandResult {
                kind: command.kind,
                expected_version: expected.clone(),
                observed_version: observed,
                exit_code,
                stdout,
                stderr,
                version_matches,
            });
        }

        Ok(RuntimeSelfCheckResult { commands })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfCheckCommandPlan {
    pub kind: SelfCheckCommandKind,
    pub command: GitCommandPlan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfCheckCommandKind {
    GitVersion,
    GitLfsVersion,
}

impl SelfCheckCommandKind {
    fn display_name(self) -> &'static str {
        match self {
            Self::GitVersion => "git",
            Self::GitLfsVersion => "git-lfs",
        }
    }
}

fn self_check_version_matches(kind: SelfCheckCommandKind, expected: &str, observed: &str) -> bool {
    let expected = normalize_self_check_version(kind, expected);
    let observed = normalize_self_check_version(kind, observed);

    !expected.is_empty() && expected == observed
}

fn normalize_self_check_version(kind: SelfCheckCommandKind, version: &str) -> String {
    let trimmed = version.trim();
    let stripped = match kind {
        SelfCheckCommandKind::GitVersion => trimmed.strip_prefix("git version ").unwrap_or(trimmed),
        SelfCheckCommandKind::GitLfsVersion => trimmed
            .strip_prefix("git-lfs/")
            .or_else(|| trimmed.strip_prefix("git-lfs version "))
            .unwrap_or(trimmed),
    };

    stripped
        .split_whitespace()
        .next()
        .unwrap_or(stripped)
        .to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSelfCheckResult {
    pub commands: Vec<SelfCheckCommandResult>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfCheckCommandResult {
    pub kind: SelfCheckCommandKind,
    pub expected_version: String,
    pub observed_version: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub version_matches: bool,
}

fn self_check_spawn_error(command: &SelfCheckCommandPlan, source: io::Error) -> AppError {
    self_check_command_error(
        command,
        format!(
            "embedded {} self-check command is not executable: {}",
            command.kind.display_name(),
            source
        ),
        None,
        String::new(),
        source.to_string(),
    )
}

fn self_check_command_error(
    command: &SelfCheckCommandPlan,
    summary: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
) -> AppError {
    AppError::fatal(summary, "runtimeSelfCheck").with_git(GitCommandError {
        command: command.command.command_for_error(),
        exit_code,
        stdout,
        stderr,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandEnvironmentPlan {
    clear_parent_environment: bool,
    variables: BTreeMap<String, OsString>,
}

impl CommandEnvironmentPlan {
    pub fn isolated(controlled_home: PathBuf, distribution: &GitDistribution) -> Self {
        let _ = fs::create_dir_all(&controlled_home);
        let _ = fs::create_dir_all(controlled_home.join(".config"));

        let mut variables = BTreeMap::new();
        variables.insert("GIT_CONFIG_NOSYSTEM".to_owned(), OsString::from("1"));
        variables.insert("GIT_CONFIG_COUNT".to_owned(), OsString::from("1"));
        variables.insert(
            "GIT_CONFIG_KEY_0".to_owned(),
            OsString::from("init.defaultBranch"),
        );
        variables.insert("GIT_CONFIG_VALUE_0".to_owned(), OsString::from("main"));
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
        variables.insert("SSH_ASKPASS_REQUIRE".to_owned(), OsString::from("force"));

        if let Some(exec_path) = distribution.git_exec_path() {
            variables.insert("GIT_EXEC_PATH".to_owned(), exec_path.into_os_string());
        }
        if let Some(template_dir) = distribution.git_template_dir() {
            variables.insert("GIT_TEMPLATE_DIR".to_owned(), template_dir.into_os_string());
        }
        let perl_dirs = distribution.git_perl_dirs();
        if !perl_dirs.is_empty() {
            if let Ok(perl_path) = std::env::join_paths(perl_dirs) {
                variables.insert("GITPERLLIB".to_owned(), perl_path);
            }
        }
        let path_entries = distribution.command_path_entries();
        if !path_entries.is_empty() {
            if let Ok(path) = std::env::join_paths(path_entries) {
                variables.insert("PATH".to_owned(), path);
            }
        }

        #[cfg(target_os = "linux")]
        if let Some(path) = appimage_library_path(&distribution.root) {
            variables.insert("LD_LIBRARY_PATH".to_owned(), path.into_os_string());
        }

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

    pub fn with_overrides(mut self, variables: BTreeMap<String, OsString>) -> Self {
        self.variables.extend(variables);
        self
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

#[cfg(target_os = "linux")]
fn appimage_library_path(distribution_root: &Path) -> Option<PathBuf> {
    let appdir = std::env::var_os("APPDIR")?;
    appimage_library_path_for(distribution_root, Path::new(&appdir))
}

#[cfg(any(target_os = "linux", test))]
fn appimage_library_path_for(distribution_root: &Path, appdir: &Path) -> Option<PathBuf> {
    let appdir = fs::canonicalize(appdir).ok()?;
    let distribution_root = fs::canonicalize(distribution_root).ok()?;
    if !distribution_root.starts_with(&appdir) {
        return None;
    }

    let library_path = appdir.join("usr/lib");
    library_path.is_dir().then_some(library_path)
}

#[derive(Debug, Default)]
pub struct OperationConcurrency {
    write_busy: AtomicBool,
    background_busy: AtomicBool,
}

impl OperationConcurrency {
    pub fn busy_state(&self) -> Option<OperationBusy> {
        if self.write_busy.load(Ordering::Acquire) {
            Some(OperationBusy::WriteBusy)
        } else if self.background_busy.load(Ordering::Acquire) {
            Some(OperationBusy::BackgroundBusy)
        } else {
            None
        }
    }

    pub fn try_begin_write(&self) -> Result<WritePermit<'_>, OperationBusy> {
        self.write_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| WritePermit { owner: self })
            .map_err(|_| OperationBusy::WriteBusy)
    }

    pub fn try_begin_write_with_identity<'a>(
        &'a self,
        request: &WriteOperationRequest,
        identity_hook: &dyn IdentityValidationHook,
    ) -> Result<WritePermit<'a>, BeginWriteError> {
        let permit = self.try_begin_write().map_err(BeginWriteError::Busy)?;
        identity_hook
            .validate_write_entry(request)
            .map_err(BeginWriteError::Identity)?;

        Ok(permit)
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

    pub fn try_begin_exclusive(&self) -> Result<ExclusivePermit<'_>, OperationBusy> {
        self.write_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| OperationBusy::WriteBusy)?;

        if self.background_busy.load(Ordering::Acquire) {
            self.write_busy.store(false, Ordering::Release);
            return Err(OperationBusy::BackgroundBusy);
        }

        Ok(ExclusivePermit { owner: self })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationBusy {
    WriteBusy,
    BackgroundBusy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginWriteError {
    Busy(OperationBusy),
    Identity(AppError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteOperationRequest {
    pub operation_name: String,
    pub repository_path: Option<PathBuf>,
    pub requires_identity: bool,
}

impl WriteOperationRequest {
    pub fn new(operation_name: impl Into<String>) -> Self {
        Self {
            operation_name: operation_name.into(),
            repository_path: None,
            requires_identity: false,
        }
    }

    pub fn with_repository_path(mut self, repository_path: impl Into<PathBuf>) -> Self {
        self.repository_path = Some(repository_path.into());
        self
    }

    pub fn requiring_identity(mut self) -> Self {
        self.requires_identity = true;
        self
    }
}

pub trait IdentityValidationHook {
    fn validate_write_entry(&self, request: &WriteOperationRequest) -> Result<(), AppError>;
}

#[derive(Debug, Default)]
pub struct AllowIdentityValidation;

impl IdentityValidationHook for AllowIdentityValidation {
    fn validate_write_entry(&self, _request: &WriteOperationRequest) -> Result<(), AppError> {
        Ok(())
    }
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

#[derive(Debug)]
pub struct ExclusivePermit<'a> {
    owner: &'a OperationConcurrency,
}

impl Drop for ExclusivePermit<'_> {
    fn drop(&mut self) {
        self.owner.write_busy.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    cancelled: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

pub trait ChildProcessHandle {
    fn id(&self) -> u32;
    fn kill(&mut self) -> io::Result<()>;
    fn wait(&mut self) -> io::Result<()>;
}

impl ChildProcessHandle for Child {
    fn id(&self) -> u32 {
        Child::id(self)
    }

    fn kill(&mut self) -> io::Result<()> {
        Child::kill(self)
    }

    fn wait(&mut self) -> io::Result<()> {
        Child::wait(self).map(|_| ())
    }
}

pub trait RecoveryHook {
    fn recover_after_cancel(&mut self, context: &CancellationContext) -> Result<(), AppError>;
}

#[derive(Debug, Default)]
pub struct NoopRecoveryHook;

impl RecoveryHook for NoopRecoveryHook {
    fn recover_after_cancel(&mut self, _context: &CancellationContext) -> Result<(), AppError> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancellationContext {
    pub operation_name: String,
    pub repository_path: Option<PathBuf>,
}

impl CancellationContext {
    pub fn new(operation_name: impl Into<String>) -> Self {
        Self {
            operation_name: operation_name.into(),
            repository_path: None,
        }
    }

    pub fn with_repository_path(mut self, repository_path: impl Into<PathBuf>) -> Self {
        self.repository_path = Some(repository_path.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancellationOutcome {
    NotCancelled,
    CancelledAndRecovered,
}

pub fn cancel_child_if_requested(
    child: &mut dyn ChildProcessHandle,
    token: &CancelToken,
    recovery: &mut dyn RecoveryHook,
    context: &CancellationContext,
) -> Result<CancellationOutcome, AppError> {
    if !token.is_cancelled() {
        return Ok(CancellationOutcome::NotCancelled);
    }

    child.kill().map_err(|source| {
        AppError::unexpected(
            format!("failed to kill cancelled git child process: {source}"),
            &context.operation_name,
        )
        .with_context(cancellation_operation_context(context))
    })?;

    recovery.recover_after_cancel(context)?;

    Ok(CancellationOutcome::CancelledAndRecovered)
}

pub trait WindowEventSink {
    fn emit_to(
        &self,
        window_label: &str,
        event_name: &str,
        payload: &AppEvent,
    ) -> Result<(), EventRouteError>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct RoutedAppEvent {
    pub window_label: String,
    pub event_name: &'static str,
    pub payload: AppEvent,
}

impl RoutedAppEvent {
    pub fn new(window_label: impl Into<String>, payload: AppEvent) -> Self {
        Self {
            window_label: window_label.into(),
            event_name: payload.event_name(),
            payload,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("failed to route {event_name} to window {window_label}: {message}")]
pub struct EventRouteError {
    pub window_label: String,
    pub event_name: String,
    pub message: String,
}

impl EventRouteError {
    pub fn new(
        window_label: impl Into<String>,
        event_name: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            window_label: window_label.into(),
            event_name: event_name.into(),
            message: message.into(),
        }
    }
}

pub struct WindowEventRouter<S> {
    sink: S,
}

impl<S> WindowEventRouter<S>
where
    S: WindowEventSink,
{
    pub fn new(sink: S) -> Self {
        Self { sink }
    }

    pub fn route(&self, event: RoutedAppEvent) -> Result<(), EventRouteError> {
        self.sink
            .emit_to(&event.window_label, event.event_name, &event.payload)
    }

    pub fn sink(&self) -> &S {
        &self.sink
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

    let path = join_valid_relative_path(root, relative_path);
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

fn cancellation_operation_context(context: &CancellationContext) -> OperationContext {
    let mut operation_context = OperationContext::new(&context.operation_name);

    if let Some(repository_path) = &context.repository_path {
        operation_context =
            operation_context.with_repository_path(repository_path.to_string_lossy().into_owned());
    }

    operation_context
}

fn display_os_str(value: &OsStr) -> String {
    value.to_string_lossy().into_owned()
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
    #[cfg(unix)]
    use artistic_git_test_support::write_executable_script;
    use artistic_git_test_support::{
        git_dist_manifest_fixture, write_executable_file, write_git_dist_manifest, TestTempDir,
    };
    use std::{cell::RefCell, rc::Rc};

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
    fn rejects_unsupported_manifest_schema() {
        let temp = TestTempDir::new("ag-unsupported-manifest").expect("temp dir");
        let mut manifest = git_dist_manifest_fixture();
        manifest.schema_version = GIT_DIST_MANIFEST_SCHEMA_VERSION - 1;

        let error = GitDistribution::from_manifest(temp.path(), manifest)
            .expect_err("unsupported schema should fail");

        assert!(matches!(
            error,
            GitDistributionError::UnsupportedSchemaVersion {
                actual: 1,
                expected: GIT_DIST_MANIFEST_SCHEMA_VERSION,
            }
        ));
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
        assert_eq!(
            environment.variable("GIT_CONFIG_COUNT"),
            Some(OsStr::new("1"))
        );
        assert_eq!(
            environment.variable("GIT_CONFIG_KEY_0"),
            Some(OsStr::new("init.defaultBranch"))
        );
        assert_eq!(
            environment.variable("GIT_CONFIG_VALUE_0"),
            Some(OsStr::new("main"))
        );
        assert!(home.is_dir());
        assert!(!environment.removes_variable("PATH"));
        assert_path_contains(
            environment.variable("PATH"),
            &temp.path().join("git").join("bin"),
        );
        assert_path_contains(
            environment.variable("PATH"),
            &temp.path().join("git").join("libexec").join("git-core"),
        );
        assert_path_contains(environment.variable("PATH"), &temp.path().join("git-lfs"));
        let expected_exec_path = temp.path().join("git").join("libexec").join("git-core");
        assert_eq!(
            environment.variable("GIT_EXEC_PATH"),
            Some(expected_exec_path.as_os_str())
        );
        let expected_template_dir = temp
            .path()
            .join("git")
            .join("share")
            .join("git-core")
            .join("templates");
        assert_eq!(
            environment.variable("GIT_TEMPLATE_DIR"),
            Some(expected_template_dir.as_os_str())
        );
        assert_path_contains(
            environment.variable("GITPERLLIB"),
            &temp.path().join("git").join("share").join("perl5"),
        );
        assert!(environment.variable("GIT_ASKPASS").is_some());
        assert!(environment.variable("SSH_ASKPASS").is_some());
        assert_eq!(
            environment.variable("SSH_ASKPASS_REQUIRE"),
            Some(OsStr::new("force"))
        );

        let command_plan = runner.git_command_plan(["status"]);
        assert_eq!(
            command_plan.executable,
            runner.distribution().git_executable
        );
        assert_eq!(command_plan.args, vec![OsString::from("status")]);
        assert!(!command_plan.environment.removes_variable("PATH"));
    }

    #[test]
    fn appimage_library_path_is_limited_to_the_distribution_appdir() {
        let temp = TestTempDir::new("ag-appimage-library-path").expect("temp dir");
        let appdir = temp.path().join("appdir");
        let library_path = appdir.join("usr/lib");
        let distribution_root = appdir.join("usr/share/artistic-git/git-dist");
        let outside_distribution = temp.path().join("outside/git-dist");
        fs::create_dir_all(&library_path).expect("appimage library path");
        fs::create_dir_all(&distribution_root).expect("appimage git-dist");
        fs::create_dir_all(&outside_distribution).expect("outside git-dist");
        let canonical_library_path =
            fs::canonicalize(&library_path).expect("canonical appimage library path");

        assert_eq!(
            appimage_library_path_for(&distribution_root, &appdir),
            Some(canonical_library_path)
        );
        assert_eq!(
            appimage_library_path_for(&outside_distribution, &appdir),
            None
        );
    }

    #[test]
    fn command_builder_injects_command_level_config_without_persisting() {
        let temp = fake_distribution().expect("create fake distribution");
        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        let plan = runner
            .git_command_builder()
            .default_credential_helper()
            .ssh_command("/usr/bin/ssh -o StrictHostKeyChecking=accept-new")
            .enable_rename_detection()
            .enable_windows_longpaths_for_platform(GitCommandPlatform::Windows)
            .args(["status", "--porcelain=v1"])
            .with_progress()
            .build();

        assert_eq!(
            plan.args,
            vec![
                OsString::from("-c"),
                config_arg(
                    "credential.helper",
                    runner.distribution().credential_helper.as_os_str()
                ),
                OsString::from("-c"),
                OsString::from("credential.useHttpPath=true"),
                OsString::from("-c"),
                OsString::from("core.sshCommand=/usr/bin/ssh -o StrictHostKeyChecking=accept-new"),
                OsString::from("-c"),
                OsString::from("diff.renames=true"),
                OsString::from("-c"),
                OsString::from("status.renames=true"),
                OsString::from("-c"),
                OsString::from("core.longpaths=true"),
                OsString::from("status"),
                OsString::from("--porcelain=v1"),
                OsString::from("--progress"),
            ]
        );
        assert!(!plan.environment.removes_variable("PATH"));
        assert!(!plan.environment.removes_variable("GIT_EXEC_PATH"));
    }

    #[test]
    fn command_builder_only_enables_longpaths_for_windows() {
        let temp = fake_distribution().expect("create fake distribution");
        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));

        let plan = runner
            .git_command_builder()
            .enable_windows_longpaths_for_platform(GitCommandPlatform::Other)
            .arg("status")
            .build();

        assert!(!plan
            .args
            .iter()
            .any(|arg| arg.as_os_str() == OsStr::new("core.longpaths=true")));
    }

    #[test]
    fn runtime_self_check_plan_targets_embedded_binaries() {
        let temp = fake_distribution().expect("create fake distribution");
        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));

        let plan = runner.runtime_self_check_plan();

        assert_eq!(plan.commands.len(), 2);
        assert_eq!(plan.commands[0].kind, SelfCheckCommandKind::GitVersion);
        assert_eq!(
            plan.commands[0].command.executable,
            runner.distribution().git_executable
        );
        assert_eq!(
            plan.commands[0].command.args,
            vec![OsString::from("--version")]
        );
        assert_eq!(plan.commands[1].kind, SelfCheckCommandKind::GitLfsVersion);
        assert_eq!(
            plan.commands[1].command.executable,
            runner.distribution().git_lfs_executable
        );
        assert_eq!(
            plan.commands[1].command.args,
            vec![OsString::from("version")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_self_check_executes_and_returns_versions() {
        let temp = fake_distribution_with_versions(
            "git version 2.50.0\n",
            "git-lfs/3.6.0 (GitHub; test)\n",
        )
        .expect("create fake distribution");
        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));

        let result = runner
            .run_runtime_self_check()
            .expect("self-check should pass");

        assert_eq!(result.commands.len(), 2);
        assert_eq!(result.commands[0].observed_version, "git version 2.50.0");
        assert_eq!(
            result.commands[1].observed_version,
            "git-lfs/3.6.0 (GitHub; test)"
        );
        assert!(result
            .commands
            .iter()
            .all(|command| command.version_matches));
    }

    #[test]
    fn runtime_self_check_version_match_normalizes_tool_banners() {
        assert!(self_check_version_matches(
            SelfCheckCommandKind::GitVersion,
            "2.55.0",
            "git version 2.55.0"
        ));
        assert!(self_check_version_matches(
            SelfCheckCommandKind::GitVersion,
            "git version 2.55.0",
            "git version 2.55.0"
        ));
        assert!(self_check_version_matches(
            SelfCheckCommandKind::GitVersion,
            "2.55.0.windows.2",
            "git version 2.55.0.windows.2"
        ));
        assert!(self_check_version_matches(
            SelfCheckCommandKind::GitLfsVersion,
            "3.7.1",
            "git-lfs/3.7.1 (GitHub; test)"
        ));
        assert!(self_check_version_matches(
            SelfCheckCommandKind::GitLfsVersion,
            "git-lfs/3.7.1",
            "git-lfs/3.7.1"
        ));
        assert!(!self_check_version_matches(
            SelfCheckCommandKind::GitVersion,
            "2.55.0",
            "git version 2.54.0"
        ));
        assert!(!self_check_version_matches(
            SelfCheckCommandKind::GitLfsVersion,
            "3.7.1",
            "git-lfs/3.6.0"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn runtime_self_check_version_mismatch_is_fatal_app_error() {
        let temp = fake_distribution_with_versions("git version 9.99.0\n", "git-lfs/3.6.0\n")
            .expect("create fake distribution");
        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));

        let error = runner
            .run_runtime_self_check()
            .expect_err("version mismatch should fail");

        assert!(error.category.terminates_app());
        assert!(error.summary.contains("version mismatch"));
        assert_eq!(
            error.git.as_ref().expect("git error").command[0],
            runner
                .distribution()
                .git_executable
                .to_string_lossy()
                .into_owned()
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_self_check_unexecutable_command_is_fatal_app_error() {
        let temp = fake_distribution().expect("create fake distribution");
        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");
        fs::remove_file(&distribution.git_executable).expect("remove executable after validation");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));

        let error = runner
            .run_runtime_self_check()
            .expect_err("missing executable should fail at runtime");

        assert!(error.category.terminates_app());
        assert!(error.summary.contains("not executable"));
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
    fn exclusive_lock_blocks_write_and_background_operations() {
        let concurrency = OperationConcurrency::default();
        let exclusive = concurrency
            .try_begin_exclusive()
            .expect("exclusive lock starts");

        assert_eq!(concurrency.busy_state(), Some(OperationBusy::WriteBusy));
        assert_eq!(
            concurrency.try_begin_write().expect_err("write is blocked"),
            OperationBusy::WriteBusy
        );
        assert_eq!(
            concurrency
                .try_begin_background()
                .expect_err("background is blocked"),
            OperationBusy::WriteBusy
        );

        drop(exclusive);
        assert_eq!(concurrency.busy_state(), None);
        let _background = concurrency
            .try_begin_background()
            .expect("background starts after exclusive lock drops");
    }

    #[test]
    fn exclusive_lock_rejects_existing_background_operation() {
        let concurrency = OperationConcurrency::default();
        let background = concurrency
            .try_begin_background()
            .expect("background starts");

        assert_eq!(
            concurrency
                .try_begin_exclusive()
                .expect_err("exclusive lock detects background"),
            OperationBusy::BackgroundBusy
        );
        assert_eq!(
            concurrency.busy_state().expect("background remains"),
            OperationBusy::BackgroundBusy
        );

        drop(background);
        concurrency
            .try_begin_exclusive()
            .expect("exclusive lock starts after background drops");
    }

    #[test]
    fn write_entry_invokes_identity_hook_before_returning_permit() {
        let concurrency = OperationConcurrency::default();
        let hook = RecordingIdentityHook::default();
        let request = WriteOperationRequest::new("commit")
            .with_repository_path("/repo")
            .requiring_identity();

        let permit = concurrency
            .try_begin_write_with_identity(&request, &hook)
            .expect("write should start");

        assert_eq!(
            hook.calls.borrow().as_slice(),
            std::slice::from_ref(&request)
        );
        assert_eq!(
            concurrency.try_begin_write().expect_err("write still held"),
            OperationBusy::WriteBusy
        );

        drop(permit);
        concurrency
            .try_begin_write()
            .expect("write lock released after permit drop");
    }

    #[test]
    fn default_identity_hook_allows_write_entry() {
        let concurrency = OperationConcurrency::default();
        let request = WriteOperationRequest::new("fetch");

        let _permit = concurrency
            .try_begin_write_with_identity(&request, &AllowIdentityValidation)
            .expect("default hook allows");
    }

    #[test]
    fn identity_hook_failure_releases_write_lock() {
        let concurrency = OperationConcurrency::default();
        let hook = FailingIdentityHook;
        let request = WriteOperationRequest::new("commit").requiring_identity();

        let error = concurrency
            .try_begin_write_with_identity(&request, &hook)
            .expect_err("identity failure blocks write");

        assert!(matches!(error, BeginWriteError::Identity(_)));
        concurrency
            .try_begin_write()
            .expect("identity failure releases write lock");
    }

    #[test]
    fn cloned_runner_shares_operation_concurrency() {
        let temp = fake_distribution().expect("create fake distribution");
        let distribution =
            GitDistribution::from_root(temp.path()).expect("distribution should load");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        let cloned = runner.clone();
        let _permit = runner
            .operation_concurrency()
            .try_begin_write()
            .expect("first write starts");

        assert_eq!(
            cloned
                .operation_concurrency()
                .try_begin_write()
                .expect_err("cloned runner observes held write lock"),
            OperationBusy::WriteBusy
        );
    }

    #[test]
    fn cancel_token_kills_child_and_runs_recovery_hook() {
        let token = CancelToken::new();
        token.cancel();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut child = FakeChild {
            calls: Rc::clone(&calls),
            ..FakeChild::default()
        };
        let mut recovery = RecordingRecoveryHook {
            calls: Rc::clone(&calls),
        };
        let context = CancellationContext::new("clone").with_repository_path("/repo");

        let outcome =
            cancel_child_if_requested(&mut child, &token, &mut recovery, &context).expect("cancel");

        assert_eq!(outcome, CancellationOutcome::CancelledAndRecovered);
        assert!(child.killed);
        assert_eq!(
            calls.borrow().as_slice(),
            &[
                "kill".to_owned(),
                format!("recover:{}", context.operation_name)
            ]
        );
    }

    #[test]
    fn cancel_token_does_nothing_until_requested() {
        let token = CancelToken::new();
        let mut child = FakeChild::default();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut recovery = RecordingRecoveryHook {
            calls: Rc::clone(&calls),
        };
        let context = CancellationContext::new("fetch");

        let outcome =
            cancel_child_if_requested(&mut child, &token, &mut recovery, &context).expect("cancel");

        assert_eq!(outcome, CancellationOutcome::NotCancelled);
        assert!(!child.killed);
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn event_router_emits_to_specified_window_label() {
        let sink = RecordingEventSink::default();
        let router = WindowEventRouter::new(sink);
        let event = AppEvent::OperationProgress(artistic_git_contracts::OperationProgressEvent {
            operation_id: artistic_git_contracts::OperationId("op-1".to_owned()),
            label: "Fetching".to_owned(),
            progress: ProgressState::Percent { value: 50.0 },
            cancellable: true,
            repository_path: Some("/repo/art".to_owned()),
            window_label: Some("repo-window".to_owned()),
        });

        router
            .route(RoutedAppEvent::new("repo-window", event.clone()))
            .expect("route event");

        let emitted = router.sink().events.borrow();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].window_label, "repo-window");
        assert_eq!(emitted[0].event_name, "operation-progress");
        assert_eq!(emitted[0].payload, event);
    }

    #[test]
    fn app_event_names_match_frontend_listener_contract() {
        assert_eq!(
            AppEvent::RepoChanged(artistic_git_contracts::RepoChangedEvent {
                repository_path: "/repo".to_owned(),
                changed_queries: vec![artistic_git_contracts::RepoQueryKind::Summary],
            })
            .event_name(),
            "repo-changed"
        );
        assert_eq!(
            AppEvent::FetchState(artistic_git_contracts::FetchStateEvent {
                repository_path: "/repo".to_owned(),
                state: artistic_git_contracts::FetchState::Fetching,
                last_success_at: None,
                message: None,
            })
            .event_name(),
            "fetch-state"
        );
        assert_eq!(
            AppEvent::ConflictEntered(artistic_git_contracts::ConflictEnteredEvent {
                operation_id: artistic_git_contracts::OperationId("op-1".to_owned()),
                repository_path: "/repo".to_owned(),
                operation_name: "sync".to_owned(),
                files: Vec::new(),
            })
            .event_name(),
            "conflict-entered"
        );
    }

    #[test]
    fn source_guard_does_not_construct_system_git_commands_by_name() {
        let source = include_str!("lib.rs");
        let forbidden_git = "Command::new(\"".to_owned() + "git\")";
        let forbidden_lfs = "Command::new(\"".to_owned() + "git-lfs\")";

        assert!(!source.contains(&forbidden_git));
        assert!(!source.contains(&forbidden_lfs));
        assert!(source.contains("env_clear()"));
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

    #[derive(Default)]
    struct RecordingIdentityHook {
        calls: RefCell<Vec<WriteOperationRequest>>,
    }

    impl IdentityValidationHook for RecordingIdentityHook {
        fn validate_write_entry(&self, request: &WriteOperationRequest) -> Result<(), AppError> {
            self.calls.borrow_mut().push(request.clone());
            Ok(())
        }
    }

    struct FailingIdentityHook;

    impl IdentityValidationHook for FailingIdentityHook {
        fn validate_write_entry(&self, request: &WriteOperationRequest) -> Result<(), AppError> {
            Err(AppError::expected(
                "missing identity",
                &request.operation_name,
            ))
        }
    }

    #[derive(Default)]
    struct FakeChild {
        killed: bool,
        calls: Rc<RefCell<Vec<String>>>,
    }

    impl ChildProcessHandle for FakeChild {
        fn id(&self) -> u32 {
            42
        }

        fn kill(&mut self) -> io::Result<()> {
            self.killed = true;
            self.calls.borrow_mut().push("kill".to_owned());
            Ok(())
        }

        fn wait(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct RecordingRecoveryHook {
        calls: Rc<RefCell<Vec<String>>>,
    }

    impl RecoveryHook for RecordingRecoveryHook {
        fn recover_after_cancel(&mut self, context: &CancellationContext) -> Result<(), AppError> {
            self.calls
                .borrow_mut()
                .push(format!("recover:{}", context.operation_name));
            Ok(())
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    struct RecordedEvent {
        window_label: String,
        event_name: String,
        payload: AppEvent,
    }

    #[derive(Default)]
    struct RecordingEventSink {
        events: RefCell<Vec<RecordedEvent>>,
    }

    impl WindowEventSink for RecordingEventSink {
        fn emit_to(
            &self,
            window_label: &str,
            event_name: &str,
            payload: &AppEvent,
        ) -> Result<(), EventRouteError> {
            self.events.borrow_mut().push(RecordedEvent {
                window_label: window_label.to_owned(),
                event_name: event_name.to_owned(),
                payload: payload.clone(),
            });

            Ok(())
        }
    }

    fn config_arg(key: &str, value: &OsStr) -> OsString {
        let mut arg = OsString::from(key);
        arg.push("=");
        arg.push(value);
        arg
    }

    fn assert_path_contains(variable: Option<&OsStr>, expected: &Path) {
        let variable = variable.expect("path variable should be set");
        assert!(
            std::env::split_paths(variable).any(|path| path == expected),
            "{:?} should contain {}",
            variable,
            expected.display()
        );
    }

    fn fake_distribution() -> Result<TestTempDir, Box<dyn std::error::Error>> {
        let temp = TestTempDir::new("ag-git-dist")?;
        let manifest = git_dist_manifest_fixture();

        write_executable_file(&temp.path().join(&manifest.paths.git_executable))?;
        write_executable_file(&temp.path().join(&manifest.paths.git_lfs_executable))?;
        write_executable_file(&temp.path().join(&manifest.paths.credential_helper))?;
        write_executable_file(&temp.path().join(&manifest.paths.ssh_askpass))?;
        fs::create_dir_all(temp.path().join("git").join("libexec").join("git-core"))?;
        fs::create_dir_all(
            temp.path()
                .join("git")
                .join("share")
                .join("git-core")
                .join("templates")
                .join("hooks"),
        )?;
        fs::create_dir_all(temp.path().join("git").join("share").join("perl5"))?;
        if let Some(windows_ssh_executable) = &manifest.paths.windows_ssh_executable {
            write_executable_file(&temp.path().join(windows_ssh_executable))?;
        }
        write_git_dist_manifest(temp.path(), &manifest)?;

        Ok(temp)
    }

    #[cfg(unix)]
    fn fake_distribution_with_versions(
        git_version_output: &str,
        lfs_version_output: &str,
    ) -> Result<TestTempDir, Box<dyn std::error::Error>> {
        let temp = TestTempDir::new("ag-git-dist-versioned")?;
        let mut manifest = git_dist_manifest_fixture();
        manifest.git_version = "2.50.0".to_owned();
        manifest.git_lfs_version = "3.6.0".to_owned();

        write_executable_script(
            &temp.path().join(&manifest.paths.git_executable),
            &format!(
                "#!/bin/sh\nprintf %s '{}'\n",
                shell_single_quote(git_version_output)
            ),
            "@echo off\r\nexit /b 0\r\n",
        )?;
        write_executable_script(
            &temp.path().join(&manifest.paths.git_lfs_executable),
            &format!(
                "#!/bin/sh\nprintf %s '{}'\n",
                shell_single_quote(lfs_version_output)
            ),
            "@echo off\r\nexit /b 0\r\n",
        )?;
        write_executable_file(&temp.path().join(&manifest.paths.credential_helper))?;
        write_executable_file(&temp.path().join(&manifest.paths.ssh_askpass))?;
        if let Some(windows_ssh_executable) = &manifest.paths.windows_ssh_executable {
            write_executable_file(&temp.path().join(windows_ssh_executable))?;
        }
        write_git_dist_manifest(temp.path(), &manifest)?;

        Ok(temp)
    }

    #[cfg(unix)]
    fn shell_single_quote(value: &str) -> String {
        value.replace('\'', "'\\''")
    }
}
