use crate::git_ops::{display_path, git_stdout};
use artistic_git_contracts::{
    AbortRevertRequest, BranchOperationResponse, CancelStashRestoreRequest, CheckoutBranchRequest,
    CheckoutLocalChangesMode, CommitRequest, CommitResponse, LargeFileDecision, OperationId,
    RevertCommitRequest, RevertCommitResponse, ReviewModeExitStatus, ReviewModeRecoveryRequest,
    ReviewModeRequest, StartReviewModeRequest, SyncAllBranchesRequest, SyncBranchRequest,
    SyncCurrentBranchRequest,
};
use artistic_git_core::config::{AutoTrackingRule, ConfigActor, ConfigPaths};
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
            operation_id: None,
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
            operation_id: None,
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

#[test]
fn phase12_sync_non_current_publish_failure_keeps_repository_reusable() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-sync-branch-publish-failure");
    fixture.local.git(["checkout", "-b", "local-only"]);
    fixture.local.write("branch.txt", "branch\n");
    fixture.local.git(["add", "branch.txt"]);
    fixture.local.git(["commit", "-m", "local-only work"]);
    fixture.local.git(["checkout", "main"]);
    fixture.local.git([
        "remote",
        "set-url",
        "origin",
        "/definitely/missing/artistic-git-remote.git",
    ]);
    let before = RepoSnapshot::capture(&fixture.local);

    crate::sync_branch(
        &runner,
        SyncBranchRequest {
            repository_path: display_path(&fixture.local.path),
            branch_name: "local-only".to_owned(),
            operation_id: Some(OperationId("phase12-sync-branch-publish".to_owned())),
        },
    )
    .expect_err("publishing to a missing origin should fail");

    before.assert_restored(&fixture.local);
    assert_repository_reusable(&fixture.local);
}

#[test]
fn phase12_auto_tracking_divergence_restores_local_changes() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-auto-tracking-failure");
    fixture.local.git(["checkout", "-b", "feature"]);
    fixture.local.write("feature.txt", "feature\n");
    fixture.local.git(["add", "feature.txt"]);
    fixture.local.git(["commit", "-m", "feature work"]);
    fixture.local.git(["push", "-u", "origin", "feature"]);
    fixture.local.git(["checkout", "main"]);
    fixture.local.write("main.txt", "main\n");
    fixture.local.git(["add", "main.txt"]);
    fixture.local.git(["commit", "-m", "main work"]);
    fixture.local.git(["push"]);
    fixture.local.git(["checkout", "feature"]);
    fixture.local.write("draft.txt", "draft survives\n");
    let before = RepoSnapshot::capture(&fixture.local);
    let config = phase12_config(&fixture._parent);
    config
        .update_project(display_path(&fixture.local.path), |project| {
            project.auto_tracking_rules = vec![AutoTrackingRule::new("feature", "main")];
        })
        .expect("store auto tracking rule");

    let response = crate::sync_all_branches_with_config(
        &runner,
        Some(&config),
        SyncAllBranchesRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId("phase12-auto-tracking-failure".to_owned())),
        },
        |_| {},
    )
    .expect("auto tracking divergence is reported in-band");

    assert!(response
        .auto_tracking
        .iter()
        .any(|result| result.source_branch == "feature" && result.message.is_some()));
    before.assert_restored(&fixture.local);
    assert_repository_reusable(&fixture.local);
}

#[test]
fn phase12_checkout_auto_stash_conflict_cancel_restores_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let repo = TestRepo::new(&runner, "ag-phase12-checkout-failure");
    repo.init_with_commit();
    repo.git(["checkout", "-b", "other"]);
    repo.write("tracked.txt", "other branch\n");
    repo.git(["add", "tracked.txt"]);
    repo.git(["commit", "-m", "other branch edit"]);
    repo.git(["checkout", "main"]);
    repo.write("tracked.txt", "local draft\n");
    let before = RepoSnapshot::capture(&repo);

    let response = crate::branches::checkout_branch(
        &runner,
        CheckoutBranchRequest {
            repository_path: display_path(&repo.path),
            branch_name: "other".to_owned(),
            local_changes_mode: CheckoutLocalChangesMode::AutoStash,
            operation_id: Some(OperationId("phase12-checkout-conflict".to_owned())),
        },
    )
    .expect("checkout conflict should be reported in-band");
    let BranchOperationResponse::Conflicts {
        stash_recovery: Some(recovery),
        ..
    } = response
    else {
        panic!("expected checkout auto-stash conflict with recovery point");
    };

    crate::cancel_stash_restore(
        &runner,
        CancelStashRestoreRequest {
            repository_path: display_path(&repo.path),
            recovery,
        },
    )
    .expect("cancel checkout stash restore");

    before.assert_restored(&repo);
    assert_repository_reusable(&repo);
}

