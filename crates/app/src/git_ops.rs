use artistic_git_contracts::{AppError, AppResult, GitCommandError};
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use std::{
    cell::RefCell,
    ffi::OsString,
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};

pub(crate) const DEFAULT_LARGE_FILE_THRESHOLD_MB: u32 = 50;

thread_local! {
    static AUTH_CONTEXT: RefCell<Vec<AuthCommandContext>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone)]
struct AuthCommandContext {
    runtime: crate::auth_ipc::AuthRuntime,
    interaction_policy: crate::auth_ipc::InteractionPolicy,
}

pub(crate) fn with_auth_runtime<T>(
    auth_runtime: Option<&crate::auth_ipc::AuthRuntime>,
    interaction_policy: crate::auth_ipc::InteractionPolicy,
    action: impl FnOnce() -> T,
) -> T {
    let Some(auth_runtime) = auth_runtime else {
        return action();
    };

    AUTH_CONTEXT.with(|contexts| {
        contexts.borrow_mut().push(AuthCommandContext {
            runtime: auth_runtime.clone(),
            interaction_policy,
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
    let mut planned_args = Vec::new();
    if let Some(root) = root {
        planned_args.push(OsString::from("-C"));
        planned_args.push(root.as_os_str().to_owned());
    }
    planned_args.extend(args.into_iter().map(Into::into));

    let plan = runner.git_lfs_command_plan(planned_args);
    command_to_output(plan.to_command(), &plan, operation_name)
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
    let output = plan
        .to_command()
        .output()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
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
    let output = plan
        .to_command()
        .output()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
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

    apply_auth_runtime_to_plan(
        plan,
        Some(&context.runtime),
        context.interaction_policy,
        root,
        operation_name,
    )
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
    use artistic_git_helpers::{AUTH_INVOCATION_ID_ENV, AUTH_SOCKET_ENV, AUTH_TOKEN_ENV};
    use artistic_git_test_support::{
        git_dist_manifest_fixture, write_executable_file, write_git_dist_manifest, TestTempDir,
    };
    use std::sync::Arc;

    #[test]
    fn auth_context_injects_helper_config_and_ipc_environment() {
        let (runner, temp) = fake_runner();
        let runtime = AuthRuntime::start_at(
            &runner,
            temp.path().join("auth.sock"),
            Arc::new(StaticAuthIpcHandler::empty()),
        )
        .expect("auth runtime");
        let plan = runner
            .git_command_builder()
            .args(["fetch", "origin"])
            .build();

        let injected = with_auth_runtime(Some(&runtime), InteractionPolicy::interactive(), || {
            apply_auth_context_to_plan(plan, Some(Path::new("/repo")), "test")
        })
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
            Some(temp.path().join("auth.sock").as_os_str())
        );
        assert!(injected.environment.variable(AUTH_TOKEN_ENV).is_some());
        assert!(injected
            .environment
            .variable(AUTH_INVOCATION_ID_ENV)
            .is_some());
        assert_eq!(args[args.len() - 2], "fetch");
        assert_eq!(args[args.len() - 1], "origin");
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
