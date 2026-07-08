use artistic_git_contracts::{
    AppError, AppResult, BranchNameValidationRequest, BranchNameValidationResponse,
    BranchOperationResponse, CheckoutBranchRequest, CheckoutLocalChangesMode,
    CreateAutoStashRequest, CreateBranchRequest, DeleteBranchRequest, DeleteSafetyBackupRequest,
    DeleteSafetyBackupResponse, GitCommandError, OperationContext, OperationId,
    RepositoryPathRequest, SafetyBackupListResponse, SafetyBackupSummary, StashRestoreOutcome,
};
use artistic_git_git_runner::GitRunner;
use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const VALIDATE_BRANCH_NAME_OPERATION: &str = "validateBranchName";
const CREATE_BRANCH_OPERATION: &str = "createBranch";
const CHECKOUT_BRANCH_OPERATION: &str = "checkoutBranch";
const DELETE_BRANCH_OPERATION: &str = "deleteBranch";
const LIST_SAFETY_BACKUPS_OPERATION: &str = "listSafetyBackups";
const DELETE_SAFETY_BACKUP_OPERATION: &str = "deleteSafetyBackup";

pub fn validate_branch_name(
    runner: &GitRunner,
    request: BranchNameValidationRequest,
) -> AppResult<BranchNameValidationResponse> {
    let root = crate::repository::canonical_repository_path(
        &request.repository_path,
        VALIDATE_BRANCH_NAME_OPERATION,
    )?;
    let name = request.name.trim().to_owned();

    if name.is_empty() {
        return Ok(BranchNameValidationResponse {
            name,
            valid: false,
            exists: false,
            message: Some("分支名称不能为空。".to_owned()),
        });
    }
    if name != request.name {
        return Ok(BranchNameValidationResponse {
            name,
            valid: false,
            exists: false,
            message: Some("分支名称不能包含首尾空白。".to_owned()),
        });
    }

    let check = git_output_status(
        runner,
        &root,
        ["check-ref-format", "--branch", name.as_str()],
        VALIDATE_BRANCH_NAME_OPERATION,
    )?;
    let exists = branch_ref_exists(runner, &root, &name, VALIDATE_BRANCH_NAME_OPERATION)?;

    Ok(BranchNameValidationResponse {
        name,
        valid: check.status.success(),
        exists,
        message: (!check.status.success()).then(|| {
            first_output_line(&check.stderr)
                .or_else(|| first_output_line(&check.stdout))
                .unwrap_or_else(|| "不是有效的 Git 分支名称。".to_owned())
        }),
    })
}

pub fn create_branch(
    runner: &GitRunner,
    request: CreateBranchRequest,
) -> AppResult<BranchOperationResponse> {
    let root = crate::repository::canonical_repository_path(
        &request.repository_path,
        CREATE_BRANCH_OPERATION,
    )?;
    ensure_committed_head(runner, &root, CREATE_BRANCH_OPERATION)?;

    let name = normalized_input(&request.name, CREATE_BRANCH_OPERATION, &root)?;
    let validation = validate_branch_name(
        runner,
        BranchNameValidationRequest {
            repository_path: crate::repository::display_path(&root),
            name: name.clone(),
        },
    )?;
    if !validation.valid {
        return Err(expected_repo_error(
            validation
                .message
                .unwrap_or_else(|| "不是有效的 Git 分支名称。".to_owned()),
            CREATE_BRANCH_OPERATION,
            &root,
        ));
    }
    if validation.exists {
        return Err(expected_repo_error(
            "同名分支已存在。",
            CREATE_BRANCH_OPERATION,
            &root,
        ));
    }

    let base_branch = normalized_input(&request.base_branch, CREATE_BRANCH_OPERATION, &root)?;
    let base_ref = resolve_start_point(runner, &root, &base_branch, CREATE_BRANCH_OPERATION)?;

    let response = if request.checkout_immediately {
        let checkout_args = vec![
            OsString::from("checkout"),
            OsString::from("-b"),
            OsString::from(&name),
            OsString::from(base_ref),
        ];
        checkout_with_mode(
            runner,
            &root,
            &name,
            checkout_args,
            request.local_changes_mode,
            request
                .operation_id
                .unwrap_or_else(|| generated_operation_id(CREATE_BRANCH_OPERATION)),
            CREATE_BRANCH_OPERATION,
        )
    } else {
        crate::repository::git_stdout(
            runner,
            Some(&root),
            ["branch", name.as_str(), base_ref.as_str()],
            CREATE_BRANCH_OPERATION,
        )?;
        Ok(completed_response(&root, name.clone()))
    }?;

    if request.create_remote && matches!(response, BranchOperationResponse::Completed { .. }) {
        ensure_origin(runner, &root, CREATE_BRANCH_OPERATION)?;
        crate::repository::git_stdout(
            runner,
            Some(&root),
            ["push", "-u", "origin", name.as_str()],
            CREATE_BRANCH_OPERATION,
        )?;
    }

    Ok(response)
}

