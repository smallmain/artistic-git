use artistic_git_contracts::{
    AcceptRemoteHistoryRequest, AcceptRemoteHistoryResponse, AppError, AppResult,
    AutoTrackingRuleResult, AutoTrackingRuleStatus, BranchExistence, ConflictEnteredEvent,
    ConflictListRequest, CreateAutoStashRequest, GitCommandError, OperationContext, OperationId,
    OperationProgressEvent, RemoteHistoryChange, RepositoryPathRequest, StashEntry,
    StashRecoveryPoint, StashRestoreOutcome, SyncAllBranchesRequest, SyncAllBranchesResponse,
    SyncBranchRequest, SyncBranchResponse, SyncCurrentBranchRequest, SyncCurrentBranchResponse,
    SyncCurrentBranchStatus,
};
use artistic_git_core::config::{AutoTrackingRule, ConfigActor};
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
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
const SYNC_ALL_OPERATION: &str = "syncAllBranches";
const AUTO_TRACKING_OPERATION: &str = "autoTracking";
const AUTO_TRACKING_STASH_RESTORE_OPERATION: &str = "autoTracking:restoreStash";
const SYNC_STASH_RESTORE_OPERATION: &str = "syncCurrentBranch:restoreStash";
const ACCEPT_REMOTE_HISTORY_OPERATION: &str = "acceptRemoteHistory";
const ACCEPT_REMOTE_HISTORY_STASH_RESTORE_OPERATION: &str = "acceptRemoteHistory:restoreStash";
const MAX_SYNC_ATTEMPTS: u8 = 3;
const SYNC_WORKTREE_PREFIX: &str = "artistic-git-sync-";
const SYNC_WORKTREE_MARKER: &str = "artistic-git-sync-worktree.json";

pub fn sync_current_branch(
    runner: &GitRunner,
    request: SyncCurrentBranchRequest,
) -> AppResult<SyncCurrentBranchResponse> {
    sync_current_branch_with_progress(runner, request, |_| {})
}

pub fn sync_current_branch_with_progress<F>(
    runner: &GitRunner,
    request: SyncCurrentBranchRequest,
    progress: F,
) -> AppResult<SyncCurrentBranchResponse>
where
    F: Fn(OperationProgressEvent),
{
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

    let sync_result = sync_current_branch_clean(
        runner,
        &root,
        &branch_name,
        &starting_head,
        &operation_id,
        &progress,
    );
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
    sync_branch_with_progress(runner, request, |_| {})
}

pub fn sync_branch_with_progress<F>(
    runner: &GitRunner,
    request: SyncBranchRequest,
    progress: F,
) -> AppResult<SyncBranchResponse>
where
    F: Fn(OperationProgressEvent),
{
    let root = canonical_repository_path(&request.repository_path, SYNC_BRANCH_OPERATION)?;
    ensure_committed_head(runner, &root)?;
    ensure_origin(runner, &root)?;
    let branch_name = validate_sync_branch_name(runner, &root, &request.branch_name)?;
    let operation_id = request
        .operation_id
        .clone()
        .unwrap_or_else(|| sync_branch_operation_id(&branch_name));

    if current_branch_name(runner, &root)?.as_deref() == Some(branch_name.as_str()) {
        return sync_current_branch_with_progress(
            runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&root),
                operation_id: Some(operation_id),
            },
            progress,
        )
        .map(sync_branch_response_from_current);
    }

    ensure_local_branch(runner, &root, &branch_name)?;
    if remote_branch_oid(runner, &root, &branch_name)?.is_none() {
        return publish_non_current_branch(runner, &root, &branch_name);
    }
    cleanup_sync_worktree_residue(runner, &root);

    match sync_branch_fast_path(runner, &root, &branch_name)? {
        FastPathOutcome::Synced(response) => Ok(response),
        FastPathOutcome::NeedsWorktree => {
            sync_branch_via_worktree(runner, &root, &branch_name, &operation_id, &progress)
        }
    }
}

fn publish_non_current_branch(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
) -> AppResult<SyncBranchResponse> {
    push_with_retry(runner, root, ["push", "-u", "origin", branch_name])?;
    Ok(SyncBranchResponse {
        repository_path: display_path(root),
        branch_name: branch_name.to_owned(),
        upstream: Some(format!("origin/{branch_name}")),
        status: SyncCurrentBranchStatus::Published,
        attempts: 1,
        message: None,
        conflict: None,
        stash_recovery: None,
        remote_history_change: None,
    })
}

pub fn sync_all_branches_with_progress<F>(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: SyncAllBranchesRequest,
    progress: F,
) -> AppResult<SyncAllBranchesResponse>
where
    F: Fn(OperationProgressEvent),
{
    let root = canonical_repository_path(&request.repository_path, SYNC_ALL_OPERATION)?;
    ensure_committed_head(runner, &root)?;
    ensure_origin(runner, &root)?;
    let operation_id = request
        .operation_id
        .clone()
        .unwrap_or_else(sync_all_operation_id);
    let current_branch = current_branch_name(runner, &root)?;
    let branch_names = syncable_local_branches(runner, &root)?;
    let mut branches = Vec::new();
    let mut conflict = None;
    let mut stash_recovery = None;
    let mut remote_history_change = None;

    for branch_name in branch_names {
        let response = if current_branch.as_deref() == Some(branch_name.as_str()) {
            sync_current_branch_with_progress(
                runner,
                SyncCurrentBranchRequest {
                    repository_path: display_path(&root),
                    operation_id: Some(operation_id.clone()),
                },
                &progress,
            )
            .map(sync_branch_response_from_current)?
        } else {
            sync_branch_with_progress(
                runner,
                SyncBranchRequest {
                    repository_path: display_path(&root),
                    branch_name: branch_name.clone(),
                    operation_id: Some(sync_branch_operation_id(&branch_name)),
                },
                &progress,
            )?
        };

        if response.status == SyncCurrentBranchStatus::Conflicts {
            conflict = response.conflict.clone();
            stash_recovery = response.stash_recovery.clone();
            branches.push(response);
            break;
        }
        if response.status == SyncCurrentBranchStatus::RemoteHistoryChanged {
            remote_history_change = response.remote_history_change.clone();
            branches.push(response);
            break;
        }
        branches.push(response);
    }

    let auto_tracking = if conflict.is_none() && remote_history_change.is_none() {
        let rules = project_auto_tracking_rules(config, &root)?;
        apply_auto_tracking_rules(runner, &root, &operation_id, &rules, &progress)?
    } else {
        Vec::new()
    };

    if conflict.is_none() {
        if let Some(tracking_conflict) = auto_tracking.iter().find_map(|result| {
            (result.status == AutoTrackingRuleStatus::Conflicts).then(|| result.clone())
        }) {
            conflict = tracking_conflict.conflict;
            stash_recovery = tracking_conflict.stash_recovery;
        }
    }

    let all_up_to_date = branches
        .iter()
        .all(|branch| branch.status == SyncCurrentBranchStatus::AlreadyUpToDate)
        && auto_tracking
            .iter()
            .all(|rule| rule.status == AutoTrackingRuleStatus::AlreadyUpToDate);

    Ok(SyncAllBranchesResponse {
        repository_path: display_path(&root),
        branches,
        auto_tracking,
        all_up_to_date,
        conflict,
        stash_recovery,
        remote_history_change,
    })
}

