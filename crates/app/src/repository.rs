use artistic_git_contracts::{
    AppError, AppErrorCategory, AppResult, BranchExistence, BranchListResponse, BranchSummary,
    CommitSummary, DiffChangeKind, GitCommandError, IndexLockInfo, LocalChange,
    LocalChangesResponse, LogPageRequest, LogPageResponse, LogSearchRequest, OpenRepositoryRequest,
    OpenRepositoryResponse, RepositoryHeadState, RepositoryHealth, RepositoryMiddleState,
    RepositoryMiddleStateKind, RepositoryOpenWarning, RepositoryOpenWarningKind,
    RepositoryPathRequest, RepositoryRemote, RepositoryRemoteMode, RepositorySummary, StashEntry,
    StashListResponse,
};
use artistic_git_core::config::ConfigActor;
use artistic_git_git_runner::{CancelToken, GitCommandPlan, GitRunner};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_LOG_LIMIT: usize = 200;
const MAX_LOG_LIMIT: usize = 200;
const TOOL_WORKTREE_PREFIX: &str = "artistic-git-";

#[derive(Clone)]
pub struct RepositoryBackend {
    runner: GitRunner,
    config: Option<ConfigActor>,
}

impl RepositoryBackend {
    pub fn new(runner: GitRunner, config: Option<ConfigActor>) -> Self {
        Self { runner, config }
    }

    pub fn runner(&self) -> &GitRunner {
        &self.runner
    }

    pub fn open_repository(
        &self,
        request: OpenRepositoryRequest,
    ) -> AppResult<OpenRepositoryResponse> {
        open_repository(&self.runner, self.config.as_ref(), request)
    }

    pub fn repository_summary(
        &self,
        request: RepositoryPathRequest,
    ) -> AppResult<RepositorySummary> {
        repository_summary(&self.runner, request)
    }

    pub fn list_branches(&self, request: RepositoryPathRequest) -> AppResult<BranchListResponse> {
        list_branches(&self.runner, request)
    }

    pub fn list_local_changes(
        &self,
        request: RepositoryPathRequest,
    ) -> AppResult<LocalChangesResponse> {
        list_local_changes(&self.runner, request)
    }

    pub fn list_stashes(&self, request: RepositoryPathRequest) -> AppResult<StashListResponse> {
        list_stashes(&self.runner, request)
    }

    pub fn log_page(&self, request: LogPageRequest) -> AppResult<LogPageResponse> {
        log_page_with_cancel(&self.runner, request, &CancelToken::new())
    }

    pub fn search_log(&self, request: LogSearchRequest) -> AppResult<LogPageResponse> {
        search_log_with_cancel(&self.runner, request, &CancelToken::new())
    }
}

pub fn open_repository(
    runner: &GitRunner,
    config: Option<&ConfigActor>,
    request: OpenRepositoryRequest,
) -> AppResult<OpenRepositoryResponse> {
    let input_path = PathBuf::from(request.path.trim());
    if input_path.as_os_str().is_empty() {
        return Err(logged(AppError::expected(
            "不是有效的 Git 项目",
            "openRepository",
        )));
    }

    let root = resolve_repository_root(runner, &input_path)?;
    let git_dir = git_path(runner, &root, ["rev-parse", "--git-dir"], "openRepository")?;
    let git_common_dir = git_path(
        runner,
        &root,
        ["rev-parse", "--git-common-dir"],
        "openRepository",
    )?;
    reject_unsupported_repository_type(runner, &root, &git_dir, &git_common_dir)?;

    clean_tool_worktree_residue(&git_common_dir);
    apply_tool_identity(runner, &root, request.tool_identity.as_ref())?;
    install_lfs_if_needed(runner, &root)?;

    let remotes = list_remotes(runner, &root)?;
    let remote_mode = remote_mode(&remotes);
    let health = inspect_health(runner, &root, &git_common_dir)?;
    let summary = build_summary(
        &root,
        remote_mode,
        remotes.iter().any(|remote| remote.is_origin),
        &health,
    );
    let warnings = open_warnings(&remotes, remote_mode, &health);

    if let Some(config) = config {
        let path = display_path(&root);
        let timestamp = unix_now_seconds().to_string();
        config
            .update_project(path.clone(), |project| {
                project.path = path.clone();
                project.last_opened_at = Some(timestamp);
            })
            .map_err(|source| {
                logged(AppError::unexpected(
                    format!("failed to record recently opened repository: {source}"),
                    "openRepository",
                ))
            })?;
    }

    Ok(OpenRepositoryResponse {
        repository_path: display_path(&root),
        git_dir: display_path(&git_dir),
        remote_mode,
        remotes,
        warnings,
        health,
        summary,
    })
}