pub fn checkout_branch(
    runner: &GitRunner,
    request: CheckoutBranchRequest,
) -> AppResult<BranchOperationResponse> {
    let root = crate::repository::canonical_repository_path(
        &request.repository_path,
        CHECKOUT_BRANCH_OPERATION,
    )?;
    ensure_committed_head(runner, &root, CHECKOUT_BRANCH_OPERATION)?;

    let branch_name = normalized_input(&request.branch_name, CHECKOUT_BRANCH_OPERATION, &root)?;
    let target = branch_target(runner, &root, &branch_name, CHECKOUT_BRANCH_OPERATION)?;
    let checkout_args = match target {
        BranchTarget::Local | BranchTarget::LocalAndRemote => {
            vec![OsString::from("checkout"), OsString::from(&branch_name)]
        }
        BranchTarget::RemoteOnly => vec![
            OsString::from("checkout"),
            OsString::from("-b"),
            OsString::from(&branch_name),
            OsString::from(format!("origin/{branch_name}")),
        ],
        BranchTarget::Missing => {
            return Err(expected_repo_error(
                "分支不存在。",
                CHECKOUT_BRANCH_OPERATION,
                &root,
            ));
        }
    };

    checkout_with_mode(
        runner,
        &root,
        &branch_name,
        checkout_args,
        request.local_changes_mode,
        request
            .operation_id
            .unwrap_or_else(|| generated_operation_id(CHECKOUT_BRANCH_OPERATION)),
        CHECKOUT_BRANCH_OPERATION,
    )
}

pub fn delete_branch(
    runner: &GitRunner,
    request: DeleteBranchRequest,
) -> AppResult<BranchOperationResponse> {
    let root = crate::repository::canonical_repository_path(
        &request.repository_path,
        DELETE_BRANCH_OPERATION,
    )?;
    ensure_committed_head(runner, &root, DELETE_BRANCH_OPERATION)?;

    let branch_name = normalized_input(&request.branch_name, DELETE_BRANCH_OPERATION, &root)?;
    if crate::repository::current_branch_name(runner, &root, DELETE_BRANCH_OPERATION).ok()
        == Some(branch_name.clone())
    {
        return Err(expected_repo_error(
            "不能删除当前分支。",
            DELETE_BRANCH_OPERATION,
            &root,
        ));
    }

    let target = branch_target(runner, &root, &branch_name, DELETE_BRANCH_OPERATION)?;
    match target {
        BranchTarget::Local | BranchTarget::LocalAndRemote => {
            ensure_branch_merged(runner, &root, &branch_name)?;
            crate::repository::git_stdout(
                runner,
                Some(&root),
                ["branch", "-d", branch_name.as_str()],
                DELETE_BRANCH_OPERATION,
            )?;
        }
        BranchTarget::RemoteOnly => {
            if !request.force_remote_only {
                return Err(expected_repo_error(
                    "删除仅远程分支需要确认。",
                    DELETE_BRANCH_OPERATION,
                    &root,
                ));
            }
        }
        BranchTarget::Missing => {
            return Err(expected_repo_error(
                "分支不存在。",
                DELETE_BRANCH_OPERATION,
                &root,
            ));
        }
    }

    if request.delete_remote || matches!(target, BranchTarget::RemoteOnly) {
        ensure_origin(runner, &root, DELETE_BRANCH_OPERATION)?;
        crate::repository::git_stdout(
            runner,
            Some(&root),
            ["push", "origin", "--delete", branch_name.as_str()],
            DELETE_BRANCH_OPERATION,
        )?;
    }

    if matches!(target, BranchTarget::RemoteOnly) || request.delete_remote {
        let remote_ref = format!("refs/remotes/origin/{branch_name}");
        let _ = crate::repository::git_stdout(
            runner,
            Some(&root),
            ["update-ref", "-d", remote_ref.as_str()],
            DELETE_BRANCH_OPERATION,
        );
    }

    Ok(completed_response(&root, branch_name))
}

