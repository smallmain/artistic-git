#!/usr/bin/env node
/* global console, process */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const runnerLabel = process.env.RUNNER_OS ?? process.platform;
const reportPath = path.resolve(
  process.env.ARTISTIC_GIT_PHASE12_E2E_AUDIT_REPORT ??
    path.join(
      "artifacts",
      `e2e-real-git-report-phase12-full-chain-audit-${runnerLabel}.json`,
    ),
);
const markdownPath = reportPath.replace(/\.json$/i, ".md");

const sourceFiles = {
  ci: ".github/workflows/ci.yml",
  gitDistActivator: "scripts/activate-phase12-git-dist.mjs",
  packageJson: "package.json",
  rust: "crates/app/src/full_chain_e2e.rs",
  wdio: "e2e/tauri/full-chain-real-git.e2e.ts",
  wdioStaticCheck: "scripts/check-e2e-real-ui.mjs",
  realGitReport: "scripts/e2e-real-git-report.mjs",
};
const sources = Object.fromEntries(
  Object.entries(sourceFiles).map(([key, relativePath]) => [
    key,
    readFileSync(path.join(repoRoot, relativePath), "utf8"),
  ]),
);

const packageJson = JSON.parse(sources.packageJson);

const coverageSteps = [
  {
    id: "clone",
    requirement: "clone from a real temporary bare remote through the UI",
    wdio: [
      'cloneThroughUi(fixture.remotePath, fixture.parentPath, "local")',
      '[data-testid="start-clone-project"]',
      '[data-testid="clone-url-input"]',
      '[data-testid="clone-submit"]',
      "waitForRepository(localPath)",
    ],
    rust: [
      'clone_with_app("local")',
      "CloneRepositoryRequest",
      "crate::clone_repository",
      "RepositoryRemoteMode::Origin",
    ],
  },
  {
    id: "modify",
    requirement: "modify tracked and new files in the local worktree",
    wdio: [
      'fixture.write("local", "local.txt", "local\\n")',
      'fixture.write("local", "tracked.txt", "local conflicting edit\\n")',
    ],
    rust: [
      "commit_path_with_app(",
      "repo.write(relative_path, content)",
      '"tracked.txt"',
    ],
  },
  {
    id: "commit",
    requirement: "commit selected local changes and optionally push",
    wdio: [
      'commitThroughUi("local.txt", "add local file", true)',
      '[data-testid="repository-tab-local-changes"]',
      '"local-change-row"',
      '[data-testid="local-changes-commit"]',
      '[data-testid="commit-dialog-submit"]',
      '[data-testid="commit-push-immediately"]',
    ],
    rust: [
      "crate::commit_changes",
      "CommitRequest",
      "push_immediately",
      "CommitResponse::Committed",
    ],
  },
  {
    id: "colleague-push",
    requirement: "simulate a colleague clone and push to the same remote",
    wdio: [
      'fixture.clone("peer")',
      '"peer pushes file"',
      'fixture.git(["push"], fixture.repoPath("peer"))',
      '"peer conflicting edit"',
    ],
    rust: [
      'let peer = fixture.clone_with_app("peer")',
      '"peer pushes file"',
      '"peer conflicting edit"',
      "commit_path_with_app(",
    ],
  },
  {
    id: "sync",
    requirement: "sync the local repository with the colleague push",
    wdio: [
      "await syncAllThroughUi()",
      '[data-testid="repository-sync-all"]',
      '"peer.txt"',
      "assertClean(fixture, localPath)",
    ],
    rust: [
      "crate::sync_current_branch",
      "SyncCurrentBranchStatus::Pulled",
      'local.read("peer.txt")',
      "assert_clean(&local)",
    ],
  },
  {
    id: "conflict",
    requirement: "create and surface a real Git conflict from diverged peers",
    wdio: [
      '"local conflicting edit"',
      '"peer conflicting edit"',
      "await waitForConflictOverlay",
      '[data-testid="conflict-resolution-overlay"]',
      "UU tracked\\.txt",
    ],
    rust: [
      "SyncCurrentBranchStatus::Conflicts",
      "conflict.files.iter()",
      '"tracked.txt"',
      "UU tracked.txt",
    ],
  },
  {
    id: "resolve",
    requirement: "resolve the conflict and return to a clean repository",
    wdio: [
      "resolveConflictWithOwnVersion",
      '[data-testid="conflict-detail-use-own"]',
      '[data-testid="conflict-complete"]',
      "assertClean(fixture, localPath)",
    ],
    rust: [
      "save_conflict_resolution",
      "complete_conflict_resolution",
      '"resolved full chain\\n"',
      "assert_clean(&local)",
    ],
  },
  {
    id: "revert",
    requirement: "revert the original local commit and push the revert",
    wdio: [
      "revertCommitThroughUi",
      '"history-commit-row"',
      "data-commit-id",
      '[data-testid="history-revert-open"]',
      '[data-testid="history-revert-confirm"]',
      'existsSync(path.join(fixture.repoPath("peer"), "local.txt"))',
    ],
    rust: [
      "crate::revert_commit",
      "RevertCommitRequest",
      "push_after_revert: true",
      "RevertCommitResponse::Reverted",
      'peer.path.join("local.txt").exists()',
    ],
  },
];

