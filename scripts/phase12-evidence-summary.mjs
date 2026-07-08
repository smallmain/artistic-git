#!/usr/bin/env node
/* global console, process */

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
const e2eRequiredTargets =
  cli.e2eRequiredTargets.length > 0
    ? cli.e2eRequiredTargets
    : cli.requiredTargets.length > 0
      ? cli.requiredTargets
      : ["linux-x86_64", "windows-x86_64"];
const perfRequiredTargets =
  cli.perfRequiredTargets.length > 0
    ? cli.perfRequiredTargets
    : cli.requiredTargets.length > 0
      ? cli.requiredTargets
      : ["linux-x86_64", "macos-universal", "windows-x86_64"];
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

const summary = {
  schemaVersion: 1,
  kind: "phase12-evidence-summary",
  generatedAt: new Date().toISOString(),
  artifactsDir,
  requiredTargets: {
    e2eFullChain: e2eRequiredTargets,
    performance: perfRequiredTargets,
  },
  source: {
    jsonFileCount: reports.length,
    e2eReportCount: e2eReports.length,
    perfReportCount: perfReports.length,
  },
  tasks: {
    e2eFullChain: {
      task: "E2E 全链路：克隆 → 修改 → 提交 → 同事推送 → 同步 → 冲突 → 解决 → 撤回",
      checkable: e2e.checkable,
      status: e2e.status,
      targets: e2e.targets,
      blockers: e2e.blockers,
    },
    performance: {
      task: "性能验证：万级提交历史滚动/几万文件大树 status/LFS 巨型二进制",
      checkable: performance.checkable,
      status: performance.status,
      targets: performance.targets,
      blockers: performance.blockers,
    },
  },
  taskUpdates: [
    {
      task: "阶段 12 E2E 全链路",
      canCheckTask: e2e.checkable,
      evidenceField: "tasks.e2eFullChain.checkable",
      blockers: e2e.blockers,
    },
    {
      task: "阶段 12 性能验证",
      canCheckTask: performance.checkable,
      evidenceField: "tasks.performance.checkable",
      blockers: performance.blockers,
    },
  ],
};

mkdirSync(reportDir, { recursive: true });
const jsonPath = path.join(reportDir, "phase12-evidence-summary.json");
const markdownPath = path.join(reportDir, "phase12-evidence-summary.md");
writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(markdownPath, renderMarkdown(summary));

console.log(
  `Phase 12 evidence summary: E2E=${summary.tasks.e2eFullChain.status}, perf=${summary.tasks.performance.status}; wrote ${jsonPath}`,
);

function evaluateTask({
  reports: currentReports,
  requiredTargets,
  taskName,
  validator,
}) {
  const targets = {};
  const blockers = [];
  for (const target of requiredTargets) {
    const candidates = currentReports
      .filter((entry) => inferReportTarget(entry.content) === target)
      .map((entry) => ({
        ...entry,
        validation: validator(entry.content, target),
      }))
      .sort((left, right) => score(right.validation) - score(left.validation));
    const selected = candidates[0] ?? null;
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

    const targetResult = {
      status: selected.validation.status,
      checkable: selected.validation.checkable,
      reportPath: selected.filePath,
      reasons: selected.validation.reasons,
      artifactName: selected.content.gitDistSource?.artifactName ?? null,
      runId: selected.content.gitDistSource?.runId ?? null,
      source: selected.content.gitDistSource?.source ?? null,
    };
    targets[target] = targetResult;
    if (!targetResult.checkable) {
      blockers.push(
        `${taskName} ${target}: ${targetResult.reasons.join("; ")}`,
      );
    }
  }

  const checkable = requiredTargets.every(
    (target) => targets[target].checkable,
  );
  return {
    checkable,
    status: checkable
      ? "checkable"
      : blockers.some((blocker) =>
            /blocker|failed|failure|missing/i.test(blocker),
          )
        ? "blocked"
        : "not-ready",
    targets,
    blockers,
  };
}