pub fn list_safety_backups(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<SafetyBackupListResponse> {
    let root = crate::repository::canonical_repository_path(
        &request.repository_path,
        LIST_SAFETY_BACKUPS_OPERATION,
    )?;
    let output = crate::repository::git_stdout(
        runner,
        Some(&root),
        [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
            "refs/heads/backup",
        ],
        LIST_SAFETY_BACKUPS_OPERATION,
    )?;

    let mut backups = output
        .lines()
        .filter_map(parse_safety_backup_ref_line)
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| {
        right
            .created_at_unix_millis
            .cmp(&left.created_at_unix_millis)
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(SafetyBackupListResponse { backups })
}

pub fn delete_safety_backup(
    runner: &GitRunner,
    request: DeleteSafetyBackupRequest,
) -> AppResult<DeleteSafetyBackupResponse> {
    let root = crate::repository::canonical_repository_path(
        &request.repository_path,
        DELETE_SAFETY_BACKUP_OPERATION,
    )?;
    let backup_branch = validate_safety_backup_branch(runner, &root, &request.backup_branch)?;
    if crate::repository::current_branch_name(runner, &root, DELETE_SAFETY_BACKUP_OPERATION).ok()
        == Some(backup_branch.clone())
    {
        return Err(expected_repo_error(
            "不能删除当前分支。",
            DELETE_SAFETY_BACKUP_OPERATION,
            &root,
        ));
    }

    crate::repository::git_stdout(
        runner,
        Some(&root),
        ["branch", "-D", backup_branch.as_str()],
        DELETE_SAFETY_BACKUP_OPERATION,
    )?;

    Ok(DeleteSafetyBackupResponse {
        repository_path: crate::repository::display_path(&root),
        backup_branch,
    })
}

pub(crate) fn create_safety_backup_branch(
    runner: &GitRunner,
    root: &Path,
    original_branch: &str,
    start_point: &str,
    operation_name: &str,
) -> AppResult<SafetyBackupSummary> {
    for offset in 0..20 {
        let timestamp = unix_now_millis().saturating_add(offset);
        let backup_branch = format!("backup/{original_branch}-{timestamp}");
        let backup_ref = format!("refs/heads/{backup_branch}");
        if exact_ref_exists(runner, root, &backup_ref, operation_name)? {
            continue;
        }

        crate::repository::git_stdout(
            runner,
            Some(root),
            ["branch", backup_branch.as_str(), start_point],
            operation_name,
        )?;

        return Ok(safety_backup_summary(
            backup_branch,
            Some(start_point.to_owned()),
        ));
    }

    Err(expected_repo_error(
        "无法创建安全备份分支，请稍后重试。",
        operation_name,
        root,
    ))
}

pub(crate) fn reset_local_branch_to_ref(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    target_ref: &str,
    operation_name: &str,
) -> AppResult<()> {
    let force_arg = ["-", "f"].concat();
    crate::repository::git_stdout(
        runner,
        Some(root),
        [
            OsString::from("branch"),
            OsString::from(force_arg),
            OsString::from(branch_name),
            OsString::from(target_ref),
        ],
        operation_name,
    )?;
    crate::repository::git_stdout(
        runner,
        Some(root),
        [
            OsString::from("branch"),
            OsString::from("--set-upstream-to"),
            OsString::from(target_ref),
            OsString::from(branch_name),
        ],
        operation_name,
    )?;
    Ok(())
}

fn checkout_with_mode(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    checkout_args: Vec<OsString>,
    mode: CheckoutLocalChangesMode,
    operation_id: OperationId,
    operation_name: &str,
) -> AppResult<BranchOperationResponse> {
    if !has_local_changes(runner, root, operation_name)? {
        crate::repository::git_stdout(runner, Some(root), checkout_args, operation_name)?;
        return Ok(completed_response(root, branch_name.to_owned()));
    }

    match mode {
        CheckoutLocalChangesMode::RequireClean => Err(expected_repo_error(
            "存在本地更改，需要先确认处理方式。",
            operation_name,
            root,
        )),
        CheckoutLocalChangesMode::Discard => {
            backup_and_discard_local_changes(runner, root, operation_name)?;
            crate::repository::git_stdout(runner, Some(root), checkout_args, operation_name)?;
            Ok(completed_response(root, branch_name.to_owned()))
        }
        CheckoutLocalChangesMode::AutoStash => checkout_with_auto_stash(
            runner,
            root,
            branch_name,
            checkout_args,
            operation_id,
            operation_name,
        ),
    }
}

fn checkout_with_auto_stash(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    checkout_args: Vec<OsString>,
    operation_id: OperationId,
    operation_name: &str,
) -> AppResult<BranchOperationResponse> {
    let pre_operation_branch = current_branch_optional(runner, root, operation_name)?;
    let pre_operation_head_oid = head_oid_optional(runner, root, operation_name)?;
    let stash = crate::stash_impl::create_auto_stash(
        runner,
        CreateAutoStashRequest {
            repository_path: crate::repository::display_path(root),
            reason: format!("before switching to {branch_name}"),
            include_untracked: true,
            paths: Vec::new(),
            operation_id: Some(operation_id.clone()),
        },
    )?
    .stash;

    if let Err(error) =
        crate::repository::git_stdout(runner, Some(root), checkout_args, operation_name)
    {
        if let Some(stash) = stash.as_ref() {
            crate::git_ops::without_cancel_token(|| {
                let _ = crate::stash_impl::restore_stash_for_root(
                    runner,
                    root,
                    &stash.selector,
                    true,
                    operation_name,
                    Some(&operation_id),
                );
            });
        }
        return Err(error);
    }

    if let Some(stash) = stash {
        let response = crate::stash_impl::restore_stash_for_root(
            runner,
            root,
            &stash.selector,
            true,
            operation_name,
            Some(&operation_id),
        )?;
        match response.outcome {
            StashRestoreOutcome::Applied { .. } => {}
            StashRestoreOutcome::Conflicts { conflict } => {
                let mut recovery = response.recovery;
                recovery.pre_operation_branch = pre_operation_branch;
                recovery.pre_operation_head_oid = pre_operation_head_oid;
                recovery.pre_operation_stash_oid = Some(stash.oid);
                return Ok(BranchOperationResponse::Conflicts {
                    repository_path: crate::repository::display_path(root),
                    branch_name: branch_name.to_owned(),
                    conflict,
                    stash_recovery: Some(Box::new(recovery)),
                });
            }
        }
    }

    Ok(completed_response(root, branch_name.to_owned()))
}

fn current_branch_optional(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Option<String>> {
    let (plan, output) = crate::git_ops::run_git_raw(
        runner,
        Some(root),
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        operation_name,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(crate::git_ops::command_failure(
            &plan,
            output,
            operation_name,
        ))
    }
}

fn head_oid_optional(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Option<String>> {
    let (plan, output) = crate::git_ops::run_git_raw(
        runner,
        Some(root),
        ["rev-parse", "--verify", "HEAD"],
        operation_name,
    )?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(crate::git_ops::command_failure(
            &plan,
            output,
            operation_name,
        ))
    }
}

fn backup_and_discard_local_changes(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<()> {
    let changes = crate::repository::list_local_changes(
        runner,
        RepositoryPathRequest {
            repository_path: crate::repository::display_path(root),
        },
    )?;

    if !changes.changes.is_empty() {
        let backup_root = trash_backup_root(root);
        fs::create_dir_all(&backup_root).map_err(|source| {
            unexpected_repo_error(
                format!("failed to create local changes backup: {source}"),
                operation_name,
                root,
            )
        })?;

        let mut manifest = String::new();
        for change in &changes.changes {
            manifest.push_str(&change.path);
            manifest.push('\n');
            backup_change_path(root, &backup_root, &change.path)?;
            if let Some(old_path) = &change.old_path {
                backup_change_path(root, &backup_root, old_path)?;
            }
        }
        fs::write(backup_root.join("manifest.txt"), manifest).map_err(|source| {
            unexpected_repo_error(
                format!("failed to write local changes backup manifest: {source}"),
                operation_name,
                root,
            )
        })?;
    }

    crate::repository::git_stdout(runner, Some(root), ["reset", "--hard"], operation_name)?;
    crate::repository::git_stdout(runner, Some(root), ["clean", "-fd"], operation_name)?;
    Ok(())
}

fn backup_change_path(root: &Path, backup_root: &Path, relative: &str) -> AppResult<()> {
    let Some(source) = safe_join(root, relative) else {
        return Ok(());
    };
    if !source.is_file() {
        return Ok(());
    }
    let Some(destination) = safe_join(backup_root, relative) else {
        return Ok(());
    };
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|source| {
            unexpected_error(
                format!("failed to create backup parent: {source}"),
                "backupChanges",
            )
        })?;
    }
    fs::copy(source, destination).map_err(|source| {
        unexpected_error(
            format!("failed to back up changed file: {source}"),
            "backupChanges",
        )
    })?;
    Ok(())
}

fn trash_backup_root(root: &Path) -> PathBuf {
    let repo_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("repository");

    trash_base_dir().join(format!(
        "Artistic Git Discarded Changes {repo_name}-{}-{}",
        crate::repository::unix_now_seconds(),
        std::process::id()
    ))
}

fn trash_base_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("ARTISTIC_GIT_TRASH_DIR") {
        return PathBuf::from(path);
    }

    if let Some(home) = std::env::var_os("HOME") {
        let candidate = PathBuf::from(home).join(".Trash");
        if fs::create_dir_all(&candidate).is_ok() {
            return candidate;
        }
    }

    std::env::temp_dir()
}

fn has_local_changes(runner: &GitRunner, root: &Path, operation_name: &str) -> AppResult<bool> {
    let output = crate::repository::git_stdout(
        runner,
        Some(root),
        ["status", "--porcelain=v1", "-z"],
        operation_name,
    )?;
    Ok(!output.is_empty())
}

fn resolve_start_point(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    operation_name: &str,
) -> AppResult<String> {
    match branch_target(runner, root, branch_name, operation_name)? {
        BranchTarget::Local | BranchTarget::LocalAndRemote => Ok(branch_name.to_owned()),
        BranchTarget::RemoteOnly => Ok(format!("origin/{branch_name}")),
        BranchTarget::Missing => Err(expected_repo_error(
            "基准分支不存在。",
            operation_name,
            root,
        )),
    }
}

fn branch_target(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    operation_name: &str,
) -> AppResult<BranchTarget> {
    let local = exact_ref_exists(
        runner,
        root,
        &format!("refs/heads/{branch_name}"),
        operation_name,
    )?;
    let remote = exact_ref_exists(
        runner,
        root,
        &format!("refs/remotes/origin/{branch_name}"),
        operation_name,
    )?;

    Ok(match (local, remote) {
        (true, true) => BranchTarget::LocalAndRemote,
        (true, false) => BranchTarget::Local,
        (false, true) => BranchTarget::RemoteOnly,
        (false, false) => BranchTarget::Missing,
    })
}

fn branch_ref_exists(
    runner: &GitRunner,
    root: &Path,
    branch_name: &str,
    operation_name: &str,
) -> AppResult<bool> {
    Ok(exact_ref_exists(
        runner,
        root,
        &format!("refs/heads/{branch_name}"),
        operation_name,
    )? || exact_ref_exists(
        runner,
        root,
        &format!("refs/remotes/origin/{branch_name}"),
        operation_name,
    )?)
}

fn exact_ref_exists(
    runner: &GitRunner,
    root: &Path,
    refname: &str,
    operation_name: &str,
) -> AppResult<bool> {
    let output = crate::repository::git_stdout(
        runner,
        Some(root),
        ["for-each-ref", "--format=%(refname)", refname],
        operation_name,
    )?;
    Ok(output.lines().any(|line| line == refname))
}

fn ensure_branch_merged(runner: &GitRunner, root: &Path, branch_name: &str) -> AppResult<()> {
    let output = git_output_status(
        runner,
        root,
        ["merge-base", "--is-ancestor", branch_name, "HEAD"],
        DELETE_BRANCH_OPERATION,
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(expected_repo_error(
            "未合并分支不能删除。",
            DELETE_BRANCH_OPERATION,
            root,
        ))
    }
}

fn ensure_committed_head(runner: &GitRunner, root: &Path, operation_name: &str) -> AppResult<()> {
    match crate::repository::git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--verify", "HEAD"],
        operation_name,
    ) {
        Ok(_) => Ok(()),
        Err(error) if git_error_indicates_unborn(&error) => Err(expected_repo_error(
            "当前仓库还没有提交，分支操作暂不可用。",
            operation_name,
            root,
        )),
        Err(error) => Err(error),
    }
}

