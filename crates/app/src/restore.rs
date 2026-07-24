use crate::git_ops::{
    canonical_repository_path, display_path, literal_pathspec, run_git, validate_relative_paths,
};
use artistic_git_contracts::{
    AppError, AppResult, OperationContext, RestoreChangesRequest, RestoreChangesResponse,
};
use artistic_git_git_runner::GitRunner;
use std::{
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const OPERATION: &str = "restoreChanges";
const BACKUP_COPY_MAX_ENTRIES: usize = 50_000;
const BACKUP_COPY_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 256 * 1024;

pub fn restore_changes(
    runner: &GitRunner,
    request: RestoreChangesRequest,
) -> AppResult<RestoreChangesResponse> {
    restore_changes_with_trash_base(runner, request, trash_base_dir())
}

fn restore_changes_with_trash_base(
    runner: &GitRunner,
    request: RestoreChangesRequest,
    trash_base: PathBuf,
) -> AppResult<RestoreChangesResponse> {
    let root = canonical_repository_path(&request.repository_path, OPERATION)?;
    let paths = validate_relative_paths(&request.paths, OPERATION)?;
    let backup = move_current_versions_to_trash(&root, &paths, &trash_base)?;

    for path in &paths {
        let result =
            restore_path(runner, &root, path).and_then(|()| clean_path(runner, &root, path));
        if let Err(error) = result {
            let rollback_errors = rollback_restored_changes(&backup.moves);
            return Err(restore_operation_error(
                error,
                &root,
                backup.root.as_deref(),
                &rollback_errors,
            ));
        }
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
        literal_pathspec(path),
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
        literal_pathspec(path),
    ];
    run_git(runner, Some(root), args, OPERATION).map(|_| ())
}

fn move_current_versions_to_trash(
    root: &Path,
    paths: &[String],
    trash_base: &Path,
) -> AppResult<BackupResult> {
    let mut result = BackupResult::default();
    let mut moved = Vec::<BackupMove>::new();
    let mut copy_budget = CopyBudget::default();
    let backup_root = trash_base.join(format!(
        "Artistic Git Restore Backup {}-{}",
        std::process::id(),
        unix_now_millis()
    ));

    for relative in paths {
        let source = root.join(relative);
        match fs::symlink_metadata(&source) {
            Ok(_) => {}
            Err(source_error) if source_error.kind() == io::ErrorKind::NotFound => continue,
            Err(source_error) => {
                let rollback_errors = rollback_backup_moves(&moved);
                return Err(backup_path_error(
                    root,
                    &source,
                    None,
                    format!("failed to inspect the path before backing it up: {source_error}"),
                    &rollback_errors,
                ));
            }
        }

        let destination = uniquify_path(&backup_root.join(relative));
        if let Some(parent) = destination.parent() {
            if let Err(source_error) = fs::create_dir_all(parent) {
                let rollback_errors = rollback_backup_moves(&moved);
                return Err(backup_path_error(
                    root,
                    &source,
                    Some(&destination),
                    format!("failed to create the Trash backup directory: {source_error}"),
                    &rollback_errors,
                ));
            }
        }

        let move_result = check_copy_cancelled()
            .and_then(|()| move_path(&source, &destination, &mut copy_budget));
        if let Err(source_error) = move_result {
            let rollback_errors = rollback_backup_moves(&moved);
            return Err(backup_path_error(
                root,
                &source,
                Some(&destination),
                source_error.to_string(),
                &rollback_errors,
            ));
        }
        moved.push(BackupMove {
            destination: destination.clone(),
            source: source.clone(),
        });
        result.moves.push(BackupMove {
            destination,
            source,
        });
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

fn move_path(source: &Path, destination: &Path, copy_budget: &mut CopyBudget) -> io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            if let Err(copy_error) = copy_path(source, destination, copy_budget) {
                let cleanup = cleanup_partial_copy(destination);
                return Err(combined_move_error(
                    &rename_error,
                    "fallback copy across filesystems failed",
                    &copy_error,
                    cleanup.as_ref().err(),
                ));
            }
            if let Err(remove_error) = remove_path(source) {
                return Err(combined_move_error(
                    &rename_error,
                    "the copy completed but the original path could not be removed; the complete backup was preserved",
                    &remove_error,
                    None,
                ));
            }
            Ok(())
        }
    }
}

