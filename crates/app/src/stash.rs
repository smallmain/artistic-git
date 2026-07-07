use artistic_git_contracts::{
    AppError, AppResult, CancelStashRestoreRequest, CancelStashRestoreResponse,
    ConflictEnteredEvent, ConflictFile, ConflictResolutionStatus, CreateAutoStashRequest,
    CreateStashRequest, CreateStashResponse, DeleteStashRequest, DeleteStashResponse,
    DiffChangeKind, DiffFileKind, GitCommandError, OperationId, RestoreStashRequest,
    RestoreStashResponse, StashDetailsRequest, StashDetailsResponse, StashDiffFile, StashEntry,
    StashListResponse, StashRecoveryPoint, StashRestoreOutcome,
};
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const AUTO_STASH_PREFIX: &str = "Auto Stash:";
const RECOVERY_STASH_REASON: &str = "stash apply recovery";

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
    let name_status = git_output_bytes(
        runner,
        Some(&root),
        [
            "stash",
            "show",
            "--include-untracked",
            "--name-status",
            "-z",
            "--find-renames",
            selector,
        ],
        "stashDetails",
    )?;
    let raw_diff = git_stdout(
        runner,
        Some(&root),
        [
            "stash",
            "show",
            "--include-untracked",
            "--patch",
            "--no-color",
            "--find-renames",
            selector,
        ],
        "stashDetails",
    )?;
    let patch_chunks = parse_patch_chunks(&raw_diff);
    let files = parse_stash_name_status(&name_status, &patch_chunks);

    Ok(StashDetailsResponse {
        entry,
        files,
        raw_diff,
    })
}

