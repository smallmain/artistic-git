use crate::git_ops::{display_path, git_stdout};
use artistic_git_contracts::{
    AbortRevertRequest, AutoTrackingRuleStatus, BranchOperationResponse, CancelStashRestoreRequest,
    CheckoutBranchRequest, CheckoutLocalChangesMode, CommitRequest, CommitResponse,
    ConflictCancelRequest, LargeFileDecision, OperationId, RevertCommitRequest,
    RevertCommitResponse, ReviewModeExitStatus, ReviewModePullStatus, ReviewModeRecoveryRequest,
    ReviewModeRequest, StartReviewModeRequest, SyncAllBranchesRequest, SyncBranchRequest,
    SyncCurrentBranchRequest, SyncCurrentBranchStatus,
};
use artistic_git_core::config::{AutoTrackingRule, ConfigActor, ConfigPaths};
use artistic_git_git_runner::{GitDistribution, GitRunner};
use artistic_git_test_support::{require_git_dist, GitDistError, TestTempDir};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

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
fn phase12_sync_fetch_network_failure_keeps_pre_operation_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-sync-fetch-failure");
    fixture.local.git([
        "remote",
        "set-url",
        "origin",
        "/definitely/missing/artistic-git-remote.git",
    ]);
    let before = RepoSnapshot::capture(&fixture.local);

    crate::sync_current_branch(
        &runner,
        SyncCurrentBranchRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId("phase12-sync-fetch-failure".to_owned())),
        },
    )
    .expect_err("fetching a missing origin should fail before local state changes");

    before.assert_restored(&fixture.local);
    assert_repository_reusable(&fixture.local);
}

#[test]
fn phase12_sync_rebase_conflict_cancel_restores_pre_operation_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-sync-rebase-conflict");
    fixture.local.write("tracked.txt", "local committed\n");
    fixture.local.git(["add", "tracked.txt"]);
    fixture
        .local
        .git(["commit", "-m", "local divergent change"]);
    fixture.peer.write("tracked.txt", "remote committed\n");
    fixture.peer.git(["add", "tracked.txt"]);
    fixture
        .peer
        .git(["commit", "-m", "remote divergent change"]);
    fixture.peer.git(["push"]);
    let before = RepoSnapshot::capture(&fixture.local);

    let response = crate::sync_current_branch(
        &runner,
        SyncCurrentBranchRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId("phase12-sync-rebase-conflict".to_owned())),
        },
    )
    .expect("rebase conflict should be reported in-band");

    assert_eq!(response.status, SyncCurrentBranchStatus::Conflicts);
    let conflict = response.conflict.expect("conflict payload");
    assert!(conflict.files.iter().any(|file| file.path == "tracked.txt"));

    crate::conflicts::cancel_conflict_resolution(
        &runner,
        ConflictCancelRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: OperationId("phase12-sync-rebase-conflict".to_owned()),
        },
    )
    .expect("cancel conflicted sync rebase");

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
fn phase12_commit_pre_sync_failure_restores_selected_and_unselected_changes() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-commit-pre-sync-failure");
    fixture.local.write("selected.txt", "selected draft\n");
    fixture.local.write("unselected.txt", "unselected draft\n");
    fixture.local.git([
        "remote",
        "set-url",
        "origin",
        "/definitely/missing/artistic-git-remote.git",
    ]);
    let before = RepoSnapshot::capture(&fixture.local);

    crate::commit_changes(
        &runner,
        CommitRequest {
            repository_path: display_path(&fixture.local.path),
            paths: vec!["selected.txt".to_owned()],
            message: "pre sync should fail".to_owned(),
            large_file_threshold_mb: None,
            large_file_decision: LargeFileDecision::Prompt,
            disable_repository_gpgsign: false,
            push_immediately: false,
            operation_id: Some(OperationId("phase12-commit-pre-sync-failure".to_owned())),
        },
    )
    .expect_err("missing origin should fail before local commit");

    before.assert_restored(&fixture.local);
    assert_eq!(fixture.local.read("selected.txt"), "selected draft\n");
    assert_eq!(fixture.local.read("unselected.txt"), "unselected draft\n");
    assert_repository_reusable(&fixture.local);
}