fn copy_path(source: &Path, destination: &Path, budget: &mut CopyBudget) -> io::Result<()> {
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
    while let Some((source, destination)) = pending.pop() {
        check_copy_cancelled()?;
        let metadata = fs::symlink_metadata(&source)?;
        budget.reserve_entry(&source)?;

        if metadata.file_type().is_symlink() {
            budget.reserve_bytes(metadata.len(), &source)?;
            copy_symlink(&source, &destination)?;
        } else if metadata.is_dir() {
            fs::create_dir_all(&destination)?;
            for entry in fs::read_dir(&source)? {
                check_copy_cancelled()?;
                let entry = entry?;
                pending.push((entry.path(), destination.join(entry.file_name())));
            }
        } else if metadata.is_file() {
            copy_file_bounded(&source, &destination, &metadata, budget)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!(
                    "cannot copy a special file into the Trash backup: {}",
                    source.display()
                ),
            ));
        }
    }
    Ok(())
}

fn copy_file_bounded(
    source: &Path,
    destination: &Path,
    metadata: &fs::Metadata,
    budget: &mut CopyBudget,
) -> io::Result<()> {
    budget.reserve_bytes(metadata.len(), source)?;
    let mut reader = fs::File::open(source)?;
    let mut writer = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    let mut copied = 0u64;
    let mut accounted = metadata.len();

    loop {
        check_copy_cancelled()?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        copied = copied.saturating_add(read as u64);
        if copied > accounted {
            budget.reserve_bytes(copied - accounted, source)?;
            accounted = copied;
        }
        writer.write_all(&buffer[..read])?;
    }
    writer.flush()?;
    fs::set_permissions(destination, metadata.permissions())?;
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(source)?, destination)
}

#[cfg(windows)]
fn copy_symlink(source: &Path, destination: &Path) -> io::Result<()> {
    let target = fs::read_link(source)?;
    if fs::metadata(source).is_ok_and(|metadata| metadata.is_dir()) {
        std::os::windows::fs::symlink_dir(target, destination)
    } else {
        std::os::windows::fs::symlink_file(target, destination)
    }
}

#[cfg(not(any(unix, windows)))]
fn copy_symlink(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "this platform does not support backing up symbolic links",
    ))
}

fn remove_path(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn cleanup_partial_copy(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => remove_path(path),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(source),
    }
}

fn combined_move_error(
    rename_error: &io::Error,
    fallback_action: &str,
    fallback_error: &io::Error,
    cleanup_error: Option<&io::Error>,
) -> io::Error {
    let cleanup_detail = cleanup_error
        .map(|source| format!("; cleanup of the incomplete backup also failed: {source}"))
        .unwrap_or_default();
    io::Error::new(
        fallback_error.kind(),
        format!(
            "direct move failed: {rename_error}; {fallback_action}: {fallback_error}{cleanup_detail}"
        ),
    )
}

fn check_copy_cancelled() -> io::Result<()> {
    if crate::git_ops::active_cancel_token().is_some_and(|token| token.is_cancelled()) {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "operation cancelled; original files that were not discarded remain unchanged",
        ))
    } else {
        Ok(())
    }
}

fn rollback_backup_moves(moved: &[BackupMove]) -> Vec<String> {
    crate::git_ops::without_cancel_token(|| {
        let mut errors = Vec::new();
        let mut budget = CopyBudget::unlimited();
        for moved_path in moved.iter().rev() {
            if let Some(parent) = moved_path.source.parent() {
                if let Err(source) = fs::create_dir_all(parent) {
                    errors.push(format!(
                        "failed to recreate the parent directory for {}: {source}",
                        moved_path.source.display()
                    ));
                    continue;
                }
            }
            if let Err(source) = move_path(&moved_path.destination, &moved_path.source, &mut budget)
            {
                errors.push(format!(
                    "failed to move {} back to {}: {source}",
                    moved_path.destination.display(),
                    moved_path.source.display()
                ));
            }
        }
        errors
    })
}

fn rollback_restored_changes(moved: &[BackupMove]) -> Vec<String> {
    crate::git_ops::without_cancel_token(|| {
        let mut errors = Vec::new();
        let mut budget = CopyBudget::unlimited();
        for moved_path in moved.iter().rev() {
            match fs::symlink_metadata(&moved_path.source) {
                Ok(_) => {
                    if let Err(source) = remove_path(&moved_path.source) {
                        errors.push(format!(
                            "failed to remove {} created by the interrupted restore: {source}",
                            moved_path.source.display()
                        ));
                        continue;
                    }
                }
                Err(source) if source.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    errors.push(format!(
                        "failed to inspect {} created by the interrupted restore: {source}",
                        moved_path.source.display()
                    ));
                    continue;
                }
            }
            if let Some(parent) = moved_path.source.parent() {
                if let Err(source) = fs::create_dir_all(parent) {
                    errors.push(format!(
                        "failed to recreate the parent directory for {}: {source}",
                        moved_path.source.display()
                    ));
                    continue;
                }
            }
            if let Err(source) = move_path(&moved_path.destination, &moved_path.source, &mut budget)
            {
                errors.push(format!(
                    "failed to restore backup {} to {}: {source}",
                    moved_path.destination.display(),
                    moved_path.source.display()
                ));
            }
        }
        errors
    })
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

