use crate::git_ops::{canonical_repository_path, display_path, run_git, validate_relative_paths};
use artistic_git_contracts::{AppError, AppResult, RestoreChangesRequest, RestoreChangesResponse};
use artistic_git_git_runner::GitRunner;
use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const OPERATION: &str = "restoreChanges";

pub fn restore_changes(
    runner: &GitRunner,
    request: RestoreChangesRequest,
) -> AppResult<RestoreChangesResponse> {
    let root = canonical_repository_path(&request.repository_path, OPERATION)?;
    let paths = validate_relative_paths(&request.paths, OPERATION)?;
    let backup = move_current_versions_to_trash(&root, &paths)?;

    for path in &paths {
        restore_path(runner, &root, path)?;
        clean_path(runner, &root, path)?;
    }

    Ok(RestoreChangesResponse {
        restored_paths: paths,
        backup_root: backup.root.map(|path| display_path(&path)),
        backed_up_paths: backup.paths,
    })
}

fn restore_path(runner: &GitRunner, root: &Path, path: &str) -> AppResult<()> {
    let args = [
        OsString::from("restore"),
        OsString::from("--staged"),
        OsString::from("--worktree"),
        OsString::from("--"),
        OsString::from(path),
    ];

    match run_git(runner, Some(root), args, OPERATION) {
        Ok(_) => Ok(()),
        Err(error) if is_unknown_pathspec(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn clean_path(runner: &GitRunner, root: &Path, path: &str) -> AppResult<()> {
    let args = [
        OsString::from("clean"),
        OsString::from("-fd"),
        OsString::from("--"),
        OsString::from(path),
    ];
    run_git(runner, Some(root), args, OPERATION).map(|_| ())
}

fn move_current_versions_to_trash(root: &Path, paths: &[String]) -> AppResult<BackupResult> {
    let mut result = BackupResult::default();
    let trash_base = trash_base_dir();
    let backup_root = trash_base.join(format!(
        "Artistic Git Restore Backup {}-{}",
        std::process::id(),
        unix_now_millis()
    ));

    for relative in paths {
        let source = root.join(relative);
        if fs::symlink_metadata(&source).is_err() {
            continue;
        }

        let destination = uniquify_path(&backup_root.join(relative));
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|source| backup_error(source, OPERATION))?;
        }

        move_path(&source, &destination).map_err(|source| backup_error(source, OPERATION))?;
        result.paths.push(relative.clone());
    }

    if !result.paths.is_empty() {
        result.root = Some(backup_root);
    }

    Ok(result)
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

fn move_path(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            copy_path(source, destination)?;
            remove_path(source)?;
            drop(rename_error);
            Ok(())
        }
    }
}

fn copy_path(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_path(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn remove_path(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn uniquify_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }

    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 1.. {
        let mut file_name = format!("{stem} ({index})");
        if let Some(extension) = extension {
            file_name.push('.');
            file_name.push_str(extension);
        }
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("unbounded suffix loop always returns")
}

fn is_unknown_pathspec(error: &AppError) -> bool {
    error
        .git
        .as_ref()
        .map(|git| git.stderr.contains("pathspec") && git.stderr.contains("did not match any file"))
        .unwrap_or(false)
}

fn backup_error(source: io::Error, operation_name: &str) -> AppError {
    crate::logged_app_error(AppError::expected(
        format!("failed to move current file version to trash: {source}"),
        operation_name,
    ))
}

fn unix_now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Default)]
struct BackupResult {
    root: Option<PathBuf>,
    paths: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ops::git_stdout;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, TestTempDir};
    use std::{ffi::OsString, io::Write, path::PathBuf};

    #[test]
    fn restore_moves_worktree_version_to_trash_before_discarding() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        let trash = TestTempDir::new("ag-restore-trash").expect("trash");
        std::env::set_var("ARTISTIC_GIT_TRASH_DIR", trash.path());
        repo.init_with_commit();
        repo.write("tracked.txt", "changed\n");

        let response = restore_changes(
            &runner,
            RestoreChangesRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["tracked.txt".to_owned()],
            },
        )
        .expect("restore changes");

        assert_eq!(
            fs::read_to_string(repo.path.join("tracked.txt")).unwrap(),
            "one\n"
        );
        let backup_root = PathBuf::from(response.backup_root.expect("backup root"));
        assert_eq!(
            fs::read_to_string(backup_root.join("tracked.txt")).unwrap(),
            "changed\n"
        );

        std::env::remove_var("ARTISTIC_GIT_TRASH_DIR");
    }

    #[test]
    fn restore_untracked_file_removes_it_without_stash() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        let trash = TestTempDir::new("ag-restore-trash").expect("trash");
        std::env::set_var("ARTISTIC_GIT_TRASH_DIR", trash.path());
        repo.init_with_commit();
        repo.write("new.txt", "new\n");

        restore_changes(
            &runner,
            RestoreChangesRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["new.txt".to_owned()],
            },
        )
        .expect("restore untracked");

        assert!(!repo.path.join("new.txt").exists());
        assert!(repo.git_output(["stash", "list"]).trim().is_empty());

        std::env::remove_var("ARTISTIC_GIT_TRASH_DIR");
    }

    fn real_runner() -> (GitRunner, TestTempDir) {
        let dist = require_git_dist().expect("load embedded git distribution");
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-restore-runner-home").expect("temp home");
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
            let temp = TestTempDir::new("ag-restore-repo").expect("temp repo");
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
}