const gates = [
  {
    id: "wdio-real-git-only",
    requirement:
      "WDIO full-chain runs only when explicitly enabled with a real git-dist manifest",
    source: "wdio",
    tokens: [
      "ARTISTIC_GIT_E2E_REAL_GIT",
      "describe.skip",
      "ARTISTIC_GIT_DIST_DIR",
      "manifest.paths.gitExecutable",
      "spawnSync(this.gitPath",
      "PATH: path.dirname(gitPath)",
    ],
  },
  {
    id: "temporary-bare-remote",
    requirement:
      "both harnesses initialize a temporary bare remote, not a mock",
    source: "wdio",
    tokens: ['"init", "--bare", "-b", "main", remotePath'],
    extraSources: [
      {
        source: "rust",
        tokens: ['OsString::from("--bare")', "remote.git"],
      },
    ],
  },
  {
    id: "ui-no-backend-invoke",
    requirement:
      "WDIO full-chain must not use Tauri internals, appInvoke, or backend invoke probes",
    source: "wdio",
    forbidden: [
      "__TAURI_INTERNALS__",
      "\\bappInvoke\\b",
      "\\.invoke\\s*(?:<|\\()",
      "\\brepository_summary\\b",
    ],
    tokens: [
      '[data-testid="repository-sync-all"]',
      '[data-testid="conflict-resolution-overlay"]',
      '[data-testid="history-revert-confirm"]',
    ],
  },
  {
    id: "static-check-wired",
    requirement: "e2e:check runs the UI gate and the Phase 12 full-chain audit",
    source: "packageJson",
    scriptTokens: {
      "e2e:check": [
        "node scripts/check-e2e-real-ui.mjs",
        "node scripts/phase12-e2e-full-chain-audit.mjs --check",
      ],
      "phase12:e2e:audit": ["node scripts/phase12-e2e-full-chain-audit.mjs"],
    },
  },
  {
    id: "ci-linux-windows",
    requirement:
      "Linux and Windows CI can stage Git Distribution artifacts, run the Tauri E2E command, and upload real-git evidence",
    source: "ci",
    tokens: [
      "os: ubuntu-22.04",
      "os: windows-latest",
      "phase12_git_dist_run_id",
      "phase12_e2e_require_real_git_dist",
      "actions/download-artifact@v4",
      "artistic-git-dist-${{ matrix.gitDistTarget }}",
      "node scripts/activate-phase12-git-dist.mjs",
      "pnpm e2e:real-git:report",
      "ARTISTIC_GIT_E2E_REAL_GIT",
      "pnpm e2e:tauri:ci",
      "e2e-real-git-report-${{ matrix.os }}",
      "artifacts/e2e-real-git-report-*",
    ],
    extraSources: [
      {
        source: "gitDistActivator",
        tokens: [
          "ARTISTIC_GIT_PHASE12_GIT_DIST_SOURCE",
          "ARTISTIC_GIT_DIST_DIR",
          "chmodSync",
          "git/libexec/git-core",
          "manifest.paths",
        ],
      },
    ],
  },
  {
    id: "no-system-git-fallback",
    requirement:
      "real-git report verifies manifest sha256 evidence and refuses system Git fallback",
    source: "realGitReport",
    tokens: [
      "Refusing to search PATH or use system Git",
      "manifest.paths.gitExecutable",
      "manifest.paths.gitLfsExecutable",
      "manifest.sha256",
      "resolves outside ARTISTIC_GIT_DIST_DIR",
      "gitLfsViaGit",
    ],
  },
];

