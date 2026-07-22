use artistic_git_contracts::{
    AppError, AppResult, CancelStashRestoreRequest, CancelStashRestoreResponse, CommitChangedFile,
    ConflictEnteredEvent, ConflictFile, ConflictResolutionStatus, CreateAutoStashRequest,
    CreateStashRequest, CreateStashResponse, DeleteStashRequest, DeleteStashResponse,
    DiffChangeKind, DiffFileKind, GitCommandError, OperationContext, OperationId,
    RestoreStashRequest, RestoreStashResponse, StashChangedFile, StashDetailsRequest,
    StashDetailsResponse, StashEntry, StashFileDetailRequest, StashFileDetailResponse,
    StashListResponse, StashRecoveryPoint, StashRestoreOutcome,
};
use artistic_git_core::diff_engine::OVERSIZED_TEXT_BYTES;
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use std::{
    ffi::OsString,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::mpsc::{self, Receiver, TryRecvError},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const AUTO_STASH_PREFIX: &str = "Auto Stash:";
const RECOVERY_STASH_REASON: &str = "stash apply recovery";
const STASH_DETAILS_OUTPUT_LIMIT_BYTES: usize = OVERSIZED_TEXT_BYTES;
const STASH_DETAILS_FILE_LIMIT: usize = 5_000;
const STASH_LIST_ENTRY_LIMIT: usize = 5_000;
const GIT_ERROR_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;
const OUTPUT_READER_GRACE_PERIOD: Duration = Duration::from_secs(2);

pub fn list_stashes(
    runner: &GitRunner,
    request: artistic_git_contracts::RepositoryPathRequest,
) -> AppResult<StashListResponse> {
    let root = canonical_repository_path(&request.repository_path, "listStashes")?;
    list_stashes_for_root(runner, &root, "listStashes")
}

pub fn create_stash(
    runner: &GitRunner,
    request: CreateStashRequest,
) -> AppResult<CreateStashResponse> {
    create_stash_with_message(
        runner,
        &request.repository_path,
        normalize_manual_stash_message(&request.message)?,
        request.include_untracked,
        request.paths,
        "createStash",
    )
}

pub fn create_auto_stash(
    runner: &GitRunner,
    request: CreateAutoStashRequest,
) -> AppResult<CreateStashResponse> {
    let reason = normalize_auto_stash_reason(&request.reason)?;
    create_stash_with_message(
        runner,
        &request.repository_path,
        format!("{AUTO_STASH_PREFIX} {reason}"),
        request.include_untracked,
        request.paths,
        "createAutoStash",
    )
}

pub fn delete_stash(
    runner: &GitRunner,
    request: DeleteStashRequest,
) -> AppResult<DeleteStashResponse> {
    let root = canonical_repository_path(&request.repository_path, "deleteStash")?;
    let selector = request.selector.trim();
    if selector.is_empty() {
        return Err(logged(AppError::expected(
            "stash selector is empty",
            "deleteStash",
        )));
    }

    let output = run_git(
        runner,
        Some(&root),
        ["stash", "drop", selector],
        "deleteStash",
    )?;
    Ok(DeleteStashResponse {
        deleted_selector: selector.to_owned(),
        stdout: output.stdout,
    })
}

pub fn stash_details(
    runner: &GitRunner,
    request: StashDetailsRequest,
) -> AppResult<StashDetailsResponse> {
    let root = canonical_repository_path(&request.repository_path, "stashDetails")?;
    let selector = request.selector.trim();
    if selector.is_empty() {
        return Err(logged(AppError::expected(
            "stash selector is empty",
            "stashDetails",
        )));
    }

    let entry = stash_entry_for_selector(runner, &root, selector, "stashDetails")?;
    let files = stash_changed_files(runner, &root, selector, "stashDetails")?;

    Ok(StashDetailsResponse { entry, files })
}

pub fn stash_file_detail(
    runner: &GitRunner,
    request: StashFileDetailRequest,
) -> AppResult<StashFileDetailResponse> {
    const OPERATION: &str = "stashFileDetail";
    let root = canonical_repository_path(&request.repository_path, OPERATION)?;
    let selector = request.selector.trim();
    if selector.is_empty() {
        return Err(logged(AppError::expected(
            "stash selector is empty",
            OPERATION,
        )));
    }
    let requested_path = request.path.as_str();
    if requested_path.is_empty() {
        return Err(logged(AppError::expected("stash path is empty", OPERATION)));
    }

    let entry = stash_entry_for_selector(runner, &root, selector, OPERATION)?;
    let file = stash_changed_files(runner, &root, selector, OPERATION)?
        .into_iter()
        .find(|file| file.path == requested_path)
        .ok_or_else(|| {
            logged(AppError::expected(
                "the selected stash file no longer exists; reload the stash and try again",
                OPERATION,
            ))
        })?;
    let parents = stash_commit_parents(runner, &root, &entry.oid, OPERATION)?;
    let Some(first_parent) = parents.first() else {
        return Err(logged(AppError::expected(
            "the selected stash has no base commit",
            OPERATION,
        )));
    };

    let old_path = file.old_path.as_deref().unwrap_or(file.path.as_str());
    let old_revision_and_path =
        (file.change_kind != DiffChangeKind::Added).then_some((first_parent.as_str(), old_path));
    let new_revision = if file.change_kind == DiffChangeKind::Deleted {
        None
    } else {
        Some(
            stash_file_new_revision(
                runner,
                &root,
                &entry.oid,
                parents.get(2).map(String::as_str),
                &file.path,
                OPERATION,
            )?
            .ok_or_else(|| {
                logged(AppError::expected(
                "the selected stash file content no longer exists; reload the stash and try again",
                OPERATION,
            ))
            })?,
        )
    };
    let new_revision_and_path = new_revision.map(|revision| (revision, file.path.as_str()));
    let historical_file = CommitChangedFile {
        path: file.path.clone(),
        old_path: file.old_path.clone(),
        old_mode: None,
        new_mode: None,
        change_kind: file.change_kind,
        additions: 0,
        deletions: 0,
    };
    let (payload, diff) = crate::repository::historical_file_diff(
        runner,
        &root,
        &historical_file,
        old_revision_and_path,
        new_revision_and_path,
        OPERATION,
    )?;

    Ok(StashFileDetailResponse {
        selector: entry.selector,
        file,
        payload,
        diff,
    })
}

pub fn restore_stash(
    runner: &GitRunner,
    request: RestoreStashRequest,
) -> AppResult<RestoreStashResponse> {
    let operation_id = request.operation_id.clone();
    let operation_name = request
        .operation_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("restoreStash");
    let root = canonical_repository_path(&request.repository_path, operation_name)?;
    let selector = request.selector.trim();
    if selector.is_empty() {
        return Err(logged(AppError::expected(
            "stash selector is empty",
            operation_name,
        )));
    }

    restore_stash_for_root(
        runner,
        &root,
        selector,
        request.drop_on_success,
        operation_name,
        operation_id.as_ref(),
    )
}

pub(crate) fn restore_stash_for_root(
    runner: &GitRunner,
    root: &Path,
    selector: &str,
    drop_on_success: bool,
    operation_name: &str,
    recovery_id: Option<&OperationId>,
) -> AppResult<RestoreStashResponse> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(logged(AppError::expected(
            "stash selector is empty",
            operation_name,
        )));
    }

    let oid = resolve_revision(runner, root, selector, operation_name)?;
    let recovery = create_recovery_point(runner, root, operation_name, recovery_id)?;
    if let Some(recovery_selector) = recovery.stash_selector.as_deref() {
        git_stdout(
            runner,
            Some(root),
            ["stash", "apply", "--index", recovery_selector],
            operation_name,
        )?;
    }

    let apply_result = run_git(
        runner,
        Some(root),
        ["stash", "apply", oid.as_str()],
        operation_name,
    );
    match apply_result {
        Ok(_) => {
            let mut dropped = false;
            if drop_on_success {
                dropped = drop_stash_by_oid(runner, root, &oid, operation_name)?;
            }
            if let Some(recovery_oid) = recovery.stash_oid.as_deref() {
                let _ = drop_stash_by_oid(runner, root, recovery_oid, operation_name);
            }
            Ok(RestoreStashResponse {
                selector: selector.to_owned(),
                oid,
                recovery,
                outcome: StashRestoreOutcome::Applied { dropped },
            })
        }
        Err(error)
            if repository_has_conflicts(runner, root) || is_stash_apply_conflict_error(&error) =>
        {
            let conflict = ConflictEnteredEvent {
                operation_id: OperationId(recovery.id.clone()),
                repository_path: display_path(root),
                operation_name: operation_name.to_owned(),
                files: list_conflict_files(runner, root, operation_name)?,
            };
            Ok(RestoreStashResponse {
                selector: selector.to_owned(),
                oid,
                recovery,
                outcome: StashRestoreOutcome::Conflicts { conflict },
            })
        }
        Err(error) => {
            let repository_path = display_path(root);
            let recovery = recovery.clone();
            crate::git_ops::without_cancel_token(|| {
                let _ = cancel_stash_restore(
                    runner,
                    CancelStashRestoreRequest {
                        repository_path,
                        recovery,
                    },
                );
            });
            Err(error)
        }
    }
}