pub fn accept_remote_history(
    runner: &GitRunner,
    request: AcceptRemoteHistoryRequest,
) -> AppResult<AcceptRemoteHistoryResponse> {
    let root =
        canonical_repository_path(&request.repository_path, ACCEPT_REMOTE_HISTORY_OPERATION)?;
    ensure_committed_head(runner, &root)?;
    ensure_origin(runner, &root)?;
    let branch_name = validate_sync_branch_name(runner, &root, &request.branch_name)?;
    if branch_name.starts_with("backup/") {
        return Err(expected_repo_error(
            "安全备份分支不能作为远程历史恢复目标。",
            &root,
        ));
    }
    ensure_local_branch(runner, &root, &branch_name)?;

    run_retryable_git(
        runner,
        &root,
        ["fetch", "origin", "--prune"],
        ACCEPT_REMOTE_HISTORY_OPERATION,
    )?;

    let current_branch = current_branch_name(runner, &root)?;
    let upstream = if current_branch.as_deref() == Some(branch_name.as_str()) {
        upstream_branch(runner, &root)?
            .ok_or_else(|| expected_repo_error("当前分支未设置上游，无法以远程为准。", &root))?
    } else {
        format!("origin/{branch_name}")
    };
    if !upstream.starts_with("origin/") {
        return Err(expected_repo_error(
            "目标分支的上游不属于 origin，无法以远程为准。",
            &root,
        ));
    }

    let local_oid = rev_parse(runner, &root, &branch_name)?;
    let remote_oid = rev_parse(runner, &root, &upstream)?;
    let backup = crate::branches::create_safety_backup_branch(
        runner,
        &root,
        &branch_name,
        &local_oid,
        ACCEPT_REMOTE_HISTORY_OPERATION,
    )?;

    let operation_id = request
        .operation_id
        .unwrap_or_else(accept_remote_history_operation_id);
    let mut conflict = None;
    let mut stash_recovery = None;

    if current_branch.as_deref() == Some(branch_name.as_str()) {
        let auto_stash = create_accept_remote_history_auto_stash(runner, &root)?;
        let (plan, output) = run_git_raw(
            runner,
            Some(&root),
            ["reset", "--hard", upstream.as_str()],
            ACCEPT_REMOTE_HISTORY_OPERATION,
        )?;
        if !output.status.success() {
            return Err(command_failure(&plan, output, "无法重置到远程分支。"));
        }
        if let Some(auto_stash) = auto_stash {
            let restore = crate::stash_impl::restore_stash_for_root(
                runner,
                &root,
                &auto_stash.selector,
                true,
                ACCEPT_REMOTE_HISTORY_STASH_RESTORE_OPERATION,
                Some(&operation_id),
            )?;
            match restore.outcome {
                StashRestoreOutcome::Applied { .. } => {}
                StashRestoreOutcome::Conflicts {
                    conflict: restore_conflict,
                } => {
                    conflict = Some(restore_conflict);
                    stash_recovery = Some(restore.recovery);
                }
            }
        }
    } else {
        crate::branches::reset_local_branch_to_ref(
            runner,
            &root,
            &branch_name,
            &upstream,
            ACCEPT_REMOTE_HISTORY_OPERATION,
        )?;
    }

    Ok(AcceptRemoteHistoryResponse {
        repository_path: display_path(&root),
        branch_name,
        upstream,
        backup,
        reset_to_oid: remote_oid,
        conflict,
        stash_recovery,
    })
}

