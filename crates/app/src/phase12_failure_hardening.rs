use crate::git_ops::{display_path, git_stdout};
use artistic_git_contracts::{
    AbortRevertRequest, CommitRequest, CommitResponse, LargeFileDecision, OperationId,
    RevertCommitRequest, RevertCommitResponse, SyncCurrentBranchRequest,
};
use artistic_git_git_runner::{GitDistribution, GitRunner};
use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
use std::{ffi::OsString, fs, io::Write, path::PathBuf};

#[test]
fn phase12_sync_local_phase_failure_restores_pre_operation_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-sync-failure");
    let before = RepoSnapshot::capture(&fixture.local);
    let gitlink_oid = fixture.peer.git_output(["rev-parse", "HEAD"]);

    fixture.peer.write(
        ".gitmodules",
        "[submodule \"broken\"]\n\tpath = broken\n\turl = /definitely/missing/artistic-git-submodule.git\n",
    );
    fixture.peer.git(["add", ".gitmodules"]);
    fixture.peer.git([
        OsString::from("update-index"),
        OsString::from("--add"),
        OsString::from("--cacheinfo"),
        OsString::from(format!("160000,{},broken", gitlink_oid.trim())),
    ]);
    fixture
        .peer
        .git(["commit", "-m", "inject broken submodule"]);
    fixture.peer.git(["push"]);

    crate::sync_current_branch(
        &runner,
        SyncCurrentBranchRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId("phase12-sync-local-failure".to_owned())),
        },
    )
    .expect_err("broken submodule should fail during local sync phase");

    before.assert_restored(&fixture.local);
    assert_repository_reusable(&fixture.local);
}

#[test]
fn phase12_commit_gpg_failure_restores_index_and_head() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let repo = TestRepo::new(&runner, "ag-phase12-commit-failure");
    repo.init_with_commit();
    repo.git(["config", "commit.gpgsign", "true"]);
    repo.git([
        "config",
        "gpg.program",
        "/definitely/missing/artistic-git-gpg",
    ]);
    repo.write("tracked.txt", "draft that should survive\n");
    let before = RepoSnapshot::capture(&repo);

    let response = crate::commit_changes(
        &runner,
        CommitRequest {
            repository_path: display_path(&repo.path),
            paths: vec!["tracked.txt".to_owned()],
            message: "signed commit should fail".to_owned(),
            large_file_threshold_mb: None,
            large_file_decision: LargeFileDecision::Prompt,
            disable_repository_gpgsign: false,
            push_immediately: false,
        },
    )
    .expect("gpg failure is an expected commit response");

    assert!(matches!(response, CommitResponse::GpgSignFailed { .. }));
    before.assert_restored(&repo);
    assert_repository_reusable(&repo);
}

#[test]
fn phase12_revert_conflict_abort_restores_pre_operation_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let repo = TestRepo::new(&runner, "ag-phase12-revert-failure");
    repo.init_with_commit();
    repo.write("tracked.txt", "target\n");
    repo.git(["add", "tracked.txt"]);
    repo.git(["commit", "-m", "target line"]);
    let target = repo.git_output(["rev-parse", "HEAD"]).trim().to_owned();
    repo.write("tracked.txt", "later\n");
    repo.git(["add", "tracked.txt"]);
    repo.git(["commit", "-m", "later line"]);
    let before = RepoSnapshot::capture(&repo);

    let response = crate::revert_commit(
        &runner,
        RevertCommitRequest {
            repository_path: display_path(&repo.path),
            oid: target,
            push_after_revert: false,
        },
    )
    .expect("conflicted revert should return a response");

    assert!(matches!(response, RevertCommitResponse::Conflicted { .. }));
    assert!(repo.read("tracked.txt").contains("<<<<<<<"));

    crate::abort_revert(
        &runner,
        AbortRevertRequest {
            repository_path: display_path(&repo.path),
        },
    )
    .expect("abort conflicted revert");

    before.assert_restored(&repo);
    assert_repository_reusable(&repo);
}

#[derive(Debug)]
struct RepoSnapshot {
    branch: String,
    head: String,
    index_tree: String,
    status: String,
}

impl RepoSnapshot {
    fn capture(repo: &TestRepo) -> Self {
        Self {
            branch: repo.git_output(["branch", "--show-current"]),
            head: repo.git_output(["rev-parse", "HEAD"]),
            index_tree: repo.git_output(["write-tree"]),
            status: repo.git_output(["status", "--porcelain=v1"]),
        }
    }