pub fn cancel_stash_restore(
    runner: &GitRunner,
    request: CancelStashRestoreRequest,
) -> AppResult<CancelStashRestoreResponse> {
    let root = canonical_repository_path(&request.repository_path, "cancelStashRestore")?;
    let recovery = request.recovery;

    if let Some(head_oid) = recovery.head_oid.as_deref() {
        git_stdout(
            runner,
            Some(&root),
            ["reset", "--hard", head_oid],
            "cancelStashRestore",
        )?;
    } else {
        git_stdout(
            runner,
            Some(&root),
            ["reset", "--hard"],
            "cancelStashRestore",
        )?;
    }
    git_stdout(runner, Some(&root), ["clean", "-fd"], "cancelStashRestore")?;

    restore_pre_operation_ref(runner, &root, &recovery)?;

    let mut restored = recovery.stash_oid.is_none();
    let mut dropped_recovery_stash = false;
    if let Some(stash_oid) = recovery.stash_oid.as_deref() {
        let selector = selector_for_oid(runner, &root, stash_oid, "cancelStashRestore")?;
        git_stdout(
            runner,
            Some(&root),
            ["stash", "apply", "--index", selector.as_str()],
            "cancelStashRestore",
        )?;
        dropped_recovery_stash = drop_stash_by_oid(runner, &root, stash_oid, "cancelStashRestore")?;
        restored = true;
    }

    if let Some(stash_oid) = recovery.pre_operation_stash_oid.as_deref() {
        let selector = selector_for_oid(runner, &root, stash_oid, "cancelStashRestore")?;
        git_stdout(
            runner,
            Some(&root),
            ["stash", "apply", "--index", selector.as_str()],
            "cancelStashRestore",
        )?;
        let _ = drop_stash_by_oid(runner, &root, stash_oid, "cancelStashRestore")?;
        restored = true;
    }

    Ok(CancelStashRestoreResponse {
        restored,
        dropped_recovery_stash,
    })
}

fn restore_pre_operation_ref(
    runner: &GitRunner,
    root: &Path,
    recovery: &StashRecoveryPoint,
) -> AppResult<()> {
    if let Some(branch) = recovery.pre_operation_branch.as_deref() {
        git_stdout(
            runner,
            Some(root),
            ["checkout", branch],
            "cancelStashRestore",
        )?;
    } else if let Some(head_oid) = recovery.pre_operation_head_oid.as_deref() {
        git_stdout(
            runner,
            Some(root),
            ["checkout", "--detach", head_oid],
            "cancelStashRestore",
        )?;
    }

    Ok(())
}

fn create_stash_with_message(
    runner: &GitRunner,
    repository_path: &str,
    message: String,
    include_untracked: bool,
    paths: Vec<String>,
    operation_name: &str,
) -> AppResult<CreateStashResponse> {
    let root = canonical_repository_path(repository_path, operation_name)?;
    let before = top_stash_oid(runner, &root, operation_name)?;
    let mut args = vec![
        OsString::from("stash"),
        OsString::from("push"),
        OsString::from("-m"),
        OsString::from(message),
    ];
    if include_untracked {
        args.push(OsString::from("-u"));
    }

    let paths = normalize_paths(paths);
    if !paths.is_empty() {
        args.push(OsString::from("--"));
        args.extend(paths.into_iter().map(crate::git_ops::literal_pathspec));
    }

    let output = run_git(runner, Some(&root), args, operation_name)?;
    let after = top_stash_entry(runner, &root, operation_name)?;
    let created = after
        .as_ref()
        .map(|entry| Some(entry.oid.as_str()) != before.as_deref())
        .unwrap_or(false);

    Ok(CreateStashResponse {
        created,
        stash: created.then_some(after).flatten(),
        stdout: output.stdout,
    })
}

