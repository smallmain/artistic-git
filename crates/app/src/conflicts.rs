use artistic_git_contracts::{
    AppError, AppResult, ConflictCancelRequest, ConflictCancelResponse, ConflictCompleteRequest,
    ConflictCompleteResponse, ConflictDetailResponse, ConflictFile, ConflictFileDetail,
    ConflictHunk, ConflictImagePreview, ConflictListRequest, ConflictListResponse,
    ConflictOperation, ConflictOperationKind, ConflictPathRequest, ConflictResolutionStatus,
    ConflictSaveResolutionRequest, ConflictSaveResolutionResponse, ConflictSelectSideRequest,
    ConflictSelectSideResponse, ConflictSide, ConflictSideFile, DiffFileKind, GitCommandError,
};
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs, io,
    path::{Component, Path, PathBuf},
    process::Command,
};

use crate::repository::RepositoryBackend;

const OP_LIST_CONFLICTS: &str = "listConflicts";
const OP_CONFLICT_DETAIL: &str = "conflictDetail";
const OP_SELECT_SIDE: &str = "selectConflictSide";
const OP_SAVE_RESOLUTION: &str = "saveConflictResolution";
const OP_COMPLETE: &str = "completeConflictResolution";
const OP_CANCEL: &str = "cancelConflictResolution";
const IMAGE_PREVIEW_LIMIT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
struct ConflictSubmoduleEntry {
    path: PathBuf,
    root: PathBuf,
}

#[derive(Debug, Clone)]
struct ResolvedConflictPath {
    repo_root: PathBuf,
    path: PathBuf,
    display_path: PathBuf,
    submodule_path: Option<PathBuf>,
}

impl RepositoryBackend {
    pub fn list_conflicts(&self, request: ConflictListRequest) -> AppResult<ConflictListResponse> {
        list_conflicts(self.runner(), request)
    }

    pub fn conflict_detail(
        &self,
        request: ConflictPathRequest,
    ) -> AppResult<ConflictDetailResponse> {
        conflict_detail(self.runner(), request)
    }

    pub fn select_conflict_side(
        &self,
        request: ConflictSelectSideRequest,
    ) -> AppResult<ConflictSelectSideResponse> {
        select_conflict_side(self.runner(), request)
    }

    pub fn save_conflict_resolution(
        &self,
        request: ConflictSaveResolutionRequest,
    ) -> AppResult<ConflictSaveResolutionResponse> {
        save_conflict_resolution(self.runner(), request)
    }

    pub fn complete_conflict_resolution(
        &self,
        request: ConflictCompleteRequest,
    ) -> AppResult<ConflictCompleteResponse> {
        complete_conflict_resolution(self.runner(), request)
    }

    pub fn cancel_conflict_resolution(
        &self,
        request: ConflictCancelRequest,
    ) -> AppResult<ConflictCancelResponse> {
        cancel_conflict_resolution(self.runner(), request)
    }
}