#[test]
fn phase12_commit_push_failure_keeps_local_commit_forward_safe() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-commit-push-failure");
    fixture.local.write("selected.txt", "selected commit\n");
    fixture
        .local
        .install_failing_push_hook("intentional phase12 commit push failure");
    let before_head = fixture.local.git_output(["rev-parse", "HEAD"]);

    let error = crate::commit_changes(
        &runner,
        CommitRequest {
            repository_path: display_path(&fixture.local.path),
            paths: vec!["selected.txt".to_owned()],
            message: "commit survives push failure".to_owned(),
            large_file_threshold_mb: None,
            large_file_decision: LargeFileDecision::Prompt,
            disable_repository_gpgsign: false,
            push_immediately: true,
            operation_id: Some(OperationId("phase12-commit-push-failure".to_owned())),
        },
    )
    .expect_err("failing pre-push hook should fail after the local commit");

    assert!(
        error.summary.contains("本地提交已保留为未推送状态"),
        "{}",
        error.summary
    );
    assert_ne!(fixture.local.git_output(["rev-parse", "HEAD"]), before_head);
    assert_eq!(
        fixture
            .local
            .git_output(["log", "-1", "--format=%s"])
            .trim(),
        "commit survives push failure"
    );
    assert_eq!(ahead_behind(&fixture.local), (1, 0));
    assert_eq!(
        fixture
            ._remote
            .git_output(["show", "refs/heads/main:tracked.txt"]),
        "initial\n"
    );
    assert_repository_clean_and_reusable(&fixture.local);
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
fn phase12_revert_push_failure_keeps_revert_commit_forward_safe() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-revert-push-failure");
    fixture.local.write("target.txt", "target\n");
    fixture.local.git(["add", "target.txt"]);
    fixture.local.git(["commit", "-m", "target commit"]);
    let target = fixture
        .local
        .git_output(["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    fixture.local.write("later.txt", "later\n");
    fixture.local.git(["add", "later.txt"]);
    fixture.local.git(["commit", "-m", "later commit"]);
    fixture.local.git(["push"]);
    fixture
        .local
        .install_failing_push_hook("intentional phase12 revert push failure");

    crate::revert_commit(
        &runner,
        RevertCommitRequest {
            repository_path: display_path(&fixture.local.path),
            oid: target,
            push_after_revert: true,
            operation_id: Some(OperationId("phase12-revert-push-failure".to_owned())),
        },
    )
    .expect_err("failing pre-push hook should fail after creating the revert commit");

    assert_eq!(
        fixture
            .local
            .git_output(["log", "-1", "--format=%s"])
            .trim(),
        "Revert: target commit"
    );
    assert_eq!(ahead_behind(&fixture.local), (1, 0));
    assert!(!fixture.local.path.join("target.txt").exists());
    assert_eq!(
        fixture
            ._remote
            .git_output(["show", "refs/heads/main:target.txt"]),
        "target\n"
    );
    assert_repository_clean_and_reusable(&fixture.local);
}

#[test]
fn phase12_revert_pre_sync_failure_restores_pre_operation_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-revert-pre-sync-failure");
    fixture.local.write("target.txt", "target\n");
    fixture.local.git(["add", "target.txt"]);
    fixture.local.git(["commit", "-m", "target commit"]);
    let target = fixture
        .local
        .git_output(["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    fixture.local.write("later.txt", "later\n");
    fixture.local.git(["add", "later.txt"]);
    fixture.local.git(["commit", "-m", "later commit"]);
    fixture.local.git([
        "remote",
        "set-url",
        "origin",
        "/definitely/missing/artistic-git-remote.git",
    ]);
    let before = RepoSnapshot::capture(&fixture.local);

    crate::revert_commit(
        &runner,
        RevertCommitRequest {
            repository_path: display_path(&fixture.local.path),
            oid: target,
            push_after_revert: false,
            operation_id: Some(OperationId("phase12-revert-pre-sync-failure".to_owned())),
        },
    )
    .expect_err("pre-revert sync should fail before revert starts");

    before.assert_restored(&fixture.local);
    assert_repository_reusable(&fixture.local);
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
fn phase12_sync_non_current_worktree_rebase_conflict_cancel_restores_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-sync-branch-conflict");
    fixture.create_tracking_branch("feature/cancel-conflict");
    fixture.local.git(["checkout", "feature/cancel-conflict"]);
    fixture.local.write("tracked.txt", "local committed\n");
    fixture.local.git(["add", "tracked.txt"]);
    fixture.local.git(["commit", "-m", "local feature change"]);
    let feature_head = fixture
        .local
        .git_output(["rev-parse", "feature/cancel-conflict"]);
    fixture.local.git(["checkout", "main"]);
    fixture.peer.write("tracked.txt", "remote committed\n");
    fixture.peer.git(["add", "tracked.txt"]);
    fixture.peer.git(["commit", "-m", "remote feature change"]);
    fixture.peer.git(["push"]);
    let before = RepoSnapshot::capture(&fixture.local);

    let response = crate::sync_branch(
        &runner,
        SyncBranchRequest {
            repository_path: display_path(&fixture.local.path),
            branch_name: "feature/cancel-conflict".to_owned(),
            operation_id: Some(OperationId("phase12-sync-branch-conflict".to_owned())),
        },
    )
    .expect("non-current branch rebase conflict should be reported in-band");

    assert_eq!(response.status, SyncCurrentBranchStatus::Conflicts);
    let conflict = response.conflict.expect("conflict payload");
    let conflict_worktree = PathBuf::from(&conflict.repository_path);
    assert!(conflict_worktree.exists());
    assert!(conflict.files.iter().any(|file| file.path == "tracked.txt"));

    crate::conflicts::cancel_conflict_resolution(
        &runner,
        ConflictCancelRequest {
            repository_path: display_path(&conflict_worktree),
            operation_id: OperationId("phase12-sync-branch-conflict".to_owned()),
        },
    )
    .expect("cancel non-current branch rebase conflict");

    assert!(!conflict_worktree.exists());
    assert_eq!(
        fixture
            .local
            .git_output(["rev-parse", "feature/cancel-conflict"]),
        feature_head
    );
    before.assert_restored(&fixture.local);
    assert_no_sync_worktrees(&fixture.local);
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
fn phase12_auto_tracking_source_fetch_failure_keeps_pre_operation_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-auto-source-fetch-failure");
    fixture.create_tracking_branch("stable");
    fixture.create_tracking_branch("release");
    fixture.delete_remote_branch_leave_stale_tracking_ref("stable");
    let before = RepoSnapshot::capture(&fixture.local);
    let config = phase12_config(&fixture._parent);
    config
        .update_project(display_path(&fixture.local.path), |project| {
            project.auto_tracking_rules = vec![AutoTrackingRule::new("stable", "release")];
        })
        .expect("store auto tracking rule");

    let response = crate::sync_all_branches_with_config(
        &runner,
        Some(&config),
        SyncAllBranchesRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId("phase12-auto-source-fetch-failure".to_owned())),
        },
        |_| {},
    )
    .expect("auto tracking source fetch failure should be reported in-band");

    let result = response
        .auto_tracking
        .iter()
        .find(|result| result.source_branch == "stable" && result.target_branch == "release")
        .expect("auto tracking result for stable -> release");
    assert_eq!(result.status, AutoTrackingRuleStatus::Failed);
    assert!(result.message.is_some());
    before.assert_restored(&fixture.local);
    assert_repository_reusable(&fixture.local);
}