fn create_recovery_point(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
    requested_id: Option<&OperationId>,
) -> AppResult<StashRecoveryPoint> {
    let head_oid = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--verify", "HEAD"],
        operation_name,
    )
    .ok()
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty());
    let id = requested_id
        .map(|value| value.0.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("stash-restore-{}", unix_now_millis()));

    if !has_local_changes(runner, root, operation_name)? {
        return Ok(StashRecoveryPoint {
            id,
            head_oid,
            stash_oid: None,
            stash_selector: None,
            pre_operation_branch: None,
            pre_operation_head_oid: None,
            pre_operation_stash_oid: None,
        });
    }

    let message = format!("{AUTO_STASH_PREFIX} {RECOVERY_STASH_REASON} {id}");
    let before = top_stash_oid(runner, root, operation_name)?;
    run_git(
        runner,
        Some(root),
        ["stash", "push", "-u", "-m", message.as_str()],
        operation_name,
    )?;
    let stash = top_stash_entry(runner, root, operation_name)?.ok_or_else(|| {
        logged(AppError::unexpected(
            "failed to create stash apply recovery point",
            operation_name,
        ))
    })?;
    if Some(stash.oid.as_str()) == before.as_deref() {
        return Err(logged(AppError::unexpected(
            "stash apply recovery point did not change stash stack",
            operation_name,
        )));
    }

    Ok(StashRecoveryPoint {
        id,
        head_oid,
        stash_oid: Some(stash.oid),
        stash_selector: Some(stash.selector),
        pre_operation_branch: None,
        pre_operation_head_oid: None,
        pre_operation_stash_oid: None,
    })
}

fn list_stashes_for_root(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<StashListResponse> {
    let output = match git_stdout(
        runner,
        Some(root),
        [
            "stash",
            "list",
            "--max-count=5001",
            "--format=%gd%x00%H%x00%ct%x00%gs%x1e",
        ],
        operation_name,
    ) {
        Ok(output) => output,
        Err(error) if is_empty_stash_error(&error) => String::new(),
        Err(error) => return Err(error),
    };

    Ok(parse_stash_list_response(&output))
}

pub(crate) fn parse_stash_list_response(output: &str) -> StashListResponse {
    let mut stashes: Vec<_> = output
        .split('\x1e')
        .filter(|record| !record.trim().is_empty())
        .filter_map(parse_stash_record)
        .collect();
    let truncated = stashes.len() > STASH_LIST_ENTRY_LIMIT;
    stashes.truncate(STASH_LIST_ENTRY_LIMIT);

    StashListResponse { stashes, truncated }
}

fn stash_entry_for_selector(
    runner: &GitRunner,
    root: &Path,
    selector: &str,
    operation_name: &str,
) -> AppResult<StashEntry> {
    let oid = resolve_revision(runner, root, selector, operation_name)?;
    if let Some(entry) = list_stashes_for_root(runner, root, operation_name)?
        .stashes
        .into_iter()
        .find(|entry| entry.selector == selector || entry.oid == oid)
    {
        return Ok(entry);
    }

    let output = git_stdout(
        runner,
        Some(root),
        ["show", "-s", "--format=%ct%x00%gs", selector],
        operation_name,
    )?;
    let mut parts = output.trim_matches('\n').split('\0');
    let created_at_unix_seconds = parts
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let raw_message = parts.next().unwrap_or(selector);
    let message = display_stash_message(raw_message);

    Ok(StashEntry {
        index: 0,
        selector: selector.to_owned(),
        oid,
        branch: branch_from_stash_message(raw_message),
        origin: auto_stash_origin(&message),
        is_auto_stash: auto_stash_origin(&message).is_some(),
        message,
        created_at_unix_seconds,
    })
}

fn top_stash_entry(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Option<StashEntry>> {
    Ok(list_stashes_for_root(runner, root, operation_name)?
        .stashes
        .into_iter()
        .next())
}

fn top_stash_oid(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Option<String>> {
    Ok(top_stash_entry(runner, root, operation_name)?.map(|entry| entry.oid))
}

fn selector_for_oid(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    operation_name: &str,
) -> AppResult<String> {
    list_stashes_for_root(runner, root, operation_name)?
        .stashes
        .into_iter()
        .find(|entry| entry.oid == oid)
        .map(|entry| entry.selector)
        .ok_or_else(|| {
            logged(AppError::expected(
                "stash recovery point is no longer available",
                operation_name,
            ))
        })
}

fn drop_stash_by_oid(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    operation_name: &str,
) -> AppResult<bool> {
    let Some(selector) = list_stashes_for_root(runner, root, operation_name)?
        .stashes
        .into_iter()
        .find(|entry| entry.oid == oid)
        .map(|entry| entry.selector)
    else {
        return Ok(false);
    };

    git_stdout(
        runner,
        Some(root),
        ["stash", "drop", selector.as_str()],
        operation_name,
    )?;
    Ok(true)
}

fn parse_stash_record(record: &str) -> Option<StashEntry> {
    let parts = record
        .trim_matches(|value| value == '\n' || value == '\x1e')
        .split('\0')
        .collect::<Vec<_>>();
    if parts.len() < 4 {
        return None;
    }

    let selector = parts[0].to_owned();
    let index = selector
        .strip_prefix("stash@{")
        .and_then(|value| value.strip_suffix('}'))
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    let raw_message = parts[3];
    let message = display_stash_message(raw_message);
    let origin = auto_stash_origin(&message);

    Some(StashEntry {
        index,
        selector,
        oid: parts[1].to_owned(),
        branch: branch_from_stash_message(raw_message),
        created_at_unix_seconds: empty_to_none(parts[2]).map(str::to_owned),
        is_auto_stash: origin.is_some(),
        origin,
        message,
    })
}

fn stash_changed_files(
    runner: &GitRunner,
    root: &Path,
    selector: &str,
    operation_name: &str,
) -> AppResult<Vec<StashChangedFile>> {
    let name_status = git_output_bytes_bounded(
        runner,
        Some(root),
        [
            "stash",
            "show",
            "--include-untracked",
            "--name-status",
            "-z",
            "--find-renames",
            selector,
        ],
        operation_name,
        STASH_DETAILS_OUTPUT_LIMIT_BYTES,
        "Stash contains too many files to preview.",
    )?;
    let files = parse_stash_name_status(&name_status);
    if files.len() > STASH_DETAILS_FILE_LIMIT {
        return Err(stash_details_limit_error(
            root,
            operation_name,
            format!(
                "Stash contains too many files to preview (limit: {STASH_DETAILS_FILE_LIMIT} files; detected: {}).",
                files.len()
            ),
            None,
        ));
    }
    Ok(files)
}

fn parse_stash_name_status(output: &[u8]) -> Vec<StashChangedFile> {
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;

    while index < fields.len() {
        let status = fields[index].as_str();
        index += 1;
        let change_kind = change_kind_from_name_status(status);
        let (old_path, path) = if status.starts_with('R') || status.starts_with('C') {
            let old_path = fields.get(index).cloned();
            index += 1;
            let path = fields.get(index).cloned().unwrap_or_default();
            index += 1;
            (old_path, path)
        } else {
            let path = fields.get(index).cloned().unwrap_or_default();
            index += 1;
            (None, path)
        };

        if path.is_empty() {
            continue;
        }
        files.push(StashChangedFile {
            path,
            old_path,
            change_kind,
        });
    }

    files
}

fn stash_commit_parents(
    runner: &GitRunner,
    root: &Path,
    oid: &str,
    operation_name: &str,
) -> AppResult<Vec<String>> {
    let output = git_stdout(
        runner,
        Some(root),
        ["rev-list", "--parents", "-n", "1", oid],
        operation_name,
    )?;
    Ok(output
        .split_whitespace()
        .skip(1)
        .map(ToOwned::to_owned)
        .collect())
}

fn stash_file_new_revision<'a>(
    runner: &GitRunner,
    root: &Path,
    stash_revision: &'a str,
    untracked_revision: Option<&'a str>,
    path: &str,
    operation_name: &str,
) -> AppResult<Option<&'a str>> {
    if tree_contains_path(runner, root, stash_revision, path, operation_name)? {
        return Ok(Some(stash_revision));
    }
    if let Some(untracked_revision) = untracked_revision {
        if tree_contains_path(runner, root, untracked_revision, path, operation_name)? {
            return Ok(Some(untracked_revision));
        }
    }
    Ok(None)
}

fn tree_contains_path(
    runner: &GitRunner,
    root: &Path,
    revision: &str,
    path: &str,
    operation_name: &str,
) -> AppResult<bool> {
    let output = git_output_bytes(
        runner,
        Some(root),
        [
            OsString::from("ls-tree"),
            OsString::from("-z"),
            OsString::from(revision),
            OsString::from("--"),
            crate::git_ops::literal_pathspec(path),
        ],
        operation_name,
    )?;
    Ok(!output.is_empty())
}

fn change_kind_from_name_status(status: &str) -> DiffChangeKind {
    match status.chars().next() {
        Some('A') => DiffChangeKind::Added,
        Some('D') => DiffChangeKind::Deleted,
        Some('R') => DiffChangeKind::Renamed,
        Some('C') => DiffChangeKind::Copied,
        _ => DiffChangeKind::Modified,
    }
}

fn repository_has_conflicts(runner: &GitRunner, root: &Path) -> bool {
    list_conflict_files(runner, root, "restoreStash")
        .map(|files| !files.is_empty())
        .unwrap_or(false)
}

fn list_conflict_files(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Vec<ConflictFile>> {
    let output = git_output_bytes(
        runner,
        Some(root),
        ["status", "--porcelain=v1", "-z"],
        operation_name,
    )?;
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect::<Vec<_>>();

    Ok(fields
        .into_iter()
        .filter_map(|entry| {
            if entry.len() < 3 {
                return None;
            }
            let index_status = &entry[0..1];
            let worktree_status = &entry[1..2];
            let path = entry[3..].to_owned();
            is_unmerged_status(index_status, worktree_status).then_some(ConflictFile {
                path,
                status: ConflictResolutionStatus::Unresolved,
                file_kind: DiffFileKind::Text,
            })
        })
        .collect())
}

fn is_unmerged_status(index_status: &str, worktree_status: &str) -> bool {
    index_status == "U"
        || worktree_status == "U"
        || matches!(
            (index_status, worktree_status),
            ("A", "A") | ("D", "D") | ("A", "D") | ("D", "A")
        )
}

fn normalize_manual_stash_message(message: &str) -> AppResult<String> {
    let message = message.trim();
    if message.is_empty() {
        return Err(logged(AppError::expected(
            "stash name is empty",
            "createStash",
        )));
    }

    Ok(message.to_owned())
}

fn normalize_auto_stash_reason(reason: &str) -> AppResult<String> {
    let reason = reason
        .trim()
        .strip_prefix(AUTO_STASH_PREFIX)
        .unwrap_or_else(|| reason.trim())
        .trim();
    if reason.is_empty() {
        return Err(logged(AppError::expected(
            "auto stash reason is empty",
            "createAutoStash",
        )));
    }

    Ok(reason.to_owned())
}

fn normalize_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
        .collect()
}

fn auto_stash_origin(message: &str) -> Option<String> {
    let index = message.find(AUTO_STASH_PREFIX)?;
    let reason = message[index + AUTO_STASH_PREFIX.len()..].trim();
    Some(if reason.is_empty() {
        "unspecified".to_owned()
    } else {
        reason.to_owned()
    })
}

fn display_stash_message(message: &str) -> String {
    message
        .strip_prefix("On ")
        .and_then(|value| value.split_once(':').map(|(_, message)| message.trim()))
        .unwrap_or(message)
        .to_owned()
}

fn branch_from_stash_message(message: &str) -> Option<String> {
    message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))
        .and_then(|value| value.split_once(':').map(|(branch, _)| branch.to_owned()))
}