pub fn list_conflicts(
    runner: &GitRunner,
    request: ConflictListRequest,
) -> AppResult<ConflictListResponse> {
    let root = canonical_repository_path(&request.repository_path, OP_LIST_CONFLICTS)?;
    let mut operation = detect_operation(runner, &root, OP_LIST_CONFLICTS)?;
    let entries = unmerged_entries(runner, &root, OP_LIST_CONFLICTS)?;
    let mut files = Vec::new();

    for path in entries.keys() {
        files.push(conflict_file_from_entries(&root, path, path, &entries));
    }

    for submodule in initialized_conflict_submodule_entries(runner, &root, OP_LIST_CONFLICTS)? {
        let submodule_operation = detect_operation(runner, &submodule.root, OP_LIST_CONFLICTS)?;
        if operation.is_none() {
            operation = submodule_operation;
        }
        let entries = unmerged_entries(runner, &submodule.root, OP_LIST_CONFLICTS)?;
        for path in entries.keys() {
            let display_path = submodule.path.join(path);
            files.push(conflict_file_from_entries(
                &submodule.root,
                path,
                &display_path,
                &entries,
            ));
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(ConflictListResponse { operation, files })
}

pub fn conflict_detail(
    runner: &GitRunner,
    request: ConflictPathRequest,
) -> AppResult<ConflictDetailResponse> {
    let root = canonical_repository_path(&request.repository_path, OP_CONFLICT_DETAIL)?;
    let path = validate_conflict_path(&request.path, OP_CONFLICT_DETAIL)?;
    let resolved = resolve_conflict_path(runner, &root, &path, OP_CONFLICT_DETAIL)?;
    let operation = detect_operation(runner, &resolved.repo_root, OP_CONFLICT_DETAIL)?;
    let entries = unmerged_entries(runner, &resolved.repo_root, OP_CONFLICT_DETAIL)?;
    let file = conflict_file_from_entries(
        &resolved.repo_root,
        &resolved.path,
        &resolved.display_path,
        &entries,
    );
    let stage_map = entries.get(&resolved.path);

    let detail = match file.file_kind {
        DiffFileKind::Text | DiffFileKind::OversizedText | DiffFileKind::LfsPointer => {
            let working_bytes =
                fs::read(resolved.repo_root.join(&resolved.path)).map_err(|source| {
                    logged(AppError::expected(
                        format!("failed to read conflict file: {source}"),
                        OP_CONFLICT_DETAIL,
                    ))
                })?;
            let working_text = String::from_utf8_lossy(&working_bytes).into_owned();
            let parsed = parse_conflict_text(&working_text);
            let own_text = stage_text(
                runner,
                &resolved.repo_root,
                stage_map,
                stage_for_side(operation.as_ref(), ConflictSide::Own),
                &working_text,
                OP_CONFLICT_DETAIL,
            )?;
            let other_text = stage_text(
                runner,
                &resolved.repo_root,
                stage_map,
                stage_for_side(operation.as_ref(), ConflictSide::Other),
                &working_text,
                OP_CONFLICT_DETAIL,
            )?;

            ConflictFileDetail::Text {
                current_text: parsed.current_text,
                own_text,
                other_text,
                hunks: parsed.hunks,
                language: language_for_path(&resolved.display_path),
            }
        }
        DiffFileKind::Binary | DiffFileKind::Image => ConflictFileDetail::Binary {
            own: stage_side_file(
                runner,
                &resolved.repo_root,
                &resolved.path,
                stage_map,
                operation.as_ref(),
                ConflictSide::Own,
                OP_CONFLICT_DETAIL,
            )?,
            other: stage_side_file(
                runner,
                &resolved.repo_root,
                &resolved.path,
                stage_map,
                operation.as_ref(),
                ConflictSide::Other,
                OP_CONFLICT_DETAIL,
            )?,
        },
    };

    Ok(ConflictDetailResponse { file, detail })
}

pub fn select_conflict_side(
    runner: &GitRunner,
    request: ConflictSelectSideRequest,
) -> AppResult<ConflictSelectSideResponse> {
    let root = canonical_repository_path(&request.repository_path, OP_SELECT_SIDE)?;
    let mut files = Vec::new();

    for raw_path in request.paths {
        let path = validate_conflict_path(&raw_path, OP_SELECT_SIDE)?;
        let resolved = resolve_conflict_path(runner, &root, &path, OP_SELECT_SIDE)?;
        let operation = require_operation(runner, &resolved.repo_root, OP_SELECT_SIDE)?;
        let checkout_side = checkout_side_for_operation(operation.kind, request.side);
        git_stdout(
            runner,
            &resolved.repo_root,
            [
                OsString::from("checkout"),
                OsString::from(checkout_side),
                OsString::from("--"),
                resolved.path.as_os_str().to_owned(),
            ],
            OP_SELECT_SIDE,
        )?;
        git_add_paths(
            runner,
            &resolved.repo_root,
            [&resolved.path],
            OP_SELECT_SIDE,
        )?;
        files.push(conflict_file(runner, &resolved, OP_SELECT_SIDE)?);
    }

    Ok(ConflictSelectSideResponse { files })
}

pub fn save_conflict_resolution(
    runner: &GitRunner,
    request: ConflictSaveResolutionRequest,
) -> AppResult<ConflictSaveResolutionResponse> {
    let root = canonical_repository_path(&request.repository_path, OP_SAVE_RESOLUTION)?;
    let path = validate_conflict_path(&request.path, OP_SAVE_RESOLUTION)?;
    let resolved = resolve_conflict_path(runner, &root, &path, OP_SAVE_RESOLUTION)?;

    if request.pending_hunks > 0 {
        return Err(logged(AppError::expected(
            "cannot save while conflicts are still pending",
            OP_SAVE_RESOLUTION,
        )));
    }
    if contains_conflict_markers(&request.content) {
        return Err(logged(AppError::expected(
            "cannot save while conflict markers remain",
            OP_SAVE_RESOLUTION,
        )));
    }

    let absolute_path = resolved.repo_root.join(&resolved.path);
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent).map_err(|source| {
            logged(AppError::expected(
                format!("failed to create parent directory: {source}"),
                OP_SAVE_RESOLUTION,
            ))
        })?;
    }
    fs::write(&absolute_path, request.content).map_err(|source| {
        logged(AppError::expected(
            format!("failed to write conflict resolution: {source}"),
            OP_SAVE_RESOLUTION,
        ))
    })?;
    git_add_paths(
        runner,
        &resolved.repo_root,
        [&resolved.path],
        OP_SAVE_RESOLUTION,
    )?;

    Ok(ConflictSaveResolutionResponse {
        file: conflict_file(runner, &resolved, OP_SAVE_RESOLUTION)?,
    })
}

pub fn complete_conflict_resolution(
    runner: &GitRunner,
    request: ConflictCompleteRequest,
) -> AppResult<ConflictCompleteResponse> {
    let root = canonical_repository_path(&request.repository_path, OP_COMPLETE)?;
    let paths = validate_conflict_paths(&request.paths, OP_COMPLETE)?;
    let mut resolved_paths = Vec::with_capacity(paths.len());
    for path in &paths {
        resolved_paths.push(resolve_conflict_path(runner, &root, path, OP_COMPLETE)?);
    }
    let (operation_root, operation_paths) = single_conflict_repository(resolved_paths)?;
    let operation = require_operation(runner, &operation_root, OP_COMPLETE)?;
    let unresolved_paths =
        unresolved_resolved_conflict_paths(runner, &operation_root, &operation_paths, OP_COMPLETE)?;

    if !unresolved_paths.is_empty() {
        return Err(logged(AppError::expected(
            format!(
                "cannot complete while conflicts remain unresolved: {}",
                unresolved_paths.join(", ")
            ),
            OP_COMPLETE,
        )));
    }

    for path in &operation_paths {
        assert_no_worktree_markers(&operation_root, &path.path, &path.display_path, OP_COMPLETE)?;
    }
    git_add_paths(
        runner,
        &operation_root,
        operation_paths.iter().map(|path| &path.path),
        OP_COMPLETE,
    )?;
    let continuation = run_continuation(runner, &operation_root, operation.kind, OP_COMPLETE);
    if continuation.is_ok() {
        crate::sync::finish_sync_worktree_conflict(runner, &operation_root, &request.operation_id)?;
    } else {
        let _ = crate::sync::cleanup_sync_worktree_after_conflict(
            runner,
            &operation_root,
            &request.operation_id,
        );
    }
    continuation?;

    Ok(ConflictCompleteResponse {
        continuation: operation.kind,
    })
}

