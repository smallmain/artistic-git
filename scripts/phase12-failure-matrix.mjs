#!/usr/bin/env node
/* global console, process */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const reportDir =
  process.env.ARTISTIC_GIT_PHASE12_FAILURE_MATRIX_REPORT_DIR ??
  (process.env.CI ? path.join("artifacts", "phase12-failure-matrix") : null);

const commonInvariant =
  "branch, HEAD, index tree, status, and basic git commands remain usable after the recovery boundary";

const operations = [
  operation("sync-current-branch", "Sync current branch", [
    covered(
      "local-submodule-update-failure",
      "Broken submodule gitlink during the local update phase",
      "phase12_sync_local_phase_failure_restores_pre_operation_snapshot",
    ),
    covered(
      "fetch-network-failure",
      "Remote fetch/auth/network failure before local changes are touched",
      "phase12_sync_fetch_network_failure_keeps_pre_operation_snapshot",
    ),
    covered(
      "rebase-conflict-abort",
      "Diverged upstream rebase conflict plus explicit abort recovery",
      "phase12_sync_rebase_conflict_cancel_restores_pre_operation_snapshot",
    ),
    gap(
      "push-race-retry-exhausted",
      "Publish retry loop exhausts after non-fast-forward races",
    ),
  ]),
  operation("sync-non-current-branch", "Sync non-current branch", [
    covered(
      "publish-missing-origin",
      "Publishing a local-only non-current branch to a missing origin",
      "phase12_sync_non_current_publish_failure_keeps_repository_reusable",
      "current worktree snapshot is unchanged and reusable",
    ),
    covered(
      "temporary-worktree-rebase-conflict",
      "Slow-path worktree rebase conflict and cleanup",
      "phase12_sync_non_current_worktree_rebase_conflict_cancel_restores_snapshot",
      "main worktree snapshot is unchanged, the conflicted tool worktree is removed, and git commands remain usable",
    ),
    gap(
      "temporary-worktree-cleanup-failure",
      "Tool-owned temporary worktree removal failure is surfaced without damaging the main worktree",
    ),
  ]),
  operation("auto-tracking", "Auto tracking sync", [
    covered(
      "ff-only-divergence-with-local-changes",
      "Tracked branch cannot fast-forward from its source branch after local changes are stashed",
      "phase12_auto_tracking_divergence_restores_local_changes",
    ),
    gap("source-fetch-failure", "Source branch fetch failure"),
    gap(
      "target-fetch-failure",
      "Target branch fetch failure after local stash",
    ),
    gap(
      "post-merge-push-failure",
      "Auto-tracking merge succeeds but final push fails at publish boundary",
    ),
  ]),
  operation("commit", "Commit selected changes", [
    covered(
      "gpg-sign-failure",
      "Repository-level GPG signing points at a missing gpg program",
      "phase12_commit_gpg_failure_restores_index_and_head",
    ),
    gap(
      "pre-commit-sync-failure",
      "Pre-commit sync fails after selected and unselected local changes are stashed",
    ),
    gap(
      "large-file-lfs-track-failure",
      "Large-file prompt chooses LFS but git-lfs tracking fails",
    ),
    gap(
      "push-after-commit-failure",
      "Local commit succeeds and immediate push fails with forward-safe preservation",
    ),
  ]),
  operation("revert", "Revert commit", [
    covered(
      "revert-conflict-abort",
      "Conflicted revert returns an in-band conflict and git revert --abort restores the snapshot",
      "phase12_revert_conflict_abort_restores_pre_operation_snapshot",
    ),
    covered(
      "pre-revert-sync-failure",
      "Pre-revert sync fails before the revert is attempted",
      "phase12_revert_pre_sync_failure_restores_pre_operation_snapshot",
    ),
    gap(
      "push-after-revert-failure",
      "Revert commit is created and final push fails with forward-safe preservation",
    ),
  ]),
  operation("review-mode", "Review mode", [
    covered(
      "exit-stash-restore-conflict-cancel",
      "Exiting review mode conflicts while restoring the review auto-stash, then cancel restores the pre-exit state",
      "phase12_review_exit_stash_conflict_cancel_keeps_review_recovery",
      "review-mode state is restored, the review auto-stash remains recoverable, and git commands remain usable",
    ),
    gap(
      "start-stash-create-failure",
      "Entering review mode fails while creating the auto-stash",
    ),
    gap(
      "pull-offline-degrade",
      "Review pull fails offline and leaves the user in review mode with explicit offline status",
    ),
    gap(
      "sync-review-ff-failure",
      "In-review sync fetches but cannot fast-forward",
    ),
  ]),
  operation("checkout", "Checkout branch", [
    covered(
      "auto-stash-conflict-cancel",
      "Auto-stash checkout applies onto the target branch with conflicts, then cancel restores the original branch snapshot",
      "phase12_checkout_auto_stash_conflict_cancel_restores_snapshot",
    ),
    gap(
      "stash-create-failure",
      "Checkout fails while creating the auto-stash before branch movement",
    ),
    gap(
      "discard-trash-backup-failure",
      "Discard-local-changes path cannot create the trash backup",
    ),
  ]),
  operation("submodule-commit", "Submodule commit", [
    covered(
      "publish-guard-missing-submodule-origin",
      "Submodule change cannot be proven pushable because the nested repository has no origin",
      "phase12_submodule_commit_publish_guard_failure_preserves_super_and_submodule",
      "superproject and submodule snapshots are both restored and reusable",
    ),
    covered(
      "nested-commit-failure",
      "Submodule local commit fails after selected nested paths are staged",
      "phase12_submodule_nested_commit_failure_restores_super_and_submodule",
      "superproject and submodule snapshots are both restored and reusable",
    ),
    gap(
      "superproject-pointer-commit-failure",
      "Submodule commit succeeds but superproject gitlink commit fails",
    ),
    gap(
      "partial-publish-boundary",
      "Submodule push succeeds but superproject push fails and leaves a forward-safe local pointer commit",
    ),
  ]),
];