fn is_stash_apply_conflict_error(error: &AppError) -> bool {
    let mut text = error.summary.clone();
    if let Some(git) = error.git.as_ref() {
        text.push('\n');
        text.push_str(&git.stdout);
        text.push('\n');
        text.push_str(&git.stderr);
    }

    [
        "would be overwritten by merge",
        "The following untracked working tree files would be overwritten",
        "could not restore untracked files from stash",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn has_local_changes(runner: &GitRunner, root: &Path, operation_name: &str) -> AppResult<bool> {
    let output = git_output_bytes(
        runner,
        Some(root),
        ["status", "--porcelain=v1", "-z"],
        operation_name,
    )?;
    Ok(!output.is_empty())
}

fn resolve_revision(
    runner: &GitRunner,
    root: &Path,
    revision: &str,
    operation_name: &str,
) -> AppResult<String> {
    Ok(git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--verify", revision],
        operation_name,
    )?
    .trim()
    .to_owned())
}

fn git_stdout<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    run_git(runner, root, args, operation_name).map(|output| output.stdout)
}

fn git_output_bytes<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    crate::git_ops::run_git(runner, root, args, operation_name)
        .map(|output| output.stdout.into_bytes())
}

fn run_git<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<crate::git_ops::CommandOutput>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    crate::git_ops::run_git(runner, root, args, operation_name)
}

fn git_output_bytes_bounded<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
    limit_bytes: usize,
    limit_summary: &str,
) -> AppResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = plan_git(runner, root, args);
    bounded_command_output(
        plan.to_command(),
        &plan,
        root,
        operation_name,
        limit_bytes,
        limit_summary,
    )
}

