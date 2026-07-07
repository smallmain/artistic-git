use crate::git_ops::{canonical_repository_path, display_path, git_stdout, run_git, run_git_raw};
use artistic_git_contracts::{
    AbortRevertRequest, AbortRevertResponse, AppError, AppResult, ConflictEnteredEvent,
    ConflictFile, ConflictResolutionStatus, CreateAutoStashRequest, DiffFileKind, OperationId,
    RevertCommitRequest, RevertCommitResponse, RevertDisabledReason, StashEntry,
    StashRecoveryPoint, StashRestoreOutcome, SyncCurrentBranchRequest,
};
use artistic_git_git_runner::GitRunner;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const OPERATION: &str = "revertCommit";
const REVERT_STASH_RESTORE_OPERATION: &str = "revertCommit:restoreStash";

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

    let has_remote = crate::remote::read_origin_url(runner, &root, OPERATION)?.is_some();
    if has_remote {
        let sync = crate::sync::sync_current_branch(
            runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&root),
                operation_id: Some(OperationId(operation_id())),
            },
        )?;
        if let Some(conflict) = sync.conflict {
            return Ok(conflicted_response(conflict, sync.stash_recovery, None));
        }
    }

    let auto_stash = create_revert_auto_stash(runner, &root)?;
    let subject = commit_subject(runner, &root, oid)?;
    match run_revert_no_commit(runner, &root, oid) {
        Ok(()) => {}
        Err(error) if has_revert_conflict(&error, &git_common_dir) => {
            let files = conflict_files(runner, &root)?;
            return Ok(conflicted_response(
                ConflictEnteredEvent {
                    operation_id: OperationId(operation_id()),
                    repository_path: display_path(&root),
                    operation_name: OPERATION.to_owned(),
                    files,
                },
                None,
                auto_stash,
            ));
        }
        Err(error) => return Err(error),
    }

    let message = format!("Revert: {subject}");
    git_commit_revert(runner, &root, &message)?;
    let revert_oid = git_stdout(runner, Some(&root), ["rev-parse", "HEAD"], OPERATION)?
        .trim()
        .to_owned();
    let mut pushed = false;
    if request.push_after_revert && has_remote {
        match push_revert_with_sync_retry(runner, &root, auto_stash.clone())? {
            RevertPushOutcome::Pushed => pushed = true,
            RevertPushOutcome::Conflicted(response) => return Ok(response),
        }
    }
    if let Some(response) = restore_revert_auto_stash_after_success(runner, &root, auto_stash)? {
        return Ok(response);
    }

    Ok(RevertCommitResponse::Reverted {
        oid: revert_oid,
        message,
        pushed,
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

fn create_revert_auto_stash(runner: &GitRunner, root: &Path) -> AppResult<Option<StashEntry>> {
    Ok(crate::stash_impl::create_auto_stash(
        runner,
        CreateAutoStashRequest {
            repository_path: display_path(root),
            reason: "before reverting commit".to_owned(),
            include_untracked: true,
            paths: Vec::new(),
        },
    )?
    .stash)
}

fn restore_revert_auto_stash_after_success(
    runner: &GitRunner,
    root: &Path,
    auto_stash: Option<StashEntry>,
) -> AppResult<Option<RevertCommitResponse>> {
    let Some(auto_stash) = auto_stash else {
        return Ok(None);
    };

    let restore = crate::stash_impl::restore_stash_for_root(
        runner,
        root,
        &auto_stash.selector,
        true,
        REVERT_STASH_RESTORE_OPERATION,
        None,
    )?;
    match restore.outcome {
        StashRestoreOutcome::Applied { .. } => Ok(None),
        StashRestoreOutcome::Conflicts { conflict } => Ok(Some(conflicted_response(
            conflict,
            Some(restore.recovery),
            None,
        ))),
    }
}

fn push_revert_with_sync_retry(
    runner: &GitRunner,
    root: &Path,
    auto_stash: Option<StashEntry>,
) -> AppResult<RevertPushOutcome> {
    match push_once(runner, root) {
        PushAttempt::Success => Ok(RevertPushOutcome::Pushed),
        PushAttempt::Failed(error) if !is_non_fast_forward_error(&error) => Err(error),
        PushAttempt::Failed(_error) => {
            let sync = crate::sync::sync_current_branch(
                runner,
                SyncCurrentBranchRequest {
                    repository_path: display_path(root),
                    operation_id: Some(OperationId(operation_id())),
                },
            )?;
            if let Some(conflict) = sync.conflict {
                return Ok(RevertPushOutcome::Conflicted(conflicted_response(
                    conflict,
                    sync.stash_recovery,
                    auto_stash,
                )));
            }
            Ok(RevertPushOutcome::Pushed)
        }
    }
}

enum RevertPushOutcome {
    Pushed,
    Conflicted(RevertCommitResponse),
}

fn push_once(runner: &GitRunner, root: &Path) -> PushAttempt {
    let (plan, output) = match run_git_raw(runner, Some(root), ["push"], OPERATION) {
        Ok(value) => value,
        Err(error) => return PushAttempt::Failed(error),
    };
    if output.status.success() {
        PushAttempt::Success
    } else {
        PushAttempt::Failed(crate::git_ops::command_failure(&plan, output, OPERATION))
    }
}

enum PushAttempt {
    Success,
    Failed(AppError),
}

fn is_non_fast_forward_error(error: &AppError) -> bool {
    error
        .git
        .as_ref()
        .map(|git| {
            let text = format!("{}\n{}", git.stdout, git.stderr).to_ascii_lowercase();
            text.contains("non-fast-forward")
                || text.contains("fetch first")
                || text.contains("failed to push some refs")
        })
        .unwrap_or(false)
}

fn conflicted_response(
    conflict: ConflictEnteredEvent,
    stash_recovery: Option<StashRecoveryPoint>,
    auto_stash: Option<StashEntry>,
) -> RevertCommitResponse {
    RevertCommitResponse::Conflicted {
        conflict,
        stash_recovery,
        auto_stash,
    }
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
    use std::{ffi::OsString, fs, io::Write, os::unix::fs::PermissionsExt};

    #[test]
    fn revert_creates_new_commit_for_current_branch_ancestor_with_phase_message() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("target.txt", "target\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "add target artifact"]);
        let target = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.write("later.txt", "later\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "later independent work"]);
        let previous_head = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&repo.path),
                oid: target,
                push_after_revert: false,
            },
        )
        .expect("revert commit");

        match response {
            RevertCommitResponse::Reverted {
                message,
                oid,
                pushed,
            } => {
                assert_eq!(message, "Revert: add target artifact");
                assert_eq!(oid, repo.git_output(["rev-parse", "HEAD"]).trim());
                assert!(!pushed);
            }
            other => panic!("unexpected response: {other:?}"),
        }
        assert_eq!(
            repo.git_output(["log", "-1", "--format=%s"]).trim(),
            "Revert: add target artifact"
        );
        assert_eq!(
            repo.git_output(["log", "-1", "--format=%P"]).trim(),
            previous_head
        );
        assert!(!repo.path.join("target.txt").exists());
        assert_eq!(repo.read("later.txt"), "later\n");
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
                push_after_revert: false,
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

    #[test]
    fn revert_disables_commits_outside_current_branch() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["checkout", "-b", "feature"]);
        repo.write("feature.txt", "feature\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "feature only"]);
        let feature_oid = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.git(["checkout", "master"]);
        repo.write("main.txt", "main\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "main only"]);
        let original_head = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&repo.path),
                oid: feature_oid,
                push_after_revert: false,
            },
        )
        .expect("outside branch disabled");

        assert!(matches!(
            response,
            RevertCommitResponse::Disabled {
                reason: RevertDisabledReason::NotOnCurrentBranch
            }
        ));
        assert_eq!(repo.git_output(["rev-parse", "HEAD"]).trim(), original_head);
        assert_eq!(repo.git_output(["status", "--porcelain"]).trim(), "");
    }

    #[test]
    fn conflicted_revert_returns_conflict_files_and_abort_restores_original_state() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "target\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "target line"]);
        let target = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.write("tracked.txt", "later\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "later line"]);
        let original_head = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&repo.path),
                oid: target,
                push_after_revert: false,
            },
        )
        .expect("conflicted revert response");

        match response {
            RevertCommitResponse::Conflicted {
                conflict,
                stash_recovery,
                auto_stash,
            } => {
                assert!(conflict.operation_id.0.starts_with("revert-"));
                assert_eq!(conflict.operation_name, OPERATION);
                assert_eq!(conflict.repository_path, display_path(&repo.path));
                assert!(stash_recovery.is_none());
                assert!(auto_stash.is_none());
                assert_eq!(
                    conflict.files,
                    vec![ConflictFile {
                        path: "tracked.txt".to_owned(),
                        status: ConflictResolutionStatus::Unresolved,
                        file_kind: DiffFileKind::Text,
                    }]
                );
            }
            other => panic!("unexpected response: {other:?}"),
        }
        assert!(repo.read("tracked.txt").contains("<<<<<<<"));

        let abort = abort_revert(
            &runner,
            AbortRevertRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("abort conflicted revert");

        assert!(abort.aborted);
        assert_eq!(repo.git_output(["rev-parse", "HEAD"]).trim(), original_head);
        assert_eq!(repo.read("tracked.txt"), "later\n");
        assert_eq!(repo.git_output(["status", "--porcelain"]).trim(), "");
        assert!(!git_common_dir(&runner, &repo.path, "test")
            .expect("git common dir")
            .join("REVERT_HEAD")
            .exists());
    }

    #[test]
    fn revert_pushes_published_history_commit_in_double_clone() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("target.txt", "target\n");
        fixture.local.git(["add", "target.txt"]);
        fixture.local.git(["commit", "-m", "add target"]);
        let target = fixture
            .local
            .git_output(["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        fixture.local.write("later.txt", "later\n");
        fixture.local.git(["add", "later.txt"]);
        fixture.local.git(["commit", "-m", "later"]);
        fixture.local.git(["push"]);

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&fixture.local.path),
                oid: target,
                push_after_revert: true,
            },
        )
        .expect("revert and push");

        match response {
            RevertCommitResponse::Reverted {
                message, pushed, ..
            } => {
                assert_eq!(message, "Revert: add target");
                assert!(pushed);
            }
            other => panic!("unexpected response: {other:?}"),
        }
        fixture.peer.git(["pull", "--ff-only"]);
        assert!(!fixture.peer.path.join("target.txt").exists());
        assert_eq!(
            fixture.peer.git_output(["log", "-1", "--format=%s"]).trim(),
            "Revert: add target"
        );
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn revert_pushes_unpublished_commit_with_same_flow() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("target.txt", "target\n");
        fixture.local.git(["add", "target.txt"]);
        fixture.local.git(["commit", "-m", "local target"]);
        let target = fixture
            .local
            .git_output(["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        fixture.local.write("later.txt", "later\n");
        fixture.local.git(["add", "later.txt"]);
        fixture.local.git(["commit", "-m", "local later"]);

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&fixture.local.path),
                oid: target,
                push_after_revert: true,
            },
        )
        .expect("sync unpublished commits, revert, and push");

        match response {
            RevertCommitResponse::Reverted {
                message, pushed, ..
            } => {
                assert_eq!(message, "Revert: local target");
                assert!(pushed);
            }
            other => panic!("unexpected response: {other:?}"),
        }
        fixture.peer.git(["pull", "--ff-only"]);
        assert!(!fixture.peer.path.join("target.txt").exists());
        assert_eq!(fixture.peer.read("later.txt"), "later\n");
        assert_eq!(
            fixture.peer.git_output(["log", "-1", "--format=%s"]).trim(),
            "Revert: local target"
        );
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn revert_push_retries_by_syncing_after_non_fast_forward() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("target.txt", "target\n");
        fixture.local.git(["add", "target.txt"]);
        fixture.local.git(["commit", "-m", "race target"]);
        let target = fixture
            .local
            .git_output(["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        fixture.local.write("later.txt", "later\n");
        fixture.local.git(["add", "later.txt"]);
        fixture.local.git(["commit", "-m", "race later"]);
        fixture.local.git(["push"]);
        fixture.install_one_shot_push_race_hook();

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&fixture.local.path),
                oid: target,
                push_after_revert: true,
            },
        )
        .expect("revert push sync retry");

        match response {
            RevertCommitResponse::Reverted {
                message, pushed, ..
            } => {
                assert_eq!(message, "Revert: race target");
                assert!(pushed);
            }
            other => panic!("unexpected response: {other:?}"),
        }
        fixture.peer.git(["pull", "--ff-only"]);
        assert_eq!(fixture.peer.read("race.txt"), "race\n");
        assert!(!fixture.peer.path.join("target.txt").exists());
        assert_eq!(
            fixture.peer.git_output(["log", "-1", "--format=%s"]).trim(),
            "Revert: race target"
        );
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn revert_push_publishes_branch_without_upstream_via_sync() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture
            .local
            .git(["checkout", "-b", "feature/revert-publish"]);
        fixture.local.write("target.txt", "target\n");
        fixture.local.git(["add", "target.txt"]);
        fixture.local.git(["commit", "-m", "publish target"]);
        let target = fixture
            .local
            .git_output(["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        fixture.local.write("later.txt", "later\n");
        fixture.local.git(["add", "later.txt"]);
        fixture.local.git(["commit", "-m", "publish later"]);

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&fixture.local.path),
                oid: target,
                push_after_revert: true,
            },
        )
        .expect("publish branch, revert, and push");

        match response {
            RevertCommitResponse::Reverted {
                message, pushed, ..
            } => {
                assert_eq!(message, "Revert: publish target");
                assert!(pushed);
            }
            other => panic!("unexpected response: {other:?}"),
        }
        assert_eq!(
            fixture
                .local
                .git_output(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
                .trim(),
            "origin/feature/revert-publish"
        );
        assert!(fixture
            .remote
            .git_output([
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/feature/revert-publish"
            ])
            .contains("refs/heads/feature/revert-publish"));
    }

    #[test]
    fn conflicted_revert_with_auto_stash_can_abort_and_restore_local_changes() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "target\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "target line"]);
        let target = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.write("tracked.txt", "later\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "later line"]);
        let original_head = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
        repo.write("draft.txt", "local draft\n");

        let response = revert_commit(
            &runner,
            RevertCommitRequest {
                repository_path: display_path(&repo.path),
                oid: target,
                push_after_revert: false,
            },
        )
        .expect("conflicted revert response");

        let auto_stash = match response {
            RevertCommitResponse::Conflicted {
                conflict,
                auto_stash,
                ..
            } => {
                assert_eq!(conflict.operation_name, OPERATION);
                auto_stash.expect("local changes should be auto-stashed")
            }
            other => panic!("unexpected response: {other:?}"),
        };
        assert!(!repo.path.join("draft.txt").exists());
        assert!(repo.read("tracked.txt").contains("<<<<<<<"));

        let abort = abort_revert(
            &runner,
            AbortRevertRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("abort conflicted revert");
        assert!(abort.aborted);
        crate::stash_impl::restore_stash_for_root(
            &runner,
            &repo.path,
            &auto_stash.selector,
            true,
            "testRestoreRevertAutoStash",
            None,
        )
        .expect("restore revert auto stash");

        assert_eq!(repo.git_output(["rev-parse", "HEAD"]).trim(), original_head);
        assert_eq!(repo.read("tracked.txt"), "later\n");
        assert_eq!(repo.read("draft.txt"), "local draft\n");
        assert!(repo
            .git_output(["status", "--porcelain"])
            .contains("?? draft.txt"));
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
        _temp: Option<TestTempDir>,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-revert-repo").expect("temp repo");
            Self {
                path: temp.path().to_path_buf(),
                _temp: Some(temp),
                runner: runner.clone(),
            }
        }

        fn at(runner: &GitRunner, path: PathBuf) -> Self {
            Self {
                path,
                _temp: None,
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

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.path.join(relative)).expect("read file")
        }

        fn configure_identity(&self) {
            self.git(["config", "user.name", "Tester"]);
            self.git(["config", "user.email", "tester@example.test"]);
        }

        fn status_clean(&self) -> bool {
            self.git_output(["status", "--porcelain"]).trim().is_empty()
        }
    }

    struct DoubleClone {
        remote: TestRepo,
        local: TestRepo,
        peer: TestRepo,
        _parent: TestTempDir,
    }

    impl DoubleClone {
        fn new(runner: &GitRunner) -> Self {
            let parent = TestTempDir::new("ag-revert-double").expect("double clone parent");
            let remote_path = parent.path().join("remote.git");
            git_stdout(
                runner,
                None::<&Path>,
                [
                    OsString::from("init"),
                    OsString::from("--bare"),
                    remote_path.as_os_str().to_owned(),
                ],
                "test",
            )
            .expect("init bare remote");

            let seed = TestRepo::at(runner, parent.path().join("seed"));
            git_stdout(
                runner,
                None::<&Path>,
                [
                    OsString::from("init"),
                    OsString::from("-b"),
                    OsString::from("main"),
                    seed.path.as_os_str().to_owned(),
                ],
                "test",
            )
            .expect("init seed");
            seed.configure_identity();
            seed.write("tracked.txt", "initial\n");
            seed.git(["add", "tracked.txt"]);
            seed.git(["commit", "-m", "initial"]);
            seed.git([
                "remote",
                "add",
                "origin",
                display_path(&remote_path).as_str(),
            ]);
            seed.git(["push", "-u", "origin", "main"]);

            let local = TestRepo::at(runner, parent.path().join("local"));
            git_stdout(
                runner,
                None::<&Path>,
                [
                    OsString::from("clone"),
                    remote_path.as_os_str().to_owned(),
                    local.path.as_os_str().to_owned(),
                ],
                "test",
            )
            .expect("clone local");
            local.configure_identity();

            let peer = TestRepo::at(runner, parent.path().join("peer"));
            git_stdout(
                runner,
                None::<&Path>,
                [
                    OsString::from("clone"),
                    remote_path.as_os_str().to_owned(),
                    peer.path.as_os_str().to_owned(),
                ],
                "test",
            )
            .expect("clone peer");
            peer.configure_identity();

            Self {
                remote: TestRepo::at(runner, remote_path),
                local,
                peer,
                _parent: parent,
            }
        }

        fn install_one_shot_push_race_hook(&self) {
            let marker = self.local.path.join(".git").join("ag-push-race-once");
            fs::write(&marker, "race\n").expect("write race marker");
            let hook = self.local.path.join(".git").join("hooks").join("pre-push");
            let script = format!(
                r#"#!/bin/sh
set -e
marker={marker}
peer={peer}
if [ -f "$marker" ]; then
  rm "$marker"
  git -C "$peer" pull --ff-only
  printf '%s\n' race > "$peer/race.txt"
  git -C "$peer" add race.txt
  git -C "$peer" commit -m 'race change'
  git -C "$peer" push
fi
"#,
                marker = display_path(&marker),
                peer = display_path(&self.peer.path),
            );
            fs::write(&hook, script).expect("write pre-push hook");
            let mut permissions = fs::metadata(&hook).expect("hook metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&hook, permissions).expect("chmod pre-push hook");
        }
    }
}
