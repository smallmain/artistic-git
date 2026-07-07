use artistic_git_contracts::{
    AppError, AppResult, GitCommandError, OperationContext, SyncCurrentBranchRequest,
    SyncCurrentBranchResponse, SyncCurrentBranchStatus,
};
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use std::{ffi::OsString, path::Path, process::Output, thread, time::Duration};

use crate::git_ops::{canonical_repository_path, display_path, run_git_raw};

const SYNC_OPERATION: &str = "syncCurrentBranch";
const MAX_SYNC_ATTEMPTS: u8 = 3;

pub fn sync_current_branch(
    runner: &GitRunner,
    request: SyncCurrentBranchRequest,
) -> AppResult<SyncCurrentBranchResponse> {
    let root = canonical_repository_path(&request.repository_path, SYNC_OPERATION)?;
    ensure_clean_worktree(runner, &root)?;
    ensure_committed_head(runner, &root)?;
    ensure_origin(runner, &root)?;

    let branch_name = crate::repository::current_branch_name(runner, &root, SYNC_OPERATION)?;
    let starting_head = rev_parse(runner, &root, "HEAD")?;
    let mut last_non_fast_forward = false;

    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        run_retryable_git(
            runner,
            &root,
            ["fetch", "origin", "--prune"],
            SYNC_OPERATION,
        )?;
        ensure_clean_worktree(runner, &root)?;

        let Some(upstream) = upstream_branch(runner, &root)? else {
            push_with_retry(
                runner,
                &root,
                ["push", "-u", "origin", branch_name.as_str()],
            )?;
            return Ok(response(
                &root,
                &branch_name,
                None,
                SyncCurrentBranchStatus::Published,
                attempt,
            ));
        };

        if !upstream.starts_with("origin/") {
            return Err(expected_repo_error(
                "当前分支的上游不属于 origin，无法由 Artistic Git 同步。",
                &root,
            ));
        }

        let before_push = sync_local_to_upstream(runner, &root, &upstream)?;
        let (ahead, _) = ahead_behind(runner, &root, "HEAD", upstream.as_str())?;
        if ahead == 0 {
            return Ok(response(
                &root,
                &branch_name,
                Some(upstream),
                if before_push.pulled {
                    SyncCurrentBranchStatus::Pulled
                } else {
                    SyncCurrentBranchStatus::AlreadyUpToDate
                },
                attempt,
            ));
        }

        match push_with_retry_raw(runner, &root, ["push"]) {
            PushOutcome::Success => {
                let status = match (before_push.pulled, before_push.rebased) {
                    (true, _) => SyncCurrentBranchStatus::PulledAndPushed,
                    (false, _) => SyncCurrentBranchStatus::Pushed,
                };
                return Ok(response(
                    &root,
                    &branch_name,
                    Some(upstream),
                    status,
                    attempt,
                ));
            }
            PushOutcome::NonFastForward if attempt < MAX_SYNC_ATTEMPTS => {
                last_non_fast_forward = true;
                continue;
            }
            PushOutcome::NonFastForward => {
                reset_to_start(runner, &root, &starting_head);
                return Err(expected_repo_error("远程更新过于频繁，请稍后重试。", &root));
            }
            PushOutcome::Failed(error) => return Err(error),
        }
    }

    if last_non_fast_forward {
        reset_to_start(runner, &root, &starting_head);
        Err(expected_repo_error("远程更新过于频繁，请稍后重试。", &root))
    } else {
        Err(expected_repo_error("同步失败，请稍后重试。", &root))
    }
}

#[derive(Debug, Clone, Copy)]
struct LocalSyncOutcome {
    pulled: bool,
    rebased: bool,
}