fn bounded_command_output(
    mut command: Command,
    plan: &GitCommandPlan,
    root: Option<&Path>,
    operation_name: &str,
    limit_bytes: usize,
    limit_summary: &str,
) -> AppResult<Vec<u8>> {
    if crate::git_ops::active_cancel_token().is_some_and(|token| token.is_cancelled()) {
        return Err(logged(AppError::expected(
            "operation cancelled",
            operation_name,
        )));
    }

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::git_ops::prepare_child_process_tree(&mut command);
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(plan, source, operation_name))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = crate::git_ops::terminate_child_process_tree(&mut child);
        return Err(logged(AppError::unexpected(
            "failed to capture git stdout",
            operation_name,
        )));
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = crate::git_ops::terminate_child_process_tree(&mut child);
        return Err(logged(AppError::unexpected(
            "failed to capture git stderr",
            operation_name,
        )));
    };
    let stdout_rx = spawn_bounded_output_reader(stdout, limit_bytes, true);
    let stderr_rx = spawn_bounded_output_reader(stderr, GIT_ERROR_OUTPUT_LIMIT_BYTES, false);
    let cancel_token = crate::git_ops::active_cancel_token();
    let mut stdout_result = None;
    let mut stderr_result = None;

    let status = loop {
        if let Err(error) =
            receive_reader_result(&stdout_rx, &mut stdout_result, "stdout", operation_name)
        {
            let _ = crate::git_ops::terminate_child_process_tree(&mut child);
            return Err(error);
        }
        if let Err(error) =
            receive_reader_result(&stderr_rx, &mut stderr_result, "stderr", operation_name)
        {
            let _ = crate::git_ops::terminate_child_process_tree(&mut child);
            return Err(error);
        }
        if matches!(stdout_result, Some(BoundedOutput::LimitExceeded { .. })) {
            let Some(BoundedOutput::LimitExceeded {
                prefix,
                observed_bytes,
            }) = stdout_result.take()
            else {
                unreachable!("matched output limit")
            };
            let status = crate::git_ops::terminate_child_process_tree(&mut child).ok();
            let stderr = finish_stderr_for_error(stderr_result, &stderr_rx);
            return Err(stash_details_limit_error(
                root.unwrap_or_else(|| Path::new("")),
                operation_name,
                format!(
                    "{limit_summary} Preview limit: {limit_bytes} bytes; detected at least {observed_bytes} bytes."
                ),
                Some(GitCommandError {
                    command: plan.command_for_error(),
                    exit_code: status.and_then(|value| value.code()),
                    stdout: preview_limit_error_output(prefix),
                    stderr,
                }),
            ));
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None)
                if cancel_token
                    .as_ref()
                    .is_some_and(|token| token.is_cancelled()) =>
            {
                if let Some(status) = crate::git_ops::terminate_child_process_tree(&mut child)
                    .ok()
                    .filter(|status| status.success())
                {
                    break status;
                }
                return Err(logged(AppError::expected(
                    "operation cancelled",
                    operation_name,
                )));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => {
                let _ = crate::git_ops::terminate_child_process_tree(&mut child);
                return Err(spawn_error(plan, source, operation_name));
            }
        }
    };

    let stdout = finish_reader_result(stdout_result, &stdout_rx, "stdout", operation_name)?;
    let stderr = finish_reader_result(stderr_result, &stderr_rx, "stderr", operation_name)?;
    let stdout = match stdout {
        BoundedOutput::Complete(output) => output,
        BoundedOutput::LimitExceeded {
            prefix,
            observed_bytes,
        } => {
            return Err(stash_details_limit_error(
                root.unwrap_or_else(|| Path::new("")),
                operation_name,
                format!(
                    "{limit_summary} Preview limit: {limit_bytes} bytes; detected at least {observed_bytes} bytes."
                ),
                Some(GitCommandError {
                    command: plan.command_for_error(),
                    exit_code: status.code(),
                    stdout: preview_limit_error_output(prefix),
                    stderr: bounded_output_text(stderr),
                }),
            ));
        }
    };
    let stderr = bounded_output_bytes(stderr);

    if status.success() {
        Ok(stdout)
    } else {
        Err(crate::git_ops::command_failure(
            plan,
            Output {
                status,
                stdout,
                stderr,
            },
            operation_name,
        ))
    }
}

#[derive(Debug)]
enum BoundedOutput {
    Complete(Vec<u8>),
    LimitExceeded {
        prefix: Vec<u8>,
        observed_bytes: usize,
    },
}

fn spawn_bounded_output_reader<R>(
    mut reader: R,
    limit_bytes: usize,
    stop_on_limit: bool,
) -> Receiver<io::Result<BoundedOutput>>
where
    R: Read + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| {
            let mut prefix = Vec::with_capacity(limit_bytes.min(64 * 1024));
            let mut observed_bytes = 0usize;
            let mut buffer = [0u8; 16 * 1024];
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                observed_bytes = observed_bytes.saturating_add(read);
                let remaining = limit_bytes.saturating_sub(prefix.len());
                prefix.extend_from_slice(&buffer[..read.min(remaining)]);
                if observed_bytes > limit_bytes && stop_on_limit {
                    return Ok(BoundedOutput::LimitExceeded {
                        prefix,
                        observed_bytes,
                    });
                }
            }

            if observed_bytes > limit_bytes {
                Ok(BoundedOutput::LimitExceeded {
                    prefix,
                    observed_bytes,
                })
            } else {
                Ok(BoundedOutput::Complete(prefix))
            }
        })();
        let _ = sender.send(result);
    });
    receiver
}

fn receive_reader_result(
    receiver: &Receiver<io::Result<BoundedOutput>>,
    slot: &mut Option<BoundedOutput>,
    stream_name: &str,
    operation_name: &str,
) -> AppResult<()> {
    if slot.is_some() {
        return Ok(());
    }
    match receiver.try_recv() {
        Ok(Ok(output)) => {
            *slot = Some(output);
            Ok(())
        }
        Ok(Err(source)) => Err(output_reader_error(source, stream_name, operation_name)),
        Err(TryRecvError::Empty) => Ok(()),
        Err(TryRecvError::Disconnected) => Err(logged(AppError::unexpected(
            format!("git {stream_name} reader stopped without returning output"),
            operation_name,
        ))),
    }
}

fn finish_reader_result(
    ready: Option<BoundedOutput>,
    receiver: &Receiver<io::Result<BoundedOutput>>,
    stream_name: &str,
    operation_name: &str,
) -> AppResult<BoundedOutput> {
    if let Some(output) = ready {
        return Ok(output);
    }
    match receiver.recv_timeout(OUTPUT_READER_GRACE_PERIOD) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(source)) => Err(output_reader_error(source, stream_name, operation_name)),
        Err(source) => Err(logged(AppError::unexpected(
            format!("git {stream_name} did not close after the command exited: {source}"),
            operation_name,
        ))),
    }
}