fn ensure_origin(runner: &GitRunner, root: &Path, operation_name: &str) -> AppResult<()> {
    if crate::remote::read_origin_url(runner, root, operation_name)?.is_some() {
        Ok(())
    } else {
        Err(expected_repo_error(
            "未配置远程仓库。",
            operation_name,
            root,
        ))
    }
}

fn git_output_status<I, S>(
    runner: &GitRunner,
    root: &Path,
    args: I,
    operation_name: &str,
) -> AppResult<std::process::Output>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut planned_args = vec![OsString::from("-C"), root.as_os_str().to_owned()];
    planned_args.extend(args.into_iter().map(Into::into));
    let plan = runner
        .git_command_builder()
        .enable_rename_detection()
        .enable_windows_longpaths()
        .args(planned_args)
        .build();

    plan.to_command().output().map_err(|source| {
        crate::logged_app_error(
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
    })
}

fn completed_response(root: &Path, branch_name: String) -> BranchOperationResponse {
    BranchOperationResponse::Completed {
        repository_path: crate::repository::display_path(root),
        branch_name,
    }
}

fn normalized_input(value: &str, operation_name: &str, root: &Path) -> AppResult<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(expected_repo_error(
            "分支名称不能为空。",
            operation_name,
            root,
        ));
    }
    Ok(normalized.to_owned())
}