pub fn cancel_conflict_resolution(
    runner: &GitRunner,
    request: ConflictCancelRequest,
) -> AppResult<ConflictCancelResponse> {
    let root = canonical_repository_path(&request.repository_path, OP_CANCEL)?;
    let (operation_root, operation) = require_active_operation_repo(runner, &root, OP_CANCEL)?;
    let command = match operation.kind {
        ConflictOperationKind::Merge => ["merge", "--abort"],
        ConflictOperationKind::Rebase => ["rebase", "--abort"],
        ConflictOperationKind::CherryPick => ["cherry-pick", "--abort"],
        ConflictOperationKind::Revert => ["revert", "--abort"],
    };
    let abort = git_stdout(runner, &operation_root, command, OP_CANCEL);
    let cleanup = crate::sync::cleanup_sync_worktree_after_conflict(
        runner,
        &operation_root,
        &request.operation_id,
    );
    abort?;
    cleanup?;

    Ok(ConflictCancelResponse {
        aborted: operation.kind,
    })
}

fn detect_operation(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Option<ConflictOperation>> {
    let candidates = [
        (ConflictOperationKind::Rebase, "rebase-merge", "Rebase"),
        (ConflictOperationKind::Rebase, "rebase-apply", "Rebase"),
        (ConflictOperationKind::Merge, "MERGE_HEAD", "Merge"),
        (
            ConflictOperationKind::CherryPick,
            "CHERRY_PICK_HEAD",
            "Cherry-pick",
        ),
        (ConflictOperationKind::Revert, "REVERT_HEAD", "Revert"),
    ];

    for (kind, git_path, label) in candidates {
        let path = git_path_for(runner, root, git_path, operation_name)?;
        if path.exists() {
            return Ok(Some(ConflictOperation {
                kind,
                label: label.to_owned(),
            }));
        }
    }

    Ok(None)
}

fn require_operation(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<ConflictOperation> {
    detect_operation(runner, root, operation_name)?.ok_or_else(|| {
        logged(AppError::expected(
            "no merge, rebase, cherry-pick, or revert operation is in progress",
            operation_name,
        ))
    })
}

fn require_active_operation_repo(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<(PathBuf, ConflictOperation)> {
    if let Some(operation) = detect_operation(runner, root, operation_name)? {
        return Ok((root.to_path_buf(), operation));
    }

    for submodule in initialized_conflict_submodule_entries(runner, root, operation_name)? {
        if let Some(operation) = detect_operation(runner, &submodule.root, operation_name)? {
            return Ok((submodule.root, operation));
        }
    }

    Err(logged(AppError::expected(
        "no merge, rebase, cherry-pick, or revert operation is in progress",
        operation_name,
    )))
}

fn initialized_conflict_submodule_entries(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Vec<ConflictSubmoduleEntry>> {
    if !root.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }

    let mut entries = crate::repository::initialized_submodule_paths(runner, root, operation_name)?
        .into_iter()
        .filter_map(|submodule_root| {
            crate::repository::repository_relative_display_path(root, &submodule_root).map(|path| {
                ConflictSubmoduleEntry {
                    path: PathBuf::from(path),
                    root: submodule_root,
                }
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        path_depth(&right.path)
            .cmp(&path_depth(&left.path))
            .then_with(|| right.path.cmp(&left.path))
    });
    Ok(entries)
}

fn resolve_conflict_path(
    runner: &GitRunner,
    root: &Path,
    path: &Path,
    operation_name: &str,
) -> AppResult<ResolvedConflictPath> {
    for submodule in initialized_conflict_submodule_entries(runner, root, operation_name)? {
        if let Ok(inner_path) = path.strip_prefix(&submodule.path) {
            if !inner_path.as_os_str().is_empty() {
                return Ok(ResolvedConflictPath {
                    repo_root: submodule.root,
                    path: inner_path.to_path_buf(),
                    display_path: path.to_path_buf(),
                    submodule_path: Some(submodule.path),
                });
            }
        }
    }

    Ok(ResolvedConflictPath {
        repo_root: root.to_path_buf(),
        path: path.to_path_buf(),
        display_path: path.to_path_buf(),
        submodule_path: None,
    })
}

fn single_conflict_repository(
    paths: Vec<ResolvedConflictPath>,
) -> AppResult<(PathBuf, Vec<ResolvedConflictPath>)> {
    let mut paths = paths.into_iter();
    let Some(first) = paths.next() else {
        return Err(logged(AppError::expected(
            "at least one conflict path is required",
            OP_COMPLETE,
        )));
    };
    let root = first.repo_root.clone();
    let mut operation_paths = vec![first];

    for path in paths {
        if path.repo_root != root {
            return Err(logged(AppError::expected(
                "conflict paths must belong to one repository",
                OP_COMPLETE,
            )));
        }
        operation_paths.push(path);
    }

    Ok((root, operation_paths))
}

fn path_depth(path: &Path) -> usize {
    path.components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count()
}

fn unmerged_entries(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<BTreeMap<PathBuf, BTreeMap<u8, StageEntry>>> {
    let bytes = git_output_bytes(runner, root, ["ls-files", "-u", "-z"], operation_name)?;
    let mut entries = BTreeMap::<PathBuf, BTreeMap<u8, StageEntry>>::new();

    for raw in bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let record = String::from_utf8_lossy(raw);
        let Some((metadata, path)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = metadata.split_whitespace();
        let _mode = fields.next();
        let Some(oid) = fields.next() else {
            continue;
        };
        let Some(stage) = fields.next().and_then(|value| value.parse::<u8>().ok()) else {
            continue;
        };
        entries.entry(PathBuf::from(path)).or_default().insert(
            stage,
            StageEntry {
                oid: oid.to_owned(),
            },
        );
    }

    Ok(entries)
}

fn conflict_file(
    runner: &GitRunner,
    resolved: &ResolvedConflictPath,
    operation_name: &str,
) -> AppResult<ConflictFile> {
    let entries = unmerged_entries(runner, &resolved.repo_root, operation_name)?;
    Ok(conflict_file_from_entries(
        &resolved.repo_root,
        &resolved.path,
        &resolved.display_path,
        &entries,
    ))
}

fn conflict_file_from_entries(
    root: &Path,
    path: &Path,
    display: &Path,
    entries: &BTreeMap<PathBuf, BTreeMap<u8, StageEntry>>,
) -> ConflictFile {
    let path_string = conflict_display_path(display);
    let has_unmerged_stages = entries.contains_key(path);
    let file_kind = file_kind_for_path(root, path);
    let status = if has_unmerged_stages || worktree_has_markers(root, path) {
        ConflictResolutionStatus::Unresolved
    } else {
        ConflictResolutionStatus::Resolved
    };

    ConflictFile {
        path: path_string,
        status,
        file_kind,
    }
}

fn file_kind_for_path(root: &Path, path: &Path) -> DiffFileKind {
    if image_mime_for_path(path).is_some() {
        return DiffFileKind::Image;
    }

    let Ok(bytes) = fs::read(root.join(path)) else {
        return DiffFileKind::Binary;
    };
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        DiffFileKind::Binary
    } else if looks_like_lfs_pointer(&bytes) {
        DiffFileKind::LfsPointer
    } else {
        DiffFileKind::Text
    }
}

fn looks_like_lfs_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"version https://git-lfs.github.com/spec/v1\n")
}

fn stage_text(
    runner: &GitRunner,
    root: &Path,
    stage_map: Option<&BTreeMap<u8, StageEntry>>,
    stage: u8,
    fallback: &str,
    operation_name: &str,
) -> AppResult<String> {
    let Some(entry) = stage_map.and_then(|stages| stages.get(&stage)) else {
        return Ok(fallback.to_owned());
    };
    let bytes = git_output_bytes(
        runner,
        root,
        [
            OsString::from("cat-file"),
            OsString::from("-p"),
            OsString::from(&entry.oid),
        ],
        operation_name,
    )?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn stage_side_file(
    runner: &GitRunner,
    root: &Path,
    path: &Path,
    stage_map: Option<&BTreeMap<u8, StageEntry>>,
    operation: Option<&ConflictOperation>,
    side: ConflictSide,
    operation_name: &str,
) -> AppResult<Option<ConflictSideFile>> {
    let stage = stage_for_side(operation, side);
    let Some(entry) = stage_map.and_then(|stages| stages.get(&stage)) else {
        return Ok(None);
    };
    let size_bytes = git_stdout(
        runner,
        root,
        [
            OsString::from("cat-file"),
            OsString::from("-s"),
            OsString::from(&entry.oid),
        ],
        operation_name,
    )?
    .trim()
    .parse::<u64>()
    .ok()
    .map(|value| value.min(u64::from(u32::MAX)) as u32);
    let mime_type = image_mime_for_path(path).map(str::to_owned);
    let preview = if let Some(mime_type) = mime_type.as_deref() {
        let bytes = if size_bytes
            .map(|size| usize::try_from(size).unwrap_or(usize::MAX) <= IMAGE_PREVIEW_LIMIT_BYTES)
            .unwrap_or(false)
        {
            Some(git_output_bytes(
                runner,
                root,
                [
                    OsString::from("cat-file"),
                    OsString::from("-p"),
                    OsString::from(&entry.oid),
                ],
                operation_name,
            )?)
        } else {
            None
        };
        bytes.map(|value| ConflictImagePreview {
            data_url: format!("data:{mime_type};base64,{}", base64_encode(&value)),
        })
    } else {
        None
    };

    Ok(Some(ConflictSideFile {
        side,
        oid: Some(entry.oid.clone()),
        size_bytes,
        modified_unix_seconds: side_modified_unix_seconds(
            runner,
            root,
            path,
            operation,
            side,
            operation_name,
        ),
        mime_type,
        preview,
    }))
}

fn side_modified_unix_seconds(
    runner: &GitRunner,
    root: &Path,
    path: &Path,
    operation: Option<&ConflictOperation>,
    side: ConflictSide,
    operation_name: &str,
) -> Option<String> {
    let revision = revision_for_side(operation, side)?;
    let output = git_stdout(
        runner,
        root,
        [
            OsString::from("log"),
            OsString::from("-1"),
            OsString::from("--format=%ct"),
            OsString::from(revision),
            OsString::from("--"),
            path.as_os_str().to_owned(),
        ],
        operation_name,
    )
    .ok()?;

    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn revision_for_side(
    operation: Option<&ConflictOperation>,
    side: ConflictSide,
) -> Option<&'static str> {
    let operation = operation?;
    Some(match (operation.kind, side) {
        (ConflictOperationKind::Rebase, ConflictSide::Own) => "REBASE_HEAD",
        (ConflictOperationKind::Rebase, ConflictSide::Other) => "HEAD",
        (ConflictOperationKind::Merge, ConflictSide::Own)
        | (ConflictOperationKind::CherryPick, ConflictSide::Own)
        | (ConflictOperationKind::Revert, ConflictSide::Own) => "HEAD",
        (ConflictOperationKind::Merge, ConflictSide::Other) => "MERGE_HEAD",
        (ConflictOperationKind::CherryPick, ConflictSide::Other) => "CHERRY_PICK_HEAD",
        (ConflictOperationKind::Revert, ConflictSide::Other) => "REVERT_HEAD",
    })
}

fn stage_for_side(operation: Option<&ConflictOperation>, side: ConflictSide) -> u8 {
    let is_rebase = operation
        .map(|operation| operation.kind == ConflictOperationKind::Rebase)
        .unwrap_or(false);
    match (is_rebase, side) {
        (true, ConflictSide::Own) => 3,
        (true, ConflictSide::Other) => 2,
        (false, ConflictSide::Own) => 2,
        (false, ConflictSide::Other) => 3,
    }
}

fn checkout_side_for_operation(kind: ConflictOperationKind, side: ConflictSide) -> &'static str {
    match (kind, side) {
        (ConflictOperationKind::Rebase, ConflictSide::Own) => "--theirs",
        (ConflictOperationKind::Rebase, ConflictSide::Other) => "--ours",
        (_, ConflictSide::Own) => "--ours",
        (_, ConflictSide::Other) => "--theirs",
    }
}

fn run_continuation(
    runner: &GitRunner,
    root: &Path,
    kind: ConflictOperationKind,
    operation_name: &str,
) -> AppResult<()> {
    let command = match kind {
        ConflictOperationKind::Merge => ["merge", "--continue"],
        ConflictOperationKind::Rebase => ["rebase", "--continue"],
        ConflictOperationKind::CherryPick => ["cherry-pick", "--continue"],
        ConflictOperationKind::Revert => ["revert", "--continue"],
    };
    let plan = plan_git(runner, root, command)
        .config("core.editor", "true")
        .config("sequence.editor", "true")
        .build();
    command_to_output(plan.to_command(), &plan, operation_name).map(|_| ())
}

fn git_add_paths<'a, I>(
    runner: &GitRunner,
    root: &Path,
    paths: I,
    operation_name: &str,
) -> AppResult<()>
where
    I: IntoIterator<Item = &'a PathBuf>,
{
    let mut args = vec![
        OsString::from("add"),
        OsString::from("-A"),
        OsString::from("--"),
    ];
    args.extend(paths.into_iter().map(|path| path.as_os_str().to_owned()));
    git_stdout(runner, root, args, operation_name).map(|_| ())
}

fn assert_no_worktree_markers(
    root: &Path,
    path: &Path,
    display: &Path,
    operation_name: &str,
) -> AppResult<()> {
    let absolute_path = root.join(path);
    let Ok(bytes) = fs::read(&absolute_path) else {
        return Ok(());
    };
    if bytes.contains(&0) {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&bytes);
    if contains_conflict_markers(&text) {
        return Err(logged(AppError::expected(
            format!(
                "cannot complete while conflict markers remain in {}",
                display_path(display)
            ),
            operation_name,
        )));
    }
    Ok(())
}

fn unresolved_resolved_conflict_paths(
    runner: &GitRunner,
    root: &Path,
    paths: &[ResolvedConflictPath],
    operation_name: &str,
) -> AppResult<Vec<String>> {
    let entries = unmerged_entries(runner, root, operation_name)?;
    Ok(unresolved_paths_from_resolved_entries(
        root, paths, &entries,
    ))
}

#[cfg(test)]
fn unresolved_paths_from_entries(
    root: &Path,
    paths: &[PathBuf],
    entries: &BTreeMap<PathBuf, BTreeMap<u8, StageEntry>>,
) -> Vec<String> {
    let mut unresolved = BTreeSet::new();

    for path in entries.keys() {
        unresolved.insert(display_path(path));
    }
    for path in paths {
        if worktree_has_markers(root, path) {
            unresolved.insert(display_path(path));
        }
    }

    unresolved.into_iter().collect()
}

fn unresolved_paths_from_resolved_entries(
    root: &Path,
    paths: &[ResolvedConflictPath],
    entries: &BTreeMap<PathBuf, BTreeMap<u8, StageEntry>>,
) -> Vec<String> {
    let mut unresolved = BTreeSet::new();
    let submodule_path = paths.first().and_then(|path| path.submodule_path.as_ref());

    for path in entries.keys() {
        let display = submodule_path
            .map(|prefix| prefix.join(path))
            .unwrap_or_else(|| path.to_path_buf());
        unresolved.insert(display_path(&display));
    }
    for path in paths {
        if worktree_has_markers(root, &path.path) {
            unresolved.insert(display_path(&path.display_path));
        }
    }

    unresolved.into_iter().collect()
}

fn worktree_has_markers(root: &Path, path: &Path) -> bool {
    fs::read(root.join(path))
        .ok()
        .filter(|bytes| !bytes.contains(&0))
        .map(|bytes| contains_conflict_markers(&String::from_utf8_lossy(&bytes)))
        .unwrap_or(false)
}

fn contains_conflict_markers(text: &str) -> bool {
    text.lines().any(|line| {
        line.starts_with("<<<<<<< ")
            || line.starts_with("||||||| ")
            || line == "======="
            || line.starts_with(">>>>>>> ")
    })
}

fn parse_conflict_text(text: &str) -> ParsedConflictText {
    let mut current_text = String::new();
    let mut hunks = Vec::new();
    let mut state = ParseState::Normal;
    let mut own = String::new();
    let mut other = String::new();
    let mut start_offset = 0usize;
    let mut start_line = 1u32;

    for line in split_inclusive_lines(text) {
        match state {
            ParseState::Normal => {
                if line.starts_with("<<<<<<< ") {
                    state = ParseState::Own;
                    start_offset = current_text.len();
                    start_line = line_number_at_offset(&current_text);
                    own.clear();
                    other.clear();
                } else {
                    current_text.push_str(line);
                }
            }
            ParseState::Own => {
                if line.starts_with("||||||| ") {
                    state = ParseState::Base;
                } else if line == "=======\n" || line == "=======" {
                    state = ParseState::Other;
                } else {
                    own.push_str(line);
                }
            }
            ParseState::Base => {
                if line == "=======\n" || line == "=======" {
                    state = ParseState::Other;
                }
            }
            ParseState::Other => {
                if line.starts_with(">>>>>>> ") {
                    let mut replacement = String::new();
                    replacement.push_str(&own);
                    replacement.push_str(&other);
                    current_text.push_str(&replacement);
                    let end_offset = current_text.len();
                    let end_line = line_number_at_offset(&current_text);
                    hunks.push(ConflictHunk {
                        id: hunks.len() as u32,
                        start_line,
                        end_line,
                        start_offset: clamp_u32(start_offset),
                        end_offset: clamp_u32(end_offset),
                        own_text: own.clone(),
                        other_text: other.clone(),
                    });
                    state = ParseState::Normal;
                } else {
                    other.push_str(line);
                }
            }
        }
    }

    if state != ParseState::Normal {
        current_text.push_str(&own);
        current_text.push_str(&other);
    }

    ParsedConflictText {
        current_text,
        hunks,
    }
}

fn split_inclusive_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut lines = text.split_inclusive('\n').collect::<Vec<_>>();
    if !text.ends_with('\n') {
        let consumed = lines.iter().map(|line| line.len()).sum::<usize>();
        if consumed < text.len() {
            lines.push(&text[consumed..]);
        }
    }
    lines
}

fn line_number_at_offset(text: &str) -> u32 {
    clamp_u32(
        text.as_bytes()
            .iter()
            .filter(|byte| **byte == b'\n')
            .count()
            + 1,
    )
}

fn clamp_u32(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

fn image_mime_for_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn language_for_path(path: &Path) -> Option<String> {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "jsx" | "ts" | "tsx" | "json" => Some("ts".to_owned()),
        extension if !extension.is_empty() => Some(extension.to_owned()),
        _ => None,
    }
}

fn validate_conflict_paths(paths: &[String], operation_name: &str) -> AppResult<Vec<PathBuf>> {
    let mut validated = Vec::with_capacity(paths.len());
    let mut seen = BTreeSet::new();
    for path in paths {
        let validated_path = validate_conflict_path(path, operation_name)?;
        if seen.insert(validated_path.clone()) {
            validated.push(validated_path);
        }
    }
    if validated.is_empty() {
        return Err(logged(AppError::expected(
            "at least one conflict path is required",
            operation_name,
        )));
    }
    Ok(validated)
}

fn validate_conflict_path(path: &str, operation_name: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(logged(AppError::expected(
            "conflict path must be a repository-relative path",
            operation_name,
        )));
    }
    Ok(path)
}