pub fn repository_summary(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<RepositorySummary> {
    let root = canonical_repository_path(&request.repository_path, "repositorySummary")?;
    let git_common_dir = git_path(
        runner,
        &root,
        ["rev-parse", "--git-common-dir"],
        "repositorySummary",
    )?;
    let remotes = list_remotes(runner, &root)?;
    let health = inspect_health(runner, &root, &git_common_dir)?;
    Ok(build_summary(
        &root,
        remote_mode(&remotes),
        remotes.iter().any(|remote| remote.is_origin),
        &health,
    ))
}

pub fn list_branches(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<BranchListResponse> {
    let root = canonical_repository_path(&request.repository_path, "listBranches")?;
    let current_branch = current_branch_name(runner, &root, "listBranches").ok();
    let output = git_stdout(
        runner,
        Some(&root),
        [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)",
            "refs/heads",
            "refs/remotes",
        ],
        "listBranches",
    )?;

    let mut merged = BTreeMap::<String, BranchAccumulator>::new();
    for line in output.lines() {
        let parts = line.split('\0').collect::<Vec<_>>();
        if parts.len() < 4 {
            continue;
        }

        let refname = parts[0];
        let oid = empty_to_none(parts[1]).map(str::to_owned);
        let commit_time = empty_to_none(parts[2]).map(str::to_owned);
        let upstream = empty_to_none(parts[3]).map(str::to_owned);

        if let Some(local) = refname.strip_prefix("refs/heads/") {
            if local.starts_with("backup/") {
                continue;
            }
            let entry = merged.entry(local.to_owned()).or_default();
            entry.local_oid = oid;
            entry.local_time = commit_time;
            entry.upstream = upstream;
        } else if let Some(remote) = refname.strip_prefix("refs/remotes/origin/") {
            if remote == "HEAD" || remote.starts_with("backup/") {
                continue;
            }
            let entry = merged.entry(remote.to_owned()).or_default();
            entry.remote_oid = oid;
            entry.remote_time = commit_time;
        }
    }

    let mut branches = merged
        .into_iter()
        .map(|(short_name, entry)| {
            branch_summary(runner, &root, current_branch.as_deref(), short_name, entry)
        })
        .collect::<AppResult<Vec<_>>>()?;

    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| {
                right
                    .latest_commit_unix_seconds
                    .cmp(&left.latest_commit_unix_seconds)
            })
            .then_with(|| left.short_name.cmp(&right.short_name))
    });

    Ok(BranchListResponse { branches })
}

pub fn list_local_changes(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<LocalChangesResponse> {
    let root = canonical_repository_path(&request.repository_path, "listLocalChanges")?;
    let output = git_output_bytes(
        runner,
        Some(&root),
        ["status", "--porcelain=v1", "-z", "--find-renames"],
        "listLocalChanges",
    )?;
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect::<Vec<_>>();

    let mut changes = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let entry = &fields[index];
        if entry.len() < 3 {
            index += 1;
            continue;
        }

        let index_status = entry[0..1].to_owned();
        let worktree_status = entry[1..2].to_owned();
        let path = entry[3..].to_owned();
        let mut old_path = None;
        if index_status == "R" || worktree_status == "R" {
            index += 1;
            old_path = fields.get(index).cloned();
        }

        changes.push(LocalChange {
            change_kind: local_change_kind(&index_status, &worktree_status),
            path,
            old_path,
            index_status,
            worktree_status,
        });
        index += 1;
    }

    Ok(LocalChangesResponse { changes })
}

