use artistic_git_contracts::{
    AppError, AppResult, CommitSummary, CreateAutoStashRequest, ExitReviewModeResponse,
    OperationContext, OperationId, RepositoryPathRequest, ReviewModeExitStatus,
    ReviewModePullStatus, ReviewModeRecoveryRequest, ReviewModeRecoveryResponse, ReviewModeRequest,
    ReviewModeState, StartReviewModeRequest, StartReviewModeResponse, StashEntry,
    StashRestoreOutcome, SyncReviewModeResponse,
};
use artistic_git_core::config::{ConfigActor, ReviewModeCrashMarker};
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use std::{
    path::Path,
    process::Output,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::git_ops::{canonical_repository_path, display_path, run_git_raw};

const REVIEW_OPERATION: &str = "reviewMode";
const REVIEW_STASH_REASON: &str = "review mode";
const REVIEW_STASH_RESTORE_OPERATION: &str = "reviewMode:restoreStash";

pub fn start_review_mode(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: StartReviewModeRequest,
) -> AppResult<StartReviewModeResponse> {
    let root = canonical_repository_path(&request.repository_path, "startReviewMode")?;
    let operation_id = request
        .operation_id
        .clone()
        .unwrap_or_else(review_operation_id);
    let auto_stash = create_review_auto_stash(runner, &root, &operation_id)?;
    write_review_marker(config, &root, auto_stash.as_ref(), &operation_id)?;
    let pull = pull_current_branch_ff_only(runner, &root);
    Ok(StartReviewModeResponse {
        state: build_state(runner, &root, auto_stash, pull)?,
    })
}

pub fn sync_review_mode(
    runner: &GitRunner,
    request: ReviewModeRequest,
) -> AppResult<SyncReviewModeResponse> {
    let root = canonical_repository_path(&request.repository_path, "syncReviewMode")?;
    ensure_clean_worktree(runner, &root, "syncReviewMode")?;
    let pull = pull_current_branch_ff_only(runner, &root);
    Ok(SyncReviewModeResponse {
        state: build_state(runner, &root, active_review_stash(runner, &root)?, pull)?,
    })
}

pub fn exit_review_mode(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: ReviewModeRequest,
) -> AppResult<ExitReviewModeResponse> {
    let root = canonical_repository_path(&request.repository_path, "exitReviewMode")?;
    let operation_id = request
        .operation_id
        .clone()
        .unwrap_or_else(review_operation_id);
    let Some(auto_stash) = review_stash_from_marker_or_latest(runner, config, &root)? else {
        clear_review_marker(config, &root)?;
        return Ok(ExitReviewModeResponse {
            repository_path: display_path(&root),
            status: ReviewModeExitStatus::NothingToRestore,
            conflict: None,
            stash_recovery: None,
        });
    };

    let restore = crate::stash_impl::restore_stash_for_root(
        runner,
        &root,
        &auto_stash.selector,
        true,
        REVIEW_STASH_RESTORE_OPERATION,
        Some(&operation_id),
    )?;
    match restore.outcome {
        StashRestoreOutcome::Applied { .. } => {
            clear_review_marker(config, &root)?;
            Ok(ExitReviewModeResponse {
                repository_path: display_path(&root),
                status: ReviewModeExitStatus::Applied,
                conflict: None,
                stash_recovery: None,
            })
        }
        StashRestoreOutcome::Conflicts { conflict } => Ok(ExitReviewModeResponse {
            repository_path: display_path(&root),
            status: ReviewModeExitStatus::Conflicts,
            conflict: Some(conflict),
            stash_recovery: Some(restore.recovery),
        }),
    }
}

pub fn review_mode_recovery(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: ReviewModeRecoveryRequest,
) -> AppResult<ReviewModeRecoveryResponse> {
    let root = canonical_repository_path(&request.repository_path, "reviewModeRecovery")?;
    let auto_stash = review_stash_from_marker(runner, config, &root)?;
    Ok(ReviewModeRecoveryResponse {
        repository_path: display_path(&root),
        should_prompt: auto_stash.is_some(),
        auto_stash,
    })
}

pub fn recover_review_mode_stash(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: ReviewModeRecoveryRequest,
) -> AppResult<ExitReviewModeResponse> {
    exit_review_mode(
        runner,
        config,
        ReviewModeRequest {
            repository_path: request.repository_path,
            operation_id: request.operation_id,
        },
    )
}

pub fn dismiss_review_mode_recovery(
    config: Option<&ConfigActor>,
    request: ReviewModeRecoveryRequest,
) -> AppResult<ReviewModeRecoveryResponse> {
    let root = canonical_repository_path(&request.repository_path, "dismissReviewModeRecovery")?;
    clear_review_marker(config, &root)?;
    Ok(ReviewModeRecoveryResponse {
        repository_path: display_path(&root),
        auto_stash: None,
        should_prompt: false,
    })
}

fn create_review_auto_stash(
    runner: &GitRunner,
    root: &Path,
    operation_id: &OperationId,
) -> AppResult<Option<StashEntry>> {
    Ok(crate::stash_impl::create_auto_stash(
        runner,
        CreateAutoStashRequest {
            repository_path: display_path(root),
            reason: REVIEW_STASH_REASON.to_owned(),
            include_untracked: true,
            paths: Vec::new(),
            operation_id: Some(operation_id.clone()),
        },
    )?
    .stash)
}

fn pull_current_branch_ff_only(runner: &GitRunner, root: &Path) -> PullOutcome {
    if crate::remote::read_origin_url(runner, root, REVIEW_OPERATION)
        .ok()
        .flatten()
        .is_none()
    {
        return PullOutcome::new(ReviewModePullStatus::NoRemote, None);
    }

    if let Err(error) = run_raw_status(runner, root, ["fetch", "origin", "--prune"]) {
        return if error.network {
            PullOutcome::new(ReviewModePullStatus::Offline, Some(error.summary))
        } else {
            PullOutcome::new(ReviewModePullStatus::Failed, Some(error.summary))
        };
    }

    let Some(upstream) = upstream_branch(runner, root).ok().flatten() else {
        return PullOutcome::new(ReviewModePullStatus::NoUpstream, None);
    };

    let (_ahead, behind) = ahead_behind(runner, root, "HEAD", upstream.as_str()).unwrap_or((0, 0));
    if behind == 0 {
        return PullOutcome::new(ReviewModePullStatus::AlreadyUpToDate, None);
    }

    match run_raw_status(runner, root, ["merge", "--ff-only", upstream.as_str()]) {
        Ok(()) => PullOutcome::new(ReviewModePullStatus::Pulled, None),
        Err(error) if error.network => {
            PullOutcome::new(ReviewModePullStatus::Offline, Some(error.summary))
        }
        Err(error) => PullOutcome::new(ReviewModePullStatus::Failed, Some(error.summary)),
    }
}

fn build_state(
    runner: &GitRunner,
    root: &Path,
    auto_stash: Option<StashEntry>,
    pull: PullOutcome,
) -> AppResult<ReviewModeState> {
    Ok(ReviewModeState {
        repository_path: display_path(root),
        branch_name: crate::repository::current_branch_name(runner, root, REVIEW_OPERATION).ok(),
        head_oid: rev_parse(runner, root, "HEAD").ok(),
        latest_commit: latest_commit(runner, root)?,
        auto_stash,
        pull_status: pull.status,
        pull_message: pull.message,
        has_remote_update: current_branch_has_remote_update(runner, root).unwrap_or(false),
    })
}

fn latest_commit(runner: &GitRunner, root: &Path) -> AppResult<Option<CommitSummary>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        [
            "log",
            "-1",
            "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x1e",
            "--decorate=short",
        ],
        REVIEW_OPERATION,
    )?;
    if !output.status.success() {
        let text = combined_output(&output).to_ascii_lowercase();
        if text.contains("does not have any commits yet")
            || text.contains("ambiguous argument")
            || text.contains("bad default revision")
        {
            return Ok(None);
        }
        return Err(command_failure(
            &plan,
            output,
            "failed to read latest review commit",
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let parts = raw
        .trim_matches(['\n', '\x1e'])
        .split('\0')
        .collect::<Vec<_>>();
    if parts.len() < 7 || parts[0].is_empty() {
        return Ok(None);
    }
    Ok(Some(CommitSummary {
        oid: parts[0].to_owned(),
        parents: parts[1]
            .split_whitespace()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        author_name: parts[2].to_owned(),
        author_email: parts[3].to_owned(),
        authored_at_unix_seconds: parts[4].to_owned(),
        subject: parts[5].to_owned(),
        refs: parts[6]
            .split(", ")
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
    }))
}

fn current_branch_has_remote_update(runner: &GitRunner, root: &Path) -> AppResult<bool> {
    let Some(upstream) = upstream_branch(runner, root)? else {
        return Ok(false);
    };
    let (_ahead, behind) = ahead_behind(runner, root, "HEAD", upstream.as_str())?;
    Ok(behind > 0)
}

fn active_review_stash(runner: &GitRunner, root: &Path) -> AppResult<Option<StashEntry>> {
    Ok(list_stashes(runner, root)?
        .into_iter()
        .find(|stash| stash.message == "Auto Stash: review mode"))
}

fn review_stash_from_marker_or_latest(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    root: &Path,
) -> AppResult<Option<StashEntry>> {
    match review_stash_from_marker(runner, config, root)? {
        Some(stash) => Ok(Some(stash)),
        None => active_review_stash(runner, root),
    }
}

fn review_stash_from_marker(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    root: &Path,
) -> AppResult<Option<StashEntry>> {
    let Some(marker) = read_review_marker(config, root)? else {
        return Ok(None);
    };
    let stashes = list_stashes(runner, root)?;
    if let Some(stash_ref) = marker.auto_stash_ref.as_deref() {
        if let Some(stash) = stashes
            .iter()
            .find(|stash| stash.oid == stash_ref || stash.selector == stash_ref)
            .cloned()
        {
            return Ok(Some(stash));
        }
    }
    Ok(None)
}

fn list_stashes(runner: &GitRunner, root: &Path) -> AppResult<Vec<StashEntry>> {
    Ok(crate::stash_impl::list_stashes(
        runner,
        RepositoryPathRequest {
            repository_path: display_path(root),
        },
    )?
    .stashes)
}

fn write_review_marker(
    config: Option<&ConfigActor>,
    root: &Path,
    auto_stash: Option<&StashEntry>,
    operation_id: &OperationId,
) -> AppResult<()> {
    let Some(config) = config else {
        return Ok(());
    };
    let entered_at = unix_now_seconds().to_string();
    config
        .update_project(display_path(root), |project| {
            project.review_mode_crash = Some(ReviewModeCrashMarker {
                auto_stash_ref: auto_stash.map(|stash| stash.oid.clone()),
                entered_at: Some(entered_at),
                operation_id: Some(operation_id.as_str().to_owned()),
            });
        })
        .map(|_| ())
        .map_err(|source| config_error(source, "startReviewMode"))
}

fn read_review_marker(
    config: Option<&ConfigActor>,
    root: &Path,
) -> AppResult<Option<ReviewModeCrashMarker>> {
    let Some(config) = config else {
        return Ok(None);
    };
    config
        .store()
        .project(&display_path(root))
        .map(|project| project.and_then(|project| project.review_mode_crash))
        .map_err(|source| config_error(source, "reviewModeRecovery"))
}

fn clear_review_marker(config: Option<&ConfigActor>, root: &Path) -> AppResult<()> {
    let Some(config) = config else {
        return Ok(());
    };
    config
        .update_project(display_path(root), |project| {
            project.review_mode_crash = None;
        })
        .map(|_| ())
        .map_err(|source| config_error(source, "exitReviewMode"))
}

fn ensure_clean_worktree(runner: &GitRunner, root: &Path, operation_name: &str) -> AppResult<()> {
    let output = crate::git_ops::git_stdout(
        runner,
        Some(root),
        ["status", "--porcelain=v1", "-z"],
        operation_name,
    )?;
    if output.is_empty() {
        Ok(())
    } else {
        Err(expected_repo_error(
            "存在本地更改，无法在审查模式内同步。",
            root,
            operation_name,
        ))
    }
}

fn upstream_branch(runner: &GitRunner, root: &Path) -> AppResult<Option<String>> {
    let (_plan, output) = run_git_raw(
        runner,
        Some(root),
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        REVIEW_OPERATION,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else {
        Ok(None)
    }
}

fn ahead_behind(runner: &GitRunner, root: &Path, left: &str, right: &str) -> AppResult<(u32, u32)> {
    let spec = format!("{left}...{right}");
    let output = crate::git_ops::git_stdout(
        runner,
        Some(root),
        ["rev-list", "--left-right", "--count", spec.as_str()],
        REVIEW_OPERATION,
    )?;
    let mut parts = output.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok((ahead, behind))
}

fn rev_parse(runner: &GitRunner, root: &Path, rev: &str) -> AppResult<String> {
    crate::git_ops::git_stdout(runner, Some(root), ["rev-parse", rev], REVIEW_OPERATION)
        .map(|value| value.trim().to_owned())
}

fn run_raw_status<I, S>(runner: &GitRunner, root: &Path, args: I) -> Result<(), RawGitFailure>
where
    I: IntoIterator<Item = S>,
    S: Into<std::ffi::OsString>,
{
    let (plan, output) =
        run_git_raw(runner, Some(root), args, REVIEW_OPERATION).map_err(|error| RawGitFailure {
            summary: error.summary,
            network: false,
        })?;
    if output.status.success() {
        Ok(())
    } else {
        let summary =
            first_error_line(&output).unwrap_or_else(|| "Git operation failed".to_owned());
        let network = is_network_error(&output);
        crate::log_app_error(&command_failure(&plan, output, summary.clone()));
        Err(RawGitFailure { summary, network })
    }
}

fn is_network_error(output: &Output) -> bool {
    let text = combined_output(output).to_ascii_lowercase();
    [
        "could not resolve host",
        "could not resolve hostname",
        "failed to connect",
        "connection timed out",
        "network is unreachable",
        "could not read from remote repository",
        "the remote end hung up",
        "connection reset",
        "ssl",
        "tls",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn first_error_line(output: &Output) -> Option<String> {
    let text = combined_output(output);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn combined_output(output: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn review_operation_id() -> OperationId {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    OperationId(format!("review-mode-{millis}"))
}

fn unix_now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn expected_repo_error(summary: impl Into<String>, root: &Path, operation_name: &str) -> AppError {
    crate::logged_app_error(AppError::expected(summary, operation_name).with_context(
        OperationContext::new(operation_name).with_repository_path(display_path(root)),
    ))
}

fn command_failure(plan: &GitCommandPlan, output: Output, summary: impl Into<String>) -> AppError {
    crate::logged_app_error(
        AppError::expected(summary, REVIEW_OPERATION)
            .with_context(OperationContext::new(REVIEW_OPERATION))
            .with_git(artistic_git_contracts::GitCommandError {
                command: plan.command_for_error(),
                exit_code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }),
    )
}

fn config_error(
    source: artistic_git_core::config::ConfigStoreError,
    operation_name: &str,
) -> AppError {
    crate::logged_app_error(AppError::unexpected(
        format!("failed to update review mode project state: {source}"),
        operation_name,
    ))
}

struct PullOutcome {
    status: ReviewModePullStatus,
    message: Option<String>,
}

impl PullOutcome {
    fn new(status: ReviewModePullStatus, message: Option<String>) -> Self {
        Self { status, message }
    }
}

struct RawGitFailure {
    summary: String,
    network: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_core::config::{ConfigActor, ConfigPaths};
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
    use std::{fs, path::PathBuf};

    #[test]
    fn review_mode_stashes_pulls_and_restores_local_changes() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let config = test_config();
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("local.txt", "local draft\n");
        fixture.peer.write("remote.txt", "remote\n");
        fixture.peer.git(["add", "remote.txt"]);
        fixture.peer.git(["commit", "-m", "remote change"]);
        fixture.peer.git(["push"]);

        let start = start_review_mode(
            &runner,
            Some(&config),
            StartReviewModeRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect("start review mode");

        assert_eq!(start.state.pull_status, ReviewModePullStatus::Pulled);
        assert!(fixture.local.path.join("remote.txt").exists());
        assert!(!fixture.local.path.join("local.txt").exists());
        assert!(start.state.auto_stash.is_some());

        let exit = exit_review_mode(
            &runner,
            Some(&config),
            ReviewModeRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect("exit review mode");

        assert_eq!(exit.status, ReviewModeExitStatus::Applied);
        assert_eq!(fixture.local.read("local.txt"), "local draft\n");
        assert!(fixture.local.stashes().is_empty());
        assert!(
            !review_mode_recovery(
                &runner,
                Some(&config),
                ReviewModeRecoveryRequest {
                    repository_path: display_path(&fixture.local.path),
                    operation_id: None,
                },
            )
            .expect("recovery")
            .should_prompt
        );
    }

    #[test]
    fn review_mode_skips_pull_without_remote() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner, "ag-review-no-remote");
        repo.git(["init", "-b", "main"]);
        repo.git(["config", "user.name", "Test User"]);
        repo.git(["config", "user.email", "test@example.com"]);
        repo.write("tracked.txt", "tracked\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "initial"]);

        let response = start_review_mode(
            &runner,
            None,
            StartReviewModeRequest {
                repository_path: display_path(&repo.path),
                operation_id: None,
            },
        )
        .expect("start review mode");

        assert_eq!(response.state.pull_status, ReviewModePullStatus::NoRemote);
        assert!(response.state.auto_stash.is_none());
    }

    #[test]
    fn review_mode_recovery_detects_marker_with_stash() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let config = test_config();
        let repo = TestRepo::new(&runner, "ag-review-recovery");
        repo.git(["init", "-b", "main"]);
        repo.git(["config", "user.name", "Test User"]);
        repo.git(["config", "user.email", "test@example.com"]);
        repo.write("tracked.txt", "tracked\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "initial"]);
        repo.write("tracked.txt", "draft\n");

        let start = start_review_mode(
            &runner,
            Some(&config),
            StartReviewModeRequest {
                repository_path: display_path(&repo.path),
                operation_id: None,
            },
        )
        .expect("start review mode");
        assert!(start.state.auto_stash.is_some());

        let recovery = review_mode_recovery(
            &runner,
            Some(&config),
            ReviewModeRecoveryRequest {
                repository_path: display_path(&repo.path),
                operation_id: None,
            },
        )
        .expect("recovery status");

        assert!(recovery.should_prompt);
        assert_eq!(
            recovery
                .auto_stash
                .as_ref()
                .map(|stash| stash.message.as_str()),
            Some("Auto Stash: review mode")
        );
    }

    fn test_config() -> ConfigActor {
        let temp = TestTempDir::new("ag-review-config").expect("temp config");
        let paths = ConfigPaths::new(
            temp.path().join("settings.json"),
            temp.path().join("projects.json"),
        );
        let config = ConfigActor::load(paths).expect("config");
        std::mem::forget(temp);
        config
    }

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => {
                eprintln!("skipping review mode test: ARTISTIC_GIT_DIST_DIR is not set");
                return None;
            }
            Err(error) => panic!("failed to load git dist: {error}"),
        };
        let home = TestTempDir::new("ag-review-runner-home").expect("temp home");
        let distribution =
            GitDistribution::from_manifest(dist.root, dist.manifest).expect("git distribution");
        Some((
            GitRunner::from_distribution(distribution, home.path()),
            home,
        ))
    }

    struct TestRepo<'a> {
        runner: &'a GitRunner,
        _temp: TestTempDir,
        path: PathBuf,
    }

    impl<'a> TestRepo<'a> {
        fn new(runner: &'a GitRunner, prefix: &str) -> Self {
            let temp = TestTempDir::new(prefix).expect("temp repo");
            let path = temp.path().to_path_buf();
            Self {
                runner,
                _temp: temp,
                path,
            }
        }

        fn git<I, S>(&self, args: I)
        where
            I: IntoIterator<Item = S>,
            S: Into<std::ffi::OsString>,
        {
            let (plan, output) =
                run_git_raw(self.runner, Some(&self.path), args, "test").expect("run git");
            assert!(
                output.status.success(),
                "git failed: {:?}\n{}",
                plan.command_for_error(),
                String::from_utf8_lossy(&output.stderr)
            );
        }

        fn git_output<I, S>(&self, args: I) -> String
        where
            I: IntoIterator<Item = S>,
            S: Into<std::ffi::OsString>,
        {
            let (_plan, output) =
                run_git_raw(self.runner, Some(&self.path), args, "test").expect("run git");
            assert!(output.status.success());
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        fn write(&self, relative: &str, content: &str) {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            fs::write(path, content).expect("write file");
        }

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.path.join(relative)).expect("read file")
        }

        fn stashes(&self) -> Vec<String> {
            self.git_output(["stash", "list"])
                .lines()
                .map(str::to_owned)
                .collect()
        }
    }

    struct DoubleClone<'a> {
        _remote: TestTempDir,
        local: TestRepo<'a>,
        peer: TestRepo<'a>,
    }

    impl<'a> DoubleClone<'a> {
        fn new(runner: &'a GitRunner) -> Self {
            let remote = TestTempDir::new("ag-review-remote").expect("remote");
            run_git_raw(
                runner,
                None,
                [
                    "init",
                    "--bare",
                    "-b",
                    "main",
                    remote.path().to_str().unwrap(),
                ],
                "test",
            )
            .expect("init remote");
            let parent = TestTempDir::new("ag-review-clones").expect("parent");
            let local_path = parent.path().join("local");
            let peer_path = parent.path().join("peer");
            run_git_raw(
                runner,
                None,
                [
                    "clone",
                    remote.path().to_str().unwrap(),
                    local_path.to_str().unwrap(),
                ],
                "test",
            )
            .expect("clone local");
            run_git_raw(
                runner,
                None,
                [
                    "clone",
                    remote.path().to_str().unwrap(),
                    peer_path.to_str().unwrap(),
                ],
                "test",
            )
            .expect("clone peer");
            let local = TestRepo {
                runner,
                _temp: parent,
                path: local_path,
            };
            let peer = TestRepo {
                runner,
                _temp: TestTempDir::new("ag-review-peer-holder").expect("peer holder"),
                path: peer_path,
            };
            local.git(["checkout", "-b", "main"]);
            local.git(["config", "user.name", "Test User"]);
            local.git(["config", "user.email", "test@example.com"]);
            local.write("README.md", "initial\n");
            local.git(["add", "."]);
            local.git(["commit", "-m", "initial"]);
            local.git(["push", "-u", "origin", "main"]);
            peer.git(["fetch", "origin"]);
            peer.git(["checkout", "-b", "main", "origin/main"]);
            peer.git(["config", "user.name", "Test User"]);
            peer.git(["config", "user.email", "test@example.com"]);

            Self {
                _remote: remote,
                local,
                peer,
            }
        }
    }
}