fn sync_local_to_upstream(
    runner: &GitRunner,
    root: &Path,
    upstream: &str,
) -> AppResult<LocalSyncOutcome> {
    let (ahead, behind) = ahead_behind(runner, root, "HEAD", upstream)?;
    if behind == 0 {
        return Ok(LocalSyncOutcome {
            pulled: false,
            rebased: false,
        });
    }
    if ahead == 0 {
        run_retryable_git(
            runner,
            root,
            ["merge", "--ff-only", upstream],
            SYNC_OPERATION,
        )?;
        return Ok(LocalSyncOutcome {
            pulled: true,
            rebased: false,
        });
    }

    let (plan, output) = run_git_raw(runner, Some(root), ["rebase", upstream], SYNC_OPERATION)?;
    if output.status.success() {
        return Ok(LocalSyncOutcome {
            pulled: true,
            rebased: true,
        });
    }

    let _ = run_git_raw(runner, Some(root), ["rebase", "--abort"], SYNC_OPERATION);
    Err(command_failure(
        &plan,
        output,
        "无法自动同步，存在分歧提交。",
    ))
}

fn ensure_origin(runner: &GitRunner, root: &Path) -> AppResult<()> {
    if crate::remote::read_origin_url(runner, root, SYNC_OPERATION)?.is_some() {
        Ok(())
    } else {
        Err(expected_repo_error("未配置远程仓库。", root))
    }
}

fn ensure_committed_head(runner: &GitRunner, root: &Path) -> AppResult<()> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["rev-parse", "--verify", "HEAD"],
        SYNC_OPERATION,
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_failure(
            &plan,
            output,
            "当前仓库还没有提交，无法同步。",
        ))
    }
}

fn ensure_clean_worktree(runner: &GitRunner, root: &Path) -> AppResult<()> {
    let output = crate::git_ops::git_stdout(
        runner,
        Some(root),
        ["status", "--porcelain=v1", "-z"],
        SYNC_OPERATION,
    )?;
    if output.is_empty() {
        Ok(())
    } else {
        Err(expected_repo_error(
            "存在本地更改，请先提交或储藏后再同步。",
            root,
        ))
    }
}

fn upstream_branch(runner: &GitRunner, root: &Path) -> AppResult<Option<String>> {
    let (_plan, output) = run_git_raw(
        runner,
        Some(root),
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        SYNC_OPERATION,
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
        SYNC_OPERATION,
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
    crate::git_ops::git_stdout(runner, Some(root), ["rev-parse", rev], SYNC_OPERATION)
        .map(|value| value.trim().to_owned())
}

fn reset_to_start(runner: &GitRunner, root: &Path, oid: &str) {
    let _ = run_git_raw(runner, Some(root), ["reset", "--hard", oid], SYNC_OPERATION);
}

fn run_retryable_git<I, S>(
    runner: &GitRunner,
    root: &Path,
    args: I,
    operation_name: &str,
) -> AppResult<()>
where
    I: Clone + IntoIterator<Item = S>,
    S: Clone + Into<OsString>,
{
    let mut last_error = None;
    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        let (plan, output) = run_git_raw(runner, Some(root), args.clone(), operation_name)?;
        if output.status.success() {
            return Ok(());
        }
        if !is_network_error(&output) || attempt == MAX_SYNC_ATTEMPTS {
            return Err(command_failure(&plan, output, "Git 网络操作失败。"));
        }
        last_error = Some(command_failure(&plan, output, "Git 网络操作失败。"));
        thread::sleep(Duration::from_millis(25 * u64::from(attempt)));
    }

    Err(last_error.unwrap_or_else(|| expected_repo_error("Git 网络操作失败。", root)))
}

fn push_with_retry<I, S>(runner: &GitRunner, root: &Path, args: I) -> AppResult<()>
where
    I: Clone + IntoIterator<Item = S>,
    S: Clone + Into<OsString>,
{
    match push_with_retry_raw(runner, root, args) {
        PushOutcome::Success => Ok(()),
        PushOutcome::NonFastForward => Err(expected_repo_error(
            "远程已有同名分支且包含本地没有的提交，无法直接发布。",
            root,
        )),
        PushOutcome::Failed(error) => Err(error),
    }
}

