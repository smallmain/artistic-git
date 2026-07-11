#!/usr/bin/env node
/* global console, process */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = parseArgs(process.argv.slice(2));
const artifactsDir = path.resolve(
  cli.artifactsDir ??
    process.env.ARTISTIC_GIT_PHASE12_EVIDENCE_ARTIFACTS_DIR ??
    "artifacts",
);
const reportDir = path.resolve(
  cli.reportDir ??
    process.env.ARTISTIC_GIT_PHASE12_EVIDENCE_REPORT_DIR ??
    path.join("artifacts", "phase12-evidence-summary"),
);
const e2eRequiredTargets = selectRequiredTargets(
  cli.e2eRequiredTargets,
  cli.requiredTargets,
  ["linux-x86_64", "windows-x86_64"],
);
const perfRequiredTargets = selectRequiredTargets(
  cli.perfRequiredTargets,
  cli.requiredTargets,
  ["linux-x86_64", "macos-universal", "windows-x86_64"],
);
const currentHeadSha = normalizeOptionalString(
  cli.currentHeadSha ??
    process.env.ARTISTIC_GIT_PHASE12_EVIDENCE_CURRENT_HEAD_SHA ??
    resolveCurrentHeadSha(),
);
const reports = loadReports(artifactsDir);
const e2eReports = reports.filter(
  (entry) => entry.content.kind === "phase12-e2e-full-chain-runtime",
);
const perfReports = reports.filter(
  (entry) => entry.content.kind === "phase12-perf",
);

const e2e = evaluateTask({
  reports: e2eReports,
  requiredTargets: e2eRequiredTargets,
  taskName: "E2E full-chain",
  validator: validateE2eReport,
});
const performance = evaluateTask({
  reports: perfReports,
  requiredTargets: perfRequiredTargets,
  taskName: "Performance",
  validator: validatePerfReport,
});
const checkable = e2e.checkable && performance.checkable;

const summary = {
  schemaVersion: 3,
  kind: "phase12-evidence-summary",
  generatedAt: new Date().toISOString(),
  status: checkable ? "pass" : "blocker",
  artifactsDir,
  requiredTargets: {
    e2eFullChain: e2eRequiredTargets,
    performance: perfRequiredTargets,
  },
  source: {
    currentHeadSha,
    jsonFileCount: reports.length,
    e2eReportCount: e2eReports.length,
    perfReportCount: perfReports.length,
  },
  tasks: {
    e2eFullChain: {
      task: "E2E 全链路：克隆 → 修改 → 提交 → 同事推送 → 同步 → 冲突 → 解决 → 撤回",
      ...e2e,
    },
    performance: {
      task: "性能验证：万级提交历史滚动/几万文件大树 status/LFS 巨型二进制",
      ...performance,
    },
  },
};

mkdirSync(reportDir, { recursive: true });
const jsonPath = path.join(reportDir, "phase12-evidence-summary.json");
const markdownPath = path.join(reportDir, "phase12-evidence-summary.md");
writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(markdownPath, renderMarkdown(summary));

console.log(
  `Phase 12 evidence summary: E2E=${e2e.status}, perf=${performance.status}; wrote ${jsonPath}`,
);
if (!checkable) {
  process.exitCode = 1;
}

function selectRequiredTargets(primary, shared, defaults) {
  if (primary.length > 0) {
    return primary;
  }
  if (shared.length > 0) {
    return shared;
  }
  return defaults;
}

function evaluateTask({
  reports: candidates,
  requiredTargets,
  taskName,
  validator,
}) {
  const targets = {};
  const blockers = [];
  for (const target of requiredTargets) {
    const selected = candidates
      .filter((entry) => inferReportTarget(entry.content) === target)
      .map((entry) => ({
        ...entry,
        validation: validator(entry.content, target),
      }))
      .sort(
        (left, right) =>
          score(right.validation) - score(left.validation) ||
          compareReportsByNewest(left, right),
      )[0];

    if (!selected) {
      const reason = `${taskName} is missing ${target} evidence.`;
      targets[target] = {
        status: "missing",
        checkable: false,
        reportPath: null,
        reasons: [reason],
      };
      blockers.push(reason);
      continue;
    }

    targets[target] = {
      status: selected.validation.status,
      checkable: selected.validation.checkable,
      reportPath: selected.filePath,
      reasons: selected.validation.reasons,
      toolchain: summarizeToolchain(selected.content),
    };
    if (!selected.validation.checkable) {
      blockers.push(
        `${taskName} ${target}: ${selected.validation.reasons.join("; ")}`,
      );
    }
  }

  const taskCheckable = requiredTargets.every(
    (target) => targets[target].checkable,
  );
  return {
    checkable: taskCheckable,
    status: taskCheckable ? "pass" : "blocker",
    targets,
    blockers,
  };
}

