use crate::git_ops::{
    canonical_repository_path, git_stdout, run_git, run_git_lfs, run_git_raw,
    validate_relative_paths, DEFAULT_LARGE_FILE_THRESHOLD_MB,
};
use artistic_git_contracts::{
    AppError, AppResult, CommitRequest, CommitResponse, LargeFileDecision, LargeFileWarning,
    OperationId, SyncCurrentBranchRequest, SyncCurrentBranchResponse,
};
use artistic_git_git_runner::GitRunner;
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const OPERATION: &str = "commitChanges";

pub fn commit_changes(runner: &GitRunner, request: CommitRequest) -> AppResult<CommitResponse> {
    let root = canonical_repository_path(&request.repository_path, OPERATION)?;
    let paths = validate_relative_paths(&request.paths, OPERATION)?;
    if request.message.trim().is_empty() {
        return Err(logged(AppError::expected(
            "commit message cannot be empty",
            OPERATION,
        )));
    }

    if request.disable_repository_gpgsign {
        git_stdout(
            runner,
            Some(&root),
            ["config", "--local", "commit.gpgsign", "false"],
            OPERATION,
        )?;
    }

    let mut plan = CommitPlan::from_paths(runner, &root, &paths)?;
    let root_has_origin = repository_has_origin(runner, &root)?;
    if request.push_immediately && root_has_origin {
        plan.ensure_pushable_submodules(runner)?;
    }

    let threshold_mb = request
        .large_file_threshold_mb
        .unwrap_or(DEFAULT_LARGE_FILE_THRESHOLD_MB)
        .max(1);
    let threshold = u64::from(threshold_mb) * 1024 * 1024;
    let large_file_targets = large_files_without_lfs(runner, &root, &plan, threshold)?;
    let large_files = large_file_targets
        .iter()
        .map(|target| LargeFileWarning {
            path: target.display_path.clone(),
            size_bytes: target.size_bytes.to_string(),
        })
        .collect::<Vec<_>>();
    let mut lfs_tracked_paths = Vec::new();

    match request.large_file_decision {
        LargeFileDecision::Prompt if !large_files.is_empty() => {
            return Ok(CommitResponse::LargeFilesNeedDecision {
                large_files,
                threshold_mb,
            });
        }
        LargeFileDecision::TrackWithLfs if !large_files.is_empty() => {
            lfs_tracked_paths = track_large_files_with_lfs(runner, &mut plan, &large_file_targets)?;
        }
        LargeFileDecision::Prompt
        | LargeFileDecision::TrackWithLfs
        | LargeFileDecision::CommitNormally => {}
    }

    let operation_id = commit_operation_id();
    let rollback_points = plan.rollback_points(runner, &root)?;
    match commit_local_plan(runner, &root, &mut plan, &request.message, &operation_id) {
        Ok(()) => {}
        Err(LocalCommitFailure::Response(response)) => {
            if !matches!(response, CommitResponse::Conflicts { .. }) {
                rollback_local_phase(runner, &rollback_points);
            }
            return Ok(response);
        }
        Err(LocalCommitFailure::Error(error)) => {
            rollback_local_phase(runner, &rollback_points);
            return Err(error);
        }
    };

    let oid = git_stdout(runner, Some(&root), ["rev-parse", "HEAD"], OPERATION)?
        .trim()
        .to_owned();
    if request.push_immediately && root_has_origin {
        for submodule in plan
            .submodules
            .iter()
            .filter(|submodule| submodule.committed)
        {
            let sync = sync_for_commit(runner, &submodule.root, &operation_id)?;
            if let Some(conflict_response) =
                commit_conflict_response(sync, Some((&root, &submodule.path)))
            {
                return Ok(conflict_response);
            }
        }

        let sync = sync_for_commit(runner, &root, &operation_id)?;
        if let Some(conflict_response) = commit_conflict_response(sync, None) {
            return Ok(conflict_response);
        }
    }

    Ok(CommitResponse::Committed {
        oid,
        committed_paths: paths,
        lfs_tracked_paths,
    })
}

#[derive(Debug)]
struct CommitPlan {
    root_paths: Vec<String>,
    root_lfs_attrs: bool,
    root_submodule_paths: Vec<String>,
    submodules: Vec<SubmoduleCommitPlan>,
}

#[derive(Debug)]
struct SubmoduleCommitPlan {
    path: String,
    root: PathBuf,
    selected_paths: Vec<String>,
    pointer_paths: Vec<String>,
    lfs_attrs: bool,
    committed: bool,
}

#[derive(Debug, Clone)]
struct SubmoduleEntry {
    path: String,
    root: PathBuf,
}

#[derive(Debug)]
enum LocalCommitFailure {
    Response(CommitResponse),
    Error(AppError),
}

#[derive(Debug)]
enum CommitAttempt {
    Committed,
    GpgSignFailed { summary: String, stderr: String },
    NothingToCommit,
}

#[derive(Debug, Clone)]
struct RollbackPoint {
    root: PathBuf,
    head_oid: String,
    branch: Option<String>,
}

#[derive(Debug, Clone)]
struct LargeFileTarget {
    repo_path: Option<String>,
    repo_root: PathBuf,
    inner_path: String,
    display_path: String,
    size_bytes: u64,
}