#[test]
fn phase12_auto_tracking_target_fetch_failure_keeps_pre_operation_snapshot() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-auto-target-fetch-failure");
    fixture.create_tracking_branch("stable");
    fixture.create_tracking_branch("release");
    fixture.delete_remote_branch_leave_stale_tracking_ref("release");
    let before = RepoSnapshot::capture(&fixture.local);
    let config = phase12_config(&fixture._parent);
    config
        .update_project(display_path(&fixture.local.path), |project| {
            project.auto_tracking_rules = vec![AutoTrackingRule::new("stable", "release")];
        })
        .expect("store auto tracking rule");

    let response = crate::sync_all_branches_with_config(
        &runner,
        Some(&config),
        SyncAllBranchesRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId("phase12-auto-target-fetch-failure".to_owned())),
        },
        |_| {},
    )
    .expect("auto tracking target fetch failure should be reported in-band");

    let result = response
        .auto_tracking
        .iter()
        .find(|result| result.source_branch == "stable" && result.target_branch == "release")
        .expect("auto tracking result for stable -> release");
    assert_eq!(result.status, AutoTrackingRuleStatus::Failed);
    assert!(result.message.is_some());
    before.assert_restored(&fixture.local);
    assert_repository_reusable(&fixture.local);
}

#[test]
fn phase12_auto_tracking_post_merge_push_failure_keeps_forward_safe_source() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-auto-post-merge-push-failure");
    fixture.local.git(["checkout", "-b", "stable"]);
    fixture.local.git(["push", "-u", "origin", "stable"]);
    fixture.local.git(["checkout", "main"]);
    fixture.local.write("target.txt", "target branch update\n");
    fixture.local.git(["add", "target.txt"]);
    fixture.local.git(["commit", "-m", "target branch update"]);
    fixture.local.git(["push"]);
    fixture.local.git(["checkout", "stable"]);
    fixture
        .local
        .write("draft.txt", "dirty draft survives push failure\n");
    fixture
        .local
        .install_failing_push_hook("intentional phase12 auto tracking push failure");
    let before_head = fixture.local.git_output(["rev-parse", "HEAD"]);
    let before_remote_source = fixture
        ._remote
        .git_output(["rev-parse", "refs/heads/stable"]);
    let config = phase12_config(&fixture._parent);
    config
        .update_project(display_path(&fixture.local.path), |project| {
            project.auto_tracking_rules = vec![AutoTrackingRule::new("stable", "main")];
        })
        .expect("store auto tracking rule");

    let response = crate::sync_all_branches_with_config(
        &runner,
        Some(&config),
        SyncAllBranchesRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId(
                "phase12-auto-post-merge-push-failure".to_owned(),
            )),
        },
        |_| {},
    )
    .expect("auto tracking push failure should be reported in-band");

    let result = response
        .auto_tracking
        .iter()
        .find(|result| result.source_branch == "stable" && result.target_branch == "main")
        .expect("auto tracking result for stable -> main");
    assert_eq!(result.status, AutoTrackingRuleStatus::Failed);
    assert_ne!(fixture.local.git_output(["rev-parse", "HEAD"]), before_head);
    assert_eq!(fixture.local.read("target.txt"), "target branch update\n");
    assert_eq!(
        fixture.local.read("draft.txt"),
        "dirty draft survives push failure\n"
    );
    assert_eq!(ahead_behind(&fixture.local), (1, 0));
    assert_eq!(
        fixture
            ._remote
            .git_output(["rev-parse", "refs/heads/stable"]),
        before_remote_source
    );
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
fn phase12_review_pull_offline_degrades_with_recovery_stash() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-review-offline");
    let config = phase12_config(&fixture._parent);
    fixture
        .local
        .write("draft.txt", "review draft survives offline\n");
    fixture.local.git([
        "remote",
        "set-url",
        "origin",
        "/definitely/missing/artistic-git-remote.git",
    ]);

    let start = crate::start_review_mode_with_config(
        &runner,
        Some(&config),
        StartReviewModeRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: Some(OperationId("phase12-review-offline".to_owned())),
        },
    )
    .expect("offline pull should degrade into review mode state");

    assert_eq!(start.state.pull_status, ReviewModePullStatus::Offline);
    assert!(start.state.pull_message.is_some());
    assert_eq!(
        start
            .state
            .auto_stash
            .as_ref()
            .map(|stash| stash.message.as_str()),
        Some("Auto Stash: review mode")
    );
    let recovery = crate::review_mode_recovery(
        &runner,
        Some(&config),
        ReviewModeRecoveryRequest {
            repository_path: display_path(&fixture.local.path),
            operation_id: None,
        },
    )
    .expect("review recovery remains available after offline pull");
    assert!(recovery.should_prompt);
    assert_repository_clean_and_reusable(&fixture.local);
}