pub fn restore_stash(
    runner: &GitRunner,
    request: RestoreStashRequest,
) -> AppResult<RestoreStashResponse> {
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

    let oid = resolve_revision(runner, &root, selector, operation_name)?;
    let recovery = create_recovery_point(runner, &root, operation_name)?;
    if let Some(recovery_selector) = recovery.stash_selector.as_deref() {
        git_stdout(
            runner,
            Some(&root),
            ["stash", "apply", "--index", recovery_selector],
            operation_name,
        )?;
    }

    let apply_result = run_git(
        runner,
        Some(&root),
        ["stash", "apply", oid.as_str()],
        operation_name,
    );
    match apply_result {
        Ok(_) => {
            let mut dropped = false;
            if request.drop_on_success {
                dropped = drop_stash_by_oid(runner, &root, &oid, operation_name)?;
            }
            if let Some(recovery_oid) = recovery.stash_oid.as_deref() {
                let _ = drop_stash_by_oid(runner, &root, recovery_oid, operation_name);
            }
            Ok(RestoreStashResponse {
                selector: selector.to_owned(),
                oid,
                recovery,
                outcome: StashRestoreOutcome::Applied { dropped },
            })
        }
        Err(_error) if repository_has_conflicts(runner, &root) => {
            let conflict = ConflictEnteredEvent {
                operation_id: OperationId(recovery.id.clone()),
                repository_path: display_path(&root),
                operation_name: operation_name.to_owned(),
                files: list_conflict_files(runner, &root, operation_name)?,
            };
            Ok(RestoreStashResponse {
                selector: selector.to_owned(),
                oid,
                recovery,
                outcome: StashRestoreOutcome::Conflicts { conflict },
            })
        }
        Err(error) => Err(error),
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

    Ok(CancelStashRestoreResponse {
        restored,
        dropped_recovery_stash,
    })
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
        args.extend(paths.into_iter().map(OsString::from));
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
    let id = format!("stash-restore-{}", unix_now_millis());

    if !has_local_changes(runner, root, operation_name)? {
        return Ok(StashRecoveryPoint {
            id,
            head_oid,
            stash_oid: None,
            stash_selector: None,
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
        ["stash", "list", "--format=%gd%x00%H%x00%ct%x00%gs%x1e"],
        operation_name,
    ) {
        Ok(output) => output,
        Err(error) if is_empty_stash_error(&error) => String::new(),
        Err(error) => return Err(error),
    };

    let stashes = output
        .split('\x1e')
        .filter(|record| !record.trim().is_empty())
        .filter_map(parse_stash_record)
        .collect();

    Ok(StashListResponse { stashes })
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
    let message = parts.next().unwrap_or(selector).to_owned();

    Ok(StashEntry {
        index: 0,
        selector: selector.to_owned(),
        oid,
        branch: branch_from_stash_message(&message),
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
    let message = parts[3].to_owned();
    let origin = auto_stash_origin(&message);

    Some(StashEntry {
        index,
        selector,
        oid: parts[1].to_owned(),
        branch: branch_from_stash_message(&message),
        created_at_unix_seconds: empty_to_none(parts[2]).map(str::to_owned),
        is_auto_stash: origin.is_some(),
        origin,
        message,
    })
}

fn parse_stash_name_status(
    output: &[u8],
    patch_chunks: &BTreeMap<String, PatchChunk>,
) -> Vec<StashDiffFile> {
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut seen_paths = BTreeSet::new();
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
        seen_paths.insert(path.clone());
        let patch = patch_for_path(patch_chunks, &path, old_path.as_deref());
        files.push(StashDiffFile {
            file_kind: file_kind_from_patch(&patch),
            path,
            old_path,
            change_kind,
            patch,
        });
    }

    for chunk in patch_chunks.values() {
        if seen_paths.contains(&chunk.path) {
            continue;
        }
        files.push(StashDiffFile {
            path: chunk.path.clone(),
            old_path: chunk.old_path.clone(),
            change_kind: DiffChangeKind::Modified,
            file_kind: file_kind_from_patch(&chunk.patch),
            patch: chunk.patch.clone(),
        });
    }

    files
}

fn parse_patch_chunks(raw_diff: &str) -> BTreeMap<String, PatchChunk> {
    let mut chunks = Vec::<PatchChunk>::new();
    let mut current_header: Option<(Option<String>, String)> = None;
    let mut current_lines = Vec::<String>::new();

    for line in raw_diff.lines() {
        if let Some((old_path, path)) = parse_diff_git_line(line) {
            if let Some((previous_old_path, previous_path)) = current_header.take() {
                chunks.push(PatchChunk {
                    old_path: previous_old_path,
                    path: previous_path,
                    patch: current_lines.join("\n"),
                });
                current_lines.clear();
            }
            current_header = Some((old_path, path));
        }
        if current_header.is_some() {
            current_lines.push(line.to_owned());
        }
    }

    if let Some((old_path, path)) = current_header {
        chunks.push(PatchChunk {
            old_path,
            path,
            patch: current_lines.join("\n"),
        });
    }

    chunks
        .into_iter()
        .map(|chunk| (chunk.path.clone(), chunk))
        .collect()
}

fn parse_diff_git_line(line: &str) -> Option<(Option<String>, String)> {
    let rest = line.strip_prefix("diff --git ")?;
    let mut parts = rest.split_whitespace();
    let old_path = strip_diff_prefix(parts.next()?);
    let path = strip_diff_prefix(parts.next()?);
    Some(((old_path != path).then_some(old_path), path))
}

fn strip_diff_prefix(path: &str) -> String {
    path.trim_matches('"')
        .strip_prefix("a/")
        .or_else(|| path.trim_matches('"').strip_prefix("b/"))
        .unwrap_or_else(|| path.trim_matches('"'))
        .to_owned()
}

fn patch_for_path(
    chunks: &BTreeMap<String, PatchChunk>,
    path: &str,
    old_path: Option<&str>,
) -> String {
    chunks
        .get(path)
        .or_else(|| old_path.and_then(|value| chunks.get(value)))
        .map(|chunk| chunk.patch.clone())
        .unwrap_or_default()
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

fn file_kind_from_patch(patch: &str) -> DiffFileKind {
    if patch.contains("Binary files ") || patch.contains("GIT binary patch") {
        DiffFileKind::Binary
    } else {
        DiffFileKind::Text
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

fn branch_from_stash_message(message: &str) -> Option<String> {
    message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))
        .and_then(|value| value.split_once(':').map(|(branch, _)| branch.to_owned()))
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
    let plan = plan_git(runner, root, args);
    let output = plan
        .to_command()
        .output()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(command_failure(&plan, output, operation_name))
    }
}

fn run_git<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<CommandOutput>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = plan_git(runner, root, args);
    let command = plan.to_command();
    command_to_output(command, &plan, operation_name)
}

fn command_to_output(
    mut command: Command,
    plan: &GitCommandPlan,
    operation_name: &str,
) -> AppResult<CommandOutput> {
    let output = command
        .output()
        .map_err(|source| spawn_error(plan, source, operation_name))?;
    if output.status.success() {
        Ok(CommandOutput::from_output(output))
    } else {
        Err(command_failure(plan, output, operation_name))
    }
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

fn command_failure(
    plan: &GitCommandPlan,
    output: std::process::Output,
    operation_name: &str,
) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let summary = if stderr.trim().is_empty() {
        format!("git command failed during {operation_name}")
    } else {
        stderr
            .lines()
            .next()
            .unwrap_or("git command failed")
            .to_owned()
    };

    logged(
        AppError::expected(summary, operation_name).with_git(GitCommandError {
            command: plan.command_for_error(),
            exit_code: output.status.code(),
            stdout,
            stderr,
        }),
    )
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

#[derive(Debug)]
struct CommandOutput {
    stdout: String,
}

impl CommandOutput {
    fn from_output(output: std::process::Output) -> Self {
        Self {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        }
    }
}

#[derive(Debug)]
struct PatchChunk {
    old_path: Option<String>,
    path: String,
    patch: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_contracts::RepositoryPathRequest;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
    use std::io::Write;

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
        assert_eq!(entry.origin.as_deref(), Some("switch branch"));
        assert_eq!(entry.branch.as_deref(), Some("main"));
    }

    #[test]
    fn parses_name_status_and_patch_chunks() {
        let raw = concat!(
            "diff --git a/src/a.txt b/src/a.txt\n",
            "index 111..222 100644\n",
            "--- a/src/a.txt\n",
            "+++ b/src/a.txt\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "+new\n"
        );
        let status = b"M\0src/a.txt\0";
        let files = parse_stash_name_status(status, &parse_patch_chunks(raw));

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/a.txt");
        assert_eq!(files[0].change_kind, DiffChangeKind::Modified);
        assert!(files[0].patch.contains("+new"));
    }

    #[test]
    fn creates_partial_stash_and_leaves_unselected_changes() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
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
            },
        )
        .expect("create partial stash");
        let status = repo.git_output(["status", "--porcelain=v1"]);

        assert!(response.created);
        assert!(status.contains("keep.txt"));
        assert!(!status.contains("stash.txt"));
    }

    #[test]
    fn restores_stash_with_recovery_and_drops_auto_on_success() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
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
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
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

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => return None,
            Err(error) => panic!("invalid embedded git distribution: {error}"),
        };
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-stash-runner-home").expect("temp home");
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
            let temp = TestTempDir::new("ag-stash-repo").expect("temp repo");
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
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            let mut file = fs::File::create(path).expect("create file");
            file.write_all(contents.as_bytes()).expect("write file");
        }

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.path.join(relative)).expect("read file")
        }
    }
}