impl CommitPlan {
    fn from_paths(runner: &GitRunner, root: &Path, paths: &[String]) -> AppResult<Self> {
        let submodule_entries = initialized_submodule_entries(runner, root)?;
        let mut root_paths = Vec::new();
        let mut selected_by_submodule: BTreeMap<String, Vec<String>> = BTreeMap::new();

        for path in paths {
            if let Some((entry, inner_path)) = deepest_submodule_path(&submodule_entries, path) {
                selected_by_submodule
                    .entry(entry.path.clone())
                    .or_default()
                    .push(inner_path.to_owned());
            } else {
                root_paths.push(path.clone());
            }
        }

        let mut affected = selected_by_submodule
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        for selected_path in selected_by_submodule.keys() {
            for entry in &submodule_entries {
                if is_submodule_ancestor(&entry.path, selected_path) {
                    affected.insert(entry.path.clone());
                }
            }
        }

        let entries_by_path = submodule_entries
            .iter()
            .map(|entry| (entry.path.clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut submodules = affected
            .iter()
            .filter_map(|path| entries_by_path.get(path))
            .map(|entry| SubmoduleCommitPlan {
                path: entry.path.clone(),
                root: entry.root.clone(),
                selected_paths: selected_by_submodule
                    .remove(&entry.path)
                    .unwrap_or_default(),
                pointer_paths: affected_child_paths(&affected, &entry.path),
                lfs_attrs: false,
                committed: false,
            })
            .collect::<Vec<_>>();
        submodules.sort_by(|left, right| {
            path_depth(&right.path)
                .cmp(&path_depth(&left.path))
                .then_with(|| right.path.cmp(&left.path))
        });

        let root_submodule_paths = affected
            .iter()
            .filter(|path| {
                !affected
                    .iter()
                    .any(|candidate| is_submodule_ancestor(candidate, path))
            })
            .cloned()
            .collect::<Vec<_>>();

        Ok(Self {
            root_paths,
            root_lfs_attrs: false,
            root_submodule_paths,
            submodules,
        })
    }

    fn ensure_pushable_submodules(&self, runner: &GitRunner) -> AppResult<()> {
        for submodule in &self.submodules {
            if !repository_has_origin(runner, &submodule.root)? {
                return Err(logged(AppError::expected(
                    format!(
                        "submodule '{}' has no origin remote, so it cannot be pushed before the superproject",
                        submodule.path
                    ),
                    OPERATION,
                )));
            }
        }
        Ok(())
    }

    fn rollback_points(&self, runner: &GitRunner, root: &Path) -> AppResult<Vec<RollbackPoint>> {
        let mut points = Vec::with_capacity(self.submodules.len() + 1);
        points.push(rollback_point(runner, root)?);
        for submodule in &self.submodules {
            points.push(rollback_point(runner, &submodule.root)?);
        }
        Ok(points)
    }
}

fn commit_local_plan(
    runner: &GitRunner,
    root: &Path,
    plan: &mut CommitPlan,
    message: &str,
    operation_id: &OperationId,
) -> Result<(), LocalCommitFailure> {
    let mut submodules_committed = 0;
    for submodule in &mut plan.submodules {
        ensure_submodule_branch(runner, root, submodule).map_err(LocalCommitFailure::Error)?;
        if should_sync_before_commit(runner, &submodule.root).map_err(LocalCommitFailure::Error)? {
            let sync = sync_for_commit(runner, &submodule.root, operation_id)
                .map_err(LocalCommitFailure::Error)?;
            if let Some(conflict_response) =
                commit_conflict_response(sync, Some((root, &submodule.path)))
            {
                return Err(LocalCommitFailure::Response(conflict_response));
            }
        }

        let mut add_paths = submodule.selected_paths.clone();
        add_paths.extend(submodule.pointer_paths.iter().cloned());
        if submodule.lfs_attrs && submodule.root.join(".gitattributes").exists() {
            add_paths.push(".gitattributes".to_owned());
        }
        normalize_paths(&mut add_paths);
        if add_paths.is_empty() {
            continue;
        }

        git_add_paths(runner, &submodule.root, &add_paths).map_err(LocalCommitFailure::Error)?;
        match git_commit_handled(runner, &submodule.root, message)
            .map_err(LocalCommitFailure::Error)?
        {
            CommitAttempt::Committed => {
                submodule.committed = true;
                submodules_committed += 1;
            }
            CommitAttempt::GpgSignFailed { summary, stderr } => {
                return Err(LocalCommitFailure::Response(
                    CommitResponse::GpgSignFailed { summary, stderr },
                ));
            }
            CommitAttempt::NothingToCommit => {}
        }
    }

    if should_sync_before_commit(runner, root).map_err(LocalCommitFailure::Error)? {
        let sync =
            sync_for_commit(runner, root, operation_id).map_err(LocalCommitFailure::Error)?;
        if let Some(conflict_response) = commit_conflict_response(sync, None) {
            return Err(LocalCommitFailure::Response(conflict_response));
        }
    }

    let mut add_paths = plan.root_paths.clone();
    add_paths.extend(plan.root_submodule_paths.iter().cloned());
    if plan.root_lfs_attrs && root.join(".gitattributes").exists() {
        add_paths.push(".gitattributes".to_owned());
    }
    normalize_paths(&mut add_paths);
    if add_paths.is_empty() {
        if submodules_committed == 0 {
            return Err(LocalCommitFailure::Response(
                CommitResponse::NothingToCommit,
            ));
        }
        return Err(LocalCommitFailure::Error(logged(AppError::expected(
            "submodule commits were created, but no superproject pointer path was selected",
            OPERATION,
        ))));
    }

    git_add_paths(runner, root, &add_paths).map_err(LocalCommitFailure::Error)?;
    match git_commit_handled(runner, root, message).map_err(LocalCommitFailure::Error)? {
        CommitAttempt::Committed => {}
        CommitAttempt::GpgSignFailed { summary, stderr } => {
            return Err(LocalCommitFailure::Response(
                CommitResponse::GpgSignFailed { summary, stderr },
            ));
        }
        CommitAttempt::NothingToCommit if submodules_committed == 0 => {
            return Err(LocalCommitFailure::Response(
                CommitResponse::NothingToCommit,
            ));
        }
        CommitAttempt::NothingToCommit => {
            return Err(LocalCommitFailure::Error(logged(AppError::expected(
                "submodule commits were created, but the superproject pointer did not change",
                OPERATION,
            ))));
        }
    };

    Ok(())
}

fn should_sync_before_commit(runner: &GitRunner, root: &Path) -> AppResult<bool> {
    Ok(repository_has_origin(runner, root)? && upstream_branch(runner, root)?.is_some())
}

fn repository_has_origin(runner: &GitRunner, root: &Path) -> AppResult<bool> {
    crate::remote::read_origin_url(runner, root, OPERATION).map(|origin| origin.is_some())
}

fn upstream_branch(runner: &GitRunner, root: &Path) -> AppResult<Option<String>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        OPERATION,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("no upstream") || stderr.contains("no such ref") {
            Ok(None)
        } else {
            Err(crate::git_ops::command_failure(&plan, output, OPERATION))
        }
    }
}

fn sync_for_commit(
    runner: &GitRunner,
    root: &Path,
    operation_id: &OperationId,
) -> AppResult<SyncCurrentBranchResponse> {
    crate::sync::sync_current_branch(
        runner,
        SyncCurrentBranchRequest {
            repository_path: crate::git_ops::display_path(root),
            operation_id: Some(operation_id.clone()),
        },
    )
}