fn sync_current_branch_clean<F>(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    starting_head: &str,
    operation_id: &OperationId,
    progress: &F,
) -> AppResult<SyncCurrentBranchResponse>
where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    let mut last_non_fast_forward = false;

    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        let previous_upstream = upstream_branch(runner, root)?;
        let previous_remote_head = previous_upstream
            .as_deref()
            .and_then(|upstream| rev_parse(runner, root, upstream).ok());
        run_retryable_git(
            runner,
            root,
            [
                "fetch",
                "origin",
                "--prune",
                "--recurse-submodules=on-demand",
            ],
            SYNC_OPERATION,
        )?;
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

        let previous_remote_head = previous_upstream
            .as_deref()
            .filter(|previous| *previous == upstream.as_str())
            .and(previous_remote_head.as_deref());
        if let Some(change) = detect_remote_history_change(
            runner,
            root,
            branch_name,
            "HEAD",
            &upstream,
            previous_remote_head,
        )? {
            return Ok(remote_history_changed_response(
                root,
                branch_name,
                Some(upstream),
                attempt,
                change,
            ));
        }

        let before_push = sync_local_to_upstream(runner, root, &upstream, operation_id, progress)?;
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
    let remote_tracking = format!("refs/remotes/origin/{branch_name}");
    let previous_remote_head = rev_parse(runner, root, &remote_tracking).ok();
    let refspec = format!("{branch_name}:{branch_name}");
    let fetch_outcome = fetch_branch_ref_fast_forward(runner, root, &refspec)?;
    if !fetch_outcome {
        let remote_oid = remote_branch_oid(runner, root, branch_name)?;
        if let Some(change) = detect_remote_history_change_from_oid(
            runner,
            root,
            branch_name,
            branch_name,
            &format!("origin/{branch_name}"),
            previous_remote_head.as_deref(),
            remote_oid.as_deref(),
        )? {
            return Ok(FastPathOutcome::Synced(SyncBranchResponse {
                repository_path: display_path(root),
                branch_name: branch_name.to_owned(),
                upstream: Some(format!("origin/{branch_name}")),
                status: SyncCurrentBranchStatus::RemoteHistoryChanged,
                attempts: 1,
                message: None,
                conflict: None,
                stash_recovery: None,
                remote_history_change: Some(change),
            }));
        }
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
                        message: None,
                        conflict: None,
                        stash_recovery: None,
                        remote_history_change: None,
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
        message: None,
        conflict: None,
        stash_recovery: None,
        remote_history_change: None,
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
                OsString::from("--recurse-submodules=on-demand"),
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

fn sync_branch_via_worktree<F>(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    operation_id: &OperationId,
    progress: &F,
) -> AppResult<SyncBranchResponse>
where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    let worktree = create_sync_worktree(runner, root, branch_name, operation_id)?;
    let starting_head = rev_parse(runner, &worktree, "HEAD")?;
    let sync_result = sync_current_branch_clean(
        runner,
        &worktree,
        branch_name,
        &starting_head,
        operation_id,
        progress,
    );

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

fn sync_local_to_upstream<F>(
    runner: &GitRunner,
    root: &Path,
    upstream: &str,
    operation_id: &OperationId,
    progress: &F,
) -> AppResult<LocalSyncOutcome>
where
    F: Fn(OperationProgressEvent) + ?Sized,
{
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
        crate::repository::update_submodules_after_checkout(
            runner,
            root,
            SYNC_OPERATION,
            Some(operation_id),
            progress,
        )?;
        return Ok(LocalSyncOutcome {
            pulled: true,
            rebased: false,
            conflict: None,
        });
    }

    let (plan, output) = run_git_raw(runner, Some(root), ["rebase", upstream], SYNC_OPERATION)?;
    if output.status.success() {
        crate::repository::update_submodules_after_checkout(
            runner,
            root,
            SYNC_OPERATION,
            Some(operation_id),
            progress,
        )?;
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

fn detect_remote_history_change(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    local_ref: &str,
    upstream: &str,
    previous_remote_head: Option<&str>,
) -> AppResult<Option<RemoteHistoryChange>> {
    let remote_head = rev_parse(runner, root, upstream).ok();
    detect_remote_history_change_from_oid(
        runner,
        root,
        branch_name,
        local_ref,
        upstream,
        previous_remote_head,
        remote_head.as_deref(),
    )
}

fn detect_remote_history_change_from_oid(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    local_ref: &str,
    upstream: &str,
    previous_remote_head: Option<&str>,
    remote_head: Option<&str>,
) -> AppResult<Option<RemoteHistoryChange>> {
    let (Some(previous_remote_head), Some(remote_head)) = (previous_remote_head, remote_head)
    else {
        return Ok(None);
    };
    if previous_remote_head == remote_head
        || is_ancestor(runner, root, previous_remote_head, remote_head)?
    {
        return Ok(None);
    }

    let Some(local_pushed_base) = merge_base(runner, root, local_ref, previous_remote_head)? else {
        return Ok(None);
    };
    if is_ancestor(runner, root, &local_pushed_base, remote_head)? {
        return Ok(None);
    }

    Ok(Some(RemoteHistoryChange {
        branch_name: branch_name.to_owned(),
        upstream: upstream.to_owned(),
        local_head: rev_parse(runner, root, local_ref)?,
        previous_remote_head: previous_remote_head.to_owned(),
        remote_head: remote_head.to_owned(),
    }))
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

fn syncable_local_branches(runner: &GitRunner, root: &Path) -> AppResult<Vec<String>> {
    Ok(crate::repository::list_branches(
        runner,
        RepositoryPathRequest {
            repository_path: display_path(root),
        },
    )?
    .branches
    .into_iter()
    .filter(|branch| branch.existence == BranchExistence::LocalAndRemote)
    .map(|branch| branch.short_name)
    .collect())
}

fn project_auto_tracking_rules(
    config: Option<&ConfigActor>,
    root: &Path,
) -> AppResult<Vec<AutoTrackingRule>> {
    let Some(config) = config else {
        return Ok(Vec::new());
    };
    Ok(crate::settings::load_project_settings(
        Some(config),
        crate::settings::ProjectSettingsRequest {
            repository_path: display_path(root),
        },
    )?
    .auto_tracking_rules)
}

fn apply_auto_tracking_rules<F>(
    runner: &GitRunner,
    root: &Path,
    operation_id: &OperationId,
    rules: &[AutoTrackingRule],
    progress: &F,
) -> AppResult<Vec<AutoTrackingRuleResult>>
where
    F: Fn(OperationProgressEvent) + ?Sized,
{
    let inventory = branch_inventory(runner, root)?;
    let validations = validate_auto_tracking_rules_for_inventory(rules, &inventory);
    let mut results = Vec::new();

    for validation in validations {
        if let Some(message) = validation.message {
            results.push(AutoTrackingRuleResult {
                source_branch: validation.rule.source_branch,
                target_branch: validation.rule.target_branch,
                status: AutoTrackingRuleStatus::Invalid,
                message: Some(message),
                conflict: None,
                stash_recovery: None,
            });
            continue;
        }

        let source = validation.rule.source_branch;
        let target = validation.rule.target_branch;
        let source_sync = sync_branch_with_progress(
            runner,
            SyncBranchRequest {
                repository_path: display_path(root),
                branch_name: source.clone(),
                operation_id: Some(sync_branch_operation_id(&source)),
            },
            progress,
        )?;
        if source_sync.status == SyncCurrentBranchStatus::Conflicts {
            results.push(AutoTrackingRuleResult {
                source_branch: source,
                target_branch: target,
                status: AutoTrackingRuleStatus::Conflicts,
                message: None,
                conflict: source_sync.conflict,
                stash_recovery: source_sync.stash_recovery,
            });
            break;
        }
        if source_sync.status == SyncCurrentBranchStatus::RemoteHistoryChanged {
            results.push(AutoTrackingRuleResult {
                source_branch: source,
                target_branch: target,
                status: AutoTrackingRuleStatus::Failed,
                message: Some("源分支远程历史发生改写，需要先处理。".to_owned()),
                conflict: None,
                stash_recovery: None,
            });
            break;
        }

        if inventory.local_branches.contains(&target) {
            let target_sync = sync_branch_with_progress(
                runner,
                SyncBranchRequest {
                    repository_path: display_path(root),
                    branch_name: target.clone(),
                    operation_id: Some(sync_branch_operation_id(&target)),
                },
                progress,
            )?;
            if target_sync.status == SyncCurrentBranchStatus::Conflicts {
                results.push(AutoTrackingRuleResult {
                    source_branch: source,
                    target_branch: target,
                    status: AutoTrackingRuleStatus::Conflicts,
                    message: None,
                    conflict: target_sync.conflict,
                    stash_recovery: target_sync.stash_recovery,
                });
                break;
            }
            if target_sync.status == SyncCurrentBranchStatus::RemoteHistoryChanged {
                results.push(AutoTrackingRuleResult {
                    source_branch: source,
                    target_branch: target,
                    status: AutoTrackingRuleStatus::Failed,
                    message: Some("目标分支远程历史发生改写，需要先处理。".to_owned()),
                    conflict: None,
                    stash_recovery: None,
                });
                break;
            }
        } else {
            fetch_remote_tracking_branch(runner, root, &target)?;
        }

        results.push(apply_auto_tracking_rule(
            runner,
            root,
            &source,
            &target,
            operation_id,
        )?);
        if results
            .last()
            .map(|result| result.status == AutoTrackingRuleStatus::Conflicts)
            .unwrap_or(false)
        {
            break;
        }
    }

    Ok(results)
}

fn apply_auto_tracking_rule(
    runner: &GitRunner,
    root: &Path,
    source: &str,
    target: &str,
    operation_id: &OperationId,
) -> AppResult<AutoTrackingRuleResult> {
    let target_ref = format!("refs/remotes/origin/{target}");
    if current_branch_name(runner, root)?.as_deref() == Some(source) {
        apply_current_auto_tracking_rule(runner, root, source, target, &target_ref, operation_id)
    } else {
        apply_non_current_auto_tracking_rule(runner, root, source, target, &target_ref)
    }
}

fn apply_current_auto_tracking_rule(
    runner: &GitRunner,
    root: &Path,
    source: &str,
    target: &str,
    target_ref: &str,
    operation_id: &OperationId,
) -> AppResult<AutoTrackingRuleResult> {
    let auto_stash = create_auto_tracking_stash(runner, root)?;
    let before = rev_parse(runner, root, "HEAD")?;
    ensure_clean_worktree(runner, root)?;
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["merge", "--ff-only", target_ref],
        AUTO_TRACKING_OPERATION,
    )?;
    if !output.status.success() {
        if let Some((conflict, stash_recovery)) =
            restore_auto_tracking_stash(runner, root, auto_stash, operation_id)?
        {
            return Ok(AutoTrackingRuleResult {
                source_branch: source.to_owned(),
                target_branch: target.to_owned(),
                status: AutoTrackingRuleStatus::Conflicts,
                message: None,
                conflict: Some(conflict),
                stash_recovery: Some(stash_recovery),
            });
        }
        return Ok(AutoTrackingRuleResult {
            source_branch: source.to_owned(),
            target_branch: target.to_owned(),
            status: AutoTrackingRuleStatus::Failed,
            message: Some(command_failure(&plan, output, "自动跟踪无法快进合并。").summary),
            conflict: None,
            stash_recovery: None,
        });
    }

    let after = rev_parse(runner, root, "HEAD")?;
    if before != after {
        let refspec = format!("{source}:{source}");
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
            PushOutcome::NonFastForward => {
                if let Some((conflict, stash_recovery)) =
                    restore_auto_tracking_stash(runner, root, auto_stash, operation_id)?
                {
                    return Ok(AutoTrackingRuleResult {
                        source_branch: source.to_owned(),
                        target_branch: target.to_owned(),
                        status: AutoTrackingRuleStatus::Conflicts,
                        message: None,
                        conflict: Some(conflict),
                        stash_recovery: Some(stash_recovery),
                    });
                }
                return Ok(AutoTrackingRuleResult {
                    source_branch: source.to_owned(),
                    target_branch: target.to_owned(),
                    status: AutoTrackingRuleStatus::Failed,
                    message: Some("自动跟踪推送被远程拒绝，请稍后重试。".to_owned()),
                    conflict: None,
                    stash_recovery: None,
                });
            }
            PushOutcome::Failed(error) => {
                if let Some((conflict, stash_recovery)) =
                    restore_auto_tracking_stash(runner, root, auto_stash, operation_id)?
                {
                    return Ok(AutoTrackingRuleResult {
                        source_branch: source.to_owned(),
                        target_branch: target.to_owned(),
                        status: AutoTrackingRuleStatus::Conflicts,
                        message: None,
                        conflict: Some(conflict),
                        stash_recovery: Some(stash_recovery),
                    });
                }
                return Ok(AutoTrackingRuleResult {
                    source_branch: source.to_owned(),
                    target_branch: target.to_owned(),
                    status: AutoTrackingRuleStatus::Failed,
                    message: Some(error.summary),
                    conflict: None,
                    stash_recovery: None,
                });
            }
        }
    }

    let restore = restore_auto_tracking_stash(runner, root, auto_stash, operation_id)?;
    if let Some((conflict, stash_recovery)) = restore {
        return Ok(AutoTrackingRuleResult {
            source_branch: source.to_owned(),
            target_branch: target.to_owned(),
            status: AutoTrackingRuleStatus::Conflicts,
            message: None,
            conflict: Some(conflict),
            stash_recovery: Some(stash_recovery),
        });
    }

    Ok(AutoTrackingRuleResult {
        source_branch: source.to_owned(),
        target_branch: target.to_owned(),
        status: if before == after {
            AutoTrackingRuleStatus::AlreadyUpToDate
        } else {
            AutoTrackingRuleStatus::Applied
        },
        message: None,
        conflict: None,
        stash_recovery: None,
    })
}

fn apply_non_current_auto_tracking_rule(
    runner: &GitRunner,
    root: &Path,
    source: &str,
    target: &str,
    target_ref: &str,
) -> AppResult<AutoTrackingRuleResult> {
    let source_ref = format!("refs/heads/{source}");
    let before = rev_parse(runner, root, &source_ref)?;
    let target_oid = rev_parse(runner, root, target_ref)?;
    if before == target_oid {
        return Ok(AutoTrackingRuleResult {
            source_branch: source.to_owned(),
            target_branch: target.to_owned(),
            status: AutoTrackingRuleStatus::AlreadyUpToDate,
            message: None,
            conflict: None,
            stash_recovery: None,
        });
    }
    if !is_ancestor(runner, root, &before, &target_oid)? {
        return Ok(AutoTrackingRuleResult {
            source_branch: source.to_owned(),
            target_branch: target.to_owned(),
            status: AutoTrackingRuleStatus::Failed,
            message: Some("自动跟踪无法快进合并。".to_owned()),
            conflict: None,
            stash_recovery: None,
        });
    }

    update_ref(runner, root, &source_ref, &target_oid)?;
    let refspec = format!("{source}:{source}");
    match push_with_retry_raw(
        runner,
        root,
        [
            OsString::from("push"),
            OsString::from("origin"),
            OsString::from(refspec.as_str()),
        ],
    ) {
        PushOutcome::Success => Ok(AutoTrackingRuleResult {
            source_branch: source.to_owned(),
            target_branch: target.to_owned(),
            status: AutoTrackingRuleStatus::Applied,
            message: None,
            conflict: None,
            stash_recovery: None,
        }),
        PushOutcome::NonFastForward => Ok(AutoTrackingRuleResult {
            source_branch: source.to_owned(),
            target_branch: target.to_owned(),
            status: AutoTrackingRuleStatus::Failed,
            message: Some("自动跟踪推送被远程拒绝，请稍后重试。".to_owned()),
            conflict: None,
            stash_recovery: None,
        }),
        PushOutcome::Failed(error) => Err(error),
    }
}

fn fetch_remote_tracking_branch(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
) -> AppResult<()> {
    let refspec = format!("refs/heads/{branch_name}:refs/remotes/origin/{branch_name}");
    run_retryable_git(
        runner,
        root,
        [
            OsString::from("fetch"),
            OsString::from("origin"),
            OsString::from(refspec),
        ],
        AUTO_TRACKING_OPERATION,
    )
}

fn update_ref(runner: &GitRunner, root: &Path, ref_name: &str, oid: &str) -> AppResult<()> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["update-ref", ref_name, oid],
        AUTO_TRACKING_OPERATION,
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_failure(&plan, output, "无法更新自动跟踪分支。"))
    }
}