#[test]
fn phase12_submodule_commit_publish_guard_failure_preserves_super_and_submodule() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-submodule-commit-failure");
    let submodule = add_local_submodule(&runner, &fixture, "module");
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

#[test]
fn phase12_submodule_superproject_pointer_commit_failure_restores_chain() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-submodule-superproject-commit-failure");
    let submodule = add_local_submodule(&runner, &fixture, "module");
    fixture.local.git(["config", "commit.gpgsign", "true"]);
    fixture.local.git([
        "config",
        "gpg.program",
        "/definitely/missing/artistic-git-superproject-gpg",
    ]);
    submodule.write("nested.txt", "submodule draft\n");
    let before_super = RepoSnapshot::capture(&fixture.local);
    let before_submodule = RepoSnapshot::capture(&submodule);

    let response = crate::commit_changes(
        &runner,
        CommitRequest {
            repository_path: display_path(&fixture.local.path),
            paths: vec!["module/nested.txt".to_owned()],
            message: "superproject pointer commit should fail".to_owned(),
            large_file_threshold_mb: None,
            large_file_decision: LargeFileDecision::Prompt,
            disable_repository_gpgsign: false,
            push_immediately: false,
            operation_id: None,
        },
    )
    .expect("superproject gpg failure is an expected commit response");

    assert!(matches!(response, CommitResponse::GpgSignFailed { .. }));
    before_super.assert_restored(&fixture.local);
    before_submodule.assert_restored(&submodule);
    assert_repository_reusable(&fixture.local);
    assert_repository_reusable(&submodule);
}