fn backup_path_error(
    root: &Path,
    source: &Path,
    destination: Option<&Path>,
    reason: String,
    rollback_errors: &[String],
) -> AppError {
    let destination = destination
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "not created".to_owned());
    let recovery_detail = if rollback_errors.is_empty() {
        "Previously moved paths were rolled back.".to_owned()
    } else {
        format!(
            "Rollback was incomplete: {}. Preserve the backup in Trash and restore it manually.",
            rollback_errors.join("; ")
        )
    };
    crate::logged_app_error(
        AppError::expected(
            format!(
                "Failed to back up current files before restoring: {reason}. Source: {}; backup: {destination}. {recovery_detail}",
                source.display()
            ),
            OPERATION,
        )
        .with_context(
            OperationContext::new(OPERATION).with_repository_path(display_path(root)),
        ),
    )
}

fn restore_operation_error(
    mut error: AppError,
    root: &Path,
    backup_root: Option<&Path>,
    rollback_errors: &[String],
) -> AppError {
    let backup_root = backup_root
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "no backup was created".to_owned());
    let recovery_detail = if rollback_errors.is_empty() {
        "The pre-restore files were restored from the Trash backup.".to_owned()
    } else {
        format!(
            "Automatic rollback was incomplete: {}. Preserve the backup at {backup_root} and restore it manually.",
            rollback_errors.join("; ")
        )
    };
    error.summary = format!("{}. {recovery_detail}", error.summary.trim_end_matches('.'));
    error.context =
        Box::new(OperationContext::new(OPERATION).with_repository_path(display_path(root)));
    crate::logged_app_error(error)
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
    moves: Vec<BackupMove>,
}

#[derive(Debug, Clone)]
struct BackupMove {
    destination: PathBuf,
    source: PathBuf,
}

#[derive(Debug)]
struct CopyBudget {
    max_bytes: u64,
    max_entries: usize,
    used_bytes: u64,
    used_entries: usize,
}

impl Default for CopyBudget {
    fn default() -> Self {
        Self::new(BACKUP_COPY_MAX_ENTRIES, BACKUP_COPY_MAX_BYTES)
    }
}

impl CopyBudget {
    fn new(max_entries: usize, max_bytes: u64) -> Self {
        Self {
            max_bytes,
            max_entries,
            used_bytes: 0,
            used_entries: 0,
        }
    }

    fn unlimited() -> Self {
        Self::new(usize::MAX, u64::MAX)
    }