function validateE2eReport(report, target) {
  const reasons = [];
  validateFreshSha(report.ci?.sha, `E2E ${target} runtime evidence`, reasons);
  if (report.status !== "pass" || report.result !== "pass") {
    reasons.push(`status/result is ${report.status}/${report.result}`);
  }
  if (report.availabilityReport?.status !== "ready") {
    reasons.push(
      `availability status is ${report.availabilityReport?.status ?? "missing"}`,
    );
  }
  if (report.wdio?.selectedOutcome !== "success") {
    reasons.push(
      `WDIO selected outcome is ${report.wdio?.selectedOutcome ?? "missing"}`,
    );
  }
  if (report.taskReadiness?.platformEvidenceCheckable !== true) {
    reasons.push("platformEvidenceCheckable is not true");
  }
  validateEmbeddedToolchain(report, target, reasons);
  return validation(reasons);
}

function validatePerfReport(report, target) {
  const reasons = [];
  const requiredChecks = ["historyPagination", "largeStatus", "largeBinaryLfs"];
  validateFreshSha(
    report.ci?.sha ?? report.environment?.repository?.head,
    `Performance ${target} runtime evidence`,
    reasons,
  );
  if (report.status !== "pass" || report.result !== "pass") {
    reasons.push(`status/result is ${report.status}/${report.result}`);
  }
  if (report.profileName !== "heavy" || report.heavy !== true) {
    reasons.push("heavy profile was not run");
  }
  validateHeavyProfileScale(report, reasons);
  for (const name of requiredChecks) {
    if (
      report.checks?.find((entry) => entry.name === name)?.status !== "pass"
    ) {
      reasons.push(`${name} check is not pass`);
    }
  }
  if (report.taskReadiness?.platformEvidenceCheckable !== true) {
    reasons.push("platformEvidenceCheckable is not true");
  }
  validateEmbeddedToolchain(report, target, reasons);
  return validation(reasons);
}

function validateEmbeddedToolchain(report, target, reasons) {
  const source = report.gitDistSource;
  if (source?.source !== "workspace-resource") {
    reasons.push(`gitDistSource.source is ${source?.source ?? "missing"}`);
  }
  if (source?.target !== target) {
    reasons.push(
      `gitDistSource.target is ${source?.target ?? "missing"}, expected ${target}`,
    );
  }

  const manifest = report.gitDist?.manifest;
  if (manifest?.schemaVersion !== 2) {
    reasons.push(
      `embedded manifest schemaVersion is ${manifest?.schemaVersion ?? "missing"}`,
    );
  }
  if (manifest?.target !== target) {
    reasons.push(
      `embedded manifest target is ${manifest?.target ?? "missing"}, expected ${target}`,
    );
  }
  for (const field of [
    "toolchainRevision",
    "baseFingerprint",
    "helperFingerprint",
    "distributionFingerprint",
  ]) {
    if (!normalizeOptionalString(manifest?.[field])) {
      reasons.push(`embedded manifest ${field} is missing`);
    }
  }

  const executables = report.gitDist?.executableEvidence;
  if (!Array.isArray(executables) || executables.length < 2) {
    reasons.push("gitDist.executableEvidence is incomplete");
    return;
  }
  for (const key of ["gitExecutable", "gitLfsExecutable"]) {
    const executable = executables.find((entry) => entry.key === key);
    if (!executable) {
      reasons.push(`gitDist.executableEvidence is missing ${key}`);
      continue;
    }
    if (executable.resolvesInsideDistDir !== true) {
      reasons.push(`${key} does not resolve inside the embedded resource tree`);
    }
    if (
      !normalizeOptionalString(executable.sha256) ||
      !normalizeOptionalString(executable.manifestSha256)
    ) {
      reasons.push(`${key} is missing sha256/manifestSha256 evidence`);
    } else if (executable.sha256 !== executable.manifestSha256) {
      reasons.push(`${key} sha256 does not match manifestSha256`);
    }
  }
}

function validateHeavyProfileScale(report, reasons) {
  const minimums = {
    binaryBytes: 128 * 1024 * 1024,
    commitCount: 10_000,
    fileCount: 50_000,
  };
  for (const [key, minimum] of Object.entries(minimums)) {
    const actual = report.profile?.[key];
    if (typeof actual !== "number" || actual < minimum) {
      reasons.push(
        `profile.${key} is ${actual ?? "missing"}, expected >= ${minimum}`,
      );
    }
  }
}

