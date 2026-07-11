use crate::git_ops::{display_path, git_stdout};
use artistic_git_contracts::{
    CloneRepositoryRequest, CommitRequest, CommitResponse, ConflictCompleteRequest,
    ConflictSaveResolutionRequest, LargeFileDecision, OpenRepositoryRequest, OperationId,
    RepositoryRemoteMode, RevertCommitRequest, RevertCommitResponse, SyncCurrentBranchRequest,
    SyncCurrentBranchStatus, ToolGitIdentity,
};
use artistic_git_git_runner::{GitDistribution, GitRunner};
use artistic_git_test_support::{require_git_dist, TestTempDir};
use std::{ffi::OsString, fs, io::Write, path::PathBuf};

#[test]
fn backend_full_chain_uses_real_temporary_remote_from_clone_to_revert() {
    let (runner, _home) = real_runner();
    let fixture = FullChainFixture::new(&runner);

    let local = fixture.clone_with_app("local");
    let opened = crate::open_repository(
        &runner,
        None,
        OpenRepositoryRequest {
            path: display_path(&local.path),
            tool_identity: Some(tool_identity()),
        },
    )
    .expect("open cloned repository");
    assert_eq!(opened.remote_mode, RepositoryRemoteMode::Origin);
    assert_eq!(opened.summary.current_branch.as_deref(), Some("main"));

    let local_add_oid = commit_path_with_app(
        &runner,
        &local,
        "local.txt",
        "local\n",
        "add local file",
        true,
    );
    assert_eq!(
        fixture
            .remote
            .git_output(["show", "refs/heads/main:local.txt"]),
        "local\n"
    );

    let peer = fixture.clone_with_app("peer");
    commit_path_with_app(
        &runner,
        &peer,
        "peer.txt",
        "peer\n",
        "peer pushes file",
        true,
    );

    let pulled = crate::sync_current_branch(
        &runner,
        SyncCurrentBranchRequest {
            repository_path: display_path(&local.path),
            operation_id: Some(OperationId("phase-12-full-chain-pull".to_owned())),
        },
    )
    .expect("sync peer push");
    assert_eq!(pulled.status, SyncCurrentBranchStatus::Pulled);
    assert_eq!(local.read("peer.txt"), "peer\n");
    assert_clean(&local);

    commit_path_with_app(
        &runner,
        &local,
        "tracked.txt",
        "local conflicting edit\n",
        "local conflicting edit",
        false,
    );
    commit_path_with_app(
        &runner,
        &peer,
        "tracked.txt",
        "peer conflicting edit\n",
        "peer conflicting edit",
        true,
    );

    let conflict_operation_id = OperationId("phase-12-full-chain-conflict".to_owned());
    let conflicted = crate::sync_current_branch(
        &runner,
        SyncCurrentBranchRequest {
            repository_path: display_path(&local.path),
            operation_id: Some(conflict_operation_id.clone()),
        },
    )
    .expect("sync conflict response");
    assert_eq!(conflicted.status, SyncCurrentBranchStatus::Conflicts);
    let conflict = conflicted.conflict.expect("conflict payload");
    assert_eq!(conflict.operation_id, conflict_operation_id);
    assert_eq!(conflict.operation_name, "syncCurrentBranch");
    assert!(conflict.files.iter().any(|file| file.path == "tracked.txt"));
    assert!(local
        .git_output(["status", "--porcelain=v1"])
        .contains("UU tracked.txt"));

    crate::conflicts::save_conflict_resolution(
        &runner,
        ConflictSaveResolutionRequest {
            repository_path: conflict.repository_path.clone(),
            path: "tracked.txt".to_owned(),
            content: "resolved full chain\n".to_owned(),
            pending_hunks: 0,
        },
    )
    .expect("save conflict resolution");
    crate::conflicts::complete_conflict_resolution(
        &runner,
        ConflictCompleteRequest {
            repository_path: conflict.repository_path,
            operation_id: OperationId("phase-12-full-chain-conflict".to_owned()),
            paths: vec!["tracked.txt".to_owned()],
        },
    )
    .expect("complete conflict resolution");
    assert_eq!(local.read("tracked.txt"), "resolved full chain\n");
    assert_clean(&local);

    let pushed_resolution = crate::sync_current_branch(
        &runner,
        SyncCurrentBranchRequest {
            repository_path: display_path(&local.path),
            operation_id: Some(OperationId(
                "phase-12-full-chain-push-resolution".to_owned(),
            )),
        },
    )
    .expect("push resolved conflict");
    assert!(matches!(
        pushed_resolution.status,
        SyncCurrentBranchStatus::Pushed | SyncCurrentBranchStatus::AlreadyUpToDate
    ));
    peer.git(["pull", "--ff-only"]);
    assert_eq!(peer.read("tracked.txt"), "resolved full chain\n");

    let reverted = crate::revert_commit(
        &runner,
        RevertCommitRequest {
            repository_path: display_path(&local.path),
            oid: local_add_oid,
            push_after_revert: true,
            operation_id: None,
        },
    )
    .expect("revert and push");
    match reverted {
        RevertCommitResponse::Reverted {
            message, pushed, ..
        } => {
            assert_eq!(message, "Revert: add local file");
            assert!(pushed);
        }
        other => panic!("unexpected revert response: {other:?}"),
    }

    peer.git(["pull", "--ff-only"]);
    assert!(!peer.path.join("local.txt").exists());
    assert_eq!(peer.read("peer.txt"), "peer\n");
    assert_eq!(peer.read("tracked.txt"), "resolved full chain\n");
    assert_clean(&local);
}

