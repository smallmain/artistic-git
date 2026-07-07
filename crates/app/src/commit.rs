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
    ffi::OsString,
    fs,
    path::Path,
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

    let threshold_mb = request
        .large_file_threshold_mb
        .unwrap_or(DEFAULT_LARGE_FILE_THRESHOLD_MB)
        .max(1);
    let threshold = u64::from(threshold_mb) * 1024 * 1024;
    let large_files = large_files_without_lfs(runner, &root, &paths, threshold)?;
    let mut lfs_tracked_paths = Vec::new();

    match request.large_file_decision {
        LargeFileDecision::Prompt if !large_files.is_empty() => {
            return Ok(CommitResponse::LargeFilesNeedDecision {
                large_files,
                threshold_mb,
            });
        }
        LargeFileDecision::TrackWithLfs if !large_files.is_empty() => {
            lfs_tracked_paths = large_files
                .iter()
                .map(|warning| warning.path.clone())
                .collect();
            track_large_files_with_lfs(runner, &root, &lfs_tracked_paths)?;
        }
        LargeFileDecision::Prompt
        | LargeFileDecision::TrackWithLfs
        | LargeFileDecision::CommitNormally => {}
    }

    let operation_id = commit_operation_id();
    if should_sync_before_commit(runner, &root)? {
        let sync = sync_for_commit(runner, &root, &operation_id)?;
        if let Some(conflict_response) = commit_conflict_response(sync) {
            return Ok(conflict_response);
        }
    }

    let mut add_paths = paths.clone();
    if !lfs_tracked_paths.is_empty() && root.join(".gitattributes").exists() {
        add_paths.push(".gitattributes".to_owned());
        add_paths.sort();
        add_paths.dedup();
    }
    git_add_paths(runner, &root, &add_paths)?;

    match git_commit(runner, &root, &request.message) {
        Ok(()) => {}
        Err(error) if is_gpg_sign_failure(&error) => {
            let (summary, stderr) = git_error_text(&error);
            return Ok(CommitResponse::GpgSignFailed { summary, stderr });
        }
        Err(error) if is_nothing_to_commit(&error) => {
            return Ok(CommitResponse::NothingToCommit);
        }
        Err(error) => return Err(error),
    }

    let oid = git_stdout(runner, Some(&root), ["rev-parse", "HEAD"], OPERATION)?
        .trim()
        .to_owned();
    if request.push_immediately && repository_has_origin(runner, &root)? {
        let sync = sync_for_commit(runner, &root, &operation_id)?;
        if let Some(conflict_response) = commit_conflict_response(sync) {
            return Ok(conflict_response);
        }
    }

    Ok(CommitResponse::Committed {
        oid,
        committed_paths: paths,
        lfs_tracked_paths,
    })
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

fn commit_conflict_response(sync: SyncCurrentBranchResponse) -> Option<CommitResponse> {
    sync.conflict.map(|conflict| CommitResponse::Conflicts {
        conflict,
        recovery: sync.stash_recovery,
    })
}

fn commit_operation_id() -> OperationId {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    OperationId(format!("commit-changes-{millis}"))
}

fn large_files_without_lfs(
    runner: &GitRunner,
    root: &Path,
    paths: &[String],
    threshold: u64,
) -> AppResult<Vec<LargeFileWarning>> {
    let mut warnings = Vec::new();
    for path in paths {
        let absolute = root.join(path);
        let Ok(metadata) = fs::metadata(&absolute) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() < threshold || is_lfs_covered(runner, root, path)?
        {
            continue;
        }

        warnings.push(LargeFileWarning {
            path: path.clone(),
            size_bytes: metadata.len().to_string(),
        });
    }

    Ok(warnings)
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

fn track_large_files_with_lfs(runner: &GitRunner, root: &Path, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }

    run_git_lfs(runner, Some(root), ["install", "--local"], OPERATION)?;

    let mut args = vec![OsString::from("track"), OsString::from("--filename")];
    args.push(OsString::from("--"));
    args.extend(paths.iter().map(OsString::from));
    run_git_lfs(runner, Some(root), args, OPERATION).map(|_| ())
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