fn finish_stderr_for_error(
    ready: Option<BoundedOutput>,
    receiver: &Receiver<io::Result<BoundedOutput>>,
) -> String {
    let output = ready.map(Ok).unwrap_or_else(|| {
        receiver
            .recv_timeout(Duration::from_millis(200))
            .unwrap_or_else(|source| {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("stderr was not available after stopping the command: {source}"),
                ))
            })
    });
    match output {
        Ok(output) => bounded_output_text(output),
        Err(source) => source.to_string(),
    }
}

fn bounded_output_bytes(output: BoundedOutput) -> Vec<u8> {
    match output {
        BoundedOutput::Complete(output) => output,
        BoundedOutput::LimitExceeded { prefix, .. } => {
            annotated_truncated_output(prefix, GIT_ERROR_OUTPUT_LIMIT_BYTES).into_bytes()
        }
    }
}

fn bounded_output_text(output: BoundedOutput) -> String {
    match output {
        BoundedOutput::Complete(output) => String::from_utf8_lossy(&output).into_owned(),
        BoundedOutput::LimitExceeded { prefix, .. } => {
            annotated_truncated_output(prefix, GIT_ERROR_OUTPUT_LIMIT_BYTES)
        }
    }
}

fn annotated_truncated_output(prefix: Vec<u8>, limit_bytes: usize) -> String {
    format!(
        "{}\n[output truncated after {limit_bytes} bytes]",
        String::from_utf8_lossy(&prefix)
    )
}

fn preview_limit_error_output(mut prefix: Vec<u8>) -> String {
    prefix.truncate(GIT_ERROR_OUTPUT_LIMIT_BYTES);
    annotated_truncated_output(prefix, GIT_ERROR_OUTPUT_LIMIT_BYTES)
}

fn output_reader_error(source: io::Error, stream_name: &str, operation_name: &str) -> AppError {
    logged(AppError::unexpected(
        format!("failed to read git {stream_name}: {source}"),
        operation_name,
    ))
}

fn stash_details_limit_error(
    root: &Path,
    operation_name: &str,
    summary: String,
    git: Option<GitCommandError>,
) -> AppError {
    let mut error = AppError::expected(summary, operation_name).with_context(
        OperationContext::new(operation_name).with_repository_path(display_path(root)),
    );
    if let Some(git) = git {
        error = error.with_git(git);
    }
    logged(error)
}

fn plan_git<I, S>(runner: &GitRunner, root: Option<&Path>, args: I) -> GitCommandPlan
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut planned_args = Vec::new();
    if let Some(root) = root {
        planned_args.push(OsString::from("-C"));
        planned_args.push(root.as_os_str().to_owned());
    }
    planned_args.extend(args.into_iter().map(Into::into));

    runner
        .git_command_builder()
        .enable_rename_detection()
        .enable_windows_longpaths()
        .args(planned_args)
        .build()
}

fn spawn_error(plan: &GitCommandPlan, source: io::Error, operation_name: &str) -> AppError {
    logged(
        AppError::fatal(
            format!("embedded git command could not be executed: {source}"),
            operation_name,
        )
        .with_git(GitCommandError {
            command: plan.command_for_error(),
            exit_code: None,
            stdout: String::new(),
            stderr: source.to_string(),
        }),
    )
}

fn canonical_repository_path(path: &str, operation_name: &str) -> AppResult<PathBuf> {
    fs::canonicalize(path).map_err(|source| {
        logged(AppError::expected(
            format!("failed to resolve repository path: {source}"),
            operation_name,
        ))
    })
}

fn is_empty_stash_error(error: &AppError) -> bool {
    error
        .git
        .as_ref()
        .map(|git| git.stderr.contains("No stash entries found"))
        .unwrap_or(false)
}