fn push_with_retry_raw<I, S>(runner: &GitRunner, root: &Path, args: I) -> PushOutcome
where
    I: Clone + IntoIterator<Item = S>,
    S: Clone + Into<OsString>,
{
    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        let result = run_git_raw(runner, Some(root), args.clone(), SYNC_OPERATION);
        let (plan, output) = match result {
            Ok(value) => value,
            Err(error) => return PushOutcome::Failed(error),
        };
        if output.status.success() {
            return PushOutcome::Success;
        }
        if is_non_fast_forward(&output) {
            return PushOutcome::NonFastForward;
        }
        if is_network_error(&output) && attempt < MAX_SYNC_ATTEMPTS {
            thread::sleep(Duration::from_millis(25 * u64::from(attempt)));
            continue;
        }
        return PushOutcome::Failed(command_failure(&plan, output, "Git 推送失败。"));
    }

    PushOutcome::Failed(expected_repo_error("Git 推送失败。", root))
}

enum PushOutcome {
    Success,
    NonFastForward,
    Failed(AppError),
}

fn is_non_fast_forward(output: &Output) -> bool {
    let text = combined_output(output).to_ascii_lowercase();
    text.contains("non-fast-forward")
        || text.contains("fetch first")
        || text.contains("rejected")
            && (text.contains("stale info") || text.contains("failed to push some refs"))
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

fn combined_output(output: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn response(
    root: &Path,
    branch_name: &str,
    upstream: Option<String>,
    status: SyncCurrentBranchStatus,
    attempts: u8,
) -> SyncCurrentBranchResponse {
    SyncCurrentBranchResponse {
        repository_path: display_path(root),
        branch_name: branch_name.to_owned(),
        upstream,
        status,
        attempts,
    }
}

fn expected_repo_error(summary: impl Into<String>, root: &Path) -> AppError {
    crate::logged_app_error(AppError::expected(summary, SYNC_OPERATION).with_context(
        OperationContext::new(SYNC_OPERATION).with_repository_path(display_path(root)),
    ))
}

fn command_failure(plan: &GitCommandPlan, output: Output, summary: impl Into<String>) -> AppError {
    crate::logged_app_error(
        AppError::expected(summary, SYNC_OPERATION)
            .with_context(OperationContext::new(SYNC_OPERATION))
            .with_git(GitCommandError {
                command: plan.command_for_error(),
                exit_code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_contracts::SyncCurrentBranchStatus;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, TestTempDir};
    use std::{fs, io::Write, path::PathBuf};

    #[test]
    fn sync_current_branch_fast_forwards_remote_changes() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.peer.write("remote.txt", "remote\n");
        fixture.peer.git(["add", "remote.txt"]);
        fixture.peer.git(["commit", "-m", "remote change"]);
        fixture.peer.git(["push"]);

        let response = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect("sync current branch");

        assert_eq!(response.status, SyncCurrentBranchStatus::Pulled);
        assert!(fixture.local.path.join("remote.txt").exists());
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn sync_current_branch_publishes_branch_without_upstream() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.git(["checkout", "-b", "feature/publish"]);
        fixture.local.write("feature.txt", "feature\n");
        fixture.local.git(["add", "feature.txt"]);
        fixture.local.git(["commit", "-m", "feature"]);

        let response = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect("publish branch");

        assert_eq!(response.status, SyncCurrentBranchStatus::Published);
        assert_eq!(
            fixture
                .local
                .git_output(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
                .trim(),
            "origin/feature/publish"
        );
        assert!(fixture
            .remote
            .git_output([
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/feature/publish"
            ])
            .contains("refs/heads/feature/publish"));
    }

    #[test]
    fn sync_current_branch_rebases_diverged_local_commits() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("local.txt", "local\n");
        fixture.local.git(["add", "local.txt"]);
        fixture.local.git(["commit", "-m", "local change"]);
        fixture.peer.write("remote.txt", "remote\n");
        fixture.peer.git(["add", "remote.txt"]);
        fixture.peer.git(["commit", "-m", "remote change"]);
        fixture.peer.git(["push"]);

        let response = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect("sync diverged branch");

        assert_eq!(response.status, SyncCurrentBranchStatus::PulledAndPushed);
        fixture.peer.git(["pull", "--ff-only"]);
        assert!(fixture.peer.path.join("local.txt").exists());
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn sync_current_branch_rejects_dirty_worktree() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("dirty.txt", "dirty\n");

        let error = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect_err("dirty tree should be rejected");

        assert!(error.summary.contains("存在本地更改"));
    }

    #[test]
    fn sync_current_branch_reports_no_remote() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner, "ag-sync-standalone");
        repo.git(["init"]);
        repo.configure_identity();
        repo.write("tracked.txt", "tracked\n");
        repo.git(["add", "tracked.txt"]);
        repo.git(["commit", "-m", "initial"]);

        let error = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&repo.path),
                operation_id: None,
            },
        )
        .expect_err("missing origin should be rejected");

        assert!(error.summary.contains("未配置远程仓库"));
    }

    struct DoubleClone {
        remote: TestRepo,
        local: TestRepo,
        peer: TestRepo,
        _parent: TestTempDir,
    }

    impl DoubleClone {
        fn new(runner: &GitRunner) -> Self {
            let parent = TestTempDir::new("ag-sync-double").expect("double clone parent");
            let remote = TestRepo::at(runner, parent.path().join("remote.git"));
            remote.git(["init", "--bare"]);

            let seed = TestRepo::at(runner, parent.path().join("seed"));
            seed.git(["init", "-b", "main"]);
            seed.configure_identity();
            seed.write("tracked.txt", "initial\n");
            seed.git(["add", "tracked.txt"]);
            seed.git(["commit", "-m", "initial"]);
            seed.git([
                "remote",
                "add",
                "origin",
                display_path(&remote.path).as_str(),
            ]);
            seed.git(["push", "-u", "origin", "main"]);

            let local = TestRepo::at(runner, parent.path().join("local"));
            local.git([
                "clone",
                display_path(&remote.path).as_str(),
                display_path(&local.path).as_str(),
            ]);
            local.configure_identity();
            let peer = TestRepo::at(runner, parent.path().join("peer"));
            peer.git([
                "clone",
                display_path(&remote.path).as_str(),
                display_path(&peer.path).as_str(),
            ]);
            peer.configure_identity();

            Self {
                remote,
                local,
                peer,
                _parent: parent,
            }
        }
    }

    struct TestRepo {
        runner: GitRunner,
        path: PathBuf,
        _temp: Option<TestTempDir>,
    }

    impl TestRepo {
        fn new(runner: &GitRunner, prefix: &str) -> Self {
            let temp = TestTempDir::new(prefix).expect("temp repo");
            Self {
                runner: runner.clone(),
                path: temp.path().to_path_buf(),
                _temp: Some(temp),
            }
        }

        fn at(runner: &GitRunner, path: PathBuf) -> Self {
            fs::create_dir_all(&path).expect("repo parent");
            Self {
                runner: runner.clone(),
                path,
                _temp: None,
            }
        }

        fn configure_identity(&self) {
            self.git(["config", "user.name", "Test User"]);
            self.git(["config", "user.email", "test@example.test"]);
        }

        fn status_clean(&self) -> bool {
            self.git_output(["status", "--porcelain=v1", "-z"])
                .is_empty()
        }

        fn git<I, S>(&self, args: I)
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            self.git_output(args);
        }

        fn git_output<I, S>(&self, args: I) -> String
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            crate::git_ops::git_stdout(&self.runner, Some(&self.path), args, "test")
                .expect("git command")
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

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(error) => {
                eprintln!("skipping real git test: {error}");
                return None;
            }
        };
        let temp = TestTempDir::new("ag-sync-runner-home").expect("temp home");
        let distribution =
            GitDistribution::from_manifest(dist.root, dist.manifest).expect("git distribution");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        Some((runner, temp))
    }
}