struct FullChainFixture {
    runner: GitRunner,
    parent: TestTempDir,
    remote: TestRepo,
}

impl FullChainFixture {
    fn new(runner: &GitRunner) -> Self {
        let parent = TestTempDir::new("ag-phase-12-full-chain").expect("full chain parent");
        let remote = TestRepo::at(runner, parent.path().join("remote.git"));
        git_stdout(
            runner,
            None,
            [
                OsString::from("init"),
                OsString::from("--bare"),
                OsString::from("-b"),
                OsString::from("main"),
                remote.path.as_os_str().to_owned(),
            ],
            "phase12FullChainTest",
        )
        .expect("init bare remote");

        let seed = TestRepo::at(runner, parent.path().join("seed"));
        git_stdout(
            runner,
            None,
            [
                OsString::from("init"),
                OsString::from("-b"),
                OsString::from("main"),
                seed.path.as_os_str().to_owned(),
            ],
            "phase12FullChainTest",
        )
        .expect("init seed repository");
        seed.configure_identity();
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

        Self {
            runner: runner.clone(),
            parent,
            remote,
        }
    }

    fn clone_with_app(&self, directory_name: &str) -> TestRepo {
        let response = crate::clone_repository(
            &self.runner,
            None,
            CloneRepositoryRequest {
                url: display_path(&self.remote.path),
                target_parent_directory: display_path(self.parent.path()),
                directory_name: directory_name.to_owned(),
                tool_identity: Some(tool_identity()),
                operation_id: Some(OperationId(format!(
                    "phase-12-full-chain-clone-{directory_name}"
                ))),
            },
        )
        .expect("clone repository");
        assert_eq!(
            response.repository.remote_mode,
            RepositoryRemoteMode::Origin
        );
        assert_eq!(
            response.repository.summary.current_branch.as_deref(),
            Some("main")
        );

        let repo = TestRepo::at(&self.runner, self.parent.path().join(directory_name));
        assert!(repo.path.join(".git").exists());
        repo
    }
}

struct TestRepo {
    runner: GitRunner,
    path: PathBuf,
}

impl TestRepo {
    fn at(runner: &GitRunner, path: PathBuf) -> Self {
        Self {
            runner: runner.clone(),
            path,
        }
    }

    fn configure_identity(&self) {
        self.git(["config", "user.name", "Test User"]);
        self.git(["config", "user.email", "test@example.test"]);
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
        git_stdout(&self.runner, Some(&self.path), args, "phase12FullChainTest")
            .expect("git command")
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir");
        }
        let mut file = fs::File::create(path).expect("create file");
        file.write_all(content.as_bytes()).expect("write file");
    }

    fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.path.join(relative)).expect("read file")
    }
}

fn commit_path_with_app(
    runner: &GitRunner,
    repo: &TestRepo,
    relative_path: &str,
    content: &str,
    message: &str,
    push_immediately: bool,
) -> String {
    repo.write(relative_path, content);
    let response = crate::commit_changes(
        runner,
        CommitRequest {
            repository_path: display_path(&repo.path),
            paths: vec![relative_path.to_owned()],
            message: message.to_owned(),
            large_file_threshold_mb: None,
            large_file_decision: LargeFileDecision::Prompt,
            disable_repository_gpgsign: false,
            push_immediately,
            operation_id: None,
        },
    )
    .expect("commit changes");

    match response {
        CommitResponse::Committed {
            oid,
            committed_paths,
            ..
        } => {
            assert_eq!(committed_paths, vec![relative_path.to_owned()]);
            oid
        }
        other => panic!("unexpected commit response: {other:?}"),
    }
}

fn assert_clean(repo: &TestRepo) {
    let status = repo.git_output(["status", "--porcelain=v1"]);
    assert!(status.trim().is_empty(), "repository is dirty:\n{status}");
}

fn tool_identity() -> ToolGitIdentity {
    ToolGitIdentity {
        name: Some("Artistic Git Test".to_owned()),
        email: Some("artistic-git-test@example.test".to_owned()),
    }
}

fn real_runner() -> (GitRunner, TestTempDir) {
    let dist = require_git_dist().expect("load embedded git distribution");
    let distribution =
        GitDistribution::from_manifest(dist.root, dist.manifest).expect("git distribution");
    let temp = TestTempDir::new("ag-phase-12-runner-home").expect("runner home");
    let home = temp.path().join("home");
    fs::create_dir_all(&home).expect("create runner home");
    let runner = GitRunner::from_distribution(distribution, home);
    (runner, temp)
}