fn create_auto_tracking_stash(runner: &GitRunner, root: &Path) -> AppResult<Option<StashEntry>> {
    Ok(crate::stash_impl::create_auto_stash(
        runner,
        CreateAutoStashRequest {
            repository_path: display_path(root),
            reason: "before applying automatic tracking".to_owned(),
            include_untracked: true,
            paths: Vec::new(),
        },
    )?
    .stash)
}

fn restore_auto_tracking_stash(
    runner: &GitRunner,
    root: &Path,
    auto_stash: Option<StashEntry>,
    operation_id: &OperationId,
) -> AppResult<Option<(ConflictEnteredEvent, StashRecoveryPoint)>> {
    let Some(auto_stash) = auto_stash else {
        return Ok(None);
    };
    let restore = crate::stash_impl::restore_stash_for_root(
        runner,
        root,
        &auto_stash.selector,
        true,
        AUTO_TRACKING_STASH_RESTORE_OPERATION,
        Some(operation_id),
    )?;
    match restore.outcome {
        StashRestoreOutcome::Applied { .. } => Ok(None),
        StashRestoreOutcome::Conflicts { conflict } => Ok(Some((conflict, restore.recovery))),
    }
}

#[derive(Debug)]
struct BranchInventory {
    local_branches: BTreeSet<String>,
    remote_branches: BTreeSet<String>,
}