fn git_path_for(
    runner: &GitRunner,
    root: &Path,
    relative: &str,
    operation_name: &str,
) -> AppResult<PathBuf> {
    let output = git_stdout(
        runner,
        root,
        ["rev-parse", "--git-path", relative],
        operation_name,
    )?;
    let path = PathBuf::from(output.trim());
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

fn canonical_repository_path(path: &str, operation_name: &str) -> AppResult<PathBuf> {
    fs::canonicalize(Path::new(path)).map_err(|source| {
        logged(AppError::expected(
            format!("failed to resolve repository path: {source}"),
            operation_name,
        ))
    })
}

fn git_stdout<I, S>(
    runner: &GitRunner,
    root: &Path,
    args: I,
    operation_name: &str,
) -> AppResult<String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let bytes = git_output_bytes(runner, root, args, operation_name)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn git_output_bytes<I, S>(
    runner: &GitRunner,
    root: &Path,
    args: I,
    operation_name: &str,
) -> AppResult<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = plan_git(runner, root, args).build();
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

fn command_to_output(
    mut command: Command,
    plan: &GitCommandPlan,
    operation_name: &str,
) -> AppResult<Vec<u8>> {
    let output = command
        .output()
        .map_err(|source| spawn_error(plan, source, operation_name))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(command_failure(plan, output, operation_name))
    }
}