fn commit_conflict_response(
    sync: SyncCurrentBranchResponse,
    submodule: Option<(&Path, &str)>,
) -> Option<CommitResponse> {
    let recovery = sync.stash_recovery;
    sync.conflict.map(|mut conflict| {
        if let Some((root, submodule_path)) = submodule {
            conflict.repository_path = crate::git_ops::display_path(root);
            for file in &mut conflict.files {
                file.path = prefix_submodule_path(submodule_path, &file.path);
            }
        }
        CommitResponse::Conflicts { conflict, recovery }
    })
}

fn commit_operation_id() -> OperationId {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    OperationId(format!("commit-changes-{millis}"))
}

fn initialized_submodule_entries(
    runner: &GitRunner,
    root: &Path,
) -> AppResult<Vec<SubmoduleEntry>> {
    if !root.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }

    let mut entries = crate::repository::initialized_submodule_paths(runner, root, OPERATION)?
        .into_iter()
        .filter_map(|submodule_root| {
            crate::repository::repository_relative_display_path(root, &submodule_root).map(|path| {
                SubmoduleEntry {
                    path,
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

fn deepest_submodule_path<'entries, 'path>(
    entries: &'entries [SubmoduleEntry],
    path: &'path str,
) -> Option<(&'entries SubmoduleEntry, &'path str)> {
    entries
        .iter()
        .filter_map(|entry| path_inside_submodule(path, &entry.path).map(|inner| (entry, inner)))
        .max_by_key(|(entry, _)| path_depth(&entry.path))
}

fn path_inside_submodule<'a>(path: &'a str, submodule_path: &str) -> Option<&'a str> {
    path.strip_prefix(submodule_path)
        .and_then(|suffix| suffix.strip_prefix('/'))
        .filter(|suffix| !suffix.is_empty())
}

fn is_submodule_ancestor(parent: &str, child: &str) -> bool {
    child != parent
        && child
            .strip_prefix(parent)
            .and_then(|suffix| suffix.strip_prefix('/'))
            .is_some()
}

fn affected_child_paths(affected: &BTreeSet<String>, parent: &str) -> Vec<String> {
    let mut children = affected
        .iter()
        .filter(|child| is_submodule_ancestor(parent, child))
        .filter(|child| {
            !affected.iter().any(|candidate| {
                candidate != parent
                    && candidate != *child
                    && is_submodule_ancestor(parent, candidate)
                    && is_submodule_ancestor(candidate, child)
            })
        })
        .filter_map(|child| path_inside_submodule(child, parent).map(ToOwned::to_owned))
        .collect::<Vec<_>>();
    normalize_paths(&mut children);
    children
}

fn path_depth(path: &str) -> usize {
    path.split('/').filter(|part| !part.is_empty()).count()
}

fn normalize_paths(paths: &mut Vec<String>) {
    paths.sort();
    paths.dedup();
}

fn prefix_submodule_path(submodule_path: &str, path: &str) -> String {
    let submodule_path = submodule_path.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        submodule_path.to_owned()
    } else {
        format!("{submodule_path}/{path}")
    }
}

fn large_files_without_lfs(
    runner: &GitRunner,
    root: &Path,
    plan: &CommitPlan,
    threshold: u64,
) -> AppResult<Vec<LargeFileTarget>> {
    let mut targets = Vec::new();
    for path in &plan.root_paths {
        collect_large_file_target(runner, root, None, path, path, threshold, &mut targets)?;
    }
    for submodule in &plan.submodules {
        for path in &submodule.selected_paths {
            let display_path = prefix_submodule_path(&submodule.path, path);
            collect_large_file_target(
                runner,
                &submodule.root,
                Some(submodule.path.clone()),
                path,
                &display_path,
                threshold,
                &mut targets,
            )?;
        }
    }

    Ok(targets)
}

fn collect_large_file_target(
    runner: &GitRunner,
    root: &Path,
    repo_path: Option<String>,
    inner_path: &str,
    display_path: &str,
    threshold: u64,
    targets: &mut Vec<LargeFileTarget>,
) -> AppResult<()> {
    let absolute = root.join(inner_path);
    let Ok(metadata) = fs::metadata(&absolute) else {
        return Ok(());
    };
    if !metadata.is_file()
        || metadata.len() < threshold
        || is_lfs_covered(runner, root, inner_path)?
    {
        return Ok(());
    }

    targets.push(LargeFileTarget {
        repo_path,
        repo_root: root.to_path_buf(),
        inner_path: inner_path.to_owned(),
        display_path: display_path.to_owned(),
        size_bytes: metadata.len(),
    });
    Ok(())
}

fn is_lfs_covered(runner: &GitRunner, root: &Path, path: &str) -> AppResult<bool> {
    let output = git_stdout(
        runner,
        Some(root),
        ["check-attr", "filter", "--", path],
        OPERATION,
    )?;

    Ok(output
        .lines()
        .any(|line| line.trim_end().ends_with(": filter: lfs")))
}

fn track_large_files_with_lfs(
    runner: &GitRunner,
    plan: &mut CommitPlan,
    targets: &[LargeFileTarget],
) -> AppResult<Vec<String>> {
    let mut grouped = BTreeMap::<Option<String>, (PathBuf, Vec<String>)>::new();
    for target in targets {
        grouped
            .entry(target.repo_path.clone())
            .or_insert_with(|| (target.repo_root.clone(), Vec::new()))
            .1
            .push(target.inner_path.clone());
    }

    for (repo_path, (repo_root, mut paths)) in grouped {
        normalize_paths(&mut paths);
        track_large_files_with_lfs_in_repo(runner, &repo_root, &paths)?;
        if let Some(repo_path) = repo_path {
            if let Some(submodule) = plan
                .submodules
                .iter_mut()
                .find(|submodule| submodule.path == repo_path)
            {
                submodule.lfs_attrs = true;
            }
        } else {
            plan.root_lfs_attrs = true;
        }
    }

    Ok(targets
        .iter()
        .map(|target| target.display_path.clone())
        .collect())
}

fn track_large_files_with_lfs_in_repo(
    runner: &GitRunner,
    root: &Path,
    paths: &[String],
) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }

    run_git_lfs(runner, Some(root), ["install", "--local"], OPERATION)?;

    let mut args = vec![OsString::from("track"), OsString::from("--filename")];
    args.push(OsString::from("--"));
    args.extend(paths.iter().map(OsString::from));
    run_git_lfs(runner, Some(root), args, OPERATION).map(|_| ())
}

