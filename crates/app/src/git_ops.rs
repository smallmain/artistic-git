use artistic_git_contracts::{AppError, AppResult, GitCommandError};
use artistic_git_git_runner::{CancelToken, GitCommandPlan, GitRunner};
use std::{
    cell::RefCell,
    ffi::OsString,
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::Duration,
};

pub(crate) const DEFAULT_LARGE_FILE_THRESHOLD_MB: u32 = 50;

thread_local! {
    static AUTH_CONTEXT: RefCell<Vec<AuthCommandContext>> = const { RefCell::new(Vec::new()) };
    static CANCEL_CONTEXT: RefCell<Vec<CancelCommandContext>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone)]
struct AuthCommandContext {
    runtime: crate::auth_ipc::AuthRuntime,
    operation_id: artistic_git_contracts::OperationId,
}

#[derive(Clone)]
struct CancelCommandContext {
    token: CancelToken,
}

pub(crate) fn with_auth_runtime_for_operation<T>(
    auth_runtime: Option<&crate::auth_ipc::AuthRuntime>,
    interaction_policy: crate::auth_ipc::InteractionPolicy,
    operation_id: Option<artistic_git_contracts::OperationId>,
    repository_path: Option<PathBuf>,
    action: impl FnOnce() -> T,
) -> T {
    let Some(auth_runtime) = auth_runtime else {
        return action();
    };
    let operation = match auth_runtime.start_operation_for_context(
        operation_id,
        interaction_policy,
        repository_path,
    ) {
        Ok(operation) => operation,
        Err(error) => {
            tracing::warn!(error = %error, "failed to start auth operation context");
            return action();
        }
    };

    AUTH_CONTEXT.with(|contexts| {
        contexts.borrow_mut().push(AuthCommandContext {
            runtime: auth_runtime.clone(),
            operation_id: operation.operation_id,
        });
    });
    let _guard = AuthContextGuard;
    action()
}

struct AuthContextGuard;

impl Drop for AuthContextGuard {
    fn drop(&mut self) {
        AUTH_CONTEXT.with(|contexts| {
            contexts.borrow_mut().pop();
        });
    }
}

pub(crate) fn with_cancel_token_for_operation<T>(
    cancel_token: &CancelToken,
    action: impl FnOnce() -> T,
) -> T {
    CANCEL_CONTEXT.with(|contexts| {
        contexts.borrow_mut().push(CancelCommandContext {
            token: cancel_token.clone(),
        });
    });
    let _guard = CancelContextGuard;
    action()
}

pub(crate) fn without_cancel_token<T>(action: impl FnOnce() -> T) -> T {
    let saved = CANCEL_CONTEXT.with(|contexts| std::mem::take(&mut *contexts.borrow_mut()));
    let _guard = CancelContextSuspendGuard { saved: Some(saved) };
    action()
}

struct CancelContextGuard;

impl Drop for CancelContextGuard {
    fn drop(&mut self) {
        CANCEL_CONTEXT.with(|contexts| {
            contexts.borrow_mut().pop();
        });
    }
}

struct CancelContextSuspendGuard {
    saved: Option<Vec<CancelCommandContext>>,
}

impl Drop for CancelContextSuspendGuard {
    fn drop(&mut self) {
        if let Some(saved) = self.saved.take() {
            CANCEL_CONTEXT.with(|contexts| {
                *contexts.borrow_mut() = saved;
            });
        }
    }
}

pub(crate) fn canonical_repository_path(path: &str, operation_name: &str) -> AppResult<PathBuf> {
    fs::canonicalize(Path::new(path)).map_err(|source| {
        logged(AppError::expected(
            format!("failed to resolve repository path: {source}"),
            operation_name,
        ))
    })
}

pub(crate) fn validate_relative_paths(
    paths: &[String],
    operation_name: &str,
) -> AppResult<Vec<String>> {
    if paths.is_empty() {
        return Err(logged(AppError::expected(
            "at least one path must be selected",
            operation_name,
        )));
    }

    let mut normalized = Vec::with_capacity(paths.len());
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(invalid_path(operation_name));
        }

        let candidate = Path::new(trimmed);
        if candidate.is_absolute() {
            return Err(invalid_path(operation_name));
        }

        let mut parts = Vec::new();
        for component in candidate.components() {
            match component {
                Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
                Component::CurDir => {}
                Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                    return Err(invalid_path(operation_name));
                }
            }
        }

        if parts.is_empty() {
            return Err(invalid_path(operation_name));
        }

        normalized.push(parts.join("/"));
    }

    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

