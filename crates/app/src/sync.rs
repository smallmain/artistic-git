use artistic_git_contracts::{
    AppError, AppResult, ConflictEnteredEvent, ConflictListRequest, CreateAutoStashRequest,
    GitCommandError, OperationContext, OperationId, StashEntry, StashRecoveryPoint,
    StashRestoreOutcome, SyncBranchRequest, SyncBranchResponse, SyncCurrentBranchRequest,
    SyncCurrentBranchResponse, SyncCurrentBranchStatus,
};
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Output,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::git_ops::{canonical_repository_path, display_path, run_git_raw};

const SYNC_OPERATION: &str = "syncCurrentBranch";
const SYNC_BRANCH_OPERATION: &str = "syncBranch";
const SYNC_STASH_RESTORE_OPERATION: &str = "syncCurrentBranch:restoreStash";
const MAX_SYNC_ATTEMPTS: u8 = 3;
const SYNC_WORKTREE_PREFIX: &str = "artistic-git-sync-";
const SYNC_WORKTREE_MARKER: &str = "artistic-git-sync-worktree.json";

pub fn sync_current_branch(
    runner: &GitRunner,
    request: SyncCurrentBranchRequest,
) -> AppResult<SyncCurrentBranchResponse> {
    let root = canonical_repository_path(&request.repository_path, SYNC_OPERATION)?;
    ensure_committed_head(runner, &root)?;
    ensure_origin(runner, &root)?;

    let branch_name = crate::repository::current_branch_name(runner, &root, SYNC_OPERATION)?;
    let starting_head = rev_parse(runner, &root, "HEAD")?;
    let operation_id = request
        .operation_id
        .clone()
        .unwrap_or_else(sync_operation_id);
    let auto_stash = create_sync_auto_stash(runner, &root)?;

    let sync_result =
        sync_current_branch_clean(runner, &root, &branch_name, &starting_head, &operation_id);
    match sync_result {
        Ok(response) if response.status == SyncCurrentBranchStatus::Conflicts => Ok(response),
        Ok(response) => {
            restore_auto_stash_after_success(runner, &root, response, auto_stash, &operation_id)
        }
        Err(error) => Err(error),
    }
}

pub fn sync_branch(
    runner: &GitRunner,
    request: SyncBranchRequest,
) -> AppResult<SyncBranchResponse> {
    let root = canonical_repository_path(&request.repository_path, SYNC_BRANCH_OPERATION)?;
    ensure_committed_head(runner, &root)?;
    ensure_origin(runner, &root)?;
    let branch_name = validate_sync_branch_name(runner, &root, &request.branch_name)?;
    let operation_id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| sync_branch_operation_id(&branch_name));

    if current_branch_name(runner, &root)?.as_deref() == Some(branch_name.as_str()) {
        return sync_current_branch(
            runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&root),
                operation_id: Some(operation_id),
            },
        )
        .map(sync_branch_response_from_current);
    }

    ensure_local_branch(runner, &root, &branch_name)?;
    cleanup_sync_worktree_residue(runner, &root);

    match sync_branch_fast_path(runner, &root, &branch_name)? {
        FastPathOutcome::Synced(response) => Ok(response),
        FastPathOutcome::NeedsWorktree => {
            sync_branch_via_worktree(runner, &root, &branch_name, &operation_id)
        }
    }
}

fn sync_current_branch_clean(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    starting_head: &str,
    operation_id: &OperationId,
) -> AppResult<SyncCurrentBranchResponse> {
    let mut last_non_fast_forward = false;

    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        run_retryable_git(runner, root, ["fetch", "origin", "--prune"], SYNC_OPERATION)?;
        ensure_clean_worktree(runner, root)?;

        let Some(upstream) = upstream_branch(runner, root)? else {
            push_with_retry(runner, root, ["push", "-u", "origin", branch_name])?;
            return Ok(response(
                root,
                branch_name,
                None,
                SyncCurrentBranchStatus::Published,
                attempt,
            ));
        };

        if !upstream.starts_with("origin/") {
            return Err(expected_repo_error(
                "当前分支的上游不属于 origin，无法由 Artistic Git 同步。",
                root,
            ));
        }

        let before_push = sync_local_to_upstream(runner, root, &upstream, operation_id)?;
        if let Some(conflict) = before_push.conflict {
            return Ok(conflict_response(
                root,
                branch_name,
                Some(upstream),
                attempt,
                conflict,
                None,
            ));
        }
        let (ahead, _) = ahead_behind(runner, root, "HEAD", upstream.as_str())?;
        if ahead == 0 {
            return Ok(response(
                root,
                branch_name,
                Some(upstream),
                if before_push.pulled {
                    SyncCurrentBranchStatus::Pulled
                } else {
                    SyncCurrentBranchStatus::AlreadyUpToDate
                },
                attempt,
            ));
        }

        match push_with_retry_raw(runner, root, ["push"]) {
            PushOutcome::Success => {
                let status = match (before_push.pulled, before_push.rebased) {
                    (true, _) => SyncCurrentBranchStatus::PulledAndPushed,
                    (false, _) => SyncCurrentBranchStatus::Pushed,
                };
                return Ok(response(root, branch_name, Some(upstream), status, attempt));
            }
            PushOutcome::NonFastForward if attempt < MAX_SYNC_ATTEMPTS => {
                last_non_fast_forward = true;
                continue;
            }
            PushOutcome::NonFastForward => {
                reset_to_start(runner, root, starting_head);
                return Err(expected_repo_error("远程更新过于频繁，请稍后重试。", root));
            }
            PushOutcome::Failed(error) => return Err(error),
        }
    }

    if last_non_fast_forward {
        reset_to_start(runner, root, starting_head);
        Err(expected_repo_error("远程更新过于频繁，请稍后重试。", root))
    } else {
        Err(expected_repo_error("同步失败，请稍后重试。", root))
    }
}