fn ensure_submodule_branch(
    runner: &GitRunner,
    root: &Path,
    submodule: &SubmoduleCommitPlan,
) -> AppResult<()> {
    if current_branch_optional(runner, &submodule.root)?.is_some() {
        return Ok(());
    }

    let head_oid = rev_parse_verify(runner, &submodule.root, "HEAD")?;
    let Some(choice) = submodule_branch_choice(runner, root, submodule)? else {
        return Err(submodule_detached_error(&submodule.path));
    };

    checkout_submodule_branch(runner, submodule, &head_oid, choice)
}

#[derive(Debug)]
struct BranchChoice {
    name: String,
    allow_create_from_head: bool,
}

fn submodule_branch_choice(
    runner: &GitRunner,
    root: &Path,
    submodule: &SubmoduleCommitPlan,
) -> AppResult<Option<BranchChoice>> {
    if let Some(branch) = submodule_branch_from_gitmodules(runner, root, &submodule.path)? {
        return Ok(Some(BranchChoice {
            name: branch,
            allow_create_from_head: true,
        }));
    }

    if let Some(branch) = remote_default_branch(runner, &submodule.root)? {
        return Ok(Some(BranchChoice {
            name: branch,
            allow_create_from_head: false,
        }));
    }

    for branch in ["main", "master"] {
        let remote_ref = format!("refs/remotes/origin/{branch}");
        let local_ref = format!("refs/heads/{branch}");
        if show_ref_optional(runner, &submodule.root, &remote_ref)?.is_some()
            || show_ref_optional(runner, &submodule.root, &local_ref)?.is_some()
        {
            return Ok(Some(BranchChoice {
                name: branch.to_owned(),
                allow_create_from_head: false,
            }));
        }
    }

    Ok(None)
}

fn submodule_branch_from_gitmodules(
    runner: &GitRunner,
    root: &Path,
    submodule_path: &str,
) -> AppResult<Option<String>> {
    let Some(paths_output) =
        git_config_regexp_optional(runner, root, ".gitmodules", "^submodule\\..*\\.path$")?
    else {
        return Ok(None);
    };

    for line in paths_output.lines() {
        let mut fields = line.splitn(2, char::is_whitespace);
        let Some(path_key) = fields.next() else {
            continue;
        };
        let Some(path_value) = fields.next().map(str::trim) else {
            continue;
        };
        if path_value != submodule_path {
            continue;
        }

        let Some(section_key) = path_key.strip_suffix(".path") else {
            continue;
        };
        let branch_key = format!("{section_key}.branch");
        let Some(branch) = git_config_value_optional(runner, root, ".gitmodules", &branch_key)?
        else {
            return Ok(None);
        };
        let branch = branch.trim();
        if branch.is_empty() {
            return Ok(None);
        }
        if branch == "." {
            return current_branch_optional(runner, root);
        }
        return Ok(Some(normalize_branch_name(branch)));
    }

    Ok(None)
}

fn remote_default_branch(runner: &GitRunner, root: &Path) -> AppResult<Option<String>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        [
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        OPERATION,
    )?;
    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        Ok((!branch.is_empty()).then(|| normalize_branch_name(&branch)))
    } else if output.status.code() == Some(1) || is_missing_ref_output(&output.stderr) {
        Ok(None)
    } else {
        Err(crate::git_ops::command_failure(&plan, output, OPERATION))
    }
}

fn checkout_submodule_branch(
    runner: &GitRunner,
    submodule: &SubmoduleCommitPlan,
    head_oid: &str,
    choice: BranchChoice,
) -> AppResult<()> {
    let remote_short = format!("origin/{}", choice.name);
    let remote_ref = format!("refs/remotes/{remote_short}");
    if show_ref_optional(runner, &submodule.root, &remote_ref)?.is_some() {
        ensure_detached_head_reaches_branch(runner, submodule, head_oid, &remote_ref)?;
        return git_stdout(
            runner,
            Some(&submodule.root),
            [
                "checkout",
                "-B",
                choice.name.as_str(),
                remote_short.as_str(),
            ],
            OPERATION,
        )
        .map(|_| ());
    }

    let local_ref = format!("refs/heads/{}", choice.name);
    if show_ref_optional(runner, &submodule.root, &local_ref)?.is_some() {
        ensure_detached_head_reaches_branch(runner, submodule, head_oid, choice.name.as_str())?;
        return git_stdout(
            runner,
            Some(&submodule.root),
            ["checkout", choice.name.as_str()],
            OPERATION,
        )
        .map(|_| ());
    }

    if choice.allow_create_from_head {
        return git_stdout(
            runner,
            Some(&submodule.root),
            ["checkout", "-b", choice.name.as_str()],
            OPERATION,
        )
        .map(|_| ());
    }

    Err(submodule_detached_error(&submodule.path))
}

fn ensure_detached_head_reaches_branch(
    runner: &GitRunner,
    submodule: &SubmoduleCommitPlan,
    head_oid: &str,
    branch_ref: &str,
) -> AppResult<()> {
    if merge_base_is_ancestor(runner, &submodule.root, head_oid, branch_ref)? {
        Ok(())
    } else {
        Err(logged(AppError::expected(
            format!(
                "子模块 '{}' 当前 detached HEAD 不在目标分支 '{}' 的历史中，无法安全提交。",
                submodule.path, branch_ref
            ),
            OPERATION,
        )))
    }
}

fn normalize_branch_name(branch: &str) -> String {
    let branch = branch.trim();
    for prefix in ["refs/remotes/origin/", "refs/heads/", "origin/"] {
        if let Some(short) = branch.strip_prefix(prefix) {
            return short.to_owned();
        }
    }
    branch.to_owned()
}

fn current_branch_optional(runner: &GitRunner, root: &Path) -> AppResult<Option<String>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        OPERATION,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(crate::git_ops::command_failure(&plan, output, OPERATION))
    }
}