pub(crate) fn git_stdout<I, S>(
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

pub(crate) fn run_git<I, S>(
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
    let plan = apply_auth_context_to_plan(plan, root, operation_name)?;
    command_to_output(plan.to_command(), &plan, operation_name)
}

pub(crate) fn run_git_lfs<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<CommandOutput>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = runner.git_lfs_command_plan(args);
    let mut command = plan.to_command();
    if let Some(root) = root {
        command.current_dir(root);
    }
    command_to_output(command, &plan, operation_name)
}

pub(crate) fn run_git_raw<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<(GitCommandPlan, Output)>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = plan_git(runner, root, args);
    let plan = apply_auth_context_to_plan(plan, root, operation_name)?;
    let output = command_output(plan.to_command(), &plan, operation_name)?;
    Ok((plan, output))
}

pub(crate) fn run_git_raw_authenticated<I, S>(
    runner: &GitRunner,
    auth_runtime: Option<&crate::auth_ipc::AuthRuntime>,
    interaction_policy: crate::auth_ipc::InteractionPolicy,
    root: Option<&Path>,
    args: I,
    operation_name: &str,
) -> AppResult<(GitCommandPlan, Output)>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = plan_git(runner, root, args);
    let plan =
        apply_auth_runtime_to_plan(plan, auth_runtime, interaction_policy, root, operation_name)?;
    let output = command_output(plan.to_command(), &plan, operation_name)?;
    Ok((plan, output))
}

pub(crate) fn apply_auth_context_to_plan(
    plan: GitCommandPlan,
    root: Option<&Path>,
    operation_name: &str,
) -> AppResult<GitCommandPlan> {
    let context = AUTH_CONTEXT.with(|contexts| contexts.borrow().last().cloned());
    let Some(context) = context else {
        return Ok(plan);
    };

    let invocation_context = root
        .map(|path| crate::auth_ipc::AuthInvocationContext::new().with_repository_path(path))
        .unwrap_or_default();
    context
        .runtime
        .inject_for_operation(&context.operation_id, plan, invocation_context)
        .map_err(|source| auth_ipc_error(source, operation_name))
}

fn apply_auth_runtime_to_plan(
    plan: GitCommandPlan,
    auth_runtime: Option<&crate::auth_ipc::AuthRuntime>,
    interaction_policy: crate::auth_ipc::InteractionPolicy,
    root: Option<&Path>,
    operation_name: &str,
) -> AppResult<GitCommandPlan> {
    let Some(auth_runtime) = auth_runtime else {
        return Ok(plan);
    };

    auth_runtime
        .inject_once(
            interaction_policy,
            root.map(Path::to_path_buf),
            plan,
            root.map(|path| {
                crate::auth_ipc::AuthInvocationContext::new().with_repository_path(path)
            })
            .unwrap_or_default(),
        )
        .map_err(|source| auth_ipc_error(source, operation_name))
}

pub(crate) fn command_failure(
    plan: &GitCommandPlan,
    output: Output,
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

pub(crate) fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn command_to_output(
    command: Command,
    plan: &GitCommandPlan,
    operation_name: &str,
) -> AppResult<CommandOutput> {
    let output = command_output(command, plan, operation_name)?;
    if output.status.success() {
        Ok(CommandOutput::from_output(output))
    } else {
        Err(command_failure(plan, output, operation_name))
    }
}

fn command_output(
    mut command: Command,
    plan: &GitCommandPlan,
    operation_name: &str,
) -> AppResult<Output> {
    let cancel_token = active_cancel_token();
    let Some(cancel_token) = cancel_token else {
        return command
            .output()
            .map_err(|source| spawn_error(plan, source, operation_name));
    };

    if cancel_token.is_cancelled() {
        return Err(cancelled_error(operation_name));
    }

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(plan, source, operation_name))?;

    loop {
        if cancel_token.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cancelled_error(operation_name));
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => return Err(spawn_error(plan, source, operation_name)),
        }
    }

    child
        .wait_with_output()
        .map_err(|source| spawn_error(plan, source, operation_name))
}