fn expected_repo_error(
    summary: impl Into<String>,
    operation_name: impl Into<String>,
    root: &Path,
) -> AppError {
    let operation_name = operation_name.into();
    crate::logged_app_error(
        AppError::expected(summary, operation_name.clone()).with_context(
            OperationContext::new(operation_name)
                .with_repository_path(crate::repository::display_path(root)),
        ),
    )
}

fn unexpected_repo_error(
    summary: impl Into<String>,
    operation_name: impl Into<String>,
    root: &Path,
) -> AppError {
    let operation_name = operation_name.into();
    crate::logged_app_error(
        AppError::unexpected(summary, operation_name.clone()).with_context(
            OperationContext::new(operation_name)
                .with_repository_path(crate::repository::display_path(root)),
        ),
    )
}

fn unexpected_error(summary: impl Into<String>, operation_name: impl Into<String>) -> AppError {
    crate::logged_app_error(AppError::unexpected(summary, operation_name))
}

fn git_error_indicates_unborn(error: &AppError) -> bool {
    error
        .git
        .as_ref()
        .map(|git| {
            git.stderr.contains("Needed a single revision")
                || git.stderr.contains("ambiguous argument")
                || git.stderr.contains("unknown revision")
                || git.stderr.contains("does not have any commits")
        })
        .unwrap_or(false)
}

fn first_output_line(output: &[u8]) -> Option<String> {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn generated_operation_id(operation_name: &str) -> OperationId {
    OperationId(format!(
        "{operation_name}-{}-{}",
        crate::repository::unix_now_seconds(),
        std::process::id()
    ))
}

fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(value) => path.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(path)
}

fn parse_safety_backup_ref_line(line: &str) -> Option<SafetyBackupSummary> {
    let parts = line.split('\0').collect::<Vec<_>>();
    if parts.len() < 3 {
        return None;
    }

    let ref_name = parts[0];
    let short_name = ref_name.strip_prefix("refs/heads/")?;
    if !short_name.starts_with("backup/") {
        return None;
    }
    Some(safety_backup_summary(
        short_name.to_owned(),
        empty_to_none(parts[1]).map(str::to_owned),
    ))
}

fn safety_backup_summary(name: String, head_oid: Option<String>) -> SafetyBackupSummary {
    let ref_name = format!("refs/heads/{name}");
    let parsed = parse_safety_backup_name(&name);
    SafetyBackupSummary {
        name,
        ref_name,
        original_branch: parsed.as_ref().map(|(branch, _timestamp)| branch.clone()),
        created_at_unix_millis: parsed.map(|(_branch, timestamp)| timestamp),
        head_oid,
    }
}