#[derive(Debug)]
struct AutoTrackingValidation {
    rule: AutoTrackingRule,
    message: Option<String>,
}

fn branch_inventory(runner: &GitRunner, root: &Path) -> AppResult<BranchInventory> {
    let output = crate::git_ops::git_stdout(
        runner,
        Some(root),
        [
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes/origin",
        ],
        AUTO_TRACKING_OPERATION,
    )?;
    let mut local_branches = BTreeSet::new();
    let mut remote_branches = BTreeSet::new();
    for refname in output.lines().map(str::trim) {
        if let Some(branch) = refname.strip_prefix("refs/heads/") {
            if !branch.starts_with("backup/") {
                local_branches.insert(branch.to_owned());
            }
        } else if let Some(branch) = refname.strip_prefix("refs/remotes/origin/") {
            if branch != "HEAD" && !branch.starts_with("backup/") {
                remote_branches.insert(branch.to_owned());
            }
        }
    }
    Ok(BranchInventory {
        local_branches,
        remote_branches,
    })
}

fn validate_auto_tracking_rules_for_inventory(
    rules: &[AutoTrackingRule],
    inventory: &BranchInventory,
) -> Vec<AutoTrackingValidation> {
    let mut source_counts = BTreeMap::<String, usize>::new();
    for rule in rules {
        *source_counts
            .entry(rule.source_branch.trim().to_owned())
            .or_default() += 1;
    }
    let cycle_sources = cyclic_auto_tracking_sources(rules);

    rules
        .iter()
        .cloned()
        .map(|rule| {
            let source = rule.source_branch.trim();
            let target = rule.target_branch.trim();
            let message = if source.is_empty() || target.is_empty() {
                Some("自动跟踪规则缺少分支。".to_owned())
            } else if source == target {
                Some("自动跟踪规则不能指向自身。".to_owned())
            } else if source_counts.get(source).copied().unwrap_or(0) > 1 {
                Some("每个源分支只能有一条自动跟踪规则。".to_owned())
            } else if cycle_sources.contains(source) {
                Some("自动跟踪规则不能成环。".to_owned())
            } else if !inventory.local_branches.contains(source) {
                Some("源分支必须是本地分支。".to_owned())
            } else if !inventory.remote_branches.contains(source) {
                Some("源分支必须有对应的 origin 远程分支。".to_owned())
            } else if !inventory.remote_branches.contains(target) {
                Some("目标分支必须是 origin 上存在的远程分支。".to_owned())
            } else {
                None
            };

            AutoTrackingValidation {
                rule: AutoTrackingRule {
                    source_branch: source.to_owned(),
                    target_branch: target.to_owned(),
                },
                message,
            }
        })
        .collect()
}

