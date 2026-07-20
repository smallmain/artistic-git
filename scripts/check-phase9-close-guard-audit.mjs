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
  app: read("src/App.tsx"),
  appTest: read("src/App.test.tsx"),
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
  windowCloseGuard: read(
    "src/features/window-close-guard/WindowCloseGuard.tsx",
  ),
};

const cancellableOperations = [
  {
    backendOperation: "openRepository",
    command: "open_repository",
    frontendEvidence: [
      [source.startScreen, /createOperationId\("open-repository"\)/],
      [
        source.startScreen,
        /cancelOperation\(\{ operationId: openOperationId \}\)/,
      ],
      [
        source.startScreenTest,
        /cancels an in-flight repository open before closing/,
      ],
    ],
    requestType: "OpenRepositoryRequest",
  },
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
    backendOperation: "restoreChanges",
    command: "restore_changes",
    frontendEvidence: [
      [
        source.repositoryShell,
        /createRepositoryOperationId\("restore-changes"\)/,
      ],
      [source.repositoryShellTest, /\^restore-changes-/],
    ],
    requestType: "RestoreChangesRequest",
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

const waitOnlyOperations = [];

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
  source.repositoryShell,
  /const writeOperationBusy\s*=[\s\S]*activeOperationBusy[\s\S]*reviewBusy[\s\S]*bisectResetBusy;/,
  "RepositoryShell write-operation close guard source set",
);
assertMatch(
  source.repositoryShell,
  /const closeGuardActive\s*=\s*[\s\S]*writeOperationBusy\s*\|\|[\s\S]*conflict !== null\s*\|\|[\s\S]*reviewActive\s*\|\|[\s\S]*reviewRecoveryPrompt;/,
  "RepositoryShell close guard covers writes, conflicts, review mode, and recovery prompts",
);
assertMatch(
  source.repositoryShell,
  /await cancelOperation\(\{[\s\S]*operationId: closeGuardActiveOperation\.operationId,[\s\S]*\}\);/,
  "RepositoryShell close guard cancels active cancellable backend writes",
);
assertMatch(
  source.repositoryShell,
  /cancelConflictResolution\(\{[\s\S]*operationId: conflict\.operationId,[\s\S]*repositoryPath: conflict\.repositoryPath,[\s\S]*\}\);/,
  "RepositoryShell close guard cancels unresolved conflict mode",
);
assertMatch(
  source.repositoryShell,
  /exitReviewMode\(\{[\s\S]*createRepositoryOperationId\("review-exit-close"\)[\s\S]*repositoryPath,[\s\S]*\}\);/,
  "RepositoryShell close guard exits active review mode",
);
assertMatch(
  source.repositoryShell,
  /recoverReviewModeStash\(\{[\s\S]*createRepositoryOperationId\("review-recover-close"\)[\s\S]*repositoryPath,[\s\S]*\}\);/,
  "RepositoryShell close guard recovers review mode crash prompt",
);
assertMatch(
  source.windowCloseGuard,
  /await onRecover\(\);[\s\S]*await setWindowCloseGuard\(\{ active: false \}\);[\s\S]*await closeCurrentWindow\(\);/,
  "WindowCloseGuard recovers, clears the backend guard, then closes the window",
);
assertMatch(
  source.windowCloseGuard,
  /if \(reason === "quit"\) \{[\s\S]*cancelPendingQuit\(\);[\s\S]*\}/,
  "WindowCloseGuard cancels pending app quit when recovery fails",
);
assertMatch(
  source.windowCloseGuard,
  /closeRequest\?\.reason === "quit"[\s\S]*cancelPendingQuit\(\);/,
  "WindowCloseGuard cancels pending app quit when the prompt is dismissed",
);
assertMatch(
  source.app,
  /key === "w"[\s\S]*event\.preventDefault\(\);[\s\S]*closeCurrentWindow\(\)/,
  "App Cmd/Ctrl+W shortcut uses the same close_current_window command as menu close",
);
assertMatch(
  source.appTest,
  /ctrlKey: true[\s\S]*closeCurrentWindow\)\.toHaveBeenCalledTimes\(1\)[\s\S]*metaKey: true[\s\S]*closeCurrentWindow\)\.toHaveBeenCalledTimes\(2\)/,
  "App shortcut test covers both Ctrl+W and Cmd+W",
);
assertMatch(
  source.tauriLib,
  /"close-window"[\s\S]*close_guard_block_event\([\s\S]*WindowCloseBlockedReason::CloseWindow[\s\S]*window\.emit\("window-close-blocked", event\)/,
  "Tauri File > Close Window menu path uses the close guard",
);
assertMatch(
  source.tauriLib,
  /WindowEvent::CloseRequested \{ api,[\s\S]*api\.prevent_close\(\);[\s\S]*window\.emit\("window-close-blocked", event\)/,
  "Tauri native X close request is blocked by the close guard",
);
assertMatch(
  source.tauriLib,
  /RunEvent::ExitRequested \{ api,[\s\S]*api\.prevent_exit\(\);[\s\S]*registry_set_pending_exit_after_close_guards\(&registry, true\)[\s\S]*emit_close_guard_request\(app, guarded_labels, WindowCloseBlockedReason::Quit\)/,
  "Tauri Cmd/Ctrl+Q app quit path fans out close guard prompts per guarded window",
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
  /cancels unresolved conflicts before closing the guarded window/,
  "RepositoryShell conflict close recovery test",
);
assertMatch(
  source.repositoryShellTest,
  /cancels unresolved conflicts before completing a pending app quit/,
  "RepositoryShell conflict pending app quit recovery test",
);
assertMatch(
  source.repositoryShellTest,
  /exits review mode before closing the guarded window/,
  "RepositoryShell review close recovery test",
);
assertMatch(
  source.repositoryShellTest,
  /exits review mode before completing a pending app quit/,
  "RepositoryShell review pending app quit recovery test",
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
  if (!/operationId\??:\s*OperationId \| null/.test(block)) {
    failures.push(
      `${command}: ${requestType} must expose nullable operationId`,
    );
  }
}

function assertBackendRegistersToken(backendOperation, command) {
  const registerPattern =
    backendOperation === "cloneRepository"
      ? /register\(operation_id,\s*"cloneRepository"\)/
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
  if (!/reserve_and_emit_operation_started\(/.test(block)) {
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
  const pattern = new RegExp(
    `\\n(?:pub\\s+)?(?:async\\s+)?fn ${escapeRegExp(functionName)}\\s*\\(`,
  );
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