const coverage = coverageSteps.map((step) => {
  const missingWdio = missingTokens(sources.wdio, step.wdio);
  const missingRust = missingTokens(sources.rust, step.rust);
  return {
    id: step.id,
    missingRust,
    missingWdio,
    requirement: step.requirement,
    status:
      missingWdio.length === 0 && missingRust.length === 0 ? "covered" : "gap",
  };
});

const gateResults = gates.map((gate) => evaluateGate(gate));
const failures = [
  ...coverage
    .filter((step) => step.status !== "covered")
    .map(
      (step) =>
        `${step.id} coverage is missing WDIO tokens [${step.missingWdio.join(
          ", ",
        )}] and Rust tokens [${step.missingRust.join(", ")}]`,
    ),
  ...gateResults
    .filter((gate) => gate.status !== "pass")
    .map((gate) => `${gate.id}: ${gate.failures.join("; ")}`),
];

const report = {
  checkedAt: new Date().toISOString(),
  coverage,
  gates: gateResults,
  result: failures.length === 0 ? "static-pass" : "failed",
  runtimeEvidence: {
    command:
      "ARTISTIC_GIT_E2E_REAL_GIT=1 ARTISTIC_GIT_DIST_DIR=<real git-dist> pnpm e2e:tauri:ci",
    status: "not-run-by-audit",
    reason:
      "This audit proves the full-chain harness and CI gates are still wired. Linux/Windows WDIO runtime evidence is still required before checking the TASKS.md item.",
  },
  schemaVersion: 1,
  sources: sourceFiles,
  taskCheckable: false,
  taskCheckableReason:
    "Static audit passed, but no successful Linux/Windows real-git WDIO run artifact is attached by this command.",
};

if (!checkOnly) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
}

if (failures.length > 0) {
  console.error("Phase 12 full-chain E2E audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  if (!checkOnly) {
    console.error(`Wrote Phase 12 E2E audit report to ${reportPath}`);
  }
  process.exit(1);
}

const suffix = checkOnly ? "" : `; wrote ${reportPath}`;
console.log(`Phase 12 full-chain E2E audit static-pass${suffix}`);

function evaluateGate(gate) {
  const failures = [];
  const source = sources[gate.source];
  if (typeof source !== "string") {
    failures.push(`unknown source ${gate.source}`);
  } else {
    for (const token of gate.tokens ?? []) {
      if (!source.includes(token)) {
        failures.push(`${gate.source} is missing ${token}`);
      }
    }
    for (const pattern of gate.forbidden ?? []) {
      if (new RegExp(pattern).test(source)) {
        failures.push(`${gate.source} contains forbidden pattern ${pattern}`);
      }
    }
  }

  for (const extra of gate.extraSources ?? []) {
    const extraSource = sources[extra.source];
    for (const token of extra.tokens) {
      if (!extraSource?.includes(token)) {
        failures.push(`${extra.source} is missing ${token}`);
      }
    }
  }

  for (const [scriptName, tokens] of Object.entries(gate.scriptTokens ?? {})) {
    const script = packageJson.scripts?.[scriptName];
    if (typeof script !== "string") {
      failures.push(`package.json is missing script ${scriptName}`);
      continue;
    }
    for (const token of tokens) {
      if (!script.includes(token)) {
        failures.push(`${scriptName} script is missing ${token}`);
      }
    }
  }

  return {
    id: gate.id,
    failures,
    requirement: gate.requirement,
    status: failures.length === 0 ? "pass" : "fail",
  };
}

function missingTokens(source, tokens) {
  return tokens.filter((token) => !source.includes(token));
}

function renderMarkdown(value) {
  const lines = [
    "# Phase 12 E2E Full-Chain Audit",
    "",
    `- Result: ${value.result}`,
    `- Runtime evidence: ${value.runtimeEvidence.status}`,
    `- Task checkable: ${value.taskCheckable}`,
    "",
    "## Coverage",
    "",
    "| Step | Status | Requirement |",
    "| --- | --- | --- |",
    ...value.coverage.map(
      (step) => `| ${step.id} | ${step.status} | ${step.requirement} |`,
    ),
    "",
    "## Gates",
    "",
    "| Gate | Status | Requirement |",
    "| --- | --- | --- |",
    ...value.gates.map(
      (gate) => `| ${gate.id} | ${gate.status} | ${gate.requirement} |`,
    ),
    "",
    "## Runtime Requirement",
    "",
    "```sh",
    value.runtimeEvidence.command,
    "```",
    "",
  ];
  return `${lines.join(os.EOL)}${os.EOL}`;
}