enum FastPathOutcome {
    Synced(SyncBranchResponse),
    NeedsWorktree,
}

fn sync_branch_fast_path(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
) -> AppResult<FastPathOutcome> {
    let before_oid = rev_parse(runner, root, branch_name)?;
    let refspec = format!("{branch_name}:{branch_name}");
    let fetch_outcome = fetch_branch_ref_fast_forward(runner, root, &refspec)?;
    if !fetch_outcome {
        let remote_oid = remote_branch_oid(runner, root, branch_name)?;
        if remote_oid
            .as_deref()
            .map(|oid| is_ancestor(runner, root, oid, &before_oid).unwrap_or(false))
            .unwrap_or(false)
        {
            match push_with_retry_raw(
                runner,
                root,
                [
                    OsString::from("push"),
                    OsString::from("origin"),
                    OsString::from(refspec.as_str()),
                ],
            ) {
                PushOutcome::Success => {
                    return Ok(FastPathOutcome::Synced(SyncBranchResponse {
                        repository_path: display_path(root),
                        branch_name: branch_name.to_owned(),
                        upstream: Some(format!("origin/{branch_name}")),
                        status: SyncCurrentBranchStatus::Pushed,
                        attempts: 1,
                        conflict: None,
                        stash_recovery: None,
                    }));
                }
                PushOutcome::NonFastForward => {}
                PushOutcome::Failed(error) => return Err(error),
            }
        }
        return Ok(FastPathOutcome::NeedsWorktree);
    }

    let after_oid = rev_parse(runner, root, branch_name)?;
    let remote_oid = remote_branch_oid(runner, root, branch_name)?;
    let needs_push = remote_oid
        .as_ref()
        .map(|oid| oid != &after_oid)
        .unwrap_or(true);

    if needs_push {
        match push_with_retry_raw(
            runner,
            root,
            [
                OsString::from("push"),
                OsString::from("origin"),
                OsString::from(refspec.as_str()),
            ],
        ) {
            PushOutcome::Success => {}
            PushOutcome::NonFastForward => return Ok(FastPathOutcome::NeedsWorktree),
            PushOutcome::Failed(error) => return Err(error),
        }
    }

    let pulled = before_oid != after_oid;
    let status = match (pulled, needs_push) {
        (true, true) => SyncCurrentBranchStatus::PulledAndPushed,
        (true, false) => SyncCurrentBranchStatus::Pulled,
        (false, true) => SyncCurrentBranchStatus::Pushed,
        (false, false) => SyncCurrentBranchStatus::AlreadyUpToDate,
    };

    Ok(FastPathOutcome::Synced(SyncBranchResponse {
        repository_path: display_path(root),
        branch_name: branch_name.to_owned(),
        upstream: Some(format!("origin/{branch_name}")),
        status,
        attempts: 1,
        conflict: None,
        stash_recovery: None,
    }))
}

fn fetch_branch_ref_fast_forward(
    runner: &GitRunner,
    root: &Path,
    refspec: &str,
) -> AppResult<bool> {
    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        let (plan, output) = run_git_raw(
            runner,
            Some(root),
            [
                OsString::from("fetch"),
                OsString::from("origin"),
                OsString::from(refspec),
            ],
            SYNC_BRANCH_OPERATION,
        )?;
        if output.status.success() {
            return Ok(true);
        }
        if is_fast_forward_fetch_rejection(&output) {
            return Ok(false);
        }
        if is_network_error(&output) && attempt < MAX_SYNC_ATTEMPTS {
            thread::sleep(retry_delay(attempt));
            continue;
        }
        return Err(command_failure(&plan, output, "Git 拉取失败。"));
    }

    Err(expected_repo_error("Git 拉取失败。", root))
}

fn sync_branch_via_worktree(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    operation_id: &OperationId,
) -> AppResult<SyncBranchResponse> {
    let worktree = create_sync_worktree(runner, root, branch_name, operation_id)?;
    let starting_head = rev_parse(runner, &worktree, "HEAD")?;
    let sync_result =
        sync_current_branch_clean(runner, &worktree, branch_name, &starting_head, operation_id);

    match sync_result {
        Ok(response) if response.status == SyncCurrentBranchStatus::Conflicts => {
            Ok(sync_branch_response_from_worktree(root, response))
        }
        Ok(response) => {
            let converted = sync_branch_response_from_worktree(root, response);
            cleanup_sync_worktree_path(runner, &worktree)?;
            Ok(converted)
        }
        Err(error) => {
            let cleanup = cleanup_sync_worktree_path(runner, &worktree);
            if cleanup.is_err() {
                return cleanup.map(|_| unreachable!());
            }
            Err(error)
        }
    }
}

#[derive(Debug, Clone)]
struct LocalSyncOutcome {
    pulled: bool,
    rebased: bool,
    conflict: Option<ConflictEnteredEvent>,
}