#[test]
fn phase12_submodule_partial_publish_boundary_keeps_forward_safe_pointer_commit() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-submodule-partial-publish");
    let (submodule, submodule_remote) = add_bare_submodule(&runner, &fixture, "module");
    let before_remote_pointer =
        fixture
            ._remote
            .git_output(["ls-tree", "refs/heads/main", "module"]);
    submodule.write(
        "nested.txt",
        "submodule published before superproject push\n",
    );
    fixture
        .local
        .install_failing_push_hook("intentional phase12 superproject push failure");

    crate::commit_changes(
        &runner,
        CommitRequest {
            repository_path: display_path(&fixture.local.path),
            paths: vec!["module/nested.txt".to_owned()],
            message: "submodule partial publish boundary".to_owned(),
            large_file_threshold_mb: None,
            large_file_decision: LargeFileDecision::Prompt,
            disable_repository_gpgsign: false,
            push_immediately: true,
            operation_id: Some(OperationId("phase12-submodule-partial-publish".to_owned())),
        },
    )
    .expect_err("superproject pre-push hook should fail after submodule publish");

    assert_eq!(
        submodule_remote.git_output(["show", "refs/heads/main:nested.txt"]),
        "submodule published before superproject push\n"
    );
    assert_eq!(ahead_behind(&submodule), (0, 0));
    assert_eq!(ahead_behind(&fixture.local), (1, 0));
    assert_eq!(
        fixture
            .local
            .git_output(["log", "-1", "--format=%s"])
            .trim(),
        "submodule partial publish boundary"
    );
    assert_ne!(
        fixture.local.git_output(["ls-tree", "HEAD", "module"]),
        before_remote_pointer
    );
    assert_eq!(
        fixture
            ._remote
            .git_output(["ls-tree", "refs/heads/main", "module"]),
        before_remote_pointer
    );
    assert_repository_clean_and_reusable(&submodule);
    assert_repository_clean_and_reusable(&fixture.local);
}