function validateE2eReport(report, target) {
  const reasons = [];
  if (report.status !== "pass") {
    reasons.push(`status is ${report.status}`);
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
  validateArtifactBacked(report, target, reasons);
  if (report.taskReadiness?.platformEvidenceCheckable !== true) {
    reasons.push("platformEvidenceCheckable is not true");
  }
  validateExecutableEvidence(report, reasons);
  return {
    checkable: reasons.length === 0,
    status: reasons.length === 0 ? "pass" : (report.status ?? "blocked"),
    reasons,
  };
}

function validatePerfReport(report, target) {
  const reasons = [];
  const requiredChecks = ["historyPagination", "largeStatus", "largeBinaryLfs"];
  if (report.status !== "pass" || report.result !== "pass") {
    reasons.push(`status/result is ${report.status}/${report.result}`);
  }
  if (report.profileName !== "heavy" || report.heavy !== true) {
    reasons.push("heavy profile was not run");
  }
  validateHeavyProfileScale(report, reasons);
  validateArtifactBacked(report, target, reasons);
  validateExecutableEvidence(report, reasons);
  for (const checkName of requiredChecks) {
    const check = report.checks?.find((entry) => entry.name === checkName);
    if (check?.status !== "pass") {
      reasons.push(`${checkName} check is not pass`);
    }
  }
  if (report.taskReadiness?.platformEvidenceCheckable !== true) {
    reasons.push("platformEvidenceCheckable is not true");
  }
  return {
    checkable: reasons.length === 0,
    status: reasons.length === 0 ? "pass" : (report.status ?? "blocked"),
    reasons,
  };
}

function validateArtifactBacked(report, target, reasons) {
  const source = report.gitDistSource;
  if (source?.source !== "artifact") {
    reasons.push(`gitDistSource.source is ${source?.source ?? "missing"}`);
  }
  if (!source?.runId) {
    reasons.push("gitDistSource.runId is missing");
  }
  if (!source?.artifactName) {
    reasons.push("gitDistSource.artifactName is missing");
  }
  if (source?.target !== target) {
    reasons.push(
      `gitDistSource.target is ${source?.target ?? "missing"}, expected ${target}`,
    );
  }
}

function validateExecutableEvidence(report, reasons) {
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
      reasons.push(`${key} does not resolve inside ARTISTIC_GIT_DIST_DIR`);
    }
    if (
      typeof executable.sha256 !== "string" ||
      executable.sha256.length === 0 ||
      typeof executable.manifestSha256 !== "string" ||
      executable.manifestSha256.length === 0
    ) {
      reasons.push(`${key} is missing sha256/manifestSha256 evidence`);
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

function score(validation) {
  if (validation.checkable) {
    return 4;
  }
  if (validation.status === "blocker" || validation.status === "failed") {
    return 3;
  }
  if (validation.status === "skipped") {
    return 2;
  }
  return 1;
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
      for (const entry of readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else if (current.endsWith(".json")) {
      results.push(current);
    }
  }
  return results;
}

function inferReportTarget(report) {
  return report.target ?? report.gitDistSource?.target ?? null;
}

function renderMarkdown(value) {
  const lines = [
    "# Phase 12 Evidence Summary",
    "",
    `Artifacts: ${value.artifactsDir}`,
    `E2E required targets: ${value.requiredTargets.e2eFullChain.join(", ")}`,
    `Performance required targets: ${value.requiredTargets.performance.join(", ")}`,
    "",
    "| TASKS.md item | Checkable | Status |",
    "| --- | --- | --- |",
    `| E2E full-chain | ${value.tasks.e2eFullChain.checkable ? "yes" : "no"} | ${value.tasks.e2eFullChain.status} |`,
    `| Performance | ${value.tasks.performance.checkable ? "yes" : "no"} | ${value.tasks.performance.status} |`,
  ];

  for (const [taskKey, task] of Object.entries(value.tasks)) {
    lines.push("", `## ${taskKey}`, "");
    lines.push("| Target | Checkable | Status | Run | Artifact |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const [target, result] of Object.entries(task.targets)) {
      lines.push(
        `| ${target} | ${result.checkable ? "yes" : "no"} | ${result.status} | ${result.runId ?? "n/a"} | ${result.artifactName ?? "n/a"} |`,
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