fn parse_safety_backup_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("backup/")?;
    let (original_branch, timestamp) = rest.rsplit_once('-')?;
    if original_branch.is_empty()
        || timestamp.is_empty()
        || !timestamp
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    Some((original_branch.to_owned(), timestamp.to_owned()))
}

fn validate_safety_backup_branch(
    runner: &GitRunner,
    root: &Path,
    backup_branch: &str,
) -> AppResult<String> {
    let trimmed = backup_branch.trim();
    let short_name = trimmed.strip_prefix("refs/heads/").unwrap_or(trimmed);
    if !short_name.starts_with("backup/") {
        return Err(expected_repo_error(
            "只能删除安全备份分支。",
            DELETE_SAFETY_BACKUP_OPERATION,
            root,
        ));
    }

    let check = git_output_status(
        runner,
        root,
        ["check-ref-format", "--branch", short_name],
        DELETE_SAFETY_BACKUP_OPERATION,
    )?;
    if !check.status.success() {
        return Err(expected_repo_error(
            "安全备份分支名称无效。",
            DELETE_SAFETY_BACKUP_OPERATION,
            root,
        ));
    }
    let backup_ref = format!("refs/heads/{short_name}");
    if !exact_ref_exists(runner, root, &backup_ref, DELETE_SAFETY_BACKUP_OPERATION)? {
        return Err(expected_repo_error(
            "安全备份分支不存在。",
            DELETE_SAFETY_BACKUP_OPERATION,
            root,
        ));
    }

    Ok(short_name.to_owned())
}