fn active_cancel_token() -> Option<CancelToken> {
    CANCEL_CONTEXT.with(|contexts| {
        contexts
            .borrow()
            .last()
            .map(|context| context.token.clone())
    })
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

fn cancelled_error(operation_name: &str) -> AppError {
    logged(AppError::expected("operation cancelled", operation_name))
}

fn auth_ipc_error(source: crate::auth_ipc::AuthIpcError, operation_name: &str) -> AppError {
    logged(AppError::unexpected(
        format!("authentication helper setup failed: {source}"),
        operation_name,
    ))
}

fn invalid_path(operation_name: &str) -> AppError {
    logged(AppError::expected(
        "selected paths must stay inside the repository",
        operation_name,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth_ipc::{AuthRuntime, InteractionPolicy, StaticAuthIpcHandler};
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_helpers::{
        AUTH_INVOCATION_ID_ENV, AUTH_OPERATION_ID_ENV, AUTH_SOCKET_ENV, AUTH_TOKEN_ENV,
    };
    use artistic_git_test_support::{
        git_dist_manifest_fixture, write_executable_file, write_git_dist_manifest, TestTempDir,
    };
    use std::{ffi::OsStr, sync::Arc};

    #[test]
    fn auth_context_injects_helper_config_and_ipc_environment() {
        let (runner, _temp) = fake_runner();
        let socket_path = short_auth_socket_path("git-ops-auth");
        let runtime = AuthRuntime::start_at(
            &runner,
            socket_path.clone(),
            Arc::new(StaticAuthIpcHandler::empty()),
        )
        .expect("auth runtime");
        let plan = runner
            .git_command_builder()
            .args(["fetch", "origin"])
            .build();

        let injected = with_auth_runtime_for_operation(
            Some(&runtime),
            InteractionPolicy::interactive(),
            None,
            Some(PathBuf::from("/repo")),
            || apply_auth_context_to_plan(plan, Some(Path::new("/repo")), "test"),
        )
        .expect("inject auth");

        let args = injected
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|arg| arg.starts_with("credential.helper=")));
        assert!(args.iter().any(|arg| arg == "credential.useHttpPath=true"));
        assert!(args.iter().any(|arg| arg.starts_with("core.sshCommand=")));
        assert_eq!(
            injected.environment.variable(AUTH_SOCKET_ENV),
            Some(socket_path.as_os_str())
        );
        assert!(injected.environment.variable(AUTH_TOKEN_ENV).is_some());
        assert!(injected
            .environment
            .variable(AUTH_INVOCATION_ID_ENV)
            .is_some());
        assert_eq!(args[args.len() - 2], "fetch");
        assert_eq!(args[args.len() - 1], "origin");
    }

    #[test]
    fn auth_context_reuses_high_level_operation_id_for_multiple_git_invocations() {
        let (runner, _temp) = fake_runner();
        let runtime = AuthRuntime::start_at(
            &runner,
            short_auth_socket_path("git-ops-auth-multi"),
            Arc::new(StaticAuthIpcHandler::empty()),
        )
        .expect("auth runtime");

        let (first, second) = with_auth_runtime_for_operation(
            Some(&runtime),
            InteractionPolicy::interactive(),
            Some(artistic_git_contracts::OperationId::new("sync-op-1")),
            Some(PathBuf::from("/repo")),
            || {
                let first = apply_auth_context_to_plan(
                    runner
                        .git_command_builder()
                        .args(["fetch", "origin"])
                        .build(),
                    Some(Path::new("/repo")),
                    "test",
                )
                .expect("first inject");
                let second = apply_auth_context_to_plan(
                    runner
                        .git_command_builder()
                        .args(["push", "origin", "main"])
                        .build(),
                    Some(Path::new("/repo")),
                    "test",
                )
                .expect("second inject");
                (first, second)
            },
        );

        assert_eq!(
            first.environment.variable(AUTH_OPERATION_ID_ENV),
            Some(OsStr::new("sync-op-1"))
        );
        assert_eq!(
            second.environment.variable(AUTH_OPERATION_ID_ENV),
            Some(OsStr::new("sync-op-1"))
        );
        assert_ne!(
            first.environment.variable(AUTH_INVOCATION_ID_ENV),
            second.environment.variable(AUTH_INVOCATION_ID_ENV)
        );
        assert_ne!(
            first.environment.variable(AUTH_TOKEN_ENV),
            second.environment.variable(AUTH_TOKEN_ENV)
        );
    }

    fn fake_runner() -> (GitRunner, TestTempDir) {
        let temp = TestTempDir::new("ag-git-ops-auth").expect("temp");
        let manifest = git_dist_manifest_fixture();
        write_git_dist_manifest(temp.path(), &manifest).expect("manifest");
        write_executable_file(&temp.path().join(&manifest.paths.git_executable)).expect("git");
        write_executable_file(&temp.path().join(&manifest.paths.git_lfs_executable))
            .expect("git-lfs");
        write_executable_file(&temp.path().join(&manifest.paths.credential_helper))
            .expect("credential helper");
        write_executable_file(&temp.path().join(&manifest.paths.ssh_askpass)).expect("ssh askpass");
        let distribution = GitDistribution::from_root(temp.path()).expect("distribution");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        (runner, temp)
    }

    fn short_auth_socket_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}-{}.sock", std::process::id()))
    }
}

fn logged(error: AppError) -> AppError {
    crate::logged_app_error(error)
}

#[derive(Debug)]
pub(crate) struct CommandOutput {
    pub(crate) stdout: String,
}

impl CommandOutput {
    fn from_output(output: Output) -> Self {
        Self {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        }
    }
}
