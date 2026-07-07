use crate::git_ops::{canonical_repository_path, git_stdout, run_git, run_git_raw};
use artistic_git_contracts::{
    AbortRevertRequest, AbortRevertResponse, AppError, AppResult, ConflictFile,
    ConflictResolutionStatus, DiffFileKind, OperationId, RevertCommitRequest, RevertCommitResponse,
    RevertDisabledReason,
};
use artistic_git_git_runner::GitRunner;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const OPERATION: &str = "revertCommit";

pub fn revert_commit(
    runner: &GitRunner,
    request: RevertCommitRequest,
) -> AppResult<RevertCommitResponse> {
    let root = canonical_repository_path(&request.repository_path, OPERATION)?;
    let oid = validate_commit_oid(&request.oid)?;
    let git_common_dir = git_common_dir(runner, &root, OPERATION)?;

    if operation_in_progress(&git_common_dir) {
        return Ok(RevertCommitResponse::Disabled {
            reason: RevertDisabledReason::OperationInProgress,
        });
    }

    match head_state(runner, &root)? {
        HeadState::Branch => {}
        HeadState::Detached => {
            return Ok(RevertCommitResponse::Disabled {
                reason: RevertDisabledReason::DetachedHead,
            });
        }
        HeadState::Unborn => {
            return Ok(RevertCommitResponse::Disabled {
                reason: RevertDisabledReason::UnbornHead,
            });
        }
    }

    let parents = commit_parents(runner, &root, oid)?;
    if parents.len() > 1 {
        return Ok(RevertCommitResponse::Disabled {
            reason: RevertDisabledReason::MergeCommit,
        });
    }

    if !is_on_current_branch(runner, &root, oid)? {
        return Ok(RevertCommitResponse::Disabled {
            reason: RevertDisabledReason::NotOnCurrentBranch,
        });
    }

    let subject = commit_subject(runner, &root, oid)?;
    match run_revert_no_commit(runner, &root, oid) {
        Ok(()) => {}
        Err(error) if has_revert_conflict(&error, &git_common_dir) => {
            let files = conflict_files(runner, &root)?;
            return Ok(RevertCommitResponse::Conflicted {
                operation_id: OperationId(operation_id()),
                files,
            });
        }
        Err(error) => return Err(error),
    }

    let message = format!("Revert: {subject}");
    git_commit_revert(runner, &root, &message)?;
    let revert_oid = git_stdout(runner, Some(&root), ["rev-parse", "HEAD"], OPERATION)?
        .trim()
        .to_owned();

    Ok(RevertCommitResponse::Reverted {
        oid: revert_oid,
        message,
    })
}

pub fn abort_revert(
    runner: &GitRunner,
    request: AbortRevertRequest,
) -> AppResult<AbortRevertResponse> {
    let root = canonical_repository_path(&request.repository_path, "abortRevert")?;
    let git_common_dir = git_common_dir(runner, &root, "abortRevert")?;
    if !git_common_dir.join("REVERT_HEAD").exists() {
        return Ok(AbortRevertResponse { aborted: false });
    }

    run_git(runner, Some(&root), ["revert", "--abort"], "abortRevert")?;
    Ok(AbortRevertResponse { aborted: true })
}

fn validate_commit_oid(oid: &str) -> AppResult<&str> {
    let trimmed = oid.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.chars().any(char::is_whitespace) {
        return Err(logged(AppError::expected(
            "invalid commit identifier",
            OPERATION,
        )));
    }
    Ok(trimmed)
}

fn git_common_dir(runner: &GitRunner, root: &Path, operation_name: &str) -> AppResult<PathBuf> {
    let output = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--git-common-dir"],
        operation_name,
    )?;
    let path = PathBuf::from(output.trim());
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

fn operation_in_progress(git_common_dir: &Path) -> bool {
    [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ]
    .iter()
    .any(|path| git_common_dir.join(path).exists())
}

fn head_state(runner: &GitRunner, root: &Path) -> AppResult<HeadState> {
    if git_stdout(
        runner,
        Some(root),
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        OPERATION,
    )
    .is_ok()
    {
        return Ok(HeadState::Branch);
    }

    Ok(
        if git_stdout(
            runner,
            Some(root),
            ["rev-parse", "--verify", "HEAD"],
            OPERATION,
        )
        .is_ok()
        {
            HeadState::Detached
        } else {
            HeadState::Unborn
        },
    )
}