fn empty_to_none(value: &str) -> Option<&str> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn unix_now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BranchTarget {
    Local,
    RemoteOnly,
    LocalAndRemote,
    Missing,
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
    use std::{ffi::OsString, io::Write};

    #[test]
    fn validates_git_branch_name_and_rejects_duplicates() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["branch", "feature/existing"]);

        let invalid = validate_branch_name(
            &runner,
            BranchNameValidationRequest {
                repository_path: display_path(&repo.path),
                name: "bad name.lock".to_owned(),
            },
        )
        .expect("validate invalid name");
        let duplicate = validate_branch_name(
            &runner,
            BranchNameValidationRequest {
                repository_path: display_path(&repo.path),
                name: "feature/existing".to_owned(),
            },
        )
        .expect("validate duplicate name");

        assert!(!invalid.valid);
        assert!(duplicate.valid);
        assert!(duplicate.exists);
    }

    #[test]
    fn checkout_remote_only_branch_creates_local_branch() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = RemoteFixture::new(&runner);
        fixture.local.git(["checkout", "main"]);

        checkout_branch(
            &runner,
            CheckoutBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/remote".to_owned(),
                local_changes_mode: CheckoutLocalChangesMode::RequireClean,
                operation_id: None,
            },
        )
        .expect("checkout remote branch");

        assert_eq!(
            fixture
                .local
                .git_output(["branch", "--show-current"])
                .trim(),
            "feature/remote"
        );
        assert!(fixture
            .local
            .git_output(["branch", "--list", "feature/remote"])
            .contains("feature/remote"));
    }

    #[test]
    fn checkout_with_auto_stash_restores_local_changes() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["branch", "feature/work"]);
        repo.write("tracked.txt", "local change\n");

        checkout_branch(
            &runner,
            CheckoutBranchRequest {
                repository_path: display_path(&repo.path),
                branch_name: "feature/work".to_owned(),
                local_changes_mode: CheckoutLocalChangesMode::AutoStash,
                operation_id: Some(OperationId("op-test".to_owned())),
            },
        )
        .expect("checkout with auto stash");

        assert_eq!(
            repo.git_output(["branch", "--show-current"]).trim(),
            "feature/work"
        );
        assert_eq!(
            fs::read_to_string(repo.path.join("tracked.txt")).expect("tracked file"),
            "local change\n"
        );
        assert!(repo.git_output(["stash", "list"]).trim().is_empty());
    }

    #[test]
    fn checkout_with_auto_stash_conflict_enters_resolution_and_keeps_stash() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["checkout", "-b", "feature/conflict"]);
        repo.write("tracked.txt", "feature side\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "feature side"]);
        repo.git(["checkout", "main"]);
        repo.write("tracked.txt", "local side\n");

        let response = checkout_branch(
            &runner,
            CheckoutBranchRequest {
                repository_path: display_path(&repo.path),
                branch_name: "feature/conflict".to_owned(),
                local_changes_mode: CheckoutLocalChangesMode::AutoStash,
                operation_id: Some(OperationId("op-conflict".to_owned())),
            },
        )
        .expect("checkout with auto stash conflict");

        let BranchOperationResponse::Conflicts {
            conflict,
            stash_recovery,
            ..
        } = response
        else {
            panic!("expected checkout conflict");
        };
        assert_eq!(conflict.operation_id.0, "op-conflict");
        assert_eq!(conflict.operation_name, CHECKOUT_BRANCH_OPERATION);
        assert!(conflict.files.iter().any(|file| file.path == "tracked.txt"));
        assert_eq!(
            stash_recovery.expect("stash recovery").id,
            conflict.operation_id.0
        );
        assert!(repo
            .git_output(["stash", "list"])
            .contains("Auto Stash: before switching to feature/conflict"));
    }

    #[test]
    fn checkout_with_discard_backs_up_and_removes_local_changes() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        let trash = TestTempDir::new("ag-branch-trash").expect("trash");
        std::env::set_var("ARTISTIC_GIT_TRASH_DIR", trash.path());
        repo.init_with_commit();
        repo.git(["branch", "feature/clean"]);
        repo.write("tracked.txt", "discard me\n");
        repo.write("untracked.txt", "backup me\n");

        checkout_branch(
            &runner,
            CheckoutBranchRequest {
                repository_path: display_path(&repo.path),
                branch_name: "feature/clean".to_owned(),
                local_changes_mode: CheckoutLocalChangesMode::Discard,
                operation_id: None,
            },
        )
        .expect("checkout with discard");

        assert_eq!(
            fs::read_to_string(repo.path.join("tracked.txt")).expect("tracked"),
            "one\n"
        );
        assert!(!repo.path.join("untracked.txt").exists());
        let backup_roots = fs::read_dir(trash.path())
            .expect("trash entries")
            .collect::<Result<Vec<_>, _>>()
            .expect("read trash entries");
        assert_eq!(backup_roots.len(), 1);
        let backup_root = backup_roots[0].path();
        assert_eq!(
            fs::read_to_string(backup_root.join("tracked.txt")).expect("tracked backup"),
            "discard me\n"
        );
        assert_eq!(
            fs::read_to_string(backup_root.join("untracked.txt")).expect("untracked backup"),
            "backup me\n"
        );

        std::env::remove_var("ARTISTIC_GIT_TRASH_DIR");
    }

    #[test]
    fn delete_branch_protects_current_and_unmerged_branches() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["checkout", "-b", "feature/unmerged"]);
        repo.write("feature.txt", "feature\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "feature"]);
        repo.git(["checkout", "main"]);

        let current = delete_branch(
            &runner,
            DeleteBranchRequest {
                repository_path: display_path(&repo.path),
                branch_name: "main".to_owned(),
                delete_remote: false,
                force_remote_only: false,
                operation_id: None,
            },
        )
        .expect_err("current branch deletion should fail");
        let unmerged = delete_branch(
            &runner,
            DeleteBranchRequest {
                repository_path: display_path(&repo.path),
                branch_name: "feature/unmerged".to_owned(),
                delete_remote: false,
                force_remote_only: false,
                operation_id: None,
            },
        )
        .expect_err("unmerged branch deletion should fail");

        assert_eq!(current.summary, "不能删除当前分支。");
        assert_eq!(unmerged.summary, "未合并分支不能删除。");
    }

    #[test]
    fn delete_remote_only_branch_requires_force_confirmation() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = RemoteFixture::new(&runner);

        let error = delete_branch(
            &runner,
            DeleteBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/remote".to_owned(),
                delete_remote: false,
                force_remote_only: false,
                operation_id: None,
            },
        )
        .expect_err("remote-only deletion should require confirmation");

        assert_eq!(error.summary, "删除仅远程分支需要确认。");

        delete_branch(
            &runner,
            DeleteBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/remote".to_owned(),
                delete_remote: false,
                force_remote_only: true,
                operation_id: None,
            },
        )
        .expect("delete remote tracking ref");

        assert!(fixture
            .local
            .git_output(["branch", "-r"])
            .lines()
            .all(|line| !line.contains("origin/feature/remote")));
    }

    #[test]
    fn safety_backups_list_parse_and_delete_local_backup_branches() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["checkout", "-b", "feature/paint"]);
        repo.write("paint.txt", "paint\n");
        repo.git(["add", "paint.txt"]);
        repo.git(["commit", "-m", "paint"]);
        let feature_head = repo.git_output(["rev-parse", "HEAD"]);

        let created = create_safety_backup_branch(
            &runner,
            &repo.path,
            "feature/paint",
            feature_head.trim(),
            "testSafetyBackup",
        )
        .expect("create safety backup");
        repo.git(["branch", "backup/manual-ref"]);

        let listed = list_safety_backups(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("list safety backups");

        let parsed = listed
            .backups
            .iter()
            .find(|backup| backup.name == created.name)
            .expect("parsed backup");
        assert_eq!(parsed.original_branch.as_deref(), Some("feature/paint"));
        assert_eq!(parsed.head_oid.as_deref(), Some(feature_head.trim()));
        assert!(parsed.created_at_unix_millis.is_some());
        let manual = listed
            .backups
            .iter()
            .find(|backup| backup.name == "backup/manual-ref")
            .expect("manual backup");
        assert_eq!(manual.original_branch, None);
        assert_eq!(manual.created_at_unix_millis, None);
        assert_eq!(manual.ref_name, "refs/heads/backup/manual-ref");

        let normal_delete = delete_safety_backup(
            &runner,
            DeleteSafetyBackupRequest {
                repository_path: display_path(&repo.path),
                backup_branch: "feature/paint".to_owned(),
                operation_id: None,
            },
        )
        .expect_err("normal branch is not a safety backup");
        assert_eq!(normal_delete.summary, "只能删除安全备份分支。");

        let deleted = delete_safety_backup(
            &runner,
            DeleteSafetyBackupRequest {
                repository_path: display_path(&repo.path),
                backup_branch: created.name.clone(),
                operation_id: None,
            },
        )
        .expect("delete safety backup");
        assert_eq!(deleted.backup_branch, created.name);
        assert!(repo
            .git_output(["branch", "--list", deleted.backup_branch.as_str()])
            .trim()
            .is_empty());
        assert_eq!(repo.git_output(["rev-parse", "HEAD"]), feature_head);
    }

    #[test]
    fn create_branch_can_publish_remote_branch() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = RemoteFixture::new(&runner);

        create_branch(
            &runner,
            CreateBranchRequest {
                repository_path: display_path(&fixture.local.path),
                name: "feature/published".to_owned(),
                base_branch: "main".to_owned(),
                checkout_immediately: false,
                create_remote: true,
                local_changes_mode: CheckoutLocalChangesMode::RequireClean,
                operation_id: None,
            },
        )
        .expect("create and publish branch");

        assert!(fixture
            .remote
            .git_output([
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/feature/published",
            ])
            .contains("refs/heads/feature/published"));
        assert_eq!(
            fixture
                .local
                .git_output(["config", "--get", "branch.feature/published.remote",])
                .trim(),
            "origin"
        );
    }

    #[test]
    fn delete_branch_can_delete_remote_branch() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let fixture = RemoteFixture::new(&runner);
        fixture.local.git(["branch", "feature/delete-me"]);
        fixture
            .local
            .git(["push", "-u", "origin", "feature/delete-me"]);

        delete_branch(
            &runner,
            DeleteBranchRequest {
                repository_path: display_path(&fixture.local.path),
                branch_name: "feature/delete-me".to_owned(),
                delete_remote: true,
                force_remote_only: false,
                operation_id: None,
            },
        )
        .expect("delete local and remote branch");

        assert!(!fixture
            .remote
            .git_output([
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/feature/delete-me",
            ])
            .contains("refs/heads/feature/delete-me"));
    }

    #[test]
    fn branch_write_operations_reject_unborn_head() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);

        let create = create_branch(
            &runner,
            CreateBranchRequest {
                repository_path: display_path(&repo.path),
                name: "feature/new".to_owned(),
                base_branch: "main".to_owned(),
                checkout_immediately: true,
                create_remote: false,
                local_changes_mode: CheckoutLocalChangesMode::RequireClean,
                operation_id: None,
            },
        )
        .expect_err("create branch should reject unborn head");
        let checkout = checkout_branch(
            &runner,
            CheckoutBranchRequest {
                repository_path: display_path(&repo.path),
                branch_name: "main".to_owned(),
                local_changes_mode: CheckoutLocalChangesMode::RequireClean,
                operation_id: None,
            },
        )
        .expect_err("checkout branch should reject unborn head");
        let delete = delete_branch(
            &runner,
            DeleteBranchRequest {
                repository_path: display_path(&repo.path),
                branch_name: "main".to_owned(),
                delete_remote: false,
                force_remote_only: false,
                operation_id: None,
            },
        )
        .expect_err("delete branch should reject unborn head");

        assert_eq!(create.summary, "当前仓库还没有提交，分支操作暂不可用。");
        assert_eq!(checkout.summary, "当前仓库还没有提交，分支操作暂不可用。");
        assert_eq!(delete.summary, "当前仓库还没有提交，分支操作暂不可用。");
    }

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => return None,
            Err(error) => panic!("invalid embedded git distribution: {error}"),
        };
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-branch-runner-home").expect("temp home");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        Some((runner, temp))
    }

    struct RemoteFixture {
        local: TestRepo,
        remote: TestRepo,
    }

    impl RemoteFixture {
        fn new(runner: &GitRunner) -> Self {
            let remote = TestRepo::new(runner);
            remote.git(["init", "--bare", "-b", "main"]);

            let seed = TestRepo::new(runner);
            seed.init_with_commit();
            seed.git(["checkout", "-b", "feature/remote"]);
            seed.write("remote.txt", "remote\n");
            seed.git(["add", "."]);
            seed.git(["commit", "-m", "remote branch"]);
            seed.git([
                "remote",
                "add",
                "origin",
                display_path(&remote.path).as_str(),
            ]);
            seed.git(["push", "--all", "origin"]);

            let local = TestRepo::new(runner);
            fs::remove_dir_all(&local.path).expect("remove clone target");
            git_stdout(
                runner,
                None,
                [
                    "clone",
                    display_path(&remote.path).as_str(),
                    display_path(&local.path).as_str(),
                ],
                "test",
            )
            .expect("clone");

            Self { local, remote }
        }
    }

    struct TestRepo {
        path: PathBuf,
        _temp: TestTempDir,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-branch-repo").expect("temp repo");
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

    fn display_path(path: &Path) -> String {
        path.to_string_lossy().into_owned()
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
        crate::repository::git_stdout(runner, root, args, operation_name)
    }
}