#[test]
fn phase12_review_exit_stash_conflict_cancel_keeps_review_recovery() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-review-failure");
    let config = phase12_config(&fixture._parent);
    fixture.local.write("tracked.txt", "local review draft\n");
    fixture.peer.write("tracked.txt", "remote review version\n");
    fixture.peer.git(["add", "tracked.txt"]);
    fixture.peer.git(["commit", "-m", "remote review update"]);
    fixture.peer.git(["push"]);

    crate::start_review_mode_with_config(
        &runner,
        Some(&config),
        StartReviewModeRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId("phase12-review-start".to_owned())),
        },
    )
    .expect("start review mode");
    assert_eq!(fixture.local.read("tracked.txt"), "remote review version\n");
    let before_exit = RepoSnapshot::capture(&fixture.local);

    let exit = crate::exit_review_mode_with_config(
        &runner,
        Some(&config),
        ReviewModeRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: None,
        },
    )
    .expect("exit review mode should report restore conflict in-band");

    assert_eq!(exit.status, ReviewModeExitStatus::Conflicts);
    assert!(fixture.local.read("tracked.txt").contains("<<<<<<<"));
    let recovery = exit
        .stash_recovery
        .expect("conflicted review exit exposes stash recovery");

    crate::cancel_stash_restore(
        &runner,
        CancelStashRestoreRequest {
            repository_path: display_path(&fixture.local.path),
            recovery,
        },
    )
    .expect("cancel review stash restore");

    before_exit.assert_restored(&fixture.local);
    let recovery = crate::review_mode_recovery(
        &runner,
        Some(&config),
        ReviewModeRecoveryRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: None,
        },
    )
    .expect("review recovery remains available");
    assert!(recovery.should_prompt);
    assert_eq!(
        recovery
            .auto_stash
            .as_ref()
            .map(|stash| stash.message.as_str()),
        Some("Auto Stash: review mode")
    );
    assert_repository_reusable(&fixture.local);
}

#[test]
fn phase12_submodule_commit_publish_guard_failure_preserves_super_and_submodule() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-submodule-commit-failure");
    let submodule_source = TestRepo::at(&runner, fixture._parent.path().join("submodule-source"));
    git_stdout(
        &runner,
        None::<&std::path::Path>,
        [
            OsString::from("init"),
            OsString::from("-b"),
            OsString::from("main"),
            submodule_source.path.as_os_str().to_owned(),
        ],
        "phase12FailureHarness",
    )
    .expect("init submodule source");
    submodule_source.configure_identity();
    submodule_source.write("nested.txt", "initial\n");
    submodule_source.git(["add", "nested.txt"]);
    submodule_source.git(["commit", "-m", "submodule initial"]);
    fixture.local.git([
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        display_path(&submodule_source.path).as_str(),
        "module",
    ]);
    fixture.local.git(["commit", "-am", "add submodule"]);
    fixture.local.git(["push"]);

    let submodule = TestRepo::at(&runner, fixture.local.path.join("module"));
    submodule.git(["remote", "remove", "origin"]);
    submodule.write("nested.txt", "submodule draft\n");
    let before_super = RepoSnapshot::capture(&fixture.local);
    let before_submodule = RepoSnapshot::capture(&submodule);

    crate::commit_changes(
        &runner,
        CommitRequest {
            repository_path: display_path(&fixture.local.path),
            paths: vec!["module/nested.txt".to_owned()],
            message: "submodule publish guard should fail".to_owned(),
            large_file_threshold_mb: None,
            large_file_decision: LargeFileDecision::Prompt,
            disable_repository_gpgsign: false,
            push_immediately: true,
            operation_id: None,
        },
    )
    .expect_err("submodule without origin cannot be pushable");

    before_super.assert_restored(&fixture.local);
    before_submodule.assert_restored(&submodule);
    assert_repository_reusable(&fixture.local);
    assert_repository_reusable(&submodule);
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

fn phase12_config(parent: &TestTempDir) -> ConfigActor {
    let config_dir = parent.path().join("config");
    fs::create_dir_all(&config_dir).expect("create config dir");
    ConfigActor::load(ConfigPaths::new(
        config_dir.join("settings.json"),
        config_dir.join("projects.json"),
    ))
    .expect("load phase12 config")
}