fn plan_git<'a, I, S>(
    runner: &'a GitRunner,
    root: &Path,
    args: I,
) -> artistic_git_git_runner::GitCommandBuilder<'a>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut planned_args = vec![OsString::from("-C"), root.as_os_str().to_owned()];
    planned_args.extend(args.into_iter().map(Into::into));
    runner
        .git_command_builder()
        .enable_rename_detection()
        .enable_windows_longpaths()
        .args(planned_args)
}

fn command_failure(
    plan: &GitCommandPlan,
    output: std::process::Output,
    operation_name: &str,
) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let summary = stderr
        .lines()
        .next()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("git command failed during {operation_name}"));

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

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn conflict_display_path(path: &Path) -> String {
    display_path(path).replace('\\', "/")
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn logged(error: AppError) -> AppError {
    crate::logged_app_error(error)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StageEntry {
    oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedConflictText {
    current_text: String,
    hunks: Vec<ConflictHunk>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParseState {
    Normal,
    Own,
    Base,
    Other,
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_contracts::OperationId;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
    use std::process::Output;

    #[test]
    fn parses_conflict_markers_without_exposing_marker_lines() {
        let parsed = parse_conflict_text(
            "a\n<<<<<<< HEAD\nown\n||||||| base\nbase\n=======\nother\n>>>>>>> branch\nz\n",
        );

        assert_eq!(parsed.current_text, "a\nown\nother\nz\n");
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(parsed.hunks[0].own_text, "own\n");
        assert_eq!(parsed.hunks[0].other_text, "other\n");
        assert!(!contains_conflict_markers(&parsed.current_text));
    }

    #[test]
    fn maps_rebase_sides_to_git_checkout_semantics() {
        assert_eq!(
            checkout_side_for_operation(ConflictOperationKind::Rebase, ConflictSide::Own),
            "--theirs"
        );
        assert_eq!(
            checkout_side_for_operation(ConflictOperationKind::Rebase, ConflictSide::Other),
            "--ours"
        );
        assert_eq!(
            checkout_side_for_operation(ConflictOperationKind::Merge, ConflictSide::Own),
            "--ours"
        );
        assert_eq!(
            checkout_side_for_operation(ConflictOperationKind::Merge, ConflictSide::Other),
            "--theirs"
        );
    }

    #[test]
    fn maps_conflict_sides_to_revision_names_for_modified_times() {
        let merge = ConflictOperation {
            kind: ConflictOperationKind::Merge,
            label: "Merge".to_owned(),
        };
        let rebase = ConflictOperation {
            kind: ConflictOperationKind::Rebase,
            label: "Rebase".to_owned(),
        };
        let cherry_pick = ConflictOperation {
            kind: ConflictOperationKind::CherryPick,
            label: "Cherry-pick".to_owned(),
        };
        let revert = ConflictOperation {
            kind: ConflictOperationKind::Revert,
            label: "Revert".to_owned(),
        };

        assert_eq!(
            revision_for_side(Some(&merge), ConflictSide::Own),
            Some("HEAD")
        );
        assert_eq!(
            revision_for_side(Some(&merge), ConflictSide::Other),
            Some("MERGE_HEAD")
        );
        assert_eq!(
            revision_for_side(Some(&rebase), ConflictSide::Own),
            Some("REBASE_HEAD")
        );
        assert_eq!(
            revision_for_side(Some(&rebase), ConflictSide::Other),
            Some("HEAD")
        );
        assert_eq!(
            revision_for_side(Some(&cherry_pick), ConflictSide::Other),
            Some("CHERRY_PICK_HEAD")
        );
        assert_eq!(
            revision_for_side(Some(&revert), ConflictSide::Other),
            Some("REVERT_HEAD")
        );
    }

    #[test]
    fn unresolved_paths_include_unmerged_entries_and_marker_files() {
        let temp = TestTempDir::new("ag-conflict-gate").expect("temp repo");
        let marker_path = PathBuf::from("src/conflict.txt");
        let absolute_marker_path = temp.path().join(&marker_path);
        fs::create_dir_all(absolute_marker_path.parent().expect("parent")).expect("parent dir");
        fs::write(
            &absolute_marker_path,
            "<<<<<<< HEAD\nown\n=======\nother\n>>>>>>> other\n",
        )
        .expect("marker file");

        let mut entries = BTreeMap::new();
        entries.insert(
            PathBuf::from("assets/conflict.png"),
            BTreeMap::from([(2, StageEntry { oid: "abc".into() })]),
        );

        assert_eq!(
            unresolved_paths_from_entries(temp.path(), &[marker_path], &entries),
            vec![
                "assets/conflict.png".to_owned(),
                "src/conflict.txt".to_owned()
            ]
        );
    }

    #[test]
    fn encodes_binary_preview_bytes_as_base64() {
        assert_eq!(base64_encode(&[0, 0, 0]), "AAAA");
        assert_eq!(base64_encode(&[255]), "/w==");
    }

    #[test]
    fn rejects_absolute_or_parent_conflict_paths() {
        let absolute_path = if cfg!(windows) {
            "C:/tmp/file"
        } else {
            "/tmp/file"
        };

        assert!(validate_conflict_path(absolute_path, "test").is_err());
        assert!(validate_conflict_path("../file", "test").is_err());
        assert!(validate_conflict_path("src/file.txt", "test").is_ok());
    }

    #[test]
    fn complete_rejects_unresolved_merge_conflicts() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.start_text_merge_conflict();

        let error = complete_conflict_resolution(
            &runner,
            ConflictCompleteRequest {
                operation_id: OperationId("test-operation".to_owned()),
                paths: vec!["tracked.txt".to_owned()],
                repository_path: display_path(&repo.path),
            },
        )
        .expect_err("unresolved conflicts should block complete");

        assert!(error.summary.contains("conflicts remain unresolved"));
        assert!(repo.git_output(["ls-files", "-u"]).contains("tracked.txt"));
    }

    #[test]
    fn cancel_aborts_merge_conflicts() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.start_text_merge_conflict();

        let response = cancel_conflict_resolution(
            &runner,
            ConflictCancelRequest {
                operation_id: OperationId("test-operation".to_owned()),
                repository_path: display_path(&repo.path),
            },
        )
        .expect("cancel conflict resolution");

        assert_eq!(response.aborted, ConflictOperationKind::Merge);
        assert!(!repo.path.join(".git").join("MERGE_HEAD").exists());
        assert!(!repo.git_output(["status", "--porcelain"]).contains("UU "));
    }

    #[test]
    fn binary_detail_includes_side_info_and_image_preview() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_binary_commit();
        repo.start_binary_merge_conflict();

        let response = conflict_detail(
            &runner,
            ConflictPathRequest {
                path: "asset.png".to_owned(),
                repository_path: display_path(&repo.path),
            },
        )
        .expect("binary conflict detail");

        assert_eq!(response.file.file_kind, DiffFileKind::Image);
        let ConflictFileDetail::Binary { own, other } = response.detail else {
            panic!("expected binary conflict detail");
        };
        let own = own.expect("own side");
        let other = other.expect("other side");

        assert_eq!(own.mime_type.as_deref(), Some("image/png"));
        assert_eq!(own.size_bytes, Some(4));
        assert!(own.modified_unix_seconds.is_some());
        assert!(own
            .preview
            .expect("own preview")
            .data_url
            .starts_with("data:image/png;base64,"));
        assert_eq!(other.mime_type.as_deref(), Some("image/png"));
        assert_eq!(other.size_bytes, Some(4));
        assert!(other.modified_unix_seconds.is_some());
    }

    #[test]
    fn submodule_conflict_commands_accept_prefixed_paths() {
        let Some((runner, _home)) = real_runner_or_skip() else {
            return;
        };
        let child_seed = TestRepo::new(&runner);
        child_seed.init_with_commit();
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(vec![
            OsString::from("-c"),
            OsString::from("protocol.file.allow=always"),
            OsString::from("submodule"),
            OsString::from("add"),
            child_seed.path.as_os_str().to_owned(),
            OsString::from("deps/lib"),
        ]);
        repo.git(["commit", "-m", "add submodule"]);
        let submodule = repo.path.join("deps/lib");
        configure_identity_at(&runner, &submodule);
        start_text_merge_conflict_at(&runner, &submodule);

        assert!(detect_operation(&runner, &repo.path, "test")
            .expect("root operation")
            .is_none());
        assert!(detect_operation(&runner, &submodule, "test")
            .expect("submodule operation")
            .is_some());

        let list = list_conflicts(
            &runner,
            ConflictListRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("list prefixed submodule conflicts");
        assert_eq!(
            list.operation.expect("operation").kind,
            ConflictOperationKind::Merge
        );
        assert_eq!(list.files.len(), 1);
        assert_eq!(list.files[0].path, "deps/lib/tracked.txt");

        let detail = conflict_detail(
            &runner,
            ConflictPathRequest {
                path: "deps/lib/tracked.txt".to_owned(),
                repository_path: display_path(&repo.path),
            },
        )
        .expect("prefixed submodule conflict detail");
        assert_eq!(detail.file.path, "deps/lib/tracked.txt");
        assert_eq!(detail.file.status, ConflictResolutionStatus::Unresolved);
        let ConflictFileDetail::Text {
            own_text,
            other_text,
            hunks,
            ..
        } = detail.detail
        else {
            panic!("expected text conflict detail");
        };
        assert_eq!(own_text, "own\n");
        assert_eq!(other_text, "other\n");
        assert_eq!(hunks.len(), 1);

        let save = save_conflict_resolution(
            &runner,
            ConflictSaveResolutionRequest {
                content: "merged\n".to_owned(),
                path: "deps/lib/tracked.txt".to_owned(),
                pending_hunks: 0,
                repository_path: display_path(&repo.path),
            },
        )
        .expect("save prefixed submodule conflict");
        assert_eq!(save.file.path, "deps/lib/tracked.txt");
        assert_eq!(save.file.status, ConflictResolutionStatus::Resolved);
        assert_eq!(
            git_output_at(&runner, &submodule, ["ls-files", "-u"]).trim(),
            ""
        );
        assert_eq!(
            fs::read_to_string(submodule.join("tracked.txt")).expect("read resolved file"),
            "merged\n"
        );

        let complete = complete_conflict_resolution(
            &runner,
            ConflictCompleteRequest {
                operation_id: OperationId("submodule-conflict-test".to_owned()),
                paths: vec!["deps/lib/tracked.txt".to_owned()],
                repository_path: display_path(&repo.path),
            },
        )
        .expect("complete prefixed submodule conflict");
        assert_eq!(complete.continuation, ConflictOperationKind::Merge);
        assert!(detect_operation(&runner, &submodule, "test")
            .expect("submodule operation after complete")
            .is_none());
    }

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => return None,
            Err(error) => panic!("invalid embedded git distribution: {error}"),
        };
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-conflict-runner-home").expect("temp home");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        Some((runner, temp))
    }

    fn configure_identity_at(runner: &GitRunner, root: &Path) {
        git_output_at(runner, root, ["config", "user.name", "Tester"]);
        git_output_at(
            runner,
            root,
            ["config", "user.email", "tester@example.test"],
        );
    }

    fn start_text_merge_conflict_at(runner: &GitRunner, root: &Path) {
        git_output_at(runner, root, ["checkout", "-b", "other"]);
        fs::write(root.join("tracked.txt"), "other\n").expect("write other");
        git_output_at(runner, root, ["commit", "-am", "other"]);
        git_output_at(runner, root, ["checkout", "main"]);
        fs::write(root.join("tracked.txt"), "own\n").expect("write own");
        git_output_at(runner, root, ["commit", "-am", "own"]);

        let output = git_output_result_at(runner, root, ["merge", "other"]);
        assert!(
            !output.status.success(),
            "submodule merge should conflict instead of succeeding"
        );
    }

    fn git_output_at<I, S>(runner: &GitRunner, root: &Path, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        git_stdout(runner, root, args, "test").expect("git command")
    }

    fn git_output_result_at<I, S>(runner: &GitRunner, root: &Path, args: I) -> Output
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let plan = plan_git(runner, root, args).build();
        plan.to_command().output().expect("run git")
    }

    struct TestRepo {
        path: PathBuf,
        _temp: TestTempDir,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-conflict-repo").expect("temp repo");
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
            self.git(["add", "."]);
            self.git(["commit", "-m", "initial"]);
        }

        fn init_with_binary_commit(&self) {
            self.git(["init", "-b", "main"]);
            self.git(["config", "user.name", "Tester"]);
            self.git(["config", "user.email", "tester@example.test"]);
            self.write_bytes("asset.png", &[0, 1, 2, 3]);
            self.git(["add", "."]);
            self.git(["commit", "-m", "initial"]);
        }

        fn start_text_merge_conflict(&self) {
            self.git(["checkout", "-b", "other"]);
            self.write("tracked.txt", "other\n");
            self.git(["commit", "-am", "other"]);
            self.git(["checkout", "main"]);
            self.write("tracked.txt", "own\n");
            self.git(["commit", "-am", "own"]);

            let output = self.git_output_result(["merge", "other"]);
            assert!(
                !output.status.success(),
                "merge should conflict instead of succeeding"
            );
        }

        fn start_binary_merge_conflict(&self) {
            self.git(["checkout", "-b", "other"]);
            self.write_bytes("asset.png", &[0, 2, 3, 4]);
            self.git(["commit", "-am", "other binary"]);
            self.git(["checkout", "main"]);
            self.write_bytes("asset.png", &[0, 5, 6, 7]);
            self.git(["commit", "-am", "own binary"]);

            let output = self.git_output_result(["merge", "other"]);
            assert!(
                !output.status.success(),
                "merge should conflict instead of succeeding"
            );
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
            git_stdout(&self.runner, &self.path, args, "test").expect("git command")
        }

        fn git_output_result<I, S>(&self, args: I) -> Output
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            let plan = plan_git(&self.runner, &self.path, args).build();
            plan.to_command().output().expect("run git")
        }

        fn write(&self, relative: &str, content: &str) {
            self.write_bytes(relative, content.as_bytes());
        }

        fn write_bytes(&self, relative: &str, content: &[u8]) {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("parent dir");
            }
            fs::write(path, content).expect("write file");
        }
    }
}
