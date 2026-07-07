use artistic_git_contracts::{AppError, AppResult, GitCommandError};
use artistic_git_git_runner::{GitCommandPlan, GitRunner};
use std::{
    ffi::OsString,
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};

pub(crate) const DEFAULT_LARGE_FILE_THRESHOLD_MB: u32 = 50;

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
    let output = plan
        .to_command()
        .output()
        .map_err(|source| spawn_error(&plan, source, operation_name))?;
    Ok((plan, output))
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

fn invalid_path(operation_name: &str) -> AppError {
    logged(AppError::expected(
        "selected paths must stay inside the repository",
        operation_name,
    ))
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
