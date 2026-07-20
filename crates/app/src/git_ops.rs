use artistic_git_contracts::{AppError, AppResult, GitCommandError};
use artistic_git_git_runner::{CancelToken, GitCommandPlan, GitRunner};
use std::{
    cell::RefCell,
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(crate) const DEFAULT_LARGE_FILE_THRESHOLD_MB: u32 = 50;
const COMMAND_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const COMMAND_OUTPUT_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const COMMAND_OUTPUT_DIAGNOSTIC_BYTES: usize = 64 * 1024;

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

    let operation_id = operation.operation_id.clone();
    AUTH_CONTEXT.with(|contexts| {
        contexts.borrow_mut().push(AuthCommandContext {
            runtime: auth_runtime.clone(),
            operation_id: operation_id.clone(),
        });
    });
    let _guard = AuthContextGuard {
        operation_id,
        runtime: auth_runtime.clone(),
    };
    action()
}

struct AuthContextGuard {
    operation_id: artistic_git_contracts::OperationId,
    runtime: crate::auth_ipc::AuthRuntime,
}

impl Drop for AuthContextGuard {
    fn drop(&mut self) {
        AUTH_CONTEXT.with(|contexts| {
            contexts.borrow_mut().pop();
        });
        if let Err(error) = self.runtime.finish_operation(&self.operation_id) {
            tracing::warn!(error = %error, "failed to finish auth operation context");
        }
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

pub(crate) fn literal_pathspec(path: impl AsRef<OsStr>) -> OsString {
    let mut pathspec = OsString::from(":(literal)");
    pathspec.push(path.as_ref());
    pathspec
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

pub(crate) fn git_stdout_with_redacted_argument<I, S>(
    runner: &GitRunner,
    root: Option<&Path>,
    args: I,
    redacted_argument: impl Into<OsString>,
    replacement: impl Into<OsString>,
    operation_name: &str,
) -> AppResult<String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let plan = plan_git(runner, root, args).redact_argument(redacted_argument, replacement);
    let plan = apply_auth_context_to_plan(plan, root, operation_name)?;
    command_to_output(plan.to_command(), &plan, operation_name).map(|output| output.stdout)
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

pub(crate) fn run_planned_command(
    command: Command,
    plan: &GitCommandPlan,
    operation_name: &str,
) -> AppResult<Output> {
    let output = command_output(command, plan, operation_name)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_failure(plan, output, operation_name))
    }
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
    with_auth_runtime_for_operation(
        auth_runtime,
        interaction_policy,
        None,
        root.map(Path::to_path_buf),
        || {
            let plan = plan_git(runner, root, args);
            let plan = apply_auth_context_to_plan(plan, root, operation_name)?;
            let output = command_output(plan.to_command(), &plan, operation_name)?;
            Ok((plan, output))
        },
    )
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

pub(crate) fn command_failure(
    plan: &GitCommandPlan,
    output: Output,
    operation_name: &str,
) -> AppError {
    let stderr = plan.redact_text(&String::from_utf8_lossy(&output.stderr));
    let stdout = plan.redact_text(&String::from_utf8_lossy(&output.stdout));
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
    let cancel_token = active_cancel_token().unwrap_or_default();

    if cancel_token.is_cancelled() {
        return Err(cancelled_error(operation_name));
    }

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    prepare_child_process_tree(&mut command);
    let mut child = command
        .spawn()
        .map_err(|source| spawn_error(plan, source, operation_name))?;
    let mut stdout_reader = child.stdout.take().map(spawn_command_output_reader);
    let mut stderr_reader = child.stderr.take().map(spawn_command_output_reader);

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancel_token.is_cancelled() => {
                if let Some(status) = terminate_child_process_tree(&mut child)
                    .ok()
                    .filter(ExitStatus::success)
                {
                    break status;
                }
                discard_command_output(&mut stdout_reader);
                discard_command_output(&mut stderr_reader);
                return Err(cancelled_error(operation_name));
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(source) => {
                let _ = terminate_child_process_tree(&mut child);
                discard_command_output(&mut stdout_reader);
                discard_command_output(&mut stderr_reader);
                return Err(spawn_error(plan, source, operation_name));
            }
        }
    };

    let output_deadline = Instant::now() + COMMAND_OUTPUT_DRAIN_TIMEOUT;
    let stdout = collect_command_output(
        stdout_reader,
        "stdout",
        operation_name,
        output_deadline,
        None,
    )?;
    let stderr = collect_command_output(
        stderr_reader,
        "stderr",
        operation_name,
        output_deadline,
        None,
    )?;
    if stdout.exceeded_limit || stderr.exceeded_limit {
        return Err(output_limit_error(
            plan,
            status,
            operation_name,
            stdout,
            stderr,
        ));
    }
    Ok(Output {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

struct CommandOutputReader {
    handle: thread::JoinHandle<io::Result<Vec<u8>>>,
    limit_bytes: usize,
}

#[derive(Debug)]
struct CapturedCommandOutput {
    bytes: Vec<u8>,
    exceeded_limit: bool,
    limit_bytes: usize,
}

fn spawn_command_output_reader<R>(reader: R) -> CommandOutputReader
where
    R: Read + Send + 'static,
{
    spawn_command_output_reader_with_limit(reader, COMMAND_OUTPUT_LIMIT_BYTES)
}

fn spawn_command_output_reader_with_limit<R>(reader: R, limit_bytes: usize) -> CommandOutputReader
where
    R: Read + Send + 'static,
{
    let handle = thread::spawn(move || read_command_output_bounded(reader, limit_bytes));
    CommandOutputReader {
        handle,
        limit_bytes,
    }
}

fn read_command_output_bounded<R>(mut reader: R, limit_bytes: usize) -> io::Result<Vec<u8>>
where
    R: Read,
{
    const READ_CHUNK_BYTES: usize = 16 * 1024;

    let capture_limit = limit_bytes.saturating_add(1);
    let mut output = Vec::with_capacity(capture_limit.min(READ_CHUNK_BYTES));
    let mut buffer = [0_u8; READ_CHUNK_BYTES];

    loop {
        let bytes_read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes_read) => bytes_read,
            Err(source) if source.kind() == io::ErrorKind::Interrupted => continue,
            Err(source) => return Err(source),
        };

        let captured_bytes = bytes_read.min(capture_limit.saturating_sub(output.len()));
        if captured_bytes > 0 {
            let required_capacity = output.len() + captured_bytes;
            if required_capacity > output.capacity() {
                let next_capacity = output
                    .capacity()
                    .saturating_mul(2)
                    .max(required_capacity)
                    .min(capture_limit);
                output.reserve_exact(next_capacity - output.len());
            }
            output.extend_from_slice(&buffer[..captured_bytes]);
        }
    }

    Ok(output)
}

fn collect_command_output(
    reader: Option<CommandOutputReader>,
    stream_name: &str,
    operation_name: &str,
    deadline: Instant,
    cancel_token: Option<&CancelToken>,
) -> AppResult<CapturedCommandOutput> {
    let Some(reader) = reader else {
        return Ok(CapturedCommandOutput {
            bytes: Vec::new(),
            exceeded_limit: false,
            limit_bytes: COMMAND_OUTPUT_LIMIT_BYTES,
        });
    };

    while !reader.handle.is_finished() {
        if cancel_token.is_some_and(CancelToken::is_cancelled) {
            return Err(cancelled_error(operation_name));
        }
        if Instant::now() >= deadline {
            return Err(logged(AppError::unexpected(
                format!(
                    "git {stream_name} remained open after the command exited; a child process may still be holding the output pipe"
                ),
                operation_name,
            )));
        }
        thread::sleep(Duration::from_millis(10));
    }

    let CommandOutputReader {
        handle,
        limit_bytes,
    } = reader;
    match handle.join() {
        Ok(Ok(mut output)) => {
            let exceeded_limit = output.len() > limit_bytes;
            output.truncate(limit_bytes);
            Ok(CapturedCommandOutput {
                bytes: output,
                exceeded_limit,
                limit_bytes,
            })
        }
        Ok(Err(source)) => Err(logged(AppError::unexpected(
            format!("failed to read git {stream_name}: {source}"),
            operation_name,
        ))),
        Err(_) => Err(logged(AppError::unexpected(
            format!("git {stream_name} reader thread panicked"),
            operation_name,
        ))),
    }
}

fn discard_command_output(reader: &mut Option<CommandOutputReader>) {
    // A Git hook or transport child can outlive the Git process while retaining
    // the pipe. Detach the reader so cancellation never waits on that child.
    reader.take();
}

pub(crate) fn prepare_child_process_tree(command: &mut Command) {
    prepare_child_process_tree_impl(command);
}

#[cfg(unix)]
fn prepare_child_process_tree_impl(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
fn prepare_child_process_tree_impl(_command: &mut Command) {}

pub(crate) fn terminate_child_process_tree(child: &mut Child) -> io::Result<ExitStatus> {
    terminate_child_process_tree_impl(child)
}

#[cfg(unix)]
fn terminate_child_process_tree_impl(child: &mut Child) -> io::Result<ExitStatus> {
    const SIGKILL: i32 = 9;

    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    let process_group = i32::try_from(child.id())
        .ok()
        .and_then(|pid| pid.checked_neg())
        .ok_or_else(|| io::Error::other("child process id is outside the supported range"))?;
    // The command is placed in a new process group immediately before spawn, so
    // a negative pid targets only that command and descendants that inherit it.
    let killed = unsafe { kill(process_group, SIGKILL) } == 0;
    if !killed {
        let source = io::Error::last_os_error();
        if source.raw_os_error() != Some(3) {
            let _ = child.kill();
        }
    }
    child.wait()
}

#[cfg(windows)]
fn terminate_child_process_tree_impl(child: &mut Child) -> io::Result<ExitStatus> {
    let taskkill_status = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if taskkill_status.is_err() || taskkill_status.is_ok_and(|status| !status.success()) {
        let _ = child.kill();
    }
    child.wait()
}

#[cfg(not(any(unix, windows)))]
fn terminate_child_process_tree_impl(child: &mut Child) -> io::Result<ExitStatus> {
    let _ = child.kill();
    child.wait()
}

pub(crate) fn active_cancel_token() -> Option<CancelToken> {
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

fn output_limit_error(
    plan: &GitCommandPlan,
    status: ExitStatus,
    operation_name: &str,
    stdout: CapturedCommandOutput,
    stderr: CapturedCommandOutput,
) -> AppError {
    let exceeded_streams = [
        stdout.exceeded_limit.then_some("stdout"),
        stderr.exceeded_limit.then_some("stderr"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" and ");
    let limit_bytes = stdout.limit_bytes.max(stderr.limit_bytes);
    logged(
        AppError::unexpected(
            format!(
                "git {exceeded_streams} exceeded the {limit_bytes}-byte per-stream output limit while running {operation_name}"
            ),
            operation_name,
        )
        .with_git(GitCommandError {
            command: plan.command_for_error(),
            exit_code: status.code(),
            stdout: bounded_output_diagnostic(&stdout.bytes),
            stderr: bounded_output_diagnostic(&stderr.bytes),
        }),
    )
}

fn bounded_output_diagnostic(output: &[u8]) -> String {
    if output.len() <= COMMAND_OUTPUT_DIAGNOSTIC_BYTES {
        return String::from_utf8_lossy(output).into_owned();
    }
    let half = COMMAND_OUTPUT_DIAGNOSTIC_BYTES / 2;
    format!(
        "{}\n\n[output truncated: showing first and last {half} bytes]\n\n{}",
        String::from_utf8_lossy(&output[..half]),
        String::from_utf8_lossy(&output[output.len() - half..]),
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
    use crate::auth_ipc::{
        AuthInvocationContext, AuthIpcError, AuthRuntime, InteractionPolicy, StaticAuthIpcHandler,
    };
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_helpers::{
        AUTH_INVOCATION_ID_ENV, AUTH_OPERATION_ID_ENV, AUTH_SOCKET_ENV, AUTH_TOKEN_ENV,
    };
    use artistic_git_test_support::{
        git_dist_manifest_fixture, write_executable_file, write_executable_script,
        write_git_dist_manifest, TestTempDir,
    };
    use std::{
        ffi::OsStr,
        sync::{mpsc, Arc},
    };

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
        let error = runtime
            .inject_for_operation(
                &artistic_git_contracts::OperationId::new("sync-op-1"),
                runner
                    .git_command_builder()
                    .args(["status", "--short"])
                    .build(),
                AuthInvocationContext::new(),
            )
            .expect_err("auth operation should be cleaned up after the scope");
        assert!(matches!(error, AuthIpcError::UnknownOperation(_)));
    }

    #[test]
    fn cancellable_command_drains_large_output_before_process_exit() {
        let (runner, temp) = fake_runner();
        let manifest = git_dist_manifest_fixture();
        write_executable_script(
            &temp.path().join(&manifest.paths.git_executable),
            "#!/bin/sh\ni=0\nwhile [ $i -lt 20000 ]; do\n  printf 'refs/heads/branch-%s\\n' \"$i\"\n  i=$((i + 1))\ndone\n",
            "@echo off\r\nfor /L %%i in (1,1,20000) do @echo refs/heads/branch-%%i\r\n",
        )
        .expect("write large-output git");
        let cancel_token = CancelToken::new();
        let (result_tx, result_rx) = mpsc::channel();

        thread::spawn(move || {
            let result = with_cancel_token_for_operation(&cancel_token, || {
                git_stdout(&runner, None, ["ls-remote"], "largeOutputTest")
            });
            let _ = result_tx.send(result);
            drop(temp);
        });

        let output = result_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("large command output should not fill the pipe")
            .expect("large command output");
        assert!(output.len() > 256 * 1024);
        assert!(output.contains("refs/heads/branch-19999"));
    }

    #[cfg(unix)]
    #[test]
    fn completed_command_wins_over_a_late_cancel_signal() {
        let (runner, temp) = fake_runner();
        let manifest = git_dist_manifest_fixture();
        let finishing_marker = temp.path().join("git-finishing");
        write_executable_script(
            &temp.path().join(&manifest.paths.git_executable),
            &format!(
                "#!/bin/sh\nsleep 0.025\ntouch '{}'\nprintf 'done\\n'\n",
                display_path(&finishing_marker)
            ),
            "@echo done\r\n",
        )
        .expect("write delayed git");
        let cancel_token = CancelToken::new();
        let cancelling_token = cancel_token.clone();
        let cancel_thread = thread::spawn(move || {
            while !finishing_marker.exists() {
                thread::sleep(Duration::from_millis(1));
            }
            thread::sleep(Duration::from_millis(5));
            cancelling_token.cancel();
        });

        let output = with_cancel_token_for_operation(&cancel_token, || {
            git_stdout(&runner, None, ["status"], "lateCancelTest")
        })
        .expect("completed command should not be replaced by cancellation");
        cancel_thread.join().expect("cancel thread");

        assert_eq!(output.trim(), "done");
    }

    #[test]
    fn command_output_reader_has_a_bounded_drain_wait() {
        let reader = thread::spawn(|| {
            thread::sleep(Duration::from_millis(200));
            Ok(Vec::new())
        });
        let reader = CommandOutputReader {
            handle: reader,
            limit_bytes: COMMAND_OUTPUT_LIMIT_BYTES,
        };
        let error = collect_command_output(
            Some(reader),
            "stdout",
            "boundedDrainTest",
            Instant::now() + Duration::from_millis(20),
            None,
        )
        .expect_err("reader wait should time out");

        assert!(error.summary.contains("remained open"));
    }

    #[test]
    fn command_output_reader_enforces_limit() {
        let limit_bytes = 32;
        let reader = spawn_command_output_reader_with_limit(
            io::Cursor::new(vec![b'x'; limit_bytes + 8]),
            limit_bytes,
        );
        let output = collect_command_output(
            Some(reader),
            "stderr",
            "boundedOutputTest",
            Instant::now() + Duration::from_secs(1),
            None,
        )
        .expect("bounded reader result");

        assert!(output.exceeded_limit);
        assert_eq!(output.limit_bytes, limit_bytes);
        assert_eq!(output.bytes.len(), limit_bytes);
    }

    #[test]
    fn command_output_reader_allows_output_at_limit() {
        let limit_bytes = 32;
        let reader = spawn_command_output_reader_with_limit(
            io::Cursor::new(vec![b'x'; limit_bytes]),
            limit_bytes,
        );
        let output = collect_command_output(
            Some(reader),
            "stdout",
            "exactOutputLimitTest",
            Instant::now() + Duration::from_secs(1),
            None,
        )
        .expect("output at the limit should be accepted");

        assert!(!output.exceeded_limit);
        assert_eq!(output.bytes.len(), limit_bytes);
    }

    #[cfg(unix)]
    #[test]
    fn output_limit_error_keeps_bounded_command_diagnostics() {
        let (runner, _temp) = fake_runner();
        let plan = plan_git(&runner, None, ["status"]);
        let status = Command::new("sh")
            .args(["-c", "exit 7"])
            .status()
            .expect("fixture status");
        let error = output_limit_error(
            &plan,
            status,
            "boundedOutputTest",
            CapturedCommandOutput {
                bytes: b"stdout diagnostic".to_vec(),
                exceeded_limit: false,
                limit_bytes: 32,
            },
            CapturedCommandOutput {
                bytes: b"stderr diagnostic".to_vec(),
                exceeded_limit: true,
                limit_bytes: 32,
            },
        );

        assert!(error.summary.contains("stderr"));
        assert!(error.summary.contains("32-byte per-stream output limit"));
        let details = error.git.expect("git diagnostics");
        assert_eq!(details.exit_code, Some(7));
        assert_eq!(details.stdout, "stdout diagnostic");
        assert_eq!(details.stderr, "stderr diagnostic");
        assert!(!details.command.is_empty());
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
