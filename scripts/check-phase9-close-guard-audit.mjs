#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const source = {
  commands: read("src/lib/ipc/commands.ts"),
  generated: read("src/lib/ipc/generated.ts"),
  startScreen: read("src/features/start/StartScreen.tsx"),
  startScreenTest: read("src/features/start/StartScreen.test.tsx"),
  repositoryShell: read("src/features/repository-shell/RepositoryShell.tsx"),
  repositoryShellTest: read(
    "src/features/repository-shell/RepositoryShell.test.tsx",
  ),
  historyWorkbench: read("src/features/history/HistoryWorkbench.tsx"),
  historyTest: read("src/features/history/history.test.tsx"),
  tauriLib: read("src-tauri/src/lib.rs"),
  backend: read("crates/app/src/repository.rs"),
  fullChainE2e: read("e2e/tauri/full-chain-real-git.e2e.ts"),
};

const cancellableOperations = [
  {
    backendOperation: "cloneRepository",
    command: "clone_repository",
    frontendEvidence: [
      [source.startScreen, /const operationId = createOperationId\(\);/],
      [
        source.startScreen,
        /cloneRepository\(\{\s*directoryName:[\s\S]*operationId,/,
      ],
      [source.startScreen, /recoverCloneForWindowClose/],
      [
        source.startScreenTest,
        /cancels an in-flight clone before closing a guarded window/,
      ],
    ],
    progressEvidence: [
      [source.backend, /cancellable:\s*true,[\s\S]*repository_path/],
    ],
    requestType: "CloneRepositoryRequest",
  },
  {
    backendOperation: "syncCurrentBranch",
    command: "sync_current_branch",
    requestType: "SyncCurrentBranchRequest",
  },
  {
    backendOperation: "syncBranch",
    command: "sync_branch",
    frontendEvidence: [
      [source.repositoryShell, /createRepositoryOperationId\("sync-branch"\)/],
      [source.repositoryShellTest, /\^sync-branch-/],
    ],
    requestType: "SyncBranchRequest",
  },
  {
    backendOperation: "syncAllBranches",
    command: "sync_all_branches",
    frontendEvidence: [
      [source.repositoryShell, /createRepositoryOperationId\("sync-all"\)/],
      [source.repositoryShellTest, /\^sync-all-/],
    ],
    requestType: "SyncAllBranchesRequest",
  },
  {
    backendOperation: "acceptRemoteHistory",
    command: "accept_remote_history",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("accept-remote-history"\)/,
      ],
      [source.repositoryShellTest, /\^accept-remote-history-/],
    ],
    requestType: "AcceptRemoteHistoryRequest",
  },
  {
    backendOperation: "startReviewMode",
    command: "start_review_mode",
    frontendEvidence: [
      [source.repositoryShell, /createRepositoryOperationId\("review-start"\)/],
      [source.repositoryShellTest, /\^review-start-/],
    ],
    requestType: "StartReviewModeRequest",
  },
  {
    backendOperation: "syncReviewMode",
    command: "sync_review_mode",
    frontendEvidence: [
      [source.repositoryShell, /createRepositoryOperationId\("review-sync"\)/],
      [source.repositoryShellTest, /\^review-sync-/],
    ],
    requestType: "ReviewModeRequest",
  },
  {
    backendOperation: "exitReviewMode",
    command: "exit_review_mode",
    frontendEvidence: [
      [source.repositoryShell, /createRepositoryOperationId\("review-exit"\)/],
      [source.repositoryShellTest, /\^review-exit-/],
    ],
    requestType: "ReviewModeRequest",
  },
  {
    backendOperation: "recoverReviewModeStash",
    command: "recover_review_mode_stash",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("review-recover"\)/,
      ],
      [
        source.repositoryShell,
        /createRepositoryOperationId\("review-recover-close"\)/,
      ],
      [source.repositoryShellTest, /\^review-recover-/],
    ],
    requestType: "ReviewModeRecoveryRequest",
  },
  {
    backendOperation: "createBranch",
    command: "create_branch",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("create-branch"\)/,
      ],
      [source.repositoryShellTest, /\^create-branch-/],
    ],
    requestType: "CreateBranchRequest",
  },
  {
    backendOperation: "checkoutBranch",
    command: "checkout_branch",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("checkout-branch"\)/,
      ],
      [source.repositoryShellTest, /\^checkout-branch-/],
    ],
    requestType: "CheckoutBranchRequest",
  },
  {
    backendOperation: "deleteBranch",
    command: "delete_branch",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("delete-branch"\)/,
      ],
      [source.repositoryShellTest, /\^delete-branch-/],
    ],
    requestType: "DeleteBranchRequest",
  },
  {
    backendOperation: "deleteSafetyBackup",
    command: "delete_safety_backup",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("delete-safety-backup"\)/,
      ],
      [source.repositoryShellTest, /\^delete-safety-backup-/],
    ],
    requestType: "DeleteSafetyBackupRequest",
  },
  {
    backendOperation: "createStash",
    command: "create_stash",
    frontendEvidence: [
      [source.repositoryShell, /createRepositoryOperationId\("create-stash"\)/],
      [source.repositoryShellTest, /\^create-stash-/],
    ],
    requestType: "CreateStashRequest",
  },
  {
    backendOperation: "createAutoStash",
    command: "create_auto_stash",
    requestType: "CreateAutoStashRequest",
  },
  {
    backendOperation: "restoreStash",
    command: "restore_stash",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("restore-stash"\)/,
      ],
      [source.repositoryShellTest, /\^restore-stash-/],
    ],
    requestType: "RestoreStashRequest",
  },
  {
    backendOperation: "deleteStash",
    command: "delete_stash",
    frontendEvidence: [
      [source.repositoryShell, /createRepositoryOperationId\("delete-stash"\)/],
      [source.repositoryShellTest, /\^delete-stash-/],
    ],
    requestType: "DeleteStashRequest",
  },
  {
    backendOperation: "commitChanges",
    command: "commit_changes",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("commit-changes"\)/,
      ],
      [source.repositoryShellTest, /\^commit-changes-/],
    ],
    requestType: "CommitRequest",
  },
  {
    backendOperation: "revertCommit",
    command: "revert_commit",
    frontendEvidence: [
      [source.historyWorkbench, /createHistoryOperationId\("revert-commit"\)/],
      [source.historyTest, /\^revert-commit-/],
    ],
    requestType: "RevertCommitRequest",
  },
];