fn empty_to_none(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn unix_now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn logged(error: AppError) -> AppError {
    crate::logged_app_error(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_contracts::{DiffContent, RepositoryPathRequest};
    use artistic_git_git_runner::{CancelToken, GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, TestTempDir};
    use std::{io::Cursor, io::Write};

    #[test]
    fn parses_auto_stash_reason_from_git_subject() {
        let entry = parse_stash_record(concat!(
            "stash@{0}",
            "\0",
            "abc",
            "\0",
            "1700000000",
            "\0",
            "On main: Auto Stash: switch branch",
            "\x1e"
        ))
        .expect("stash entry");

        assert!(entry.is_auto_stash);
        assert_eq!(entry.message, "Auto Stash: switch branch");
        assert_eq!(entry.origin.as_deref(), Some("switch branch"));
        assert_eq!(entry.branch.as_deref(), Some("main"));
    }

    #[test]
    fn normalizes_explicit_stash_subject_display_message() {
        let entry = parse_stash_record(concat!(
            "stash@{0}",
            "\0",
            "abc",
            "\0",
            "1700000000",
            "\0",
            "On main: manual full stash",
            "\x1e"
        ))
        .expect("stash entry");

        assert_eq!(entry.message, "manual full stash");
        assert_eq!(entry.branch.as_deref(), Some("main"));
        assert!(!entry.is_auto_stash);
    }

    #[test]
    fn stash_list_response_caps_entries_and_reports_truncation() {
        let output = (0..=STASH_LIST_ENTRY_LIMIT)
            .map(|index| {
                format!("stash@{{{index}}}\0oid-{index}\01700000000\0On main: stash {index}\x1e")
            })
            .collect::<String>();

        let response = parse_stash_list_response(&output);

        assert_eq!(response.stashes.len(), STASH_LIST_ENTRY_LIMIT);
        assert!(response.truncated);
        assert_eq!(
            response.stashes.last().map(|stash| stash.selector.as_str()),
            Some("stash@{4999}")
        );
    }

    #[test]
    fn parses_name_status_metadata() {
        let status = b"M\0src/a.txt\0R100\0old.txt\0new.txt\0";
        let files = parse_stash_name_status(status);

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/a.txt");
        assert_eq!(files[0].change_kind, DiffChangeKind::Modified);
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].change_kind, DiffChangeKind::Renamed);
    }

    #[test]
    fn bounded_reader_stops_after_the_configured_prefix() {
        let receiver = spawn_bounded_output_reader(Cursor::new(vec![b'x'; 64]), 16, true);
        let output = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("reader result")
            .expect("read output");

        match output {
            BoundedOutput::LimitExceeded {
                prefix,
                observed_bytes,
            } => {
                assert_eq!(prefix.len(), 16);
                assert!(observed_bytes > 16);
            }
            BoundedOutput::Complete(_) => panic!("expected output limit"),
        }
    }

    #[test]
    fn stash_git_commands_honor_the_active_cancel_token() {
        let (runner, _dist_temp) = real_runner();
        let token = CancelToken::new();
        token.cancel();

        let error = crate::git_ops::with_cancel_token_for_operation(&token, || {
            run_git(&runner, None, ["--version"], "cancelledStashCommand")
        })
        .expect_err("cancelled command");

        assert_eq!(error.summary, "operation cancelled");
        assert_eq!(error.context.operation_name, "cancelledStashCommand");
    }

    #[test]
    fn oversized_stash_file_returns_a_visual_preview_placeholder() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write(
            "tracked.txt",
            &format!("{}\n", "x".repeat(STASH_DETAILS_OUTPUT_LIMIT_BYTES + 1024)),
        );
        let stash = create_stash(
            &runner,
            CreateStashRequest {
                repository_path: display_path(&repo.path),
                message: "oversized preview".to_owned(),
                include_untracked: true,
                paths: Vec::new(),
                operation_id: None,
            },
        )
        .expect("create stash")
        .stash
        .expect("created stash");

        let details = stash_details(
            &runner,
            StashDetailsRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector.clone(),
            },
        )
        .expect("stash metadata");
        assert_eq!(details.files.len(), 1);

        let detail = stash_file_detail(
            &runner,
            StashFileDetailRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector,
                path: "tracked.txt".to_owned(),
                operation_id: None,
            },
        )
        .expect("oversized stash file detail");

        assert!(matches!(detail.diff, DiffContent::Deferred { .. }));
        assert_eq!(detail.payload.file_kind, DiffFileKind::OversizedText);
        assert_eq!(
            detail.payload.metadata.get("oversized").map(String::as_str),
            Some("true")
        );
    }

    #[test]
    fn creates_partial_stash_and_leaves_unselected_changes() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("keep.txt", "keep changed\n");
        repo.write("stash.txt", "stash changed\n");

        let response = create_stash(
            &runner,
            CreateStashRequest {
                repository_path: display_path(&repo.path),
                message: "manual stash".to_owned(),
                include_untracked: true,
                paths: vec!["stash.txt".to_owned()],
                operation_id: None,
            },
        )
        .expect("create partial stash");
        let status = repo.git_output(["status", "--porcelain=v1"]);

        assert!(response.created);
        assert!(status.contains("keep.txt"));
        assert!(!status.contains("stash.txt"));
    }

    #[test]
    fn creates_full_stash_including_untracked_and_manual_apply_keeps_stash() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "tracked changed\n");
        repo.write("new/asset.txt", "untracked asset\n");

        let response = create_stash(
            &runner,
            CreateStashRequest {
                repository_path: display_path(&repo.path),
                message: "manual full stash".to_owned(),
                include_untracked: true,
                paths: Vec::new(),
                operation_id: None,
            },
        )
        .expect("create full stash");
        let stash = response.stash.expect("created stash");
        let status = repo.git_output(["status", "--porcelain=v1"]);

        assert!(response.created);
        assert!(status.trim().is_empty());

        let details = stash_details(
            &runner,
            StashDetailsRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector.clone(),
            },
        )
        .expect("stash details");
        assert_eq!(details.entry.oid, stash.oid);
        assert!(
            details
                .files
                .iter()
                .any(|file| file.path == "tracked.txt"
                    && file.change_kind == DiffChangeKind::Modified)
        );
        assert!(details
            .files
            .iter()
            .any(|file| file.path == "new/asset.txt" && file.change_kind == DiffChangeKind::Added));

        let tracked_detail = stash_file_detail(
            &runner,
            StashFileDetailRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector.clone(),
                path: "tracked.txt".to_owned(),
                operation_id: None,
            },
        )
        .expect("tracked stash file detail");
        let DiffContent::Text {
            old_text, new_text, ..
        } = tracked_detail.diff
        else {
            panic!("expected tracked text diff");
        };
        assert_eq!(old_text.as_deref(), Some("base\n"));
        assert_eq!(new_text.as_deref(), Some("tracked changed\n"));
        assert_eq!(tracked_detail.payload.file_kind, DiffFileKind::Text);

        let untracked_detail = stash_file_detail(
            &runner,
            StashFileDetailRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector.clone(),
                path: "new/asset.txt".to_owned(),
                operation_id: None,
            },
        )
        .expect("untracked stash file detail");
        assert_eq!(untracked_detail.file.change_kind, DiffChangeKind::Added);
        let DiffContent::Text {
            old_text, new_text, ..
        } = untracked_detail.diff
        else {
            panic!("expected untracked text diff");
        };
        assert_eq!(old_text, None);
        assert_eq!(new_text.as_deref(), Some("untracked asset\n"));

        let restore = restore_stash(
            &runner,
            RestoreStashRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector,
                drop_on_success: false,
                operation_name: None,
                operation_id: None,
            },
        )
        .expect("manual apply stash");
        let stashes = list_stashes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("list stashes");

        assert!(matches!(
            restore.outcome,
            StashRestoreOutcome::Applied { dropped: false }
        ));
        assert_eq!(repo.read("tracked.txt"), "tracked changed\n");
        assert_eq!(repo.read("new/asset.txt"), "untracked asset\n");
        assert!(stashes.stashes.iter().any(|entry| entry.oid == restore.oid));
    }

    #[test]
    fn stash_file_detail_returns_visual_image_assets() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write_bytes("preview.bmp", &single_pixel_bmp([0, 0, 255]));
        repo.git(["add", "preview.bmp"]);
        repo.git(["commit", "-m", "add preview image"]);
        repo.write_bytes("preview.bmp", &single_pixel_bmp([255, 0, 0]));
        let stash = create_stash(
            &runner,
            CreateStashRequest {
                repository_path: display_path(&repo.path),
                message: "image preview".to_owned(),
                include_untracked: false,
                paths: Vec::new(),
                operation_id: None,
            },
        )
        .expect("create image stash")
        .stash
        .expect("created image stash");

        let detail = stash_file_detail(
            &runner,
            StashFileDetailRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector,
                path: "preview.bmp".to_owned(),
                operation_id: None,
            },
        )
        .expect("image stash detail");

        assert_eq!(detail.payload.file_kind, DiffFileKind::Image);
        let DiffContent::Image {
            old_image,
            new_image,
        } = detail.diff
        else {
            panic!("expected image diff");
        };
        for image in [old_image, new_image] {
            let image = image.expect("image asset");
            assert_eq!(image.width, Some(1));
            assert_eq!(image.height, Some(1));
            assert!(image.src.starts_with("data:image/bmp;base64,"));
        }
    }

    #[test]
    fn stash_details_marks_auto_origin_and_delete_drops_entry() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "auto stash change\n");

        let stash = create_auto_stash(
            &runner,
            CreateAutoStashRequest {
                repository_path: display_path(&repo.path),
                reason: "Auto Stash: switch branch".to_owned(),
                include_untracked: true,
                paths: Vec::new(),
                operation_id: None,
            },
        )
        .expect("create auto stash")
        .stash
        .expect("created stash");
        let details = stash_details(
            &runner,
            StashDetailsRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector.clone(),
            },
        )
        .expect("stash details");

        assert!(details.entry.is_auto_stash);
        assert_eq!(details.entry.origin.as_deref(), Some("switch branch"));
        assert!(details.files.iter().any(|file| file.path == "tracked.txt"));

        let deleted = delete_stash(
            &runner,
            DeleteStashRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector,
                operation_id: None,
            },
        )
        .expect("delete stash");
        let stashes = list_stashes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("list stashes");

        assert_eq!(deleted.deleted_selector, "stash@{0}");
        assert!(stashes.stashes.is_empty());
    }

    #[test]
    fn auto_stash_restore_conflict_keeps_original_until_cancel_recovers() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "stash side\n");
        let stash = create_auto_stash(
            &runner,
            CreateAutoStashRequest {
                repository_path: display_path(&repo.path),
                reason: "switch branch".to_owned(),
                include_untracked: true,
                paths: Vec::new(),
                operation_id: None,
            },
        )
        .expect("create auto stash")
        .stash
        .expect("created stash");
        repo.write("tracked.txt", "local side\n");

        let response = restore_stash(
            &runner,
            RestoreStashRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector,
                drop_on_success: true,
                operation_name: None,
                operation_id: None,
            },
        )
        .expect("conflict keeps typed outcome");
        let StashRestoreOutcome::Conflicts { .. } = response.outcome else {
            panic!("expected conflict outcome");
        };
        let conflicted_stashes = list_stashes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("list stashes after conflict");
        assert!(conflicted_stashes
            .stashes
            .iter()
            .any(|entry| entry.oid == response.oid && entry.is_auto_stash));

        cancel_stash_restore(
            &runner,
            CancelStashRestoreRequest {
                repository_path: display_path(&repo.path),
                recovery: response.recovery,
            },
        )
        .expect("cancel restore");
        let stashes = list_stashes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("list stashes");

        assert_eq!(repo.read("tracked.txt"), "local side\n");
        assert!(stashes
            .stashes
            .iter()
            .any(|entry| entry.oid == response.oid && entry.is_auto_stash));
    }

    #[test]
    fn restores_stash_with_recovery_and_drops_auto_on_success() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "from stash\n");
        let stash = create_auto_stash(
            &runner,
            CreateAutoStashRequest {
                repository_path: display_path(&repo.path),
                reason: "switch branch".to_owned(),
                include_untracked: true,
                paths: Vec::new(),
                operation_id: None,
            },
        )
        .expect("create auto stash")
        .stash
        .expect("created stash");

        let response = restore_stash(
            &runner,
            RestoreStashRequest {
                repository_path: display_path(&repo.path),
                selector: stash.selector,
                drop_on_success: true,
                operation_name: None,
                operation_id: None,
            },
        )
        .expect("restore stash");
        let stashes = list_stashes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("list stashes");

        assert!(matches!(
            response.outcome,
            StashRestoreOutcome::Applied { dropped: true }
        ));
        assert!(stashes.stashes.is_empty());
        assert_eq!(repo.read("tracked.txt"), "from stash\n");
    }

    #[test]
    fn cancel_restore_recovers_pre_apply_changes_and_keeps_original_stash() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("tracked.txt", "stash side\n");
        repo.git(["stash", "push", "-m", "conflicting stash"]);
        repo.write("tracked.txt", "local side\n");

        let response = restore_stash(
            &runner,
            RestoreStashRequest {
                repository_path: display_path(&repo.path),
                selector: "stash@{0}".to_owned(),
                drop_on_success: false,
                operation_name: None,
                operation_id: None,
            },
        )
        .expect("conflict is a typed outcome");
        let StashRestoreOutcome::Conflicts { .. } = response.outcome else {
            panic!("expected conflict outcome");
        };

        cancel_stash_restore(
            &runner,
            CancelStashRestoreRequest {
                repository_path: display_path(&repo.path),
                recovery: response.recovery,
            },
        )
        .expect("cancel restore");
        let stashes = list_stashes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("list stashes");

        assert_eq!(repo.read("tracked.txt"), "local side\n");
        assert!(stashes
            .stashes
            .iter()
            .any(|stash| stash.message.contains("conflicting stash")));
    }

    fn real_runner() -> (GitRunner, TestTempDir) {
        let dist = require_git_dist().expect("load embedded git distribution");
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-stash-runner-home").expect("temp home");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        (runner, temp)
    }

    struct TestRepo {
        path: PathBuf,
        _temp: TestTempDir,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-stash-repo").expect("temp repo");
            Self {
                path: temp.path().to_path_buf(),
                _temp: temp,
                runner: runner.clone(),
            }
        }

        fn init_with_commit(&self) {
            self.git(["init", "-b", "main"]);
            self.git(["config", "user.name", "Tester"]);
            self.git(["config", "user.email", "tester@example.test"]);
            self.write("tracked.txt", "base\n");
            self.write("keep.txt", "keep\n");
            self.write("stash.txt", "stash\n");
            self.git(["add", "."]);
            self.git(["commit", "-m", "initial"]);
        }

        fn git<const N: usize>(&self, args: [&str; N]) {
            let output = self
                .runner
                .git_command_builder()
                .args([OsString::from("-C"), self.path.as_os_str().to_owned()])
                .args(args.map(OsString::from))
                .build()
                .to_command()
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        fn git_output<const N: usize>(&self, args: [&str; N]) -> String {
            let output = self
                .runner
                .git_command_builder()
                .args([OsString::from("-C"), self.path.as_os_str().to_owned()])
                .args(args.map(OsString::from))
                .build()
                .to_command()
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        fn write(&self, relative: &str, contents: &str) {
            self.write_bytes(relative, contents.as_bytes());
        }

        fn write_bytes(&self, relative: &str, contents: &[u8]) {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            let mut file = fs::File::create(path).expect("create file");
            file.write_all(contents).expect("write file");
        }

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.path.join(relative)).expect("read file")
        }
    }

    fn single_pixel_bmp(pixel: [u8; 3]) -> Vec<u8> {
        let mut bmp = vec![
            b'B', b'M', 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
            1, 0, 24, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        bmp.extend_from_slice(&pixel);
        bmp.push(0);
        bmp
    }
}