fn sync_local_to_upstream(
    runner: &GitRunner,
    root: &Path,
    upstream: &str,
    operation_id: &OperationId,
) -> AppResult<LocalSyncOutcome> {
    let (ahead, behind) = ahead_behind(runner, root, "HEAD", upstream)?;
    if behind == 0 {
        return Ok(LocalSyncOutcome {
            pulled: false,
            rebased: false,
            conflict: None,
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
            conflict: None,
        });
    }

    let (plan, output) = run_git_raw(runner, Some(root), ["rebase", upstream], SYNC_OPERATION)?;
    if output.status.success() {
        return Ok(LocalSyncOutcome {
            pulled: true,
            rebased: true,
            conflict: None,
        });
    }

    if has_conflicts(runner, root)? {
        return Ok(LocalSyncOutcome {
            pulled: true,
            rebased: true,
            conflict: Some(conflict_event(runner, root, operation_id)?),
        });
    }

    let _ = run_git_raw(runner, Some(root), ["rebase", "--abort"], SYNC_OPERATION);
    Err(command_failure(
        &plan,
        output,
        "无法自动同步，存在分歧提交。",
    ))
}

fn validate_sync_branch_name(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
) -> AppResult<String> {
    let trimmed = branch_name.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(expected_repo_error("不是有效的分支名称。", root));
    }

    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["check-ref-format", "--branch", trimmed],
        SYNC_BRANCH_OPERATION,
    )?;
    if output.status.success() {
        Ok(trimmed.to_owned())
    } else {
        Err(command_failure(&plan, output, "不是有效的分支名称。"))
    }
}

fn ensure_local_branch(runner: &GitRunner, root: &Path, branch_name: &str) -> AppResult<()> {
    let rev = format!("refs/heads/{branch_name}^{{commit}}");
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["rev-parse", "--verify", rev.as_str()],
        SYNC_BRANCH_OPERATION,
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_failure(&plan, output, "本地分支不存在，无法同步。"))
    }
}