    fn assert_restored(&self, repo: &TestRepo) {
        assert_eq!(repo.git_output(["branch", "--show-current"]), self.branch);
        assert_eq!(repo.git_output(["rev-parse", "HEAD"]), self.head);
        assert_eq!(repo.git_output(["write-tree"]), self.index_tree);
        assert_eq!(repo.git_output(["status", "--porcelain=v1"]), self.status);
    }
}

struct RemoteFixture {
    local: TestRepo,
    peer: TestRepo,
    _remote: TestRepo,
    _parent: TestTempDir,
}

impl RemoteFixture {
    fn new(runner: &GitRunner, prefix: &str) -> Self {
        let parent = TestTempDir::new(prefix).expect("remote fixture parent");
        let remote_path = parent.path().join("remote.git");
        git_stdout(
            runner,
            None::<&std::path::Path>,
            [
                OsString::from("init"),
                OsString::from("--bare"),
                OsString::from("-b"),
                OsString::from("main"),
                remote_path.as_os_str().to_owned(),
            ],
            "phase12FailureHarness",
        )
        .expect("init bare remote");

        let seed = TestRepo::at(runner, parent.path().join("seed"));
        git_stdout(
            runner,
            None::<&std::path::Path>,
            [
                OsString::from("init"),
                OsString::from("-b"),
                OsString::from("main"),
                seed.path.as_os_str().to_owned(),
            ],
            "phase12FailureHarness",
        )
        .expect("init seed");
        seed.configure_identity();
        seed.write("tracked.txt", "initial\n");
        seed.git(["add", "tracked.txt"]);
        seed.git(["commit", "-m", "initial"]);
        seed.git([
            "remote",
            "add",
            "origin",
            display_path(&remote_path).as_str(),
        ]);
        seed.git(["push", "-u", "origin", "main"]);

        let local = TestRepo::at(runner, parent.path().join("local"));
        git_stdout(
            runner,
            None::<&std::path::Path>,
            [
                OsString::from("clone"),
                remote_path.as_os_str().to_owned(),
                local.path.as_os_str().to_owned(),
            ],
            "phase12FailureHarness",
        )
        .expect("clone local");
        local.configure_identity();

        let peer = TestRepo::at(runner, parent.path().join("peer"));
        git_stdout(
            runner,
            None::<&std::path::Path>,
            [
                OsString::from("clone"),
                remote_path.as_os_str().to_owned(),
                peer.path.as_os_str().to_owned(),
            ],
            "phase12FailureHarness",
        )
        .expect("clone peer");
        peer.configure_identity();

        Self {
            local,
            peer,
            _remote: TestRepo::at(runner, remote_path),
            _parent: parent,
        }
    }
}

struct TestRepo {
    runner: GitRunner,
    path: PathBuf,
    _temp: Option<TestTempDir>,
}

impl TestRepo {
    fn new(runner: &GitRunner, prefix: &str) -> Self {
        let temp = TestTempDir::new(prefix).expect("test repo");
        Self {
            runner: runner.clone(),
            path: temp.path().to_path_buf(),
            _temp: Some(temp),
        }
    }

    fn at(runner: &GitRunner, path: PathBuf) -> Self {
        Self {
            runner: runner.clone(),
            path,
            _temp: None,
        }
    }

    fn init_with_commit(&self) {
        self.git(["init", "-b", "main"]);
        self.configure_identity();
        self.write("tracked.txt", "initial\n");
        self.git(["add", "tracked.txt"]);
        self.git(["commit", "-m", "initial"]);
    }

    fn configure_identity(&self) {
        self.git(["config", "user.name", "Phase 12 Test"]);
        self.git(["config", "user.email", "phase12@example.test"]);
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
        git_stdout(
            &self.runner,
            Some(&self.path),
            args,
            "phase12FailureHarness",
        )
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

fn assert_repository_reusable(repo: &TestRepo) {
    repo.git(["rev-parse", "--verify", "HEAD"]);
    repo.git(["status", "--porcelain=v1"]);
}

fn real_runner_or_skip() -> Option<(GitRunner, TestTempDir)> {
    let dist = match require_git_dist() {
        Ok(dist) => dist,
        Err(GitDistError::MissingEnvironment) => {
            eprintln!("skipping phase 12 failure hardening: ARTISTIC_GIT_DIST_DIR is not set");
            return None;
        }
        Err(error) => panic!("invalid embedded git distribution: {error}"),
    };
    let distribution =
        GitDistribution::from_manifest(dist.root, dist.manifest).expect("git distribution");
    let temp = TestTempDir::new("ag-phase12-failure-home").expect("runner home");
    let home = temp.path().join("home");
    fs::create_dir_all(&home).expect("create runner home");
    let runner = GitRunner::from_distribution(distribution, home);
    Some((runner, temp))
}