const summary = summarize(operations);
const report = {
  schemaVersion: 1,
  kind: "phase12-failure-matrix",
  generatedAt: new Date().toISOString(),
  status: summary.gapSteps > 0 ? "blocker" : "pass",
  exitCodePolicy:
    "Known gaps are reported as blocker in artifacts but only fail the command when ARTISTIC_GIT_PHASE12_FAILURE_MATRIX_FAIL_ON_GAPS=1.",
  invariant: commonInvariant,
  summary,
  operations,
};

writeReports(report);
printSummary(report);

if (
  report.status === "blocker" &&
  process.env.ARTISTIC_GIT_PHASE12_FAILURE_MATRIX_FAIL_ON_GAPS === "1"
) {
  process.exitCode = 1;
}

function operation(id, name, steps) {
  const coveredSteps = steps.filter((step) => step.status === "covered").length;
  const gapSteps = steps.filter((step) => step.status === "gap").length;
  return {
    id,
    name,
    status: gapSteps > 0 ? (coveredSteps > 0 ? "partial" : "gap") : "covered",
    steps,
  };
}

function covered(id, failureMode, test, invariant = commonInvariant) {
  return {
    id,
    status: "covered",
    failureMode,
    harness: "crates/app/src/phase12_failure_hardening.rs",
    test,
    invariant,
  };
}

function gap(id, failureMode) {
  return {
    id,
    status: "gap",
    failureMode,
    gapMarker: true,
    requiredEvidence:
      "Add a real git-dist harness test that injects this failure and asserts the recovery invariant.",
  };
}

function summarize(items) {
  const steps = items.flatMap((item) => item.steps);
  return {
    operations: items.length,
    coveredOperations: items.filter((item) => item.status === "covered").length,
    partialOperations: items.filter((item) => item.status === "partial").length,
    gapOperations: items.filter((item) => item.status === "gap").length,
    totalSteps: steps.length,
    coveredSteps: steps.filter((step) => step.status === "covered").length,
    gapSteps: steps.filter((step) => step.status === "gap").length,
  };
}

function writeReports(content) {
  if (!reportDir) {
    return;
  }
  const absoluteReportDir = path.resolve(reportDir);
  mkdirSync(absoluteReportDir, { recursive: true });
  writeFileSync(
    path.join(absoluteReportDir, "phase12-failure-matrix.json"),
    `${JSON.stringify(content, null, 2)}\n`,
  );
  writeFileSync(
    path.join(absoluteReportDir, "phase12-failure-matrix.md"),
    markdownReport(content),
  );
  console.log(`Wrote phase12 failure matrix artifacts to ${absoluteReportDir}`);
}

function markdownReport(content) {
  const lines = [
    "# Phase 12 failure matrix",
    "",
    `Status: ${content.status}`,
    `Covered steps: ${content.summary.coveredSteps}/${content.summary.totalSteps}`,
    `Gap steps: ${content.summary.gapSteps}`,
    "",
  ];
  for (const item of content.operations) {
    lines.push(`## ${item.name}`, "", `Status: ${item.status}`, "");
    for (const step of item.steps) {
      const suffix =
        step.status === "covered" ? `covered by ${step.test}` : "gap marker";
      lines.push(`- ${step.status}: ${step.id} - ${suffix}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function printSummary(content) {
  console.log(
    `phase12 failure matrix: ${content.status}; ` +
      `${content.summary.coveredSteps}/${content.summary.totalSteps} steps covered, ` +
      `${content.summary.gapSteps} gaps marked.`,
  );
}