pub fn list_stashes(
    runner: &GitRunner,
    request: RepositoryPathRequest,
) -> AppResult<StashListResponse> {
    let root = canonical_repository_path(&request.repository_path, "listStashes")?;
    let output = match git_stdout(
        runner,
        Some(&root),
        ["stash", "list", "--format=%gd%x00%H%x00%ct%x00%gs%x1e"],
        "listStashes",
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

pub fn log_page_with_cancel(
    runner: &GitRunner,
    request: LogPageRequest,
    cancel_token: &CancelToken,
) -> AppResult<LogPageResponse> {
    let root = canonical_repository_path(&request.repository_path, "logPage")?;
    let (limit, skip) = log_limit_and_skip(request.limit, request.after.as_deref());
    let mut args = vec![
        OsString::from("log"),
        OsString::from("--topo-order"),
        OsString::from("--parents"),
        OsString::from(format!("--max-count={}", limit + 1)),
        OsString::from(format!("--skip={skip}")),
        OsString::from("--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x1e"),
        OsString::from("--all"),
    ];

    run_log_command(
        runner,
        &root,
        args.drain(..),
        limit,
        skip,
        "logPage",
        cancel_token,
    )
}

pub fn search_log_with_cancel(
    runner: &GitRunner,
    request: LogSearchRequest,
    cancel_token: &CancelToken,
) -> AppResult<LogPageResponse> {
    let root = canonical_repository_path(&request.repository_path, "searchLog")?;
    let (limit, skip) = log_limit_and_skip(request.limit, request.after.as_deref());
    let mut args = vec![
        OsString::from("log"),
        OsString::from("--topo-order"),
        OsString::from("--parents"),
        OsString::from(format!("--max-count={}", limit + 1)),
        OsString::from(format!("--skip={skip}")),
        OsString::from("--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x1e"),
    ];

    if let Some(grep) = request.grep.filter(|value| !value.is_empty()) {
        args.push(OsString::from("--grep"));
        args.push(OsString::from(grep));
    }
    if let Some(author) = request.author.filter(|value| !value.is_empty()) {
        args.push(OsString::from("--author"));
        args.push(OsString::from(author));
    }
    if let Some(pickaxe) = request.pickaxe.filter(|value| !value.is_empty()) {
        args.push(OsString::from(format!("-S{pickaxe}")));
    }
    args.push(OsString::from("--all"));

    run_log_command(
        runner,
        &root,
        args.drain(..),
        limit,
        skip,
        "searchLog",
        cancel_token,
    )
}

fn resolve_repository_root(runner: &GitRunner, path: &Path) -> AppResult<PathBuf> {
    let output = run_git(
        runner,
        Some(path),
        ["rev-parse", "--show-toplevel"],
        "openRepository",
    )
    .map_err(|error| {
        if error.category == AppErrorCategory::Expected {
            logged(AppError::expected("不是有效的 Git 项目", "openRepository"))
        } else {
            error
        }
    })?;
    let root = PathBuf::from(output.stdout.trim());
    canonicalize_path(&root, "openRepository")
}

fn reject_unsupported_repository_type(
    runner: &GitRunner,
    root: &Path,
    git_dir: &Path,
    git_common_dir: &Path,
) -> AppResult<()> {
    let is_bare = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--is-bare-repository"],
        "openRepository",
    )?;
    let inside_work_tree = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--is-inside-work-tree"],
        "openRepository",
    )?;

    if is_bare.trim() == "true" || inside_work_tree.trim() != "true" {
        return Err(logged(AppError::expected(
            "不是受支持的 Git 项目类型",
            "openRepository",
        )));
    }

    if canonical_or_self(git_dir) != canonical_or_self(git_common_dir) {
        return Err(logged(AppError::expected(
            "不是受支持的 Git 项目类型",
            "openRepository",
        )));
    }

    Ok(())
}

fn apply_tool_identity(
    runner: &GitRunner,
    root: &Path,
    identity: Option<&artistic_git_contracts::ToolGitIdentity>,
) -> AppResult<()> {
    let Some(identity) = identity else {
        return Ok(());
    };

    if let Some(name) = identity.name.as_deref().filter(|value| !value.is_empty()) {
        write_local_config_if_changed(runner, root, "user.name", name)?;
    }
    if let Some(email) = identity.email.as_deref().filter(|value| !value.is_empty()) {
        write_local_config_if_changed(runner, root, "user.email", email)?;
    }

    Ok(())
}

fn write_local_config_if_changed(
    runner: &GitRunner,
    root: &Path,
    key: &str,
    value: &str,
) -> AppResult<()> {
    let current = git_stdout(
        runner,
        Some(root),
        ["config", "--local", "--get", key],
        "openRepository",
    )
    .ok()
    .map(|value| value.trim().to_owned());

    if current.as_deref() != Some(value) {
        git_stdout(
            runner,
            Some(root),
            ["config", "--local", key, value],
            "openRepository",
        )?;
    }

    Ok(())
}

fn install_lfs_if_needed(runner: &GitRunner, root: &Path) -> AppResult<()> {
    if !repository_has_lfs_rules(root) {
        return Ok(());
    }

    let plan = runner.git_lfs_command_plan(["install", "--local"]);
    let mut command = plan.to_command();
    command.current_dir(root);
    command_to_output(command, &plan, "openRepository").map(|_| ())
}

