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
    id: "wdio-embedded-git-required",
    requirement:
      "WDIO full-chain uses the embedded Git tree installed beside the debug application",
    source: "wdio",
    requiredPatterns: [
      'const\\s+installedGitDistDir\\s*=\\s*path\\.join\\(\\s*repositoryRoot\\s*,\\s*"target"\\s*,\\s*"debug"\\s*,\\s*"git-dist"\\s*,?\\s*\\);',
    ],
    tokens: [
      'describe("Artistic Git Tauri real-git full chain"',
      "installedGitDistDir",
      "manifest.paths.gitExecutable",
      "spawnSync(this.gitPath",
      "createEmbeddedGitEnv",
      "GIT_EXEC_PATH",
      "git/libexec/git-core",
    ],
    forbidden: [
      "describe\\.skip",
      'path\\.join\\(\\s*repositoryRoot\\s*,\\s*"src-tauri"\\s*,\\s*"resources"\\s*,\\s*"git-dist"\\s*,?\\s*\\)',
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
      "Linux and Windows CI ensure the embedded toolchain, run Tauri E2E, and upload evidence",
    source: "ci",
    customCheck: evaluateCiWorkflowContract,
    tokens: [
      "git-toolchain:ensure",
      "pnpm e2e:real-git:report",
      "pnpm e2e:tauri:ci",
      "e2e-real-git-report-${{ matrix.os }}",
      "artifacts/e2e-real-git-report-*",
    ],
  },
  {
    id: "no-system-git-fallback",
    requirement:
      "real-git report verifies manifest sha256 evidence and refuses system Git fallback",
    source: "realGitReport",
    tokens: [
      "const gitDistDir = path.join(",
      "manifest.paths.gitExecutable",
      "manifest.paths.gitLfsExecutable",
      "manifest.sha256",
      "resolves outside the embedded Git resource directory",
      "runTool(\n  gitEvidence.absolutePath",
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
    command: "pnpm e2e:tauri:ci",
    status: "not-run-by-audit",
    reason:
      "This audit proves the full-chain harness and CI gates are still wired. Linux/Windows WDIO runtime evidence is still required before checking the TASKS.md item.",
  },
  schemaVersion: 1,
  sources: sourceFiles,
  taskCheckable: false,
  taskCheckableReason:
    "Static audit passed, but successful Linux/Windows real-git WDIO runtime evidence is still required.",
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
    for (const pattern of gate.requiredPatterns ?? []) {
      if (!new RegExp(pattern).test(source)) {
        failures.push(`${gate.source} is missing required pattern ${pattern}`);
      }
    }
    for (const pattern of gate.forbidden ?? []) {
      if (new RegExp(pattern).test(source)) {
        failures.push(`${gate.source} contains forbidden pattern ${pattern}`);
      }
    }
  }

  if (gate.customCheck && typeof source === "string") {
    failures.push(...gate.customCheck(source));
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

function evaluateCiWorkflowContract(source) {
  const failures = [];
  const testJob = workflowJob(source, "test", "e2e", failures);
  const e2eJob = workflowJob(
    source,
    "e2e",
    "phase12-evidence-summary",
    failures,
  );
  const summaryJob = workflowJob(
    source,
    "phase12-evidence-summary",
    null,
    failures,
  );

  requireTokens(
    source,
    ["pull_request:", "push:", "workflow_dispatch:"],
    failures,
  );
  requireTokens(
    testJob,
    [
      "(github.event_name != 'workflow_dispatch' || inputs.platform_scope == 'all')",
      "inputs.platform_scope == 'windows' &&",
      "inputs.platform_scope == 'linux' &&",
    ],
    failures,
    "test job",
  );
  requireTokens(
    e2eJob,
    [
      "if: github.event_name != 'workflow_dispatch' || inputs.platform_scope != 'macos'",
      "(github.event_name != 'workflow_dispatch' || inputs.platform_scope == 'all')",
      "inputs.platform_scope == 'windows' &&",
      "inputs.platform_scope == 'linux' &&",
    ],
    failures,
    "e2e job",
  );

  compareMatrixPlatforms(
    testJob,
    [
      ["ubuntu-22.04", "macos-latest", "windows-latest"],
      ["windows-latest"],
      ["ubuntu-22.04"],
      ["macos-latest"],
    ],
    "test job",
    failures,
  );
  compareMatrixPlatforms(
    e2eJob,
    [["ubuntu-22.04", "windows-latest"], ["windows-latest"], ["ubuntu-22.04"]],
    "e2e job",
    failures,
  );

  if (/\n\s+needs:\s+test(?:\s|$)/.test(e2eJob)) {
    failures.push("e2e job must run in parallel and must not need test");
  }
  requireTokens(
    summaryJob,
    [
      "needs:\n      - test\n      - e2e",
      "(github.event_name != 'workflow_dispatch' || inputs.platform_scope == 'all')",
    ],
    failures,
    "phase12 evidence summary job",
  );

  return failures;
}

function workflowJob(source, jobName, nextJobName, failures) {
  const start = source.indexOf(`\n  ${jobName}:\n`);
  if (start === -1) {
    failures.push(`ci is missing ${jobName} job`);
    return "";
  }

  if (nextJobName === null) {
    return source.slice(start);
  }

  const end = source.indexOf(`\n  ${nextJobName}:\n`, start + 1);
  if (end === -1) {
    failures.push(`ci is missing ${nextJobName} job after ${jobName}`);
    return source.slice(start);
  }
  return source.slice(start, end);
}

function requireTokens(source, tokens, failures, sourceLabel = "ci") {
  for (const token of tokens) {
    if (!source.includes(token)) {
      failures.push(`${sourceLabel} is missing ${token}`);
    }
  }
}

function compareMatrixPlatforms(jobSource, expected, sourceLabel, failures) {
  let actual;
  try {
    actual = [...jobSource.matchAll(/'(\[\{[^\n]+\}\])'/g)].map((match) =>
      JSON.parse(match[1]).map((entry) => entry.os),
    );
  } catch (error) {
    failures.push(`${sourceLabel} matrix JSON is invalid: ${error.message}`);
    return;
  }

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${sourceLabel} matrix platforms are ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
    );
  }
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