    fn reserve_entry(&mut self, path: &Path) -> io::Result<()> {
        self.used_entries = self.used_entries.saturating_add(1);
        if self.used_entries > self.max_entries {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "cross-filesystem backup contains too many files and directories (limit: {}; exceeded at {})",
                    self.max_entries,
                    path.display()
                ),
            ));
        }
        Ok(())
    }

    fn reserve_bytes(&mut self, bytes: u64, path: &Path) -> io::Result<()> {
        let next = self.used_bytes.checked_add(bytes).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "cross-filesystem backup size overflowed",
            )
        })?;
        if next > self.max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "cross-filesystem backup is too large (limit: {} bytes; processing {} would reach {} bytes)",
                    self.max_bytes,
                    path.display(),
                    next
                ),
            ));
        }
        self.used_bytes = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_ops::git_stdout;
    use artistic_git_git_runner::{CancelToken, GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, TestTempDir};
    use std::{ffi::OsString, io::Write, path::PathBuf};

    #[test]
    fn restore_moves_worktree_version_to_trash_before_discarding() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        let trash = TestTempDir::new("ag-restore-trash").expect("trash");
        repo.init_with_commit();
        repo.write("tracked.txt", "changed\n");

        let response = restore_changes_with_trash_base(
            &runner,
            RestoreChangesRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["tracked.txt".to_owned()],
                operation_id: None,
            },
            trash.path().to_path_buf(),
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
    }

    #[test]
    fn restore_untracked_file_removes_it_without_stash() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        let trash = TestTempDir::new("ag-restore-trash").expect("trash");
        repo.init_with_commit();
        repo.write("new.txt", "new\n");

        restore_changes_with_trash_base(
            &runner,
            RestoreChangesRequest {
                repository_path: display_path(&repo.path),
                paths: vec!["new.txt".to_owned()],
                operation_id: None,
            },
            trash.path().to_path_buf(),
        )
        .expect("restore untracked");

        assert!(!repo.path.join("new.txt").exists());
        assert!(repo.git_output(["stash", "list"]).trim().is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn restore_treats_pathspec_magic_as_a_literal_filename() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        let trash = TestTempDir::new("ag-restore-trash").expect("trash");
        repo.init_with_commit();
        repo.write(":(glob)**", "selected\n");
        repo.write("unselected.txt", "must remain\n");

        restore_changes_with_trash_base(
            &runner,
            RestoreChangesRequest {
                repository_path: display_path(&repo.path),
                paths: vec![":(glob)**".to_owned()],
                operation_id: None,
            },
            trash.path().to_path_buf(),
        )
        .expect("restore literal path");

        assert!(!repo.path.join(":(glob)**").exists());
        assert_eq!(
            fs::read_to_string(repo.path.join("unselected.txt")).expect("unselected file"),
            "must remain\n"
        );
    }

    #[test]
    fn bounded_copy_rejects_a_file_before_allocating_its_destination() {
        let temp = TestTempDir::new("ag-restore-copy-limit").expect("temp");
        let source = temp.path().join("source.bin");
        let destination = temp.path().join("destination.bin");
        fs::write(&source, b"oversized").expect("source");
        let mut budget = CopyBudget::new(10, 4);

        let error = copy_path(&source, &destination, &mut budget).expect_err("copy limit");

        assert!(error
            .to_string()
            .contains("cross-filesystem backup is too large"));
        assert!(source.exists());
        assert!(!destination.exists());
    }

    #[test]
    fn bounded_copy_honors_cancellation_without_removing_the_source() {
        let temp = TestTempDir::new("ag-restore-copy-cancel").expect("temp");
        let source = temp.path().join("source.bin");
        let destination = temp.path().join("destination.bin");
        fs::write(&source, vec![b'x'; COPY_BUFFER_BYTES * 2]).expect("source");
        let mut budget = CopyBudget::default();
        let token = CancelToken::new();
        token.cancel();

        let error = crate::git_ops::with_cancel_token_for_operation(&token, || {
            copy_path(&source, &destination, &mut budget)
        })
        .expect_err("cancelled copy");

        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert!(source.exists());
        assert!(!destination.exists());
    }

    #[test]
    fn backup_rollback_restores_paths_that_were_already_moved() {
        let temp = TestTempDir::new("ag-restore-backup-rollback").expect("temp");
        let source = temp.path().join("repo/current.txt");
        let destination = temp.path().join("trash/current.txt");
        fs::create_dir_all(source.parent().expect("source parent")).expect("source parent");
        fs::create_dir_all(destination.parent().expect("destination parent"))
            .expect("destination parent");
        fs::write(&source, "current contents").expect("source");
        fs::rename(&source, &destination).expect("move to backup");

        let errors = rollback_backup_moves(&[BackupMove {
            destination: destination.clone(),
            source: source.clone(),
        }]);

        assert!(errors.is_empty(), "rollback errors: {errors:?}");
        assert_eq!(
            fs::read_to_string(&source).expect("restored"),
            "current contents"
        );
        assert!(!destination.exists());
    }

    #[test]
    fn failed_restore_rollback_replaces_git_output_with_the_original_backup() {
        let temp = TestTempDir::new("ag-restore-operation-rollback").expect("temp");
        let source = temp.path().join("repo/current.txt");
        let destination = temp.path().join("trash/current.txt");
        fs::create_dir_all(source.parent().expect("source parent")).expect("source parent");
        fs::create_dir_all(destination.parent().expect("destination parent"))
            .expect("destination parent");
        fs::write(&source, "git restored contents").expect("restored source");
        fs::write(&destination, "original current contents").expect("backup");

        let errors = rollback_restored_changes(&[BackupMove {
            destination: destination.clone(),
            source: source.clone(),
        }]);

        assert!(errors.is_empty(), "rollback errors: {errors:?}");
        assert_eq!(
            fs::read_to_string(&source).expect("original restored"),
            "original current contents"
        );
        assert!(!destination.exists());
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