fn rev_parse_verify(runner: &GitRunner, root: &Path, rev: &str) -> AppResult<String> {
    git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--verify", rev],
        OPERATION,
    )
    .map(|value| value.trim().to_owned())
}

fn show_ref_optional(runner: &GitRunner, root: &Path, refname: &str) -> AppResult<Option<String>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["show-ref", "--verify", "--hash", refname],
        OPERATION,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(crate::git_ops::command_failure(&plan, output, OPERATION))
    }
}

fn merge_base_is_ancestor(
    runner: &GitRunner,
    root: &Path,
    ancestor: &str,
    descendant: &str,
) -> AppResult<bool> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["merge-base", "--is-ancestor", ancestor, descendant],
        OPERATION,
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(crate::git_ops::command_failure(&plan, output, OPERATION)),
    }
}

fn git_config_regexp_optional(
    runner: &GitRunner,
    root: &Path,
    config_file: &str,
    pattern: &str,
) -> AppResult<Option<String>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["config", "--file", config_file, "--get-regexp", pattern],
        OPERATION,
    )?;
    if output.status.success() {
        Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(crate::git_ops::command_failure(&plan, output, OPERATION))
    }
}

fn git_config_value_optional(
    runner: &GitRunner,
    root: &Path,
    config_file: &str,
    key: &str,
) -> AppResult<Option<String>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["config", "--file", config_file, "--get", key],
        OPERATION,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(crate::git_ops::command_failure(&plan, output, OPERATION))
    }
}

fn is_missing_ref_output(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    stderr.contains("not a symbolic ref")
        || stderr.contains("no such ref")
        || stderr.contains("not found")
        || stderr.contains("needed a single revision")
}

fn submodule_detached_error(submodule_path: &str) -> AppError {
    logged(AppError::expected(
        format!(
            "子模块 '{submodule_path}' 当前处于 detached HEAD，且无法安全确定可提交分支。请先在该子模块中检出目标分支。"
        ),
        OPERATION,
    ))
}

fn rollback_point(runner: &GitRunner, root: &Path) -> AppResult<RollbackPoint> {
    Ok(RollbackPoint {
        root: root.to_path_buf(),
        head_oid: rev_parse_verify(runner, root, "HEAD")?,
        branch: current_branch_optional(runner, root)?,
    })
}

fn rollback_local_phase(runner: &GitRunner, points: &[RollbackPoint]) {
    for point in points.iter().rev() {
        let _ = run_git_raw(
            runner,
            Some(&point.root),
            ["reset", "--mixed", point.head_oid.as_str()],
            OPERATION,
        );
        match point.branch.as_deref() {
            Some(branch) => {
                if current_branch_optional(runner, &point.root)
                    .ok()
                    .flatten()
                    .as_deref()
                    != Some(branch)
                {
                    let _ = run_git_raw(runner, Some(&point.root), ["checkout", branch], OPERATION);
                }
            }
            None => {
                let _ = run_git_raw(
                    runner,
                    Some(&point.root),
                    ["checkout", "--detach", point.head_oid.as_str()],
                    OPERATION,
                );
            }
        }
    }
}

fn git_commit_handled(runner: &GitRunner, root: &Path, message: &str) -> AppResult<CommitAttempt> {
    match git_commit(runner, root, message) {
        Ok(()) => Ok(CommitAttempt::Committed),
        Err(error) if is_gpg_sign_failure(&error) => {
            let (summary, stderr) = git_error_text(&error);
            Ok(CommitAttempt::GpgSignFailed { summary, stderr })
        }
        Err(error) if is_nothing_to_commit(&error) => Ok(CommitAttempt::NothingToCommit),
        Err(error) => Err(error),
    }
}

fn git_add_paths(runner: &GitRunner, root: &Path, paths: &[String]) -> AppResult<()> {
    let mut args = vec![
        OsString::from("add"),
        OsString::from("-A"),
        OsString::from("--"),
    ];
    args.extend(paths.iter().map(OsString::from));
    run_git(runner, Some(root), args, OPERATION).map(|_| ())
}

fn git_commit(runner: &GitRunner, root: &Path, message: &str) -> AppResult<()> {
    let args = [
        OsString::from("commit"),
        OsString::from("-m"),
        OsString::from(message),
    ];
    let (plan, output) = run_git_raw(runner, Some(root), args, OPERATION)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(crate::git_ops::command_failure(&plan, output, OPERATION))
    }
}

fn is_gpg_sign_failure(error: &AppError) -> bool {
    let stderr = error
        .git
        .as_ref()
        .map(|git| git.stderr.to_ascii_lowercase())
        .unwrap_or_default();

    stderr.contains("gpg failed to sign")
        || stderr.contains("failed to sign")
        || stderr.contains("no secret key")
        || stderr.contains("failed to write commit object") && stderr.contains("sign")
}

fn is_nothing_to_commit(error: &AppError) -> bool {
    let combined = error
        .git
        .as_ref()
        .map(|git| format!("{}\n{}", git.stdout, git.stderr).to_ascii_lowercase())
        .unwrap_or_default();
    combined.contains("nothing to commit") || combined.contains("no changes added to commit")
}

fn git_error_text(error: &AppError) -> (String, String) {
    let stderr = error
        .git
        .as_ref()
        .map(|git| git.stderr.clone())
        .unwrap_or_default();
    let summary = if error.summary.trim().is_empty() {
        "commit signing failed".to_owned()
    } else {
        error.summary.clone()
    };
    (summary, stderr)
}