#[test]
fn phase12_submodule_nested_commit_failure_restores_super_and_submodule() {
    let Some((runner, _home)) = real_runner_or_skip() else {
        return;
    };
    let fixture = RemoteFixture::new(&runner, "ag-phase12-submodule-nested-commit-failure");
    let submodule = add_local_submodule(&runner, &fixture, "module");
    submodule.git(["config", "commit.gpgsign", "true"]);
    submodule.git([
        "config",
        "gpg.program",
        "/definitely/missing/artistic-git-submodule-gpg",
    ]);
    submodule.write("nested.txt", "submodule draft\n");
    let before_super = RepoSnapshot::capture(&fixture.local);
    let before_submodule = RepoSnapshot::capture(&submodule);

    let response = crate::commit_changes(
        &runner,
        CommitRequest {
            repository_path: display_path(&fixture.local.path),
            paths: vec!["module/nested.txt".to_owned()],
            message: "nested submodule commit should fail".to_owned(),
            large_file_threshold_mb: None,
            large_file_decision: LargeFileDecision::Prompt,
            disable_repository_gpgsign: false,
            push_immediately: false,
            operation_id: None,
        },
    )
    .expect("nested submodule gpg failure is an expected commit response");

    assert!(matches!(response, CommitResponse::GpgSignFailed { .. }));
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

    fn create_tracking_branch(&self, branch_name: &str) {
        self.local.git(["checkout", "-b", branch_name]);
        self.local.write("branch.txt", "branch\n");
        self.local.git(["add", "branch.txt"]);
        self.local.git(["commit", "-m", "create feature branch"]);
        self.local.git(["push", "-u", "origin", branch_name]);
        self.local.git(["checkout", "main"]);
        self.peer.git(["fetch", "origin"]);
        self.peer.git(["checkout", "main"]);
        self.peer.git([
            OsString::from("checkout"),
            OsString::from("-b"),
            OsString::from(branch_name),
            OsString::from(format!("origin/{branch_name}")),
        ]);
    }

    fn delete_remote_branch_leave_stale_tracking_ref(&self, branch_name: &str) {
        let tracking_ref = format!("refs/remotes/origin/{branch_name}");
        let tracking_oid = self.local.git_output(["rev-parse", tracking_ref.as_str()]);
        self.local.git(["push", "origin", "--delete", branch_name]);
        self.local
            .git(["update-ref", tracking_ref.as_str(), tracking_oid.trim()]);
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

    fn write_bytes(&self, relative: &str, content: &[u8]) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir");
        }
        let mut file = fs::File::create(path).expect("create file");
        file.write_all(content).expect("write file");
    }

    fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.path.join(relative)).expect("read file")
    }

    fn git_path(&self, relative: &str) -> PathBuf {
        let path = PathBuf::from(
            self.git_output(["rev-parse", "--git-path", relative])
                .trim(),
        );
        if path.is_absolute() {
            path
        } else {
            self.path.join(path)
        }
    }

    fn install_failing_push_hook(&self, message: &str) {
        let hook = self.git_path("hooks/pre-push");
        fs::create_dir_all(hook.parent().expect("hook parent")).expect("create hook parent");
        let script = format!("#!/bin/sh\nprintf '%s\\n' '{message}' >&2\nexit 1\n");
        let mut file = fs::File::create(&hook).expect("create pre-push hook");
        file.write_all(script.as_bytes())
            .expect("write pre-push hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755))
                .expect("chmod pre-push hook");
        }
    }
}

#[test]
fn phase12_commit_large_file_lfs_track_failure_keeps_pre_operation_snapshot() {
    let Some((runner, home)) = real_runner_or_skip() else {
        return;
    };
    let runner = runner_with_failing_git_lfs(
        &runner,
        home.path(),
        "intentional phase12 git-lfs track failure",
    );
    let repo = TestRepo::new(&runner, "ag-phase12-commit-lfs-track-failure");
    repo.init_with_commit();
    repo.write_bytes("large.bin", &vec![b'x'; 1024 * 1024 + 1]);
    let before = RepoSnapshot::capture(&repo);

    let error = crate::commit_changes(
        &runner,
        CommitRequest {
            repository_path: display_path(&repo.path),
            paths: vec!["large.bin".to_owned()],
            message: "large file should fail before commit".to_owned(),
            large_file_threshold_mb: Some(1),
            large_file_decision: LargeFileDecision::TrackWithLfs,
            disable_repository_gpgsign: false,
            push_immediately: false,
            operation_id: Some(OperationId("phase12-commit-lfs-track-failure".to_owned())),
        },
    )
    .expect_err("failing git-lfs track should stop before local commit");

    assert!(
        error
            .git
            .as_ref()
            .map(|git| git
                .stderr
                .contains("intentional phase12 git-lfs track failure"))
            .unwrap_or(false),
        "{error:?}"
    );
    before.assert_restored(&repo);
    assert_repository_reusable(&repo);
}

fn assert_repository_reusable(repo: &TestRepo) {
    repo.git(["rev-parse", "--verify", "HEAD"]);
    repo.git(["status", "--porcelain=v1"]);
}

fn assert_repository_clean_and_reusable(repo: &TestRepo) {
    assert_eq!(repo.git_output(["status", "--porcelain=v1"]), "");
    assert_repository_reusable(repo);
}