pub fn validate_auto_tracking_rules(rules: &[AutoTrackingRule]) -> AppResult<()> {
    let mut sources = BTreeSet::new();
    for rule in rules {
        let source = rule.source_branch.trim();
        let target = rule.target_branch.trim();
        if source.is_empty() || target.is_empty() {
            return Err(AppError::expected(
                "自动跟踪规则缺少分支。",
                "saveProjectSettings",
            ));
        }
        if source == target {
            return Err(AppError::expected(
                "自动跟踪规则不能指向自身。",
                "saveProjectSettings",
            ));
        }
        if !sources.insert(source.to_owned()) {
            return Err(AppError::expected(
                "每个源分支只能有一条自动跟踪规则。",
                "saveProjectSettings",
            ));
        }
    }
    if !cyclic_auto_tracking_sources(rules).is_empty() {
        return Err(AppError::expected(
            "自动跟踪规则不能成环。",
            "saveProjectSettings",
        ));
    }
    Ok(())
}

fn cyclic_auto_tracking_sources(rules: &[AutoTrackingRule]) -> BTreeSet<String> {
    let graph = rules
        .iter()
        .map(|rule| {
            (
                rule.source_branch.trim().to_owned(),
                rule.target_branch.trim().to_owned(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut cyclic = BTreeSet::new();
    for source in graph.keys() {
        let mut seen = BTreeSet::new();
        let mut cursor = source.as_str();
        while let Some(next) = graph.get(cursor) {
            if !seen.insert(cursor.to_owned()) {
                cyclic.extend(seen);
                break;
            }
            cursor = next;
        }
    }
    cyclic
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

fn merge_base(
    runner: &GitRunner,
    root: &Path,
    left: &str,
    right: &str,
) -> AppResult<Option<String>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["merge-base", left, right],
        SYNC_BRANCH_OPERATION,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(command_failure(&plan, output, "无法判断远程历史状态。"))
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

fn create_accept_remote_history_auto_stash(
    runner: &GitRunner,
    root: &Path,
) -> AppResult<Option<StashEntry>> {
    Ok(crate::stash_impl::create_auto_stash(
        runner,
        CreateAutoStashRequest {
            repository_path: display_path(root),
            reason: "before accepting remote history".to_owned(),
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

fn sync_all_operation_id() -> OperationId {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    OperationId(format!("sync-all-branches-{millis}"))
}

fn accept_remote_history_operation_id() -> OperationId {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    OperationId(format!("accept-remote-history-{millis}"))
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
        remote_history_change: None,
    }
}

fn remote_history_changed_response(
    root: &Path,
    branch_name: &str,
    upstream: Option<String>,
    attempts: u8,
    remote_history_change: RemoteHistoryChange,
) -> SyncCurrentBranchResponse {
    SyncCurrentBranchResponse {
        repository_path: display_path(root),
        branch_name: branch_name.to_owned(),
        upstream,
        status: SyncCurrentBranchStatus::RemoteHistoryChanged,
        attempts,
        conflict: None,
        stash_recovery: None,
        remote_history_change: Some(remote_history_change),
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
        remote_history_change: None,
    }
}

fn sync_branch_response_from_current(response: SyncCurrentBranchResponse) -> SyncBranchResponse {
    SyncBranchResponse {
        repository_path: response.repository_path,
        branch_name: response.branch_name,
        upstream: response.upstream,
        status: response.status,
        attempts: response.attempts,
        message: None,
        conflict: response.conflict,
        stash_recovery: response.stash_recovery,
        remote_history_change: response.remote_history_change,
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
        message: None,
        conflict: response.conflict,
        stash_recovery: response.stash_recovery,
        remote_history_change: response.remote_history_change,
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
    use artistic_git_core::config::AutoTrackingRule;
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
    fn sync_current_branch_updates_submodule_after_fast_forward_pull() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let fixture = SubmoduleSyncFixture::new(&runner);

        fixture.child.write("tracked.txt", "two\n");
        fixture.child.git(["add", "tracked.txt"]);
        fixture.child.git(["commit", "-m", "update child"]);
        let new_child_oid = fixture
            .child
            .git_output(["rev-parse", "HEAD"])
            .trim()
            .to_owned();

        let peer_submodule = fixture.peer.path.join("deps/lib");
        crate::git_ops::git_stdout(&runner, Some(&peer_submodule), ["fetch", "origin"], "test")
            .expect("fetch child update");
        crate::git_ops::git_stdout(
            &runner,
            Some(&peer_submodule),
            ["checkout", new_child_oid.as_str()],
            "test",
        )
        .expect("checkout child update");
        fixture.peer.git(["add", "deps/lib"]);
        fixture
            .peer
            .git(["commit", "-m", "update submodule pointer"]);
        fixture.peer.git(["push"]);

        let events = std::cell::RefCell::new(Vec::new());
        let response = sync_current_branch_with_progress(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
            |event| events.borrow_mut().push(event),
        )
        .expect("sync current branch");

        assert_eq!(response.status, SyncCurrentBranchStatus::Pulled);
        assert_eq!(fixture.local.read("deps/lib/tracked.txt"), "two\n");
        assert_eq!(
            crate::git_ops::git_stdout(
                &runner,
                Some(&fixture.local.path.join("deps/lib")),
                ["rev-parse", "HEAD"],
                "test",
            )
            .expect("local child head")
            .trim(),
            new_child_oid
        );
        assert!(fixture.local.status_clean());
        assert!(events
            .borrow()
            .iter()
            .any(|event| event.label == "Updating submodules"));
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
    fn sync_branch_publishes_non_current_branch_without_touching_worktree() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.git(["checkout", "-b", "feature/unpublished"]);
        fixture.local.write("feature.txt", "feature\n");
        fixture.local.git(["add", "feature.txt"]);
        fixture.local.git(["commit", "-m", "feature"]);
        fixture.local.git(["checkout", "main"]);
        fixture
            .local
            .write("tracked.txt", "dirty current worktree\n");

        let response = sync_branch(
            &runner,
            SyncBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/unpublished".to_owned(),
                operation_id: None,
            },
        )
        .expect("publish non-current branch");

        assert_eq!(response.status, SyncCurrentBranchStatus::Published);
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
        assert_eq!(
            fixture
                .local
                .git_output([
                    "rev-parse",
                    "--abbrev-ref",
                    "--symbolic-full-name",
                    "feature/unpublished@{u}",
                ])
                .trim(),
            "origin/feature/unpublished"
        );
        assert!(fixture
            .remote
            .git_output([
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/feature/unpublished"
            ])
            .contains("refs/heads/feature/unpublished"));
        assert_no_sync_worktrees(&fixture.local);
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
    fn sync_all_branches_syncs_current_and_non_current_tracking_branches() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.create_tracking_branch("feature/batch");

        fixture.peer.git(["checkout", "main"]);
        fixture.peer.write("main-remote.txt", "main remote\n");
        fixture.peer.git(["add", "main-remote.txt"]);
        fixture.peer.git(["commit", "-m", "main remote"]);
        fixture.peer.git(["push"]);

        fixture.peer.git(["checkout", "feature/batch"]);
        fixture.peer.write("feature-remote.txt", "feature remote\n");
        fixture.peer.git(["add", "feature-remote.txt"]);
        fixture.peer.git(["commit", "-m", "feature remote"]);
        fixture.peer.git(["push"]);

        fixture.local.git(["checkout", "feature/batch"]);
        fixture.local.write("feature-local.txt", "feature local\n");
        fixture.local.git(["add", "feature-local.txt"]);
        fixture.local.git(["commit", "-m", "feature local"]);
        fixture.local.git(["checkout", "main"]);
        fixture.local.write("tracked.txt", "dirty current\n");

        let response = sync_all_branches_with_progress(
            &runner,
            None,
            SyncAllBranchesRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: Some(OperationId("sync-all-test".to_owned())),
            },
            |_| {},
        )
        .expect("sync all branches");

        assert_eq!(response.branches.len(), 2);
        assert!(response
            .branches
            .iter()
            .any(|branch| branch.branch_name == "main"
                && branch.status == SyncCurrentBranchStatus::Pulled));
        assert!(response.branches.iter().any(|branch| {
            branch.branch_name == "feature/batch"
                && branch.status == SyncCurrentBranchStatus::PulledAndPushed
        }));
        assert_eq!(fixture.local.read("tracked.txt"), "dirty current\n");
        assert!(fixture.local.path.join("main-remote.txt").exists());
        assert_eq!(
            fixture.local.show("feature/batch", "feature-remote.txt"),
            "feature remote\n"
        );
        fixture.peer.git(["checkout", "feature/batch"]);
        fixture.peer.git(["pull", "--ff-only"]);
        assert_eq!(fixture.peer.read("feature-local.txt"), "feature local\n");
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn auto_tracking_rule_fast_forwards_source_to_remote_target_and_pushes() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.create_tracking_branch("stable");
        fixture.create_tracking_branch("release");

        fixture.peer.git(["checkout", "release"]);
        fixture.peer.write("release.txt", "release\n");
        fixture.peer.git(["add", "release.txt"]);
        fixture.peer.git(["commit", "-m", "release update"]);
        fixture.peer.git(["push"]);
        fixture.local.write("tracked.txt", "dirty current\n");

        let results = apply_auto_tracking_rules(
            &runner,
            &fixture.local.path,
            &OperationId("auto-tracking-test".to_owned()),
            &[AutoTrackingRule {
                source_branch: "stable".to_owned(),
                target_branch: "release".to_owned(),
            }],
            &|_| {},
        )
        .expect("apply auto tracking");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, AutoTrackingRuleStatus::Applied);
        assert_eq!(
            fixture.local.git_output(["rev-parse", "stable"]),
            fixture.local.git_output(["rev-parse", "origin/release"])
        );
        fixture.peer.git(["checkout", "stable"]);
        fixture.peer.git(["pull", "--ff-only"]);
        assert_eq!(fixture.peer.read("release.txt"), "release\n");
        assert_eq!(fixture.local.read("tracked.txt"), "dirty current\n");
        assert!(fixture.local.status_clean());
    }

    #[test]
    fn auto_tracking_validation_rejects_duplicate_sources_and_cycles() {
        let duplicate = validate_auto_tracking_rules(&[
            AutoTrackingRule {
                source_branch: "a".to_owned(),
                target_branch: "b".to_owned(),
            },
            AutoTrackingRule {
                source_branch: "a".to_owned(),
                target_branch: "c".to_owned(),
            },
        ])
        .expect_err("duplicate source should fail");
        assert!(duplicate.summary.contains("源分支"));

        let cycle = validate_auto_tracking_rules(&[
            AutoTrackingRule {
                source_branch: "a".to_owned(),
                target_branch: "b".to_owned(),
            },
            AutoTrackingRule {
                source_branch: "b".to_owned(),
                target_branch: "a".to_owned(),
            },
        ])
        .expect_err("cycle should fail");
        assert!(cycle.summary.contains("成环"));
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
    fn remote_history_rewrite_requires_confirmation_and_accept_creates_local_backup() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("published.txt", "published\n");
        fixture.local.git(["add", "published.txt"]);
        fixture
            .local
            .git(["commit", "-m", "published local change"]);
        fixture.local.git(["push"]);
        let published_head = fixture.local.git_output(["rev-parse", "HEAD"]);

        fixture.peer.write("rewrite.txt", "rewrite\n");
        fixture.peer.git(["add", "rewrite.txt"]);
        fixture.peer.git(["commit", "-m", "rewrite remote history"]);
        let remote_head = fixture.peer.git_output(["rev-parse", "HEAD"]);
        let force_arg = ["--", "force"].concat();
        fixture
            .peer
            .git(["push", force_arg.as_str(), "origin", "main"]);

        let response = sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect("sync detects rewritten remote history");

        assert_eq!(
            response.status,
            SyncCurrentBranchStatus::RemoteHistoryChanged
        );
        let change = response
            .remote_history_change
            .expect("remote history change");
        assert_eq!(change.branch_name, "main");
        assert_eq!(change.local_head, published_head.trim());
        assert_eq!(change.previous_remote_head, published_head.trim());
        assert_eq!(change.remote_head, remote_head.trim());
        assert_eq!(
            fixture.local.git_output(["rev-parse", "HEAD"]),
            published_head
        );
        assert!(fixture.local.path.join("published.txt").exists());
        assert!(!fixture.local.path.join("rewrite.txt").exists());

        let accept = accept_remote_history(
            &runner,
            AcceptRemoteHistoryRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "main".to_owned(),
                operation_id: None,
            },
        )
        .expect("accept rewritten remote history");

        assert!(accept.backup.name.starts_with("backup/main-"));
        assert_eq!(
            fixture
                .local
                .git_output(["rev-parse", accept.backup.name.as_str()]),
            published_head
        );
        assert_eq!(
            fixture
                .local
                .show(accept.backup.name.as_str(), "published.txt"),
            "published\n"
        );
        assert_eq!(fixture.local.git_output(["rev-parse", "HEAD"]), remote_head);
        assert!(fixture.local.path.join("rewrite.txt").exists());
        assert!(!fixture.local.path.join("published.txt").exists());
        assert!(fixture
            .remote
            .git_output(["for-each-ref", "--format=%(refname)", "refs/heads/backup"])
            .trim()
            .is_empty());
        assert!(fixture.local.status_clean());
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

    struct SubmoduleSyncFixture {
        child: TestRepo,
        local: TestRepo,
        peer: TestRepo,
        _remote: TestRepo,
        _seed: TestRepo,
        _parent: TestTempDir,
    }

    impl SubmoduleSyncFixture {
        fn new(runner: &GitRunner) -> Self {
            let parent = TestTempDir::new("ag-sync-submodule").expect("submodule parent");
            let child = TestRepo::at(runner, parent.path().join("child"));
            child.git(["init"]);
            child.configure_identity();
            child.write("tracked.txt", "one\n");
            child.git(["add", "tracked.txt"]);
            child.git(["commit", "-m", "initial child"]);

            let remote = TestRepo::at(runner, parent.path().join("remote.git"));
            remote.git(["init", "--bare"]);

            let seed = TestRepo::at(runner, parent.path().join("seed"));
            seed.git(["init", "-b", "main"]);
            seed.configure_identity();
            seed.git([
                OsString::from("-c"),
                OsString::from("protocol.file.allow=always"),
                OsString::from("submodule"),
                OsString::from("add"),
                OsString::from(display_path(&child.path)),
                OsString::from("deps/lib"),
            ]);
            seed.git(["commit", "-m", "add submodule"]);
            seed.git([
                "remote",
                "add",
                "origin",
                display_path(&remote.path).as_str(),
            ]);
            seed.git(["push", "-u", "origin", "main"]);
            remote.git(["symbolic-ref", "HEAD", "refs/heads/main"]);

            let local = TestRepo::at(runner, parent.path().join("local"));
            git_clone_recurse_submodules(runner, &remote.path, &local.path);
            local.configure_identity();

            let peer = TestRepo::at(runner, parent.path().join("peer"));
            git_clone_recurse_submodules(runner, &remote.path, &peer.path);
            peer.configure_identity();

            Self {
                child,
                local,
                peer,
                _remote: remote,
                _seed: seed,
                _parent: parent,
            }
        }
    }

    fn git_clone_recurse_submodules(runner: &GitRunner, remote: &Path, destination: &Path) {
        crate::git_ops::git_stdout(
            runner,
            None,
            [
                OsString::from("-c"),
                OsString::from("protocol.file.allow=always"),
                OsString::from("clone"),
                OsString::from("--recurse-submodules"),
                OsString::from(display_path(remote)),
                OsString::from(display_path(destination)),
            ],
            "test",
        )
        .expect("clone recurse submodules");
    }

    fn allow_file_protocol_for_local_submodule_fixtures(runner: &GitRunner) {
        crate::git_ops::git_stdout(
            runner,
            None,
            ["config", "--global", "protocol.file.allow", "always"],
            "test",
        )
        .expect("allow file protocol for local submodule fixtures");
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