fn clean_tool_worktree_residue(git_common_dir: &Path) {
    let worktrees = git_common_dir.join("worktrees");
    let Ok(entries) = fs::read_dir(worktrees) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(OsStr::to_str) else {
            continue;
        };
        if !name.starts_with(TOOL_WORKTREE_PREFIX) {
            continue;
        }

        let gitdir = path.join("gitdir");
        let remove = fs::read_to_string(&gitdir)
            .map(|target| !Path::new(target.trim()).exists())
            .unwrap_or(false);
        if remove {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn list_remotes(runner: &GitRunner, root: &Path) -> AppResult<Vec<RepositoryRemote>> {
    let output = git_stdout(runner, Some(root), ["remote", "-v"], "openRepository")?;
    let mut remotes = BTreeMap::<String, String>::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        let Some(url) = parts.next() else {
            continue;
        };
        let kind = parts.next().unwrap_or_default();
        if kind == "(fetch)" {
            remotes
                .entry(name.to_owned())
                .or_insert_with(|| url.to_owned());
        }
    }

    Ok(remotes
        .into_iter()
        .map(|(name, url)| {
            let is_origin = name == "origin";
            RepositoryRemote {
                name,
                url,
                is_origin,
                managed: is_origin,
            }
        })
        .collect())
}

fn remote_mode(remotes: &[RepositoryRemote]) -> RepositoryRemoteMode {
    if remotes.iter().any(|remote| remote.is_origin) {
        RepositoryRemoteMode::Origin
    } else {
        RepositoryRemoteMode::NoRemote
    }
}

fn open_warnings(
    remotes: &[RepositoryRemote],
    remote_mode: RepositoryRemoteMode,
    health: &RepositoryHealth,
) -> Vec<RepositoryOpenWarning> {
    let mut warnings = Vec::new();
    if remotes.len() > 1 && remote_mode == RepositoryRemoteMode::Origin {
        warnings.push(warning(
            RepositoryOpenWarningKind::MultipleRemotesOriginManaged,
            "检测到多个远程仓库；Artistic Git 仅管理 origin，其他远程保持只读展示。",
        ));
    } else if remotes.len() > 1 {
        warnings.push(warning(
            RepositoryOpenWarningKind::MultipleRemotesNoOrigin,
            "检测到多个远程仓库但没有 origin；已进入无远程模式。",
        ));
    } else if remotes.is_empty() {
        warnings.push(warning(
            RepositoryOpenWarningKind::NoRemote,
            "未配置远程仓库；已进入无远程模式。",
        ));
    }

    match health.head {
        RepositoryHeadState::Detached { .. } => warnings.push(warning(
            RepositoryOpenWarningKind::DetachedHead,
            "当前处于游离 HEAD 状态，可新建分支或切换到已有分支。",
        )),
        RepositoryHeadState::Unborn { .. } => warnings.push(warning(
            RepositoryOpenWarningKind::UnbornHead,
            "当前仓库还没有提交，历史为空，分支切换/删除暂不可用。",
        )),
        RepositoryHeadState::Branch { .. } => {}
    }

    if !health.middle_states.is_empty() {
        warnings.push(warning(
            RepositoryOpenWarningKind::OperationInProgress,
            "检测到外部 Git 操作中间态，请完成或放弃恢复后继续。",
        ));
    }
    if health.index_lock.is_some() {
        warnings.push(warning(
            RepositoryOpenWarningKind::IndexLockPresent,
            "检测到 .git/index.lock 残留；不会自动删除，需确认没有 Git 进程运行后手动处理。",
        ));
    }

    warnings
}

fn inspect_health(
    runner: &GitRunner,
    root: &Path,
    git_common_dir: &Path,
) -> AppResult<RepositoryHealth> {
    let head = inspect_head(runner, root)?;
    let middle_states = inspect_middle_states(git_common_dir);
    let index_lock = inspect_index_lock(git_common_dir);
    Ok(RepositoryHealth {
        head,
        middle_states,
        index_lock,
    })
}

fn inspect_head(runner: &GitRunner, root: &Path) -> AppResult<RepositoryHeadState> {
    if let Ok(branch) = current_branch_name(runner, root, "repositoryHealth") {
        let oid = git_stdout(
            runner,
            Some(root),
            ["rev-parse", "--verify", "HEAD"],
            "repositoryHealth",
        )
        .ok()
        .map(|value| value.trim().to_owned());
        return Ok(if let Some(oid) = oid {
            RepositoryHeadState::Branch {
                name: branch,
                oid: Some(oid),
            }
        } else {
            RepositoryHeadState::Unborn { branch }
        });
    }

    let oid = git_stdout(
        runner,
        Some(root),
        ["rev-parse", "--verify", "HEAD"],
        "repositoryHealth",
    )?
    .trim()
    .to_owned();
    Ok(RepositoryHeadState::Detached { oid })
}

fn inspect_middle_states(git_common_dir: &Path) -> Vec<RepositoryMiddleState> {
    let candidates = [
        (
            RepositoryMiddleStateKind::Merge,
            "MERGE_HEAD",
            Some(vec![
                "git".to_owned(),
                "merge".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (
            RepositoryMiddleStateKind::Rebase,
            "rebase-merge",
            Some(vec![
                "git".to_owned(),
                "rebase".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (
            RepositoryMiddleStateKind::Rebase,
            "rebase-apply",
            Some(vec![
                "git".to_owned(),
                "rebase".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (
            RepositoryMiddleStateKind::CherryPick,
            "CHERRY_PICK_HEAD",
            Some(vec![
                "git".to_owned(),
                "cherry-pick".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (
            RepositoryMiddleStateKind::Revert,
            "REVERT_HEAD",
            Some(vec![
                "git".to_owned(),
                "revert".to_owned(),
                "--abort".to_owned(),
            ]),
        ),
        (RepositoryMiddleStateKind::Bisect, "BISECT_LOG", None),
    ];

    candidates
        .into_iter()
        .filter_map(|(kind, relative, abort_command)| {
            let path = git_common_dir.join(relative);
            path.exists().then(|| RepositoryMiddleState {
                kind,
                path: display_path(&path),
                abort_command,
            })
        })
        .collect()
}

fn inspect_index_lock(git_common_dir: &Path) -> Option<IndexLockInfo> {
    let path = git_common_dir.join("index.lock");
    let metadata = fs::metadata(&path).ok()?;
    let modified = metadata.modified().ok()?;
    let age_seconds = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        .as_secs();
    Some(IndexLockInfo {
        path: display_path(&path),
        age_seconds: age_seconds.min(u64::from(u32::MAX)) as u32,
        warning: "index.lock 可能表示仍有 Git 进程在运行；Artistic Git 永不自动清除该文件。"
            .to_owned(),
    })
}

fn build_summary(
    root: &Path,
    remote_mode: RepositoryRemoteMode,
    has_origin: bool,
    health: &RepositoryHealth,
) -> RepositorySummary {
    let (current_branch, head_oid, is_detached, is_unborn) = match &health.head {
        RepositoryHeadState::Branch { name, oid } => {
            (Some(name.clone()), oid.clone(), false, false)
        }
        RepositoryHeadState::Detached { oid } => (None, Some(oid.clone()), true, false),
        RepositoryHeadState::Unborn { branch } => (Some(branch.clone()), None, false, true),
    };

    RepositorySummary {
        repository_path: display_path(root),
        current_branch,
        head_oid,
        remote_mode,
        has_origin,
        is_detached,
        is_unborn,
        in_progress: !health.middle_states.is_empty() || health.index_lock.is_some(),
    }
}

fn branch_summary(
    runner: &GitRunner,
    root: &Path,
    current_branch: Option<&str>,
    short_name: String,
    entry: BranchAccumulator,
) -> AppResult<BranchSummary> {
    let existence = match (&entry.local_oid, &entry.remote_oid) {
        (Some(_), Some(_)) => BranchExistence::LocalAndRemote,
        (Some(_), None) => BranchExistence::LocalOnly,
        (None, Some(_)) => BranchExistence::RemoteOnly,
        (None, None) => BranchExistence::LocalOnly,
    };
    let current = current_branch == Some(short_name.as_str());
    let (ahead, behind) = branch_ahead_behind(runner, root, &short_name, &entry)?;
    let head_oid = entry.local_oid.clone().or(entry.remote_oid.clone());
    let latest_commit_unix_seconds = entry.local_time.or(entry.remote_time);

    Ok(BranchSummary {
        name: short_name.clone(),
        short_name,
        existence,
        current,
        head_oid,
        upstream: entry.upstream,
        ahead,
        behind,
        latest_commit_unix_seconds,
    })
}

fn branch_ahead_behind(
    runner: &GitRunner,
    root: &Path,
    short_name: &str,
    entry: &BranchAccumulator,
) -> AppResult<(u32, u32)> {
    if entry.local_oid.is_none() || entry.remote_oid.is_none() {
        return Ok((0, 0));
    }

    let spec = format!("{short_name}...origin/{short_name}");
    let output = git_stdout(
        runner,
        Some(root),
        ["rev-list", "--left-right", "--count", spec.as_str()],
        "listBranches",
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

fn run_log_command<I>(
    runner: &GitRunner,
    root: &Path,
    args: I,
    limit: usize,
    skip: usize,
    operation_name: &str,
    cancel_token: &CancelToken,
) -> AppResult<LogPageResponse>
where
    I: IntoIterator<Item = OsString>,
{
    let output = match run_git_cancellable(runner, Some(root), args, operation_name, cancel_token) {
        Ok(output) => output,
        Err(error) if is_unborn_log_error(&error) => {
            return Ok(LogPageResponse {
                commits: Vec::new(),
                next_after: None,
            });
        }
        Err(error) => return Err(error),
    };
    let mut commits = parse_log_records(&output.stdout);
    let has_next = commits.len() > limit;
    commits.truncate(limit);
    let next_after = has_next.then(|| (skip + limit).to_string());
    Ok(LogPageResponse {
        commits,
        next_after,
    })
}

fn parse_log_records(output: &str) -> Vec<CommitSummary> {
    output
        .split('\x1e')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let parts = record.trim_matches('\n').split('\0').collect::<Vec<_>>();
            if parts.len() < 7 {
                return None;
            }
            Some(CommitSummary {
                oid: parts[0].to_owned(),
                parents: parts[1]
                    .split_whitespace()
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
                author_name: parts[2].to_owned(),
                author_email: parts[3].to_owned(),
                authored_at_unix_seconds: parts[4].to_owned(),
                subject: parts[5].to_owned(),
                refs: parts[6]
                    .split(", ")
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .collect()
}

fn parse_stash_record(record: &str) -> Option<StashEntry> {
    let parts = record.trim_matches('\n').split('\0').collect::<Vec<_>>();
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
    let branch = message
        .strip_prefix("WIP on ")
        .and_then(|value| value.split_once(':').map(|(branch, _)| branch.to_owned()));
    let is_auto_stash =
        message.contains("Auto Stash:") || message.to_ascii_lowercase().contains("autostash");

    Some(StashEntry {
        index,
        selector,
        oid: parts[1].to_owned(),
        message,
        branch,
        created_at_unix_seconds: empty_to_none(parts[2]).map(str::to_owned),
        is_auto_stash,
        origin: is_auto_stash.then(|| "auto-stash".to_owned()),
    })
}

fn local_change_kind(index_status: &str, worktree_status: &str) -> DiffChangeKind {
    if index_status == "R" || worktree_status == "R" {
        DiffChangeKind::Renamed
    } else if index_status == "D" || worktree_status == "D" {
        DiffChangeKind::Deleted
    } else if index_status == "A" || worktree_status == "A" || index_status == "?" {
        DiffChangeKind::Added
    } else {
        DiffChangeKind::Modified
    }
}

fn log_limit_and_skip(limit: Option<u16>, after: Option<&str>) -> (usize, usize) {
    let limit = limit
        .map(usize::from)
        .unwrap_or(DEFAULT_LOG_LIMIT)
        .clamp(1, MAX_LOG_LIMIT);
    let skip = after.and_then(|value| value.parse().ok()).unwrap_or(0);
    (limit, skip)
}

fn current_branch_name(runner: &GitRunner, root: &Path, operation_name: &str) -> AppResult<String> {
    git_stdout(
        runner,
        Some(root),
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        operation_name,
    )
    .map(|value| value.trim().to_owned())
}

fn git_path<I, S>(
    runner: &GitRunner,
    root: &Path,
    args: I,
    operation_name: &str,
) -> AppResult<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let output = git_stdout(runner, Some(root), args, operation_name)?;
    let path = PathBuf::from(output.trim());
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
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

fn run_git_cancellable<I>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
    cancel_token: &CancelToken,
) -> AppResult<CommandOutput>
where
    I: IntoIterator<Item = OsString>,
{
    if cancel_token.is_cancelled() {
        return Err(cancelled_error(operation_name));
    }

    let plan = plan_git(runner, root, args);
    let mut command = plan.to_command();
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;

    loop {
        if cancel_token.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cancelled_error(operation_name));
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => return Err(spawn_error(&plan, source, operation_name)),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
    if output.status.success() {
        Ok(CommandOutput::from_output(output))
    } else {
        Err(command_failure(&plan, output, operation_name))
    }
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

fn cancelled_error(operation_name: &str) -> AppError {
    logged(AppError::expected("operation cancelled", operation_name))
}

fn canonical_repository_path(path: &str, operation_name: &str) -> AppResult<PathBuf> {
    canonicalize_path(Path::new(path), operation_name)
}

fn canonicalize_path(path: &Path, operation_name: &str) -> AppResult<PathBuf> {
    fs::canonicalize(path).map_err(|source| {
        logged(AppError::expected(
            format!("failed to resolve repository path: {source}"),
            operation_name,
        ))
    })
}

fn repository_has_lfs_rules(root: &Path) -> bool {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
            if file_name == ".git" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if file_name == ".gitattributes"
                && fs::read_to_string(&path)
                    .map(|content| content.contains("filter=lfs"))
                    .unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
}

fn canonical_or_self(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn empty_to_none(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn is_empty_stash_error(error: &AppError) -> bool {
    error
        .git
        .as_ref()
        .map(|git| git.stderr.contains("No stash entries found"))
        .unwrap_or(false)
}

fn is_unborn_log_error(error: &AppError) -> bool {
    error
        .git
        .as_ref()
        .map(|git| {
            git.stderr.contains("does not have any commits")
                || git.stderr.contains("bad default revision")
                || git.stderr.contains("ambiguous argument")
        })
        .unwrap_or(false)
}

fn warning(kind: RepositoryOpenWarningKind, message: impl Into<String>) -> RepositoryOpenWarning {
    RepositoryOpenWarning {
        kind,
        message: message.into(),
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn unix_now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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

#[derive(Debug, Default)]
struct BranchAccumulator {
    local_oid: Option<String>,
    remote_oid: Option<String>,
    local_time: Option<String>,
    remote_time: Option<String>,
    upstream: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_git_runner::GitDistribution;
    use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
    use std::io::Write;

    #[test]
    fn local_change_parser_marks_untracked_as_added() {
        assert_eq!(local_change_kind("?", "?"), DiffChangeKind::Added);
        assert_eq!(local_change_kind("R", " "), DiffChangeKind::Renamed);
        assert_eq!(local_change_kind(" ", "D"), DiffChangeKind::Deleted);
    }

    #[test]
    fn log_pagination_is_capped_at_phase_batch_size() {
        assert_eq!(log_limit_and_skip(None, None), (200, 0));
        assert_eq!(log_limit_and_skip(Some(500), Some("12")), (200, 12));
    }

    #[test]
    fn parses_auto_stash_origin() {
        let entry = parse_stash_record(concat!(
            "stash@{0}",
            "\0",
            "abc",
            "\0",
            "1700000000",
            "\0",
            "Auto Stash: before checkout",
            "\x1e"
        ))
        .expect("stash entry");

        assert!(entry.is_auto_stash);
        assert_eq!(entry.origin.as_deref(), Some("auto-stash"));
    }

    #[test]
    fn missing_embedded_git_distribution_is_explicit() {
        if std::env::var_os("ARTISTIC_GIT_DIST_DIR").is_some() {
            return;
        }

        let error = require_git_dist().expect_err("missing dist should be explicit");

        assert!(matches!(error, GitDistError::MissingEnvironment));
    }

    #[test]
    fn opens_repository_from_subdirectory_and_reports_no_remote() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        repo.write("nested/file.txt", "hello");

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path.join("nested")),
                tool_identity: None,
            },
        )
        .expect("open repo");

        assert_eq!(response.repository_path, display_path(&repo.path));
        assert_eq!(response.remote_mode, RepositoryRemoteMode::NoRemote);
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.kind == RepositoryOpenWarningKind::NoRemote));
    }

    #[test]
    fn rejects_bare_repository() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init", "--bare"]);

        let error = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect_err("bare repo should be rejected");

        assert_eq!(error.summary, "不是受支持的 Git 项目类型");
    }

    #[test]
    fn reports_unborn_and_index_lock_health() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        fs::File::create(repo.path.join(".git/index.lock")).expect("index.lock");

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect("open unborn repo");

        assert!(matches!(
            response.health.head,
            RepositoryHeadState::Unborn { .. }
        ));
        assert!(response.health.index_lock.is_some());
    }

    #[test]
    fn lists_local_changes_and_filters_backup_branches() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);
        repo.git(["config", "user.name", "Tester"]);
        repo.git(["config", "user.email", "tester@example.test"]);
        repo.write("tracked.txt", "one\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "initial"]);
        repo.git(["branch", "backup/hidden"]);
        repo.write("new.txt", "new\n");
        repo.write("tracked.txt", "two\n");

        let changes = list_local_changes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("local changes");
        let branches = list_branches(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("branches");

        assert!(changes
            .changes
            .iter()
            .any(|change| change.path == "new.txt" && change.change_kind == DiffChangeKind::Added));
        assert!(changes
            .changes
            .iter()
            .any(|change| change.path == "tracked.txt"));
        assert!(!branches
            .branches
            .iter()
            .any(|branch| branch.short_name.starts_with("backup/")));
    }

    #[test]
    fn rejects_linked_worktree() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        let linked = TestTempDir::new("ag-linked-worktree").expect("linked worktree path");
        fs::remove_dir_all(linked.path()).expect("git worktree target must not exist");
        let linked_path = display_path(linked.path());
        repo.git(["worktree", "add", linked_path.as_str(), "HEAD"]);

        let error = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(linked.path()),
                tool_identity: None,
            },
        )
        .expect_err("linked worktree should be rejected");

        assert_eq!(error.summary, "不是受支持的 Git 项目类型");
    }

    #[test]
    fn reports_detached_head_warning() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["checkout", "--detach", "HEAD"]);

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect("open detached repo");

        assert!(matches!(
            response.health.head,
            RepositoryHeadState::Detached { .. }
        ));
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.kind == RepositoryOpenWarningKind::DetachedHead));
    }

    #[test]
    fn multiple_remotes_manage_only_origin() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.git(["remote", "add", "origin", "https://example.test/origin.git"]);
        repo.git([
            "remote",
            "add",
            "upstream",
            "https://example.test/upstream.git",
        ]);

        let response = open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: None,
            },
        )
        .expect("open repo with remotes");

        assert_eq!(response.remote_mode, RepositoryRemoteMode::Origin);
        assert!(response
            .remotes
            .iter()
            .any(|remote| remote.name == "origin" && remote.managed));
        assert!(response
            .remotes
            .iter()
            .any(|remote| remote.name == "upstream" && !remote.managed));
        assert!(response.warnings.iter().any(|warning| {
            warning.kind == RepositoryOpenWarningKind::MultipleRemotesOriginManaged
        }));
    }

    #[test]
    fn writes_tool_identity_only_to_local_config() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.git(["init"]);

        open_repository(
            &runner,
            None,
            OpenRepositoryRequest {
                path: display_path(&repo.path),
                tool_identity: Some(artistic_git_contracts::ToolGitIdentity {
                    name: Some("Artistic Git".to_owned()),
                    email: Some("tool@example.test".to_owned()),
                }),
            },
        )
        .expect("open with identity");

        assert_eq!(
            repo.git_output(["config", "--local", "--get", "user.name"])
                .trim(),
            "Artistic Git"
        );
        assert_eq!(
            repo.git_output(["config", "--local", "--get", "user.email"])
                .trim(),
            "tool@example.test"
        );
    }

    #[test]
    fn lists_stashes_and_searches_log() {
        let Some((runner, _dist_temp)) = real_runner_or_skip() else {
            return;
        };
        let repo = TestRepo::new(&runner);
        repo.init_with_commit();
        repo.write("second.txt", "needle\n");
        repo.git(["add", "."]);
        repo.git(["commit", "-m", "second searchable commit"]);
        repo.write("second.txt", "needle changed\n");
        repo.git(["stash", "push", "-m", "Auto Stash: before test"]);

        let stashes = list_stashes(
            &runner,
            RepositoryPathRequest {
                repository_path: display_path(&repo.path),
            },
        )
        .expect("stashes");
        let log = log_page_with_cancel(
            &runner,
            LogPageRequest {
                repository_path: display_path(&repo.path),
                after: None,
                limit: Some(1),
            },
            &CancelToken::new(),
        )
        .expect("log page");
        let search = search_log_with_cancel(
            &runner,
            LogSearchRequest {
                repository_path: display_path(&repo.path),
                grep: Some("searchable".to_owned()),
                author: None,
                pickaxe: None,
                after: None,
                limit: Some(200),
            },
            &CancelToken::new(),
        )
        .expect("search log");

        assert!(stashes.stashes.iter().any(|stash| stash.is_auto_stash));
        assert_eq!(log.commits.len(), 1);
        assert!(log.next_after.is_some());
        assert_eq!(search.commits.len(), 1);
        assert_eq!(search.commits[0].subject, "second searchable commit");
    }

    fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
        let dist = match require_git_dist() {
            Ok(dist) => dist,
            Err(GitDistError::MissingEnvironment) => return None,
            Err(error) => panic!("invalid embedded git distribution: {error}"),
        };
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-app-runner-home").expect("temp home");
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
            let temp = TestTempDir::new("ag-repo").expect("temp repo");
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