fn ahead_behind(repo: &TestRepo) -> (usize, usize) {
    let counts = repo.git_output(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    let mut parts = counts.split_whitespace();
    let ahead = parts
        .next()
        .expect("ahead count")
        .parse()
        .expect("parse ahead count");
    let behind = parts
        .next()
        .expect("behind count")
        .parse()
        .expect("parse behind count");
    (ahead, behind)
}

fn assert_no_sync_worktrees(repo: &TestRepo) {
    let listed_worktrees = repo.git_output(["worktree", "list", "--porcelain"]);
    assert!(
        !listed_worktrees.contains("artistic-git-sync-"),
        "{listed_worktrees}"
    );
    let Some(parent) = repo.path.parent() else {
        return;
    };
    for entry in fs::read_dir(parent).expect("read worktree parent") {
        let entry = entry.expect("read worktree entry");
        let name = entry.file_name();
        let name = name.to_string_lossy();
        assert!(
            !name.starts_with("artistic-git-sync-"),
            "leftover sync worktree: {}",
            entry.path().display()
        );
    }
}

fn add_local_submodule(runner: &GitRunner, fixture: &RemoteFixture, path: &str) -> TestRepo {
    let source_name = format!("submodule-source-{}", path.replace('/', "-"));
    let submodule_source = TestRepo::at(runner, fixture._parent.path().join(source_name));
    git_stdout(
        runner,
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
        path,
    ]);
    fixture.local.git(["commit", "-am", "add submodule"]);
    fixture.local.git(["push"]);
    TestRepo::at(runner, fixture.local.path.join(path))
}

fn add_bare_submodule(
    runner: &GitRunner,
    fixture: &RemoteFixture,
    path: &str,
) -> (TestRepo, TestRepo) {
    let remote_path = fixture
        ._parent
        .path()
        .join(format!("submodule-{}.git", path.replace('/', "-")));
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
    .expect("init bare submodule remote");

    let seed = TestRepo::at(
        runner,
        fixture
            ._parent
            .path()
            .join(format!("submodule-seed-{}", path.replace('/', "-"))),
    );
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
    .expect("init submodule seed");
    seed.configure_identity();
    seed.write("nested.txt", "initial\n");
    seed.git(["add", "nested.txt"]);
    seed.git(["commit", "-m", "submodule initial"]);
    seed.git([
        "remote",
        "add",
        "origin",
        display_path(&remote_path).as_str(),
    ]);
    seed.git(["push", "-u", "origin", "main"]);

    fixture.local.git([
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        display_path(&remote_path).as_str(),
        path,
    ]);
    fixture.local.git(["commit", "-am", "add submodule"]);
    fixture.local.git(["push"]);
    let submodule = TestRepo::at(runner, fixture.local.path.join(path));
    submodule.configure_identity();
    (submodule, TestRepo::at(runner, remote_path))
}

fn runner_with_failing_git_lfs(runner: &GitRunner, parent: &Path, message: &str) -> GitRunner {
    let fake_dir = parent.join("fake-git-lfs");
    fs::create_dir_all(&fake_dir).expect("create fake git-lfs dir");
    let fake_lfs = fake_git_lfs_path(&fake_dir);
    write_failing_git_lfs(&fake_lfs, message);
    let distribution = runner.distribution();
    GitRunner::from_distribution(
        GitDistribution {
            root: distribution.root.clone(),
            manifest: distribution.manifest.clone(),
            git_executable: distribution.git_executable.clone(),
            git_lfs_executable: fake_lfs,
            credential_helper: distribution.credential_helper.clone(),
            ssh_askpass: distribution.ssh_askpass.clone(),
            windows_ssh_executable: distribution.windows_ssh_executable.clone(),
        },
        parent.join("fake-git-lfs-home"),
    )
}

#[cfg(windows)]
fn fake_git_lfs_path(fake_dir: &Path) -> PathBuf {
    fake_dir.join("git-lfs.cmd")
}

#[cfg(not(windows))]
fn fake_git_lfs_path(fake_dir: &Path) -> PathBuf {
    fake_dir.join("git-lfs")
}

#[cfg(windows)]
fn write_failing_git_lfs(path: &Path, message: &str) {
    let script = format!(
        "@echo off\r\necho %* | findstr /C:\" track \" >nul\r\nif %errorlevel%==0 (\r\n  echo {message} 1>&2\r\n  exit /b 1\r\n)\r\nexit /b 0\r\n"
    );
    fs::write(path, script).expect("write fake git-lfs");
}

#[cfg(not(windows))]
fn write_failing_git_lfs(path: &Path, message: &str) {
    let script = format!(
        "#!/bin/sh\ncase \" $* \" in\n  *\" track \"*) printf '%s\\n' '{message}' >&2; exit 1 ;;\n  *) exit 0 ;;\nesac\n"
    );
    fs::write(path, script).expect("write fake git-lfs");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod fake git-lfs");
    }
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