function validateFreshSha(actualSha, evidenceKind, reasons) {
  if (!currentHeadSha) {
    return;
  }
  const normalized = normalizeOptionalString(actualSha);
  if (!normalized) {
    reasons.push(`${evidenceKind} is missing commit SHA evidence`);
  } else if (!sameCommitSha(normalized, currentHeadSha)) {
    reasons.push(
      `${evidenceKind} commit ${normalized} does not match current HEAD ${currentHeadSha}`,
    );
  }
}

function validation(reasons) {
  return {
    checkable: reasons.length === 0,
    status: reasons.length === 0 ? "pass" : "blocker",
    reasons,
  };
}

function summarizeToolchain(report) {
  const manifest = report.gitDist?.manifest ?? {};
  return {
    target: manifest.target ?? null,
    toolchainRevision: manifest.toolchainRevision ?? null,
    baseFingerprint: manifest.baseFingerprint ?? null,
    helperFingerprint: manifest.helperFingerprint ?? null,
    distributionFingerprint: manifest.distributionFingerprint ?? null,
  };
}

function score(result) {
  return result.checkable ? 2 : 1;
}

function loadReports(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }
  return listJsonFiles(rootDir).flatMap((filePath) => {
    try {
      return [
        {
          filePath,
          mtimeMs: statSync(filePath).mtimeMs,
          content: JSON.parse(readFileSync(filePath, "utf8")),
        },
      ];
    } catch {
      return [];
    }
  });
}

function listJsonFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current).sort()) {
        stack.push(path.join(current, entry));
      }
    } else if (current.endsWith(".json")) {
      results.push(current);
    }
  }
  return results;
}

function inferReportTarget(report) {
  return (
    report.target ??
    report.gitDistSource?.target ??
    report.gitDist?.manifest?.target ??
    null
  );
}

function compareReportsByNewest(left, right) {
  const timeDelta = reportTime(right) - reportTime(left);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  const mtimeDelta = (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0);
  return mtimeDelta !== 0
    ? mtimeDelta
    : left.filePath.localeCompare(right.filePath);
}

function reportTime(entry) {
  const parsed = Date.parse(entry.content.generatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : (entry.mtimeMs ?? 0);
}

function resolveCurrentHeadSha() {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sameCommitSha(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return (
    a === b ||
    (a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)))
  );
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function renderMarkdown(value) {
  const lines = [
    "# Phase 12 Evidence Summary",
    "",
    `Status: ${value.status}`,
    `Artifacts: ${value.artifactsDir}`,
    "",
    "| Task | Checkable | Status |",
    "| --- | --- | --- |",
    `| E2E full-chain | ${value.tasks.e2eFullChain.checkable ? "yes" : "no"} | ${value.tasks.e2eFullChain.status} |`,
    `| Performance | ${value.tasks.performance.checkable ? "yes" : "no"} | ${value.tasks.performance.status} |`,
  ];
  for (const [taskName, task] of Object.entries(value.tasks)) {
    lines.push(
      "",
      `## ${taskName}`,
      "",
      "| Target | Checkable | Status | Report |",
      "| --- | --- | --- | --- |",
    );
    for (const [target, result] of Object.entries(task.targets)) {
      lines.push(
        `| ${target} | ${result.checkable ? "yes" : "no"} | ${result.status} | ${result.reportPath ?? "n/a"} |`,
      );
    }
    if (task.blockers.length > 0) {
      lines.push("", "Blockers:");
      for (const blocker of task.blockers) {
        lines.push(`- ${blocker}`);
      }
    }
  }
  lines.push("");
  return `${lines.join(os.EOL)}${os.EOL}`;
}

function parseArgs(args) {
  const parsed = {
    artifactsDir: null,
    currentHeadSha: null,
    e2eRequiredTargets: [],
    perfRequiredTargets: [],
    reportDir: null,
    requiredTargets: [],
  };
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      parsed.artifactsDir = arg.slice("--artifacts-dir=".length);
    } else if (arg.startsWith("--current-head-sha=")) {
      parsed.currentHeadSha = arg.slice("--current-head-sha=".length);
    } else if (arg.startsWith("--e2e-required-targets=")) {
      parsed.e2eRequiredTargets = parseTargetList(
        arg.slice("--e2e-required-targets=".length),
      );
    } else if (arg.startsWith("--perf-required-targets=")) {
      parsed.perfRequiredTargets = parseTargetList(
        arg.slice("--perf-required-targets=".length),
      );
    } else if (arg.startsWith("--report-dir=")) {
      parsed.reportDir = arg.slice("--report-dir=".length);
    } else if (arg.startsWith("--required-targets=")) {
      parsed.requiredTargets = parseTargetList(
        arg.slice("--required-targets=".length),
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function parseTargetList(value) {
  return value
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
}