const waitOnlyOperations = [
  {
    command: "open_repository",
    evidence: [
      [source.generated, requestBlock("OpenRepositoryRequest", /operationId/)],
      [
        source.startScreen,
        /cancellable:\s*false,[\s\S]*label:\s*"Opening repository"/,
      ],
      [source.startScreen, /active=\{isCloning \|\| openingPath !== null\}/],
      [
        source.startScreen,
        /canRecover=\{isCloning && cloneOperationId !== null && !cloneCancelling\}/,
      ],
      [
        source.startScreenTest,
        /guards an in-flight repository open as wait-only/,
      ],
      [
        source.backend,
        /"Updating submodules"[\s\S]*ProgressState::Indeterminate,\s*false/,
      ],
    ],
    reason:
      "open repository may run submodule updates; no cancel token exists, so close guard waits",
  },
  {
    command: "restore_changes",
    evidence: [
      [source.generated, requestBlock("RestoreChangesRequest", /operationId/)],
      [source.repositoryShell, /setRestoreBusy\(true\)[\s\S]*restoreChanges\(/],
      [source.repositoryShell, /writeOperationBusy\s*=[\s\S]*restoreBusy/],
    ],
    reason:
      "restore is a short rollback-backed local write; close guard blocks until it finishes",
  },
];

const notCloseGuardCancelled = [
  "abort_revert",
  "cancel_clone_repository",
  "cancel_conflict_resolution",
  "cancel_operation",
  "cancel_pending_window_exit",
  "cancel_stash_restore",
  "check_for_updates",
  "complete_conflict_resolution",
  "delete_https_credential",
  "dismiss_review_mode_recovery",
  "fetch_repository",
  "generate_ssh_key",
  "install_ready_update",
  "open_log_dir",
  "open_repository_window",
  "open_update_release_page",
  "register_window_repository",
  "review_mode_recovery",
  "save_app_settings",
  "save_conflict_resolution",
  "save_gitignore",
  "save_https_credential",
  "save_project_settings",
  "save_remote_settings",
  "save_window_geometry",
  "select_conflict_side",
  "set_window_close_guard",
  "submit_https_credential_prompt",
  "submit_ssh_passphrase_prompt",
  "update_install_gate",
  "validate_identity_for_write",
];

const failures = [];
const classifiedCommands = new Set([
  ...cancellableOperations.map((operation) => operation.command),
  ...waitOnlyOperations.map((operation) => operation.command),
  ...notCloseGuardCancelled,
]);

for (const operation of cancellableOperations) {
  assertRequestHasOperationId(operation.requestType, operation.command);
  assertBackendRegistersToken(operation.backendOperation, operation.command);
  assertTauriCommandEmitsCancellableProgress(operation.command);
  for (const [fileSource, pattern] of operation.frontendEvidence ?? []) {
    assertMatch(fileSource, pattern, `${operation.command} frontend evidence`);
  }
  for (const [fileSource, pattern] of operation.progressEvidence ?? []) {
    assertMatch(fileSource, pattern, `${operation.command} progress evidence`);
  }
}

for (const operation of waitOnlyOperations) {
  for (const [fileSource, patternOrCheck] of operation.evidence) {
    if (typeof patternOrCheck === "function") {
      const error = patternOrCheck(fileSource);
      if (error) {
        failures.push(`${operation.command}: ${error}`);
      }
    } else {
      assertMatch(
        fileSource,
        patternOrCheck,
        `${operation.command} wait-only evidence`,
      );
    }
  }
}

assertMatch(
  source.repositoryShell,
  /activeOperation\?\.cancellable === true \? activeOperation : null/,
  "RepositoryShell only cancels operations explicitly marked cancellable",
);
assertMatch(
  source.repositoryShellTest,
  /guards non-cancellable active backend operations as wait-only/,
  "RepositoryShell wait-only active operation test",
);
assertMatch(
  source.repositoryShellTest,
  /cancels a cancellable active backend operation before closing/,
  "RepositoryShell cancellable active operation test",
);
assertMatch(
  source.repositoryShellTest,
  /cancels pending app quit when an active backend operation must keep waiting/,
  "RepositoryShell pending quit wait-only test",
);
assertMatch(
  source.fullChainE2e,
  /assertCloseGuardBlocksWindowShortcutDuringConflict/,
  "real-git WDIO conflict close shortcut evidence",
);

const writeEntrances = appCommandNames().filter(isWriteLikeCommand);
const unclassified = writeEntrances.filter(
  (command) => !classifiedCommands.has(command),
);
if (unclassified.length > 0) {
  failures.push(
    `unclassified write-like IPC commands: ${unclassified.sort().join(", ")}`,
  );
}

if (failures.length > 0) {
  console.error("Phase 9C close guard audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Phase 9C close guard audit passed.");
console.log(
  `cancellable: ${cancellableOperations.map((operation) => operation.command).join(", ")}`,
);
console.log(
  `wait-only: ${waitOnlyOperations
    .map((operation) => `${operation.command} (${operation.reason})`)
    .join("; ")}`,
);
console.log(
  `not close-guard cancelled: ${notCloseGuardCancelled.sort().join(", ")}`,
);

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertRequestHasOperationId(requestType, command) {
  const block = typeBlock(source.generated, requestType);
  if (!block.includes("operationId: OperationId | null")) {
    failures.push(
      `${command}: ${requestType} must expose nullable operationId`,
    );
  }
}

function assertBackendRegistersToken(backendOperation, command) {
  const registerPattern =
    backendOperation === "cloneRepository"
      ? /register\(operation_id,\s*token\.clone\(\),\s*"cloneRepository"\)/
      : new RegExp(
          `run_cancellable_operation\\([\\s\\S]{0,220}"${escapeRegExp(
            backendOperation,
          )}"`,
        );
  assertMatch(
    source.backend,
    registerPattern,
    `${command}: backend cancellable token registration`,
  );
}

function assertTauriCommandEmitsCancellableProgress(command) {
  if (command === "clone_repository") {
    assertMatch(
      source.backend,
      /fn emit_clone_progress[\s\S]*cancellable:\s*true/,
      "clone_repository cancellable progress",
    );
    return;
  }

  const block = rustFunctionBlock(source.tauriLib, command);
  if (!/emit_operation_started\(/.test(block)) {
    failures.push(
      `${command}: Tauri command must emit cancellable start progress`,
    );
  }
}

function assertMatch(fileSource, pattern, label) {
  if (!pattern.test(fileSource)) {
    failures.push(`${label}: missing ${pattern}`);
  }
}

function appCommandNames() {
  const argsBlock = interfaceBlock(source.commands, "AppCommandArgs");
  return [...argsBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map((match) => match[1]);
}

function isWriteLikeCommand(command) {
  return /^(accept_|abort_|cancel_|check_for_updates|checkout_|clone_|complete_|create_|delete_|dismiss_|exit_|fetch_|generate_|install_|open_log_dir|open_repository|open_update_release_page|recover_|register_window_repository|restore_|review_mode_recovery|save_|select_|set_window_close_guard|start_|submit_|sync_|update_install_gate|validate_identity_for_write)/.test(
    command,
  );
}

function requestBlock(typeName, forbiddenPattern) {
  return (fileSource) => {
    const block = typeBlock(fileSource, typeName);
    return forbiddenPattern.test(block)
      ? `${typeName} unexpectedly contains ${forbiddenPattern}`
      : null;
  };
}

function typeBlock(fileSource, typeName) {
  const pattern = new RegExp(
    `export type ${escapeRegExp(typeName)} = \\{[\\s\\S]*?\\n\\};`,
  );
  const match = fileSource.match(pattern);
  if (!match) {
    failures.push(`missing generated type ${typeName}`);
    return "";
  }
  return match[0];
}

function interfaceBlock(fileSource, interfaceName) {
  const start = fileSource.indexOf(`export interface ${interfaceName} {`);
  if (start === -1) {
    failures.push(`missing interface ${interfaceName}`);
    return "";
  }
  return balancedBlock(fileSource, fileSource.indexOf("{", start));
}

function rustFunctionBlock(fileSource, functionName) {
  const pattern = new RegExp(`\\nfn ${escapeRegExp(functionName)}\\s*\\(`);
  const match = pattern.exec(fileSource);
  if (!match) {
    failures.push(`missing Rust function ${functionName}`);
    return "";
  }
  return balancedBlock(fileSource, fileSource.indexOf("{", match.index));
}

function balancedBlock(fileSource, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < fileSource.length; index += 1) {
    const char = fileSource[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return fileSource.slice(openBraceIndex, index + 1);
      }
    }
  }
  return fileSource.slice(openBraceIndex);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
