use artistic_git_contracts::{
    AppError, AppResult, FetchRepositoryRequest, FetchRepositoryResponse, FetchState,
    FetchStateEvent, RepoQueryKind, RepositoryRemoteMode,
};
use artistic_git_git_runner::{GitRunner, OperationBusy};
use std::{
    collections::BTreeMap,
    process::Output,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::git_ops::{
    canonical_repository_path, command_failure, display_path, run_git_raw_authenticated,
};

const FETCH_OPERATION: &str = "fetchRepository";
const MIN_FETCH_INTERVAL_SECONDS: u32 = 10;
const MAX_FETCH_INTERVAL_SECONDS: u32 = 3_600;

#[derive(Clone, Default)]
pub struct FetchStateStore {
    records: Arc<Mutex<BTreeMap<String, FetchStateRecord>>>,
}

impl FetchStateStore {
    pub fn started_event(&self, repository_path: impl AsRef<str>) -> FetchStateEvent {
        self.update(repository_path.as_ref(), FetchState::Fetching, None, None)
    }

    pub fn snapshot_event(&self, repository_path: impl AsRef<str>) -> FetchStateEvent {
        let repository_path = repository_path.as_ref();
        let records = self.records.lock().expect("fetch state lock poisoned");
        let record = records.get(repository_path).cloned().unwrap_or_default();
        event_from_record(repository_path, record)
    }

    fn success_event(&self, repository_path: &str) -> FetchStateEvent {
        self.update(
            repository_path,
            FetchState::Idle,
            Some(unix_now_seconds().to_string()),
            None,
        )
    }

    fn skipped_event(&self, repository_path: &str, message: impl Into<String>) -> FetchStateEvent {
        let records = self.records.lock().expect("fetch state lock poisoned");
        let mut record = records.get(repository_path).cloned().unwrap_or_default();
        record.message = Some(message.into());
        event_from_record(repository_path, record)
    }

    fn offline_event(&self, repository_path: &str, message: impl Into<String>) -> FetchStateEvent {
        self.update(
            repository_path,
            FetchState::Offline,
            None,
            Some(message.into()),
        )
    }

    fn failed_event(&self, repository_path: &str, message: impl Into<String>) -> FetchStateEvent {
        self.update(
            repository_path,
            FetchState::Failed,
            None,
            Some(message.into()),
        )
    }

    fn update(
        &self,
        repository_path: &str,
        state: FetchState,
        last_success_at: Option<String>,
        message: Option<String>,
    ) -> FetchStateEvent {
        let mut records = self.records.lock().expect("fetch state lock poisoned");
        let record = records.entry(repository_path.to_owned()).or_default();
        record.state = state;
        if last_success_at.is_some() {
            record.last_success_at = last_success_at;
        }
        record.message = message;
        event_from_record(repository_path, record.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchScheduleDecision {
    Disabled,
    NoRemote,
    RunNow,
    Wait { next_due_in_seconds: u32 },
}

pub fn plan_scheduled_fetch(
    auto_fetch: bool,
    remote_mode: RepositoryRemoteMode,
    interval_seconds: u32,
    last_success_unix_seconds: Option<u64>,
    now_unix_seconds: u64,
) -> FetchScheduleDecision {
    if !auto_fetch {
        return FetchScheduleDecision::Disabled;
    }
    if remote_mode == RepositoryRemoteMode::NoRemote {
        return FetchScheduleDecision::NoRemote;
    }

    let interval = normalize_fetch_interval_seconds(interval_seconds);
    let Some(last_success) = last_success_unix_seconds else {
        return FetchScheduleDecision::RunNow;
    };
    let elapsed = now_unix_seconds.saturating_sub(last_success);

    if elapsed >= u64::from(interval) {
        FetchScheduleDecision::RunNow
    } else {
        FetchScheduleDecision::Wait {
            next_due_in_seconds: interval.saturating_sub(elapsed as u32),
        }
    }
}

pub fn fetch_repository(
    runner: &GitRunner,
    state_store: &FetchStateStore,
    request: FetchRepositoryRequest,
) -> AppResult<FetchRepositoryResponse> {
    fetch_repository_with_auth(runner, None, state_store, request)
}

pub(crate) fn fetch_repository_with_auth(
    runner: &GitRunner,
    auth_runtime: Option<&crate::auth_ipc::AuthRuntime>,
    state_store: &FetchStateStore,
    request: FetchRepositoryRequest,
) -> AppResult<FetchRepositoryResponse> {
    let root = canonical_repository_path(&request.repository_path, FETCH_OPERATION)?;
    let repository_path = display_path(&root);
    let permit = match runner.operation_concurrency().try_begin_background() {
        Ok(permit) => permit,
        Err(OperationBusy::WriteBusy) => {
            return Ok(FetchRepositoryResponse {
                event: state_store.skipped_event(
                    &repository_path,
                    "fetch skipped because a write operation is in progress",
                ),
                skipped: true,
            });
        }
        Err(OperationBusy::BackgroundBusy) => {
            return Ok(FetchRepositoryResponse {
                event: state_store.skipped_event(
                    &repository_path,
                    "fetch skipped because another fetch is already in progress",
                ),
                skipped: true,
            });
        }
    };

    let _permit = permit;
    if crate::remote::read_origin_url(runner, &root, FETCH_OPERATION)?.is_none() {
        return Ok(FetchRepositoryResponse {
            event: state_store.skipped_event(
                &repository_path,
                "fetch skipped because origin is not configured",
            ),
            skipped: true,
        });
    }

    let (plan, output) = run_git_raw_authenticated(
        runner,
        auth_runtime,
        crate::auth_ipc::InteractionPolicy::background_non_interactive(),
        Some(&root),
        [
            "fetch",
            "origin",
            "--prune",
            "--recurse-submodules=on-demand",
        ],
        FETCH_OPERATION,
    )?;

    if output.status.success() {
        return Ok(FetchRepositoryResponse {
            event: state_store.success_event(&repository_path),
            skipped: false,
        });
    }

    let message = fetch_failure_summary(&output);
    if is_network_fetch_error(&message) {
        return Ok(FetchRepositoryResponse {
            event: state_store.offline_event(&repository_path, message),
            skipped: false,
        });
    }

    state_store.failed_event(&repository_path, &message);
    Err(command_failure(&plan, output, FETCH_OPERATION))
}

pub fn fetch_changed_queries(response: &FetchRepositoryResponse) -> Vec<RepoQueryKind> {
    if response.skipped || response.event.state != FetchState::Idle {
        Vec::new()
    } else {
        vec![
            RepoQueryKind::Summary,
            RepoQueryKind::Branches,
            RepoQueryKind::History,
        ]
    }
}

pub fn normalize_fetch_interval_seconds(value: u32) -> u32 {
    value.clamp(MIN_FETCH_INTERVAL_SECONDS, MAX_FETCH_INTERVAL_SECONDS)
}

pub(crate) fn validate_fetch_interval_seconds(value: u32, operation_name: &str) -> AppResult<()> {
    if (MIN_FETCH_INTERVAL_SECONDS..=MAX_FETCH_INTERVAL_SECONDS).contains(&value) {
        Ok(())
    } else {
        Err(crate::logged_app_error(AppError::expected(
            format!(
                "fetch interval must be between {MIN_FETCH_INTERVAL_SECONDS} and {MAX_FETCH_INTERVAL_SECONDS} seconds"
            ),
            operation_name,
        )))
    }
}

fn fetch_failure_summary(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    first_non_empty_line(&stderr)
        .or_else(|| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            first_non_empty_line(&stdout)
        })
        .unwrap_or_else(|| "git fetch failed".to_owned())
}

fn is_network_fetch_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "could not resolve host",
        "could not resolve hostname",
        "failed to connect",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "temporary failure in name resolution",
        "connection refused",
        "connection reset",
        "connection closed",
        "early eof",
    ]
    .into_iter()
    .any(|needle| message.contains(needle))
}

fn first_non_empty_line(value: &str) -> Option<String> {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn event_from_record(repository_path: &str, record: FetchStateRecord) -> FetchStateEvent {
    FetchStateEvent {
        repository_path: repository_path.to_owned(),
        state: record.state,
        last_success_at: record.last_success_at,
        message: record.message,
    }
}

fn unix_now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FetchStateRecord {
    state: FetchState,
    last_success_at: Option<String>,
    message: Option<String>,
}

impl Default for FetchStateRecord {
    fn default() -> Self {
        Self {
            state: FetchState::Idle,
            last_success_at: None,
            message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{
        git_dist_manifest_fixture, require_git_dist, write_executable_file,
        write_git_dist_manifest, GitDistError, TestTempDir,
    };
    use std::{
        ffi::OsString,
        fs,
        io::Write,
        path::{Path, PathBuf},
    };

    #[test]
    fn schedule_plan_respects_disabled_no_remote_and_interval() {
        assert_eq!(
            plan_scheduled_fetch(true, RepositoryRemoteMode::NoRemote, 60, None, 100),
            FetchScheduleDecision::NoRemote
        );
        assert_eq!(
            plan_scheduled_fetch(false, RepositoryRemoteMode::Origin, 60, None, 100),
            FetchScheduleDecision::Disabled
        );
        assert_eq!(
            plan_scheduled_fetch(true, RepositoryRemoteMode::Origin, 60, None, 100),
            FetchScheduleDecision::RunNow
        );
        assert_eq!(
            plan_scheduled_fetch(true, RepositoryRemoteMode::Origin, 60, Some(50), 100),
            FetchScheduleDecision::Wait {
                next_due_in_seconds: 10,
            }
        );
        assert_eq!(
            plan_scheduled_fetch(true, RepositoryRemoteMode::Origin, 60, Some(40), 100),
            FetchScheduleDecision::RunNow
        );
    }

    #[test]
    fn rejects_fetch_interval_outside_supported_bounds() {
        assert!(validate_fetch_interval_seconds(10, "saveAppSettings").is_ok());
        assert!(validate_fetch_interval_seconds(3_600, "saveAppSettings").is_ok());
        assert!(validate_fetch_interval_seconds(9, "saveAppSettings").is_err());
        assert!(validate_fetch_interval_seconds(3_601, "saveAppSettings").is_err());
    }

    #[test]
    fn classifies_network_fetch_errors() {
        assert!(is_network_fetch_error(
            "fatal: unable to access 'https://example.test/repo.git/': Could not resolve host: example.test"
        ));
        assert!(is_network_fetch_error(
            "ssh: connect to host example.test port 22: Network is unreachable"
        ));
        assert!(!is_network_fetch_error(
            "ERROR: Repository not found.\nfatal: Could not read from remote repository."
        ));
        assert!(!is_network_fetch_error("Permission denied (publickey)."));
    }

    #[test]
    fn fetch_source_uses_on_demand_submodules() {
        let source = include_str!("fetch.rs");
        assert!(source.contains("\"--recurse-submodules=on-demand\""));
    }

    #[test]
    fn skips_fetch_when_write_lock_is_busy_without_running_git() {
        let (runner, _dist_temp) = fake_runner();
        let repo = TestTempDir::new("ag-fetch-lock-repo").expect("temp repo");
        let _write = runner
            .operation_concurrency()
            .try_begin_write()
            .expect("hold write lock");

        let response = fetch_repository(
            &runner,
            &FetchStateStore::default(),
            FetchRepositoryRequest {
                repository_path: display_path(repo.path()),
            },
        )
        .expect("fetch skip");

        assert!(response.skipped);
        assert_eq!(response.event.state, FetchState::Idle);
        assert!(response
            .event
            .message
            .as_deref()
            .is_some_and(|message| message.contains("write operation")));
    }

    #[test]
    fn skips_fetch_when_background_fetch_is_already_running() {
        let (runner, _dist_temp) = fake_runner();
        let repo = TestTempDir::new("ag-fetch-background-repo").expect("temp repo");
        let _background = runner
            .operation_concurrency()
            .try_begin_background()
            .expect("hold background lock");

        let response = fetch_repository(
            &runner,
            &FetchStateStore::default(),
            FetchRepositoryRequest {
                repository_path: display_path(repo.path()),
            },
        )
        .expect("fetch skip");

        assert!(response.skipped);
        assert_eq!(response.event.state, FetchState::Idle);
        assert!(response
            .event
            .message
            .as_deref()
            .is_some_and(|message| message.contains("already in progress")));
    }

    #[test]
    fn fetch_without_origin_enters_no_remote_mode() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);

        let response = fetch_repository(
            &runner,
            &FetchStateStore::default(),
            FetchRepositoryRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("fetch no origin");

        assert!(response.skipped);
        assert_eq!(response.event.state, FetchState::Idle);
        assert!(response
            .event
            .message
            .as_deref()
            .is_some_and(|message| message.contains("origin is not configured")));
    }

    #[test]
    fn fetch_prunes_deleted_remote_branches() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let remote = TestRepo::new(&runner);
        remote.git(["init", "--bare"]);
        let seed = TestRepo::new(&runner);
        seed.init_with_commit();
        seed.git(["checkout", "-b", "feature/stale"]);
        seed.write("stale.txt", "stale\n");
        seed.git(["add", "."]);
        seed.git(["commit", "-m", "stale"]);
        seed.git(["checkout", "-b", "feature/live"]);
        seed.write("live.txt", "live\n");
        seed.git(["add", "."]);
        seed.git(["commit", "-m", "live"]);
        seed.git([
            "remote",
            "add",
            "origin",
            display_path(&remote.path).as_str(),
        ]);
        seed.git(["push", "--all", "origin"]);

        let local = TestTempDir::new("ag-fetch-clone").expect("local clone path");
        fs::remove_dir_all(local.path()).expect("clone target starts absent");
        git(
            &runner,
            None,
            [
                OsString::from("clone"),
                OsString::from(display_path(&remote.path)),
                OsString::from(display_path(local.path())),
            ],
        );
        seed.git(["push", "origin", ":feature/stale"]);

        let before = git(
            &runner,
            Some(local.path()),
            [
                OsString::from("for-each-ref"),
                OsString::from("--format=%(refname)"),
                OsString::from("refs/remotes/origin"),
            ],
        );
        assert!(before.contains("refs/remotes/origin/feature/stale"));

        let response = fetch_repository(
            &runner,
            &FetchStateStore::default(),
            FetchRepositoryRequest {
                repository_path: display_path(local.path()),
            },
        )
        .expect("fetch");

        assert!(!response.skipped);
        assert_eq!(response.event.state, FetchState::Idle);
        assert!(response.event.last_success_at.is_some());
        let after = git(
            &runner,
            Some(local.path()),
            [
                OsString::from("for-each-ref"),
                OsString::from("--format=%(refname)"),
                OsString::from("refs/remotes/origin"),
            ],
        );
        assert!(!after.contains("refs/remotes/origin/feature/stale"));
        assert!(after.contains("refs/remotes/origin/feature/live"));
    }

    fn fake_runner() -> (GitRunner, TestTempDir) {
        let temp = TestTempDir::new("ag-fetch-fake-dist").expect("fake dist");
        let manifest = git_dist_manifest_fixture();
        write_executable_file(&temp.path().join(&manifest.paths.git_executable)).expect("fake git");
        write_executable_file(&temp.path().join(&manifest.paths.git_lfs_executable))
            .expect("fake git-lfs");
        write_executable_file(&temp.path().join(&manifest.paths.credential_helper))
            .expect("fake helper");
        write_executable_file(&temp.path().join(&manifest.paths.ssh_askpass))
            .expect("fake askpass");
        write_git_dist_manifest(temp.path(), &manifest).expect("manifest");
        let distribution = GitDistribution::from_root(temp.path()).expect("distribution");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        (runner, temp)
    }

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => return None,
            Err(error) => panic!("invalid embedded git distribution: {error}"),
        };
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-fetch-runner-home").expect("temp home");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        Some((runner, temp))
    }

    fn git<I, S>(runner: &GitRunner, root: Option<&Path>, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        crate::git_ops::git_stdout(runner, root, args, "test").expect("git command")
    }

    struct TestRepo {
        path: PathBuf,
        _temp: TestTempDir,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-fetch-repo").expect("temp repo");
            Self {
                path: temp.path().to_path_buf(),
                _temp: temp,
                runner: runner.clone(),
            }
        }

        fn init_with_commit(&self) {
            self.git(["init"]);
            self.git(["config", "user.name", "Tester"]);
            self.git(["config", "user.email", "tester@example.test"]);
            self.write("tracked.txt", "one\n");
            self.git(["add", "."]);
            self.git(["commit", "-m", "initial"]);
        }

        fn git<I, S>(&self, args: I)
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            git(&self.runner, Some(&self.path), args);
        }

        fn write(&self, relative: &str, content: &str) {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("parent dir");
            }
            let mut file = fs::File::create(path).expect("create file");
            file.write_all(content.as_bytes()).expect("write file");
        }
    }
}