fn commit_parents(runner: &GitRunner, root: &Path, oid: &str) -> AppResult<Vec<String>> {
    let output = git_stdout(
        runner,
        Some(root),
        ["show", "-s", "--format=%P", oid],
        OPERATION,
    )?;
    Ok(output
        .split_whitespace()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect())
}

fn commit_subject(runner: &GitRunner, root: &Path, oid: &str) -> AppResult<String> {
    Ok(git_stdout(
        runner,
        Some(root),
        ["show", "-s", "--format=%s", oid],
        OPERATION,
    )?
    .trim()
    .to_owned())
}

fn is_on_current_branch(runner: &GitRunner, root: &Path, oid: &str) -> AppResult<bool> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["merge-base", "--is-ancestor", oid, "HEAD"],
        OPERATION,
    )?;
    if output.status.success() {
        return Ok(true);
    }
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    Err(crate::git_ops::command_failure(&plan, output, OPERATION))
}

fn run_revert_no_commit(runner: &GitRunner, root: &Path, oid: &str) -> AppResult<()> {
    let args = [
        OsString::from("revert"),
        OsString::from("--no-commit"),
        OsString::from("--no-edit"),
        OsString::from(oid),
    ];
    let (plan, output) = run_git_raw(runner, Some(root), args, OPERATION)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(crate::git_ops::command_failure(&plan, output, OPERATION))
    }
}

fn git_commit_revert(runner: &GitRunner, root: &Path, message: &str) -> AppResult<()> {
    let args = [
        OsString::from("commit"),
        OsString::from("-m"),
        OsString::from(message),
    ];
    run_git(runner, Some(root), args, OPERATION).map(|_| ())
}

fn has_revert_conflict(error: &AppError, git_common_dir: &Path) -> bool {
    if git_common_dir.join("REVERT_HEAD").exists() {
        return true;
    }

    error
        .git
        .as_ref()
        .map(|git| {
            let stderr = git.stderr.to_ascii_lowercase();
            stderr.contains("conflict") || stderr.contains("after resolving the conflicts")
        })
        .unwrap_or(false)
}

fn conflict_files(runner: &GitRunner, root: &Path) -> AppResult<Vec<ConflictFile>> {
    let output = git_stdout(
        runner,
        Some(root),
        ["diff", "--name-only", "--diff-filter=U"],
        OPERATION,
    )?;

    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|path| ConflictFile {
            path: path.to_owned(),
            status: ConflictResolutionStatus::Unresolved,
            file_kind: DiffFileKind::Text,
        })
        .collect())
}

fn operation_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("revert-{}-{now}", std::process::id())
}

fn logged(error: AppError) -> AppError {
    crate::logged_app_error(error)
}

enum HeadState {
    Branch,
    Detached,
    Unborn,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ops::display_path;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
    use std::{ffi::OsString, fs, io::Write};

    #[test]
    fn revert_creates_new_commit_with_phase_message() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "two\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "second"]);
        let target = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&repo.path),
                oid: target,
            },
        )
        .expect("revert commit");

        match response {
            RevertCommitResponse::Reverted { message, .. } => {
                assert_eq!(message, "Revert: second");
            }
            other => panic!("unexpected response: {other:?}"),
        }
        assert_eq!(
            repo.git_output(["log", "-1", "--format=%s"]).trim(),
            "Revert: second"
        );
    }

    #[test]
    fn revert_disables_merge_commits() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["checkout", "-b", "feature"]);
        repo.write("feature.txt", "feature\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "feature"]);
        repo.git(["checkout", "master"]);
        repo.write("main.txt", "main\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "main"]);
        repo.git(["merge", "--no-ff", "feature", "-m", "merge feature"]);
        let merge_oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&repo.path),
                oid: merge_oid,
            },
        )
        .expect("merge disabled");

        assert!(matches!(
            response,
            RevertCommitResponse::Disabled {
                reason: RevertDisabledReason::MergeCommit
            }
        ));
    }

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => return None,
            Err(error) => panic!("invalid embedded git distribution: {error}"),
        };
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-revert-runner-home").expect("temp home");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        Some((runner, temp))
    }

    struct TestRepo {
        path: PathBuf,
        _temp: TestTempDir,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-revert-repo").expect("temp repo");
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
            self.git_output(args);
        }

        fn git_output<I, S>(&self, args: I) -> String
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            git_stdout(&self.runner, Some(&self.path), args, "test").expect("git command")
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