fn current_branch_name(runner: &GitRunner, root: &Path) -> AppResult<Option<String>> {
    let (_plan, output) = run_git_raw(
        runner,
        Some(root),
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        SYNC_BRANCH_OPERATION,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else {
        Ok(None)
    }
}

fn remote_branch_oid(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
) -> AppResult<Option<String>> {
    let remote_ref = format!("refs/heads/{branch_name}");
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["ls-remote", "--heads", "origin", remote_ref.as_str()],
        SYNC_BRANCH_OPERATION,
    )?;
    if !output.status.success() {
        return Err(command_failure(&plan, output, "无法读取远程分支状态。"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .map(str::to_owned))
}

fn is_ancestor(
    runner: &GitRunner,
    root: &Path,
    ancestor: &str,
    descendant: &str,
) -> AppResult<bool> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["merge-base", "--is-ancestor", ancestor, descendant],
        SYNC_BRANCH_OPERATION,
    )?;
    if output.status.success() {
        Ok(true)
    } else if output.status.code() == Some(1) {
        Ok(false)
    } else {
        Err(command_failure(&plan, output, "无法判断分支分叉状态。"))
    }
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

fn create_sync_auto_stash(runner: &GitRunner, root: &Path) -> AppResult<Option<StashEntry>> {
    Ok(crate::stash_impl::create_auto_stash(
        runner,
        CreateAutoStashRequest {
            repository_path: display_path(root),
            reason: "before syncing current branch".to_owned(),
            include_untracked: true,
            paths: Vec::new(),
        },
    )?
    .stash)
}

fn restore_auto_stash_after_success(
    runner: &GitRunner,
    root: &Path,
    mut response: SyncCurrentBranchResponse,
    auto_stash: Option<StashEntry>,
    operation_id: &OperationId,
) -> AppResult<SyncCurrentBranchResponse> {
    let Some(auto_stash) = auto_stash else {
        return Ok(response);
    };

    let restore = crate::stash_impl::restore_stash_for_root(
        runner,
        root,
        &auto_stash.selector,
        true,
        SYNC_STASH_RESTORE_OPERATION,
        Some(operation_id),
    )?;
    match restore.outcome {
        StashRestoreOutcome::Applied { .. } => Ok(response),
        StashRestoreOutcome::Conflicts { conflict } => {
            response.conflict = Some(conflict);
            response.stash_recovery = Some(restore.recovery);
            Ok(response)
        }
    }
}

fn has_conflicts(runner: &GitRunner, root: &Path) -> AppResult<bool> {
    Ok(crate::conflicts::list_conflicts(
        runner,
        ConflictListRequest {
            repository_path: display_path(root),
        },
    )?
    .files
    .into_iter()
    .any(|file| {
        matches!(
            file.status,
            artistic_git_contracts::ConflictResolutionStatus::Unresolved
        )
    }))
}

fn conflict_event(
    runner: &GitRunner,
    root: &Path,
    operation_id: &OperationId,
) -> AppResult<ConflictEnteredEvent> {
    let response = crate::conflicts::list_conflicts(
        runner,
        ConflictListRequest {
            repository_path: display_path(root),
        },
    )?;
    Ok(ConflictEnteredEvent {
        operation_id: operation_id.clone(),
        repository_path: display_path(root),
        operation_name: SYNC_OPERATION.to_owned(),
        files: response.files,
    })
}

fn sync_operation_id() -> OperationId {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    OperationId(format!("sync-current-branch-{millis}"))
}

fn sync_branch_operation_id(branch_name: &str) -> OperationId {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    OperationId(format!(
        "sync-branch-{}-{millis}",
        sanitize_path_component(branch_name)
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncWorktreeMarker {
    operation_id: OperationId,
    parent_repository_path: String,
    branch_name: String,
}

pub fn finish_sync_worktree_conflict(
    runner: &GitRunner,
    root: &Path,
    operation_id: &OperationId,
) -> AppResult<()> {
    let Some(marker) = read_sync_worktree_marker(runner, root)? else {
        return Ok(());
    };
    if marker.operation_id != *operation_id {
        return Ok(());
    }

    let refspec = format!("{}:{}", marker.branch_name, marker.branch_name);
    let result = push_with_retry(
        runner,
        root,
        [
            OsString::from("push"),
            OsString::from("origin"),
            OsString::from(refspec),
        ],
    );
    let cleanup = cleanup_sync_worktree_path(runner, root);
    result?;
    cleanup
}

pub fn cleanup_sync_worktree_after_conflict(
    runner: &GitRunner,
    root: &Path,
    operation_id: &OperationId,
) -> AppResult<()> {
    let Some(marker) = read_sync_worktree_marker(runner, root)? else {
        return Ok(());
    };
    if marker.operation_id == *operation_id {
        cleanup_sync_worktree_path(runner, root)?;
    }
    Ok(())
}

fn create_sync_worktree(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    operation_id: &OperationId,
) -> AppResult<PathBuf> {
    let parent = std::env::temp_dir().join("artistic-git-sync-worktrees");
    fs::create_dir_all(&parent)
        .map_err(|source| expected_repo_error(format!("无法创建同步临时目录：{source}"), root))?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let worktree = parent.join(format!(
        "{SYNC_WORKTREE_PREFIX}{}-{millis}",
        sanitize_path_component(branch_name)
    ));

    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        [
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("--no-guess-remote"),
            worktree.as_os_str().to_owned(),
            OsString::from(branch_name),
        ],
        SYNC_BRANCH_OPERATION,
    )?;
    if !output.status.success() {
        return Err(command_failure(
            &plan,
            output,
            "无法创建同步临时 worktree。",
        ));
    }

    write_sync_worktree_marker(
        runner,
        &worktree,
        &SyncWorktreeMarker {
            operation_id: operation_id.clone(),
            parent_repository_path: display_path(root),
            branch_name: branch_name.to_owned(),
        },
    )?;
    Ok(worktree)
}

fn write_sync_worktree_marker(
    runner: &GitRunner,
    worktree: &Path,
    marker: &SyncWorktreeMarker,
) -> AppResult<()> {
    let marker_path = sync_worktree_marker_path(runner, worktree)?;
    let bytes = serde_json::to_vec(marker).map_err(|source| {
        expected_repo_error(format!("无法记录同步临时 worktree：{source}"), worktree)
    })?;
    fs::write(&marker_path, bytes).map_err(|source| {
        expected_repo_error(format!("无法记录同步临时 worktree：{source}"), worktree)
    })
}

fn read_sync_worktree_marker(
    runner: &GitRunner,
    worktree: &Path,
) -> AppResult<Option<SyncWorktreeMarker>> {
    if !is_sync_worktree_path(worktree) {
        return Ok(None);
    }
    let marker_path = sync_worktree_marker_path(runner, worktree)?;
    let Ok(bytes) = fs::read(&marker_path) else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|source| {
        expected_repo_error(
            format!("无法读取同步临时 worktree 状态：{source}"),
            worktree,
        )
    })
}

fn sync_worktree_marker_path(runner: &GitRunner, worktree: &Path) -> AppResult<PathBuf> {
    Ok(git_dir_path(runner, worktree, SYNC_BRANCH_OPERATION)?.join(SYNC_WORKTREE_MARKER))
}

fn git_dir_path(runner: &GitRunner, root: &Path, operation_name: &str) -> AppResult<PathBuf> {
    let output = crate::git_ops::git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--git-dir"],
        operation_name,
    )?;
    let path = PathBuf::from(output.trim());
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

fn git_common_dir_path(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<PathBuf> {
    let output = crate::git_ops::git_stdout(
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

fn cleanup_sync_worktree_path(runner: &GitRunner, worktree: &Path) -> AppResult<()> {
    if !is_sync_worktree_path(worktree) {
        return Ok(());
    }

    let marker = read_sync_worktree_marker(runner, worktree).ok().flatten();
    let parent = marker
        .as_ref()
        .map(|value| PathBuf::from(&value.parent_repository_path))
        .filter(|path| path.exists());
    let command_root = parent.as_deref().unwrap_or(worktree);
    let force_arg = ["--", "force"].concat();
    let (plan, output) = run_git_raw(
        runner,
        Some(command_root),
        [
            OsString::from("worktree"),
            OsString::from("remove"),
            OsString::from(force_arg),
            worktree.as_os_str().to_owned(),
        ],
        SYNC_BRANCH_OPERATION,
    )?;
    if !output.status.success() && worktree.exists() {
        return Err(command_failure(
            &plan,
            output,
            "无法删除同步临时 worktree。",
        ));
    }

    if worktree.exists() {
        fs::remove_dir_all(worktree).map_err(|source| {
            expected_repo_error(format!("无法删除同步临时 worktree：{source}"), worktree)
        })?;
    }
    if let Some(parent) = parent {
        let _ = run_git_raw(
            runner,
            Some(&parent),
            ["worktree", "prune"],
            SYNC_BRANCH_OPERATION,
        );
    }
    Ok(())
}

pub(crate) fn cleanup_sync_worktree_residue(runner: &GitRunner, root: &Path) {
    let Ok(git_common_dir) = git_common_dir_path(runner, root, SYNC_BRANCH_OPERATION) else {
        return;
    };
    let worktrees = git_common_dir.join("worktrees");
    let Ok(entries) = fs::read_dir(worktrees) else {
        return;
    };

    for entry in entries.flatten() {
        let admin_path = entry.path();
        let Some(admin_name) = admin_path.file_name().and_then(OsStr::to_str) else {
            continue;
        };
        if !admin_name.starts_with(SYNC_WORKTREE_PREFIX) {
            continue;
        }

        let gitdir = admin_path.join("gitdir");
        let worktree = fs::read_to_string(&gitdir)
            .ok()
            .map(|value| PathBuf::from(value.trim()))
            .and_then(|path| path.parent().map(Path::to_path_buf));
        if let Some(worktree) = worktree.filter(|path| is_sync_worktree_path(path)) {
            let _ = cleanup_sync_worktree_path(runner, &worktree);
        } else {
            let _ = fs::remove_dir_all(admin_path);
        }
    }
}

fn is_sync_worktree_path(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(|name| name.starts_with(SYNC_WORKTREE_PREFIX))
        .unwrap_or(false)
}

fn sanitize_path_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    sanitized.trim_matches('-').chars().take(48).collect()
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
        thread::sleep(retry_delay(attempt));
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
            thread::sleep(retry_delay(attempt));
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

fn is_fast_forward_fetch_rejection(output: &Output) -> bool {
    let text = combined_output(output).to_ascii_lowercase();
    text.contains("non-fast-forward")
        || text.contains("not possible to fast-forward")
        || text.contains("would clobber existing tag")
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

fn retry_delay(attempt: u8) -> Duration {
    let exponent = u32::from(attempt.saturating_sub(1));
    Duration::from_millis(25 * 2_u64.saturating_pow(exponent))
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
        conflict: None,
        stash_recovery: None,
    }
}

fn conflict_response(
    root: &Path,
    branch_name: &str,
    upstream: Option<String>,
    attempts: u8,
    conflict: ConflictEnteredEvent,
    stash_recovery: Option<StashRecoveryPoint>,
) -> SyncCurrentBranchResponse {
    SyncCurrentBranchResponse {
        repository_path: display_path(root),
        branch_name: branch_name.to_owned(),
        upstream,
        status: SyncCurrentBranchStatus::Conflicts,
        attempts,
        conflict: Some(conflict),
        stash_recovery,
    }
}

fn sync_branch_response_from_current(response: SyncCurrentBranchResponse) -> SyncBranchResponse {
    SyncBranchResponse {
        repository_path: response.repository_path,
        branch_name: response.branch_name,
        upstream: response.upstream,
        status: response.status,
        attempts: response.attempts,
        conflict: response.conflict,
        stash_recovery: response.stash_recovery,
    }
}

fn sync_branch_response_from_worktree(
    root: &Path,
    response: SyncCurrentBranchResponse,
) -> SyncBranchResponse {
    SyncBranchResponse {
        repository_path: display_path(root),
        branch_name: response.branch_name,
        upstream: response.upstream,
        status: response.status,
        attempts: response.attempts,
        conflict: response.conflict,
        stash_recovery: response.stash_recovery,
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
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
    };

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
    fn sync_current_branch_restores_dirty_worktree_after_success() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("tracked.txt", "dirty local\n");
        fixture.local.write("scratch.txt", "scratch\n");
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
        .expect("sync dirty tree");

        assert_eq!(response.status, SyncCurrentBranchStatus::Pulled);
        assert_eq!(fixture.local.read("tracked.txt"), "dirty local\n");
        assert_eq!(fixture.local.read("scratch.txt"), "scratch\n");
        assert!(fixture.local.path.join("remote.txt").exists());
        assert!(fixture
            .local
            .git_output(["stash", "list"])
            .trim()
            .is_empty());
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

    #[test]
    fn sync_current_branch_recovers_from_push_race_without_force() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("local.txt", "local\n");
        fixture.local.git(["add", "local.txt"]);
        fixture.local.git(["commit", "-m", "local change"]);
        fixture.install_one_shot_push_race_hook();

        let response = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect("sync push race");

        assert_eq!(response.status, SyncCurrentBranchStatus::PulledAndPushed);
        assert_eq!(response.attempts, 2);
        fixture.peer.git(["pull", "--ff-only"]);
        assert!(fixture.peer.path.join("local.txt").exists());
        assert!(fixture.peer.path.join("race.txt").exists());
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn sync_current_branch_caps_push_race_retries_and_restores_start() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("local.txt", "local\n");
        fixture.local.git(["add", "local.txt"]);
        fixture.local.git(["commit", "-m", "local change"]);
        let starting_head = fixture.local.git_output(["rev-parse", "HEAD"]);
        fixture.install_repeating_push_race_hook();

        let error = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect_err("push race should stop after capped retries");

        assert!(error.summary.contains("远程更新过于频繁"));
        assert_eq!(
            fixture.local.git_output(["rev-parse", "HEAD"]),
            starting_head
        );
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn sync_current_branch_rebase_conflict_returns_conflict_response() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("tracked.txt", "local committed\n");
        fixture.local.git(["add", "tracked.txt"]);
        fixture.local.git(["commit", "-m", "local change"]);
        fixture.peer.write("tracked.txt", "remote committed\n");
        fixture.peer.git(["add", "tracked.txt"]);
        fixture.peer.git(["commit", "-m", "remote change"]);
        fixture.peer.git(["push"]);
        let starting_head = fixture.local.git_output(["rev-parse", "HEAD"]);
        fixture.local.write("scratch.txt", "dirty scratch\n");

        let response = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: Some(OperationId("sync-conflict-test".to_owned())),
            },
        )
        .expect("sync conflict response");

        assert_eq!(response.status, SyncCurrentBranchStatus::Conflicts);
        let conflict = response.conflict.expect("conflict payload");
        assert_eq!(conflict.operation_id.0, "sync-conflict-test");
        assert_eq!(conflict.operation_name, SYNC_OPERATION);
        assert!(conflict.files.iter().any(|file| file.path == "tracked.txt"));
        assert!(fixture
            .local
            .git_output(["status", "--porcelain=v1"])
            .contains("UU tracked.txt"));
        assert!(fixture
            .local
            .git_output(["stash", "list"])
            .contains("Auto Stash: before syncing current branch"));

        crate::conflicts::cancel_conflict_resolution(
            &runner,
            artistic_git_contracts::ConflictCancelRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: OperationId("sync-conflict-test".to_owned()),
            },
        )
        .expect("cancel rebase conflict");
        assert_eq!(
            fixture.local.git_output(["rev-parse", "HEAD"]),
            starting_head
        );
        assert!(fixture.local.status_clean());
        assert!(fixture
            .local
            .git_output(["stash", "list"])
            .contains("Auto Stash: before syncing current branch"));
    }

    #[test]
    fn sync_current_branch_stash_restore_conflict_returns_recovery() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("tracked.txt", "dirty local\n");
        fixture.peer.write("tracked.txt", "remote committed\n");
        fixture.peer.git(["add", "tracked.txt"]);
        fixture.peer.git(["commit", "-m", "remote change"]);
        fixture.peer.git(["push"]);

        let response = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: Some(OperationId("sync-stash-conflict-test".to_owned())),
            },
        )
        .expect("sync stash restore conflict response");

        assert_eq!(response.status, SyncCurrentBranchStatus::Pulled);
        let conflict = response.conflict.expect("conflict payload");
        assert_eq!(conflict.operation_id.0, "sync-stash-conflict-test");
        assert_eq!(conflict.operation_name, SYNC_STASH_RESTORE_OPERATION);
        assert!(conflict.files.iter().any(|file| file.path == "tracked.txt"));
        assert_eq!(
            response.stash_recovery.expect("stash recovery").id,
            "sync-stash-conflict-test"
        );
        assert!(fixture
            .local
            .git_output(["stash", "list"])
            .contains("Auto Stash: before syncing current branch"));
        assert!(fixture
            .local
            .git_output(["status", "--porcelain=v1"])
            .contains("UU tracked.txt"));
    }

    #[test]
    fn sync_branch_fast_path_fast_forwards_without_touching_current_worktree() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.create_tracking_branch("feature/fast");
        fixture.peer.write("remote.txt", "remote\n");
        fixture.peer.git(["add", "remote.txt"]);
        fixture.peer.git(["commit", "-m", "remote feature change"]);
        fixture.peer.git(["push"]);
        fixture
            .local
            .write("tracked.txt", "dirty current worktree\n");

        let response = sync_branch(
            &runner,
            SyncBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/fast".to_owned(),
                operation_id: None,
            },
        )
        .expect("sync non-current fast path");

        assert_eq!(response.status, SyncCurrentBranchStatus::Pulled);
        assert_eq!(
            fixture
                .local
                .git_output(["branch", "--show-current"])
                .trim(),
            "main"
        );
        assert_eq!(
            fixture.local.read("tracked.txt"),
            "dirty current worktree\n"
        );
        assert_eq!(fixture.local.show("feature/fast", "remote.txt"), "remote\n");
        assert_no_sync_worktrees(&fixture.local);
    }

    #[test]
    fn sync_branch_slow_path_rebases_in_temporary_worktree_and_cleans_up() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.create_tracking_branch("feature/rebase");
        fixture.local.git(["checkout", "feature/rebase"]);
        fixture.local.write("local.txt", "local\n");
        fixture.local.git(["add", "local.txt"]);
        fixture.local.git(["commit", "-m", "local feature change"]);
        fixture.local.git(["checkout", "main"]);
        fixture
            .local
            .write("tracked.txt", "dirty current worktree\n");
        fixture.peer.write("remote.txt", "remote\n");
        fixture.peer.git(["add", "remote.txt"]);
        fixture.peer.git(["commit", "-m", "remote feature change"]);
        fixture.peer.git(["push"]);

        let response = sync_branch(
            &runner,
            SyncBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/rebase".to_owned(),
                operation_id: None,
            },
        )
        .expect("sync non-current slow path");

        assert_eq!(response.status, SyncCurrentBranchStatus::PulledAndPushed);
        assert_eq!(
            fixture
                .local
                .git_output(["branch", "--show-current"])
                .trim(),
            "main"
        );
        assert_eq!(
            fixture.local.read("tracked.txt"),
            "dirty current worktree\n"
        );
        fixture.peer.git(["pull", "--ff-only"]);
        assert_eq!(fixture.peer.read("local.txt"), "local\n");
        assert_eq!(fixture.peer.read("remote.txt"), "remote\n");
        assert_no_sync_worktrees(&fixture.local);
    }

    #[test]
    fn sync_branch_fast_path_pushes_ahead_branch_without_temporary_worktree() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.create_tracking_branch("feature/ahead");
        fixture.local.git(["checkout", "feature/ahead"]);
        fixture.local.write("local.txt", "local\n");
        fixture.local.git(["add", "local.txt"]);
        fixture.local.git(["commit", "-m", "local feature change"]);
        fixture.local.git(["checkout", "main"]);
        fixture
            .local
            .write("tracked.txt", "dirty current worktree\n");

        let response = sync_branch(
            &runner,
            SyncBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/ahead".to_owned(),
                operation_id: None,
            },
        )
        .expect("sync ahead non-current fast path");

        assert_eq!(response.status, SyncCurrentBranchStatus::Pushed);
        assert_eq!(
            fixture
                .local
                .git_output(["branch", "--show-current"])
                .trim(),
            "main"
        );
        assert_eq!(
            fixture.local.read("tracked.txt"),
            "dirty current worktree\n"
        );
        fixture.peer.git(["pull", "--ff-only"]);
        assert_eq!(fixture.peer.read("local.txt"), "local\n");
        assert_no_sync_worktrees(&fixture.local);
    }

    #[test]
    fn sync_branch_conflict_cancel_aborts_rebase_and_removes_temporary_worktree() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.create_tracking_branch("feature/cancel-conflict");
        fixture.local.git(["checkout", "feature/cancel-conflict"]);
        fixture.local.write("tracked.txt", "local committed\n");
        fixture.local.git(["add", "tracked.txt"]);
        fixture.local.git(["commit", "-m", "local feature change"]);
        let starting_head = fixture.local.git_output(["rev-parse", "HEAD"]);
        fixture.local.git(["checkout", "main"]);
        fixture.peer.write("tracked.txt", "remote committed\n");
        fixture.peer.git(["add", "tracked.txt"]);
        fixture.peer.git(["commit", "-m", "remote feature change"]);
        fixture.peer.git(["push"]);

        let response = sync_branch(
            &runner,
            SyncBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/cancel-conflict".to_owned(),
                operation_id: Some(OperationId("sync-branch-cancel-test".to_owned())),
            },
        )
        .expect("sync conflict response");

        assert_eq!(response.status, SyncCurrentBranchStatus::Conflicts);
        assert_eq!(response.repository_path, display_path(&fixture.local.path));
        let conflict = response.conflict.expect("conflict payload");
        assert_ne!(conflict.repository_path, display_path(&fixture.local.path));
        let conflict_worktree = PathBuf::from(&conflict.repository_path);
        assert!(conflict_worktree.exists());
        assert!(conflict.files.iter().any(|file| file.path == "tracked.txt"));

        crate::conflicts::cancel_conflict_resolution(
            &runner,
            artistic_git_contracts::ConflictCancelRequest {
                repository_path: display_path(&conflict_worktree),
                operation_id: OperationId("sync-branch-cancel-test".to_owned()),
            },
        )
        .expect("cancel non-current rebase conflict");

        assert!(!conflict_worktree.exists());
        assert_eq!(
            fixture
                .local
                .git_output(["rev-parse", "feature/cancel-conflict"]),
            starting_head
        );
        assert_no_sync_worktrees(&fixture.local);
    }

    #[test]
    fn sync_branch_conflict_complete_pushes_and_removes_temporary_worktree() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.create_tracking_branch("feature/complete-conflict");
        fixture.local.git(["checkout", "feature/complete-conflict"]);
        fixture.local.write("tracked.txt", "local committed\n");
        fixture.local.git(["add", "tracked.txt"]);
        fixture.local.git(["commit", "-m", "local feature change"]);
        fixture.local.git(["checkout", "main"]);
        fixture.peer.write("tracked.txt", "remote committed\n");
        fixture.peer.git(["add", "tracked.txt"]);
        fixture.peer.git(["commit", "-m", "remote feature change"]);
        fixture.peer.git(["push"]);

        let response = sync_branch(
            &runner,
            SyncBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/complete-conflict".to_owned(),
                operation_id: Some(OperationId("sync-branch-complete-test".to_owned())),
            },
        )
        .expect("sync conflict response");
        let conflict = response.conflict.expect("conflict payload");
        let conflict_worktree = PathBuf::from(&conflict.repository_path);

        crate::conflicts::save_conflict_resolution(
            &runner,
            artistic_git_contracts::ConflictSaveResolutionRequest {
                repository_path: display_path(&conflict_worktree),
                path: "tracked.txt".to_owned(),
                content: "resolved\n".to_owned(),
                pending_hunks: 0,
            },
        )
        .expect("save resolution");
        crate::conflicts::complete_conflict_resolution(
            &runner,
            artistic_git_contracts::ConflictCompleteRequest {
                repository_path: display_path(&conflict_worktree),
                operation_id: OperationId("sync-branch-complete-test".to_owned()),
                paths: vec!["tracked.txt".to_owned()],
            },
        )
        .expect("complete non-current rebase conflict");

        assert!(!conflict_worktree.exists());
        fixture.peer.git(["pull", "--ff-only"]);
        assert_eq!(fixture.peer.read("tracked.txt"), "resolved\n");
        assert_no_sync_worktrees(&fixture.local);
    }

    #[test]
    fn sync_branch_slow_path_failure_removes_temporary_worktree() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.create_tracking_branch("feature/failure-cleanup");
        fixture.local.git([
            "remote",
            "add",
            "other",
            display_path(&fixture.remote.path).as_str(),
        ]);
        fixture.local.git(["fetch", "other"]);
        fixture.local.git([
            "branch",
            "--set-upstream-to",
            "other/feature/failure-cleanup",
            "feature/failure-cleanup",
        ]);
        fixture.local.git(["checkout", "feature/failure-cleanup"]);
        fixture.local.write("local.txt", "local\n");
        fixture.local.git(["add", "local.txt"]);
        fixture.local.git(["commit", "-m", "local feature change"]);
        fixture.local.git(["checkout", "main"]);
        fixture.peer.write("remote.txt", "remote\n");
        fixture.peer.git(["add", "remote.txt"]);
        fixture.peer.git(["commit", "-m", "remote feature change"]);
        fixture.peer.git(["push"]);

        let error = sync_branch(
            &runner,
            SyncBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/failure-cleanup".to_owned(),
                operation_id: None,
            },
        )
        .expect_err("non-origin upstream should fail in slow path");

        assert!(error.summary.contains("上游不属于 origin"));
        assert_no_sync_worktrees(&fixture.local);
    }

    #[test]
    fn sync_source_does_not_contain_force_push_flags() {
        let source = include_str!("sync.rs");
        let long_force = ["--", "force"].concat();
        let long_force_with_lease = ["--", "force-with-lease"].concat();
        let short_force_arg = ['"', '-', 'f', '"'].into_iter().collect::<String>();
        let forced_refspec = ["+", "refs/"].concat();

        for needle in [
            long_force.as_str(),
            long_force_with_lease.as_str(),
            short_force_arg.as_str(),
            forced_refspec.as_str(),
        ] {
            assert!(
                !source.contains(needle),
                "sync source must not contain force-push flag or refspec: {needle}"
            );
        }
    }

    #[test]
    fn sync_branch_unit_detects_fast_forward_fetch_rejection() {
        let output = test_output(
            1,
            "",
            "! [rejected]        feature/demo -> feature/demo  (non-fast-forward)\n",
        );

        assert!(is_fast_forward_fetch_rejection(&output));
    }

    #[test]
    fn sync_branch_unit_limits_cleanup_to_tool_prefix() {
        assert!(is_sync_worktree_path(Path::new(
            "/tmp/artistic-git-sync-feature-demo-123"
        )));
        assert!(!is_sync_worktree_path(Path::new(
            "/tmp/user-linked-worktree"
        )));
        assert!(!is_sync_worktree_path(Path::new("/tmp/artistic-git-other")));
    }

    #[test]
    fn sync_branch_unit_sanitizes_branch_names_for_operation_and_paths() {
        assert_eq!(
            sanitize_path_component("feature/noncurrent sync"),
            "feature-noncurrent-sync"
        );
        assert_eq!(sanitize_path_component("///"), "");
    }

    fn test_output(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: exit_status(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(unix)]
    fn exit_status(code: i32) -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exit_status(code: i32) -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code as u32)
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

        fn create_tracking_branch(&self, branch_name: &str) {
            self.local.git(["checkout", "-b", branch_name]);
            self.local.write("branch.txt", "branch\n");
            self.local.git(["add", "branch.txt"]);
            self.local.git(["commit", "-m", "create feature branch"]);
            self.local.git(["push", "-u", "origin", branch_name]);
            self.local.git(["checkout", "main"]);
            self.peer.git(["fetch", "origin"]);
            self.peer.git([
                OsString::from("checkout"),
                OsString::from("-b"),
                OsString::from(branch_name),
                OsString::from(format!("origin/{branch_name}")),
            ]);
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
exit 0
"#,
                marker = shell_quote(&marker),
                peer = shell_quote(&self.peer.path),
            );
            fs::write(&hook, script).expect("write pre-push hook");
            make_executable(&hook);
        }

        fn install_repeating_push_race_hook(&self) {
            let counter = self.local.path.join(".git").join("ag-push-race-counter");
            let hook = self.local.path.join(".git").join("hooks").join("pre-push");
            let script = format!(
                r#"#!/bin/sh
set -e
counter_file={counter}
peer={peer}
counter=0
if [ -f "$counter_file" ]; then
  counter=$(cat "$counter_file")
fi
counter=$((counter + 1))
printf '%s\n' "$counter" > "$counter_file"
git -C "$peer" pull --ff-only
printf '%s\n' "$counter" > "$peer/race-$counter.txt"
git -C "$peer" add "race-$counter.txt"
git -C "$peer" commit -m "race change $counter"
git -C "$peer" push
exit 0
"#,
                counter = shell_quote(&counter),
                peer = shell_quote(&self.peer.path),
            );
            fs::write(&hook, script).expect("write repeating pre-push hook");
            make_executable(&hook);
        }
    }

    fn make_executable(path: &Path) {
        let _ = path;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).expect("hook metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("make hook executable");
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

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.path.join(relative)).expect("read file")
        }

        fn show(&self, branch_name: &str, relative: &str) -> String {
            self.git_output([
                OsString::from("show"),
                OsString::from(format!("{branch_name}:{relative}")),
            ])
        }
    }

    fn assert_no_sync_worktrees(repo: &TestRepo) {
        assert!(
            !repo
                .git_output(["worktree", "list", "--porcelain"])
                .contains(SYNC_WORKTREE_PREFIX),
            "sync worktree should have been removed"
        );
    }

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", display_path(path).replace('\'', "'\\''"))
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