fn logged(error: AppError) -> AppError {
    crate::logged_app_error(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ops::display_path;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
    use std::{
        ffi::OsString,
        io::Write,
        path::{Path, PathBuf},
    };

    #[test]
    fn commits_only_selected_paths() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("selected.txt", "selected\n");
        repo.write("unselected.txt", "unselected\n");

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["selected.txt".to_owned()],
                message: "commit selected\n\nbody".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: false,
            },
        )
        .expect("commit selected path");

        assert!(matches!(response, CommitResponse::Committed { .. }));
        assert_eq!(
            repo.git_output(["status", "--short", "--", "unselected.txt"])
                .trim(),
            "?? unselected.txt"
        );
        assert_eq!(
            repo.git_output(["log", "-1", "--format=%s"]).trim(),
            "commit selected"
        );
    }

    #[test]
    fn large_file_prompt_blocks_before_commit() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write_bytes("large.bin", &vec![7; 1024 * 1024 + 1]);

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["large.bin".to_owned()],
                message: "large".to_owned(),
                large_file_threshold_mb: Some(1),
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: false,
            },
        )
        .expect("large file prompt");

        match response {
            CommitResponse::LargeFilesNeedDecision {
                large_files,
                threshold_mb,
            } => {
                assert_eq!(threshold_mb, 1);
                assert_eq!(large_files[0].path, "large.bin");
            }
            other => panic!("unexpected response: {other:?}"),
        }
        assert!(repo.git_output(["log", "--format=%s"]).contains("initial"));
    }

    #[test]
    fn large_file_track_with_lfs_installs_filters_and_commits_pointer() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write_bytes("large.bin", &vec![7; 1024 * 1024 + 1]);

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["large.bin".to_owned()],
                message: "track large".to_owned(),
                large_file_threshold_mb: Some(1),
                large_file_decision: LargeFileDecision::TrackWithLfs,
                disable_repository_gpgsign: false,
                push_immediately: false,
            },
        )
        .expect("track large file with lfs");

        match response {
            CommitResponse::Committed {
                lfs_tracked_paths, ..
            } => {
                assert_eq!(lfs_tracked_paths, vec!["large.bin"]);
            }
            other => panic!("unexpected response: {other:?}"),
        }
        assert!(repo
            .read(".gitattributes")
            .contains("large.bin filter=lfs diff=lfs merge=lfs -text"));
        assert!(repo
            .git_output(["show", "HEAD:large.bin"])
            .starts_with("version https://git-lfs.github.com/spec/v1\n"));
    }

    #[test]
    fn large_file_commit_normally_skips_lfs_tracking() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write_bytes("large.bin", &vec![9; 1024 * 1024 + 1]);

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["large.bin".to_owned()],
                message: "commit normally".to_owned(),
                large_file_threshold_mb: Some(1),
                large_file_decision: LargeFileDecision::CommitNormally,
                disable_repository_gpgsign: false,
                push_immediately: false,
            },
        )
        .expect("commit large file normally");

        assert!(matches!(response, CommitResponse::Committed { .. }));
        assert!(!repo.path.join(".gitattributes").exists());
        assert_eq!(
            repo.git_output(["cat-file", "-s", "HEAD:large.bin"]).trim(),
            (1024 * 1024 + 1).to_string()
        );
    }

    #[test]
    fn disable_repository_gpgsign_writes_local_config_before_commit() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["config", "--local", "commit.gpgsign", "true"]);
        repo.write("tracked.txt", "signed config disabled\n");

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["tracked.txt".to_owned()],
                message: "disable signing".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: true,
                push_immediately: false,
            },
        )
        .expect("disable repository gpgsign");

        assert!(matches!(response, CommitResponse::Committed { .. }));
        assert_eq!(
            repo.git_output(["config", "--local", "--get", "commit.gpgsign"])
                .trim(),
            "false"
        );
    }

    #[test]
    fn commit_syncs_before_commit_and_pushes_selected_paths() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.peer.write("remote.txt", "remote\n");
        fixture.peer.git(["add", "remote.txt"]);
        fixture.peer.git(["commit", "-m", "remote change"]);
        fixture.peer.git(["push"]);
        fixture.local.write("selected.txt", "selected\n");
        fixture.local.write("unselected.txt", "unselected\n");

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&fixture.local.path),
                paths: vec!["selected.txt".to_owned()],
                message: "selected commit".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: true,
            },
        )
        .expect("commit with sync and push");

        assert!(matches!(response, CommitResponse::Committed { .. }));
        assert_eq!(fixture.local.read("remote.txt"), "remote\n");
        assert_eq!(fixture.local.read("unselected.txt"), "unselected\n");
        assert_eq!(
            fixture
                .local
                .git_output(["status", "--short", "--", "unselected.txt"])
                .trim(),
            "?? unselected.txt"
        );
        fixture.peer.git(["pull", "--ff-only"]);
        assert_eq!(fixture.peer.read("selected.txt"), "selected\n");
    }

    #[test]
    fn commit_push_immediately_publishes_branch_without_upstream() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let parent = TestTempDir::new("ag-commit-publish").expect("publish parent");
        let remote = TestRepo::at(&runner, parent.path().join("remote.git"));
        remote.git(["init", "--bare"]);
        let repo = TestRepo::at(&runner, parent.path().join("repo"));
        repo.git(["init", "-b", "main"]);
        repo.git(["config", "user.name", "Tester"]);
        repo.git(["config", "user.email", "tester@example.test"]);
        repo.write("tracked.txt", "initial\n");
        repo.git(["add", "tracked.txt"]);
        repo.git(["commit", "-m", "initial"]);
        repo.git([
            "remote",
            "add",
            "origin",
            display_path(&remote.path).as_str(),
        ]);
        repo.write("selected.txt", "selected\n");

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["selected.txt".to_owned()],
                message: "publish selected".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: true,
            },
        )
        .expect("commit publishes branch");

        assert!(matches!(response, CommitResponse::Committed { .. }));
        assert_eq!(
            repo.git_output(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
                .trim(),
            "origin/main"
        );
        assert_eq!(
            remote.git_output(["show", "refs/heads/main:selected.txt"]),
            "selected\n"
        );
    }

    #[test]
    fn commit_push_immediately_recovers_from_push_race() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = DoubleClone::new(&runner);
        fixture.local.write("selected.txt", "selected\n");
        fixture.install_one_shot_push_race_hook();

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&fixture.local.path),
                paths: vec!["selected.txt".to_owned()],
                message: "selected with race".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: true,
            },
        )
        .expect("commit push race self-heals");

        assert!(matches!(response, CommitResponse::Committed { .. }));
        fixture.peer.git(["pull", "--ff-only"]);
        assert_eq!(fixture.peer.read("selected.txt"), "selected\n");
        assert_eq!(fixture.peer.read("race.txt"), "race\n");
    }

    #[test]
    fn commit_submodule_workspace_change_commits_child_then_superproject_pointer() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let fixture = SubmoduleCommitFixture::new(&runner);
        let submodule = fixture.local.path.join("deps/lib");
        fs::write(submodule.join("tracked.txt"), "two\n").expect("write submodule file");

        let response = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&fixture.local.path),
                paths: vec!["deps/lib/tracked.txt".to_owned()],
                message: "update submodule file".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: false,
            },
        )
        .expect("commit submodule workspace change");

        assert!(matches!(response, CommitResponse::Committed { .. }));
        assert_eq!(
            git_output_at(&runner, &submodule, ["branch", "--show-current"]).trim(),
            "main"
        );
        assert_eq!(
            git_output_at(&runner, &submodule, ["log", "-1", "--format=%s"]).trim(),
            "update submodule file"
        );
        let child_head = git_output_at(&runner, &submodule, ["rev-parse", "HEAD"]);
        assert!(fixture
            .local
            .git_output(["ls-tree", "HEAD", "deps/lib"])
            .contains(child_head.trim()));
        assert_eq!(
            fixture
                .local
                .git_output(["log", "-1", "--format=%s"])
                .trim(),
            "update submodule file"
        );
        assert!(fixture
            .local
            .git_output(["status", "--porcelain=v1"])
            .is_empty());
    }

    #[test]
    fn commit_submodule_push_boundary_keeps_superproject_ahead_after_root_push_failure() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let fixture = SubmoduleCommitFixture::new(&runner);
        let submodule = fixture.local.path.join("deps/lib");
        fs::write(submodule.join("tracked.txt"), "two\n").expect("write submodule file");
        fixture.install_failing_superproject_push_hook();

        let error = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&fixture.local.path),
                paths: vec!["deps/lib/tracked.txt".to_owned()],
                message: "publish submodule chain".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: true,
            },
        )
        .expect_err("superproject push should fail after child push");

        assert!(
            error.summary.contains("本地提交已保留为未推送状态"),
            "{}",
            error.summary
        );
        assert_eq!(
            fixture
                .child_remote
                .git_output(["show", "refs/heads/main:tracked.txt"]),
            "two\n"
        );
        assert_eq!(test_ahead_behind(&fixture.local), (1, 0));
        assert!(fixture
            .local
            .git_output(["status", "--porcelain=v1"])
            .is_empty());

        fixture.remove_superproject_push_hook();
        crate::sync::sync_current_branch(
            &runner,
            SyncCurrentBranchRequest {
                repository_path: display_path(&fixture.local.path),
                operation_id: None,
            },
        )
        .expect("next sync publishes preserved superproject commit");
        fixture.peer.git(["pull", "--ff-only"]);
        fixture
            .peer
            .git(["submodule", "update", "--init", "--recursive"]);
        assert_eq!(fixture.peer.read("deps/lib/tracked.txt"), "two\n");
    }

    #[test]
    fn commit_submodule_detached_without_safe_branch_is_rejected() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        allow_file_protocol_for_local_submodule_fixtures(&runner);
        let fixture = SubmoduleCommitFixture::new(&runner);
        let submodule = fixture.local.path.join("deps/lib");
        git_output_at(&runner, &submodule, ["remote", "remove", "origin"]);
        fixture.local.git([
            "config",
            "--file",
            ".gitmodules",
            "--unset",
            "submodule.deps/lib.branch",
        ]);
        fs::write(submodule.join("tracked.txt"), "two\n").expect("write submodule file");

        let error = commit_changes(
            &runner,
            CommitRequest {
                repository_path: display_path(&fixture.local.path),
                paths: vec!["deps/lib/tracked.txt".to_owned()],
                message: "blocked submodule commit".to_owned(),
                large_file_threshold_mb: None,
                large_file_decision: LargeFileDecision::Prompt,
                disable_repository_gpgsign: false,
                push_immediately: false,
            },
        )
        .expect_err("unsafe detached submodule should be rejected");

        assert!(error.summary.contains("detached HEAD"), "{}", error.summary);
        assert!(
            git_output_at(&runner, &submodule, ["branch", "--show-current"])
                .trim()
                .is_empty()
        );
        assert_eq!(
            git_output_at(&runner, &submodule, ["status", "--short"]).trim(),
            "M tracked.txt"
        );
        assert_ne!(
            fixture
                .local
                .git_output(["log", "-1", "--format=%s"])
                .trim(),
            "blocked submodule commit"
        );
    }

    #[test]
    fn commit_conflict_response_prefixes_submodule_paths() {
        let response = commit_conflict_response(
            SyncCurrentBranchResponse {
                repository_path: "/repo/deps/lib".to_owned(),
                branch_name: "main".to_owned(),
                upstream: Some("origin/main".to_owned()),
                status: artistic_git_contracts::SyncCurrentBranchStatus::Conflicts,
                attempts: 1,
                conflict: Some(artistic_git_contracts::ConflictEnteredEvent {
                    operation_id: OperationId("conflict-prefix-test".to_owned()),
                    repository_path: "/repo/deps/lib".to_owned(),
                    operation_name: "syncCurrentBranch".to_owned(),
                    files: vec![artistic_git_contracts::ConflictFile {
                        path: "src/lib.rs".to_owned(),
                        status: artistic_git_contracts::ConflictResolutionStatus::Unresolved,
                        file_kind: artistic_git_contracts::DiffFileKind::Text,
                    }],
                }),
                stash_recovery: None,
                remote_history_change: None,
            },
            Some((Path::new("/repo"), "deps/lib")),
        )
        .expect("conflict response");

        match response {
            CommitResponse::Conflicts { conflict, .. } => {
                assert_eq!(conflict.repository_path, "/repo");
                assert_eq!(conflict.files[0].path, "deps/lib/src/lib.rs");
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn relative_path_validation_rejects_escape() {
        let error = validate_relative_paths(&["../outside".to_owned()], OPERATION)
            .expect_err("escape should be rejected");

        assert_eq!(
            error.summary,
            "selected paths must stay inside the repository"
        );
    }

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => return None,
            Err(error) => panic!("invalid embedded git distribution: {error}"),
        };
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-commit-runner-home").expect("temp home");
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
            let temp = TestTempDir::new("ag-commit-repo").expect("temp repo");
            Self {
                path: temp.path().to_path_buf(),
                _temp: Some(temp),
                runner: runner.clone(),
            }
        }

        fn at(runner: &GitRunner, path: PathBuf) -> Self {
            fs::create_dir_all(&path).expect("create repo path");
            Self {
                path,
                _temp: None,
                runner: runner.clone(),
            }
        }

        fn init_with_commit(&self) {
            self.git(["init"]);
            self.configure_identity();
            self.write("tracked.txt", "one\n");
            self.git(["add", "."]);
            self.git(["commit", "-m", "initial"]);
        }

        fn configure_identity(&self) {
            self.git(["config", "user.name", "Tester"]);
            self.git(["config", "user.email", "tester@example.test"]);
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
            self.write_bytes(relative, content.as_bytes());
        }

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.path.join(relative)).expect("read file")
        }

        fn write_bytes(&self, relative: &str, content: &[u8]) {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("parent dir");
            }
            let mut file = fs::File::create(path).expect("create file");
            file.write_all(content).expect("write file");
        }
    }

    struct SubmoduleCommitFixture {
        child_remote: TestRepo,
        local: TestRepo,
        peer: TestRepo,
        _super_remote: TestRepo,
        _child_seed: TestRepo,
        _super_seed: TestRepo,
        _parent: TestTempDir,
    }

    impl SubmoduleCommitFixture {
        fn new(runner: &GitRunner) -> Self {
            let parent = TestTempDir::new("ag-commit-submodule").expect("submodule parent");

            let child_remote = TestRepo::at(runner, parent.path().join("child.git"));
            child_remote.git(["init", "--bare", "-b", "main"]);

            let child_seed = TestRepo::at(runner, parent.path().join("child-seed"));
            child_seed.git(["init", "-b", "main"]);
            child_seed.configure_identity();
            child_seed.write("tracked.txt", "one\n");
            child_seed.git(["add", "tracked.txt"]);
            child_seed.git(["commit", "-m", "initial child"]);
            child_seed.git([
                "remote",
                "add",
                "origin",
                display_path(&child_remote.path).as_str(),
            ]);
            child_seed.git(["push", "-u", "origin", "main"]);

            let super_remote = TestRepo::at(runner, parent.path().join("super.git"));
            super_remote.git(["init", "--bare", "-b", "main"]);

            let super_seed = TestRepo::at(runner, parent.path().join("super-seed"));
            super_seed.git(["init", "-b", "main"]);
            super_seed.configure_identity();
            super_seed.git([
                OsString::from("-c"),
                OsString::from("protocol.file.allow=always"),
                OsString::from("submodule"),
                OsString::from("add"),
                OsString::from("-b"),
                OsString::from("main"),
                OsString::from(display_path(&child_remote.path)),
                OsString::from("deps/lib"),
            ]);
            super_seed.git(["commit", "-m", "add submodule"]);
            super_seed.git([
                "remote",
                "add",
                "origin",
                display_path(&super_remote.path).as_str(),
            ]);
            super_seed.git(["push", "-u", "origin", "main"]);

            let local = TestRepo::at(runner, parent.path().join("local"));
            git_clone_recurse_submodules(runner, &super_remote.path, &local.path);
            local.configure_identity();
            configure_identity_at(runner, &local.path.join("deps/lib"));

            let peer = TestRepo::at(runner, parent.path().join("peer"));
            git_clone_recurse_submodules(runner, &super_remote.path, &peer.path);
            peer.configure_identity();
            configure_identity_at(runner, &peer.path.join("deps/lib"));

            Self {
                child_remote,
                local,
                peer,
                _super_remote: super_remote,
                _child_seed: child_seed,
                _super_seed: super_seed,
                _parent: parent,
            }
        }

        fn install_failing_superproject_push_hook(&self) {
            let hook = self.local.path.join(".git").join("hooks").join("pre-push");
            fs::write(
                &hook,
                "#!/bin/sh\nprintf '%s\\n' 'intentional superproject push failure' >&2\nexit 1\n",
            )
            .expect("write failing pre-push hook");
            make_executable(&hook);
        }

        fn remove_superproject_push_hook(&self) {
            let hook = self.local.path.join(".git").join("hooks").join("pre-push");
            let _ = fs::remove_file(hook);
        }
    }

    fn git_clone_recurse_submodules(runner: &GitRunner, remote: &Path, destination: &Path) {
        git_stdout(
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

    fn configure_identity_at(runner: &GitRunner, root: &Path) {
        git_output_at(runner, root, ["config", "user.name", "Tester"]);
        git_output_at(
            runner,
            root,
            ["config", "user.email", "tester@example.test"],
        );
    }

    fn git_output_at<I, S>(runner: &GitRunner, root: &Path, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        git_stdout(runner, Some(root), args, "test").expect("git command")
    }

    fn allow_file_protocol_for_local_submodule_fixtures(runner: &GitRunner) {
        git_stdout(
            runner,
            None,
            ["config", "--global", "protocol.file.allow", "always"],
            "test",
        )
        .expect("allow file protocol for local submodule fixtures");
    }

    fn test_ahead_behind(repo: &TestRepo) -> (u32, u32) {
        let output = repo.git_output(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
        let mut parts = output.split_whitespace();
        let ahead = parts
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or_default();
        let behind = parts
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or_default();
        (ahead, behind)
    }

    struct DoubleClone {
        local: TestRepo,
        peer: TestRepo,
        _remote: TestRepo,
        _parent: TestTempDir,
    }

    impl DoubleClone {
        fn new(runner: &GitRunner) -> Self {
            let parent = TestTempDir::new("ag-commit-double").expect("double clone parent");
            let remote = TestRepo::at(runner, parent.path().join("remote.git"));
            remote.git(["init", "--bare"]);

            let seed = TestRepo::at(runner, parent.path().join("seed"));
            seed.git(["init", "-b", "main"]);
            seed.git(["config", "user.name", "Tester"]);
            seed.git(["config", "user.email", "tester@example.test"]);
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
            local.git(["config", "user.name", "Tester"]);
            local.git(["config", "user.email", "tester@example.test"]);

            let peer = TestRepo::at(runner, parent.path().join("peer"));
            peer.git([
                "clone",
                display_path(&remote.path).as_str(),
                display_path(&peer.path).as_str(),
            ]);
            peer.git(["config", "user.name", "Tester"]);
            peer.git(["config", "user.email", "tester@example.test"]);

            Self {
                local,
                peer,
                _remote: remote,
                _parent: parent,
            }
        }

        fn install_one_shot_push_race_hook(&self) {
            let marker = self.local.path.join(".git").join("ag-commit-race-once");
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

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", display_path(path).replace('\'', "'\\''"))
    }
}
