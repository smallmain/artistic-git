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
const gitDistBuildReports = reports.filter(
  (entry) => entry.content.workflowBuild?.schemaVersion === 1,
);
const gitDistSourceReports = reports.filter(
  (entry) => entry.content.mode === "source-evidence-only",
);
const gitDistBlockerReports = reports.filter(
  (entry) => entry.content.workflowBuild?.target?.blocked === true,
);
const gitDistRequiredTargets = Array.from(
  new Set([...e2eRequiredTargets, ...perfRequiredTargets]),
);
const gitDistribution = evaluateGitDistributionEvidence({
  buildReports: gitDistBuildReports,
  blockerReports: gitDistBlockerReports,
  requiredTargets: gitDistRequiredTargets,
  sourceReports: gitDistSourceReports,
});

const e2e = evaluateTask({
  reports: e2eReports,
  requiredTargets: e2eRequiredTargets,
  taskName: "E2E full-chain",
  gitDistribution,
  validator: validateE2eReport,
});
const performance = evaluateTask({
  reports: perfReports,
  requiredTargets: perfRequiredTargets,
  taskName: "Performance",
  gitDistribution,
  validator: validatePerfReport,
});

const summary = {
  schemaVersion: 2,
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
    gitDistBuildReportCount: gitDistBuildReports.length,
    gitDistSourceReportCount: gitDistSourceReports.length,
    gitDistBlockerReportCount: gitDistBlockerReports.length,
  },
  gitDistribution,
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
  gitDistribution: currentGitDistribution,
  validator,
}) {
  const targets = {};
  const blockers = [];
  for (const target of requiredTargets) {
    const candidates = currentReports
      .filter((entry) => inferReportTarget(entry.content) === target)
      .map((entry) => ({
        ...entry,
        validation: mergeValidations(
          validator(entry.content, target),
          validateRuntimeGitDistBuildEvidence(
            entry.content,
            target,
            currentGitDistribution.targets[target] ?? null,
          ),
        ),
      }))
      .sort(
        (left, right) =>
          score(right.validation) - score(left.validation) ||
          compareReportsByNewest(left, right),
      );
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

    const gitDistEvidence = currentGitDistribution.targets[target] ?? null;
    const targetResult = {
      status: selected.validation.status,
      checkable: selected.validation.checkable,
      reportPath: selected.filePath,
      reasons: selected.validation.reasons,
      artifactName: selected.content.gitDistSource?.artifactName ?? null,
      runId: selected.content.gitDistSource?.runId ?? null,
      source: selected.content.gitDistSource?.source ?? null,
      gitDistEvidence,
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

function evaluateGitDistributionEvidence({
  buildReports,
  blockerReports,
  requiredTargets,
  sourceReports,
}) {
  const targets = {};
  const blockers = [];
  for (const target of requiredTargets) {
    const buildCandidates = buildReports
      .filter((entry) => entry.content.workflowBuild?.target?.name === target)
      .map((entry) => ({
        ...entry,
        validation: validateGitDistBuildEvidence(entry.content, target),
      }))
      .sort(
        (left, right) =>
          scoreGitDistBuild(right.validation) -
            scoreGitDistBuild(left.validation) ||
          compareReportsByNewest(left, right),
      );
    const selectedBuild = buildCandidates[0] ?? null;
    const selectedSource =
      sourceReports
        .filter((entry) => entry.content.target?.name === target)
        .sort(compareReportsByNewest)[0] ?? null;
    const selectedBlocker =
      blockerReports
        .filter((entry) => entry.content.workflowBuild?.target?.name === target)
        .sort(compareReportsByNewest)[0] ?? null;

    const sourceArchiveValidation =
      selectedBuild?.content.workflowBuild?.sourceArchiveValidation ??
      (selectedSource
        ? sourceArchiveValidationFromStandalone(selectedSource.content)
        : null);
    const sourceArchive =
      sourceArchiveValidation &&
      validateSourceArchiveValidation(sourceArchiveValidation);

    const targetResult = {
      status: "missing",
      reusableArtifactCheckable: false,
      sourceArchiveCheckable: sourceArchive?.checkable ?? false,
      buildEvidencePath: selectedBuild?.filePath ?? null,
      sourceEvidencePath: selectedSource?.filePath ?? null,
      blockerEvidencePath: selectedBlocker?.filePath ?? null,
      runId: selectedBuild?.content.workflowBuild?.run?.runId ?? null,
      artifactName:
        selectedBuild?.content.workflowBuild?.target?.artifactName ??
        selectedSource?.content.target?.artifactName ??
        `artistic-git-dist-${target}`,
      build: selectedBuild
        ? {
            status: selectedBuild.validation.status,
            reusableArtifactProduced:
              selectedBuild.content.workflowBuild?.validationSummary
                ?.reusableArtifactProduced ?? null,
            targetStatus:
              selectedBuild.content.workflowBuild?.target?.status ?? null,
            blocked:
              selectedBuild.content.workflowBuild?.target?.blocked ?? null,
            reasons: selectedBuild.validation.reasons,
          }
        : null,
      sourceArchive: sourceArchive
        ? {
            status: sourceArchiveValidation.status,
            checkable: sourceArchive.checkable,
            summary: sourceArchiveValidation.summary ?? null,
            checkedComponents: sourceArchive.checkedComponents,
            blockedComponents: sourceArchive.blockedComponents,
            reasons: sourceArchive.reasons,
          }
        : null,
      blockers: [],
    };

    if (selectedBuild) {
      targetResult.reusableArtifactCheckable =
        selectedBuild.validation.checkable;
      if (selectedBuild.validation.checkable) {
        targetResult.status = "reusable-ready";
      } else if (sourceArchive?.checkable) {
        targetResult.status = "source-partial";
      } else if (selectedBuild.content.workflowBuild?.target?.blocked) {
        targetResult.status = "blocked";
      } else {
        targetResult.status = selectedBuild.validation.status;
      }
      targetResult.blockers.push(...selectedBuild.validation.reasons);
    } else if (sourceArchive?.checkable) {
      targetResult.status = "source-partial";
      targetResult.blockers.push(
        `git-dist ${target} reusable build evidence is missing.`,
      );
    } else {
      targetResult.blockers.push(
        `git-dist ${target} build evidence is missing.`,
      );
    }

    if (sourceArchive && !sourceArchive.checkable) {
      targetResult.blockers.push(...sourceArchive.reasons);
    }
    if (!targetResult.reusableArtifactCheckable) {
      blockers.push(`git-dist ${target}: ${targetResult.blockers.join("; ")}`);
    }
    targets[target] = targetResult;
  }

  return {
    requiredTargets,
    targets,
    blockers,
  };
}

function validateGitDistBuildEvidence(report, target) {
  const reasons = [];
  const build = report.workflowBuild;
  if (build?.target?.name !== target) {
    reasons.push(
      `workflowBuild.target.name is ${build?.target?.name ?? "missing"}, expected ${target}`,
    );
  }
  if (build?.mode !== "build") {
    reasons.push(`workflowBuild.mode is ${build?.mode ?? "missing"}`);
  }
  if (build?.target?.blocked === true || build?.target?.status !== "ready") {
    reasons.push(
      `target is ${build?.target?.status ?? "missing"} blocked=${String(
        build?.target?.blocked,
      )}`,
    );
  }
  if (build?.validationSummary?.reusableArtifactProduced !== true) {
    reasons.push("reusableArtifactProduced is not true");
  }
  if (
    !["validated-cache-hit", "validated-fresh-build"].includes(
      build?.validationSummary?.status,
    )
  ) {
    reasons.push(
      `validationSummary.status is ${build?.validationSummary?.status ?? "missing"}`,
    );
  }
  const reusableArtifact = Array.isArray(build?.artifactIndex)
    ? build.artifactIndex.find(
        (artifact) => artifact.kind === "reusable-git-dist",
      )
    : null;
  if (reusableArtifact?.produced !== true) {
    reasons.push("reusable git-dist artifact was not produced");
  }
  const commands = build?.validationSummary?.commands;
  if (!Array.isArray(commands)) {
    reasons.push("validationSummary.commands is missing");
  } else {
    if (
      !commands.includes(`node scripts/check-git-dist.mjs --target="${target}"`)
    ) {
      reasons.push("target runtime check-git-dist validation is missing");
    }
    if (commands.some((command) => String(command).includes("--no-exec"))) {
      reasons.push("build evidence contains --no-exec validation");
    }
  }

  return {
    checkable: reasons.length === 0,
    status: reasons.length === 0 ? "pass" : "blocked",
    reasons,
  };
}

function scoreGitDistBuild(validation) {
  if (validation.checkable) {
    return 4;
  }
  if (validation.status === "blocked") {
    return 3;
  }
  return 1;
}

function sourceArchiveValidationFromStandalone(evidence) {
  return {
    status: evidence.status,
    produced: true,
    evidencePath: null,
    evidenceArtifactName: `git-dist-source-evidence-${evidence.target?.name ?? "unknown"}`,
    summary: evidence.summary,
    sources: Array.isArray(evidence.sources)
      ? evidence.sources.map((source) => ({
          ref: source.ref,
          component: source.component,
          status: source.status,
          stable: source.stable,
          placeholder: source.placeholder,
          reason: source.reason,
          expectedSha256: source.checksum?.expectedSha256 ?? null,
          actualSha256: source.actualSha256 ?? null,
          cachePath: source.cachePath ?? null,
          url: source.url,
          assetName: source.assetName,
        }))
      : [],
  };
}

function validateSourceArchiveValidation(evidence) {
  const reasons = [];
  const checkedComponents = [];
  const blockedComponents = [];
  if (evidence.produced !== true) {
    reasons.push("source archive evidence was not produced");
  }
  if (!["passed", "partial"].includes(evidence.status)) {
    reasons.push(`source archive status is ${evidence.status ?? "missing"}`);
  }
  if (
    typeof evidence.summary?.checked !== "number" ||
    evidence.summary.checked < 1
  ) {
    reasons.push("source archive evidence checked no stable sources");
  }
  if (!Array.isArray(evidence.sources)) {
    reasons.push("source archive evidence sources are missing");
  } else {
    for (const source of evidence.sources) {
      if (source.status === "checked") {
        checkedComponents.push(source.component);
        if (!source.stable || source.placeholder) {
          reasons.push(`${source.component} checked source is not stable`);
        }
        if (
          !source.expectedSha256 ||
          !source.actualSha256 ||
          source.expectedSha256 !== source.actualSha256
        ) {
          reasons.push(
            `${source.component} checked SHA-256 evidence is invalid`,
          );
        }
      } else if (source.status === "skipped-blocked") {
        blockedComponents.push(source.component);
        if (!source.reason) {
          reasons.push(`${source.component} blocked source is missing reason`);
        }
      }
    }
  }

  return {
    checkable: reasons.length === 0,
    reasons,
    checkedComponents,
    blockedComponents,
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

function validateRuntimeGitDistBuildEvidence(report, target, gitDistEvidence) {
  const source = report.gitDistSource;
  if (source?.source !== "artifact") {
    return {
      checkable: true,
      status: "pass",
      reasons: [],
    };
  }

  const reasons = [];
  if (!gitDistEvidence?.buildEvidencePath) {
    reasons.push(
      `git-dist ${target} build evidence is missing for artifact-backed report`,
    );
  } else {
    if (gitDistEvidence.reusableArtifactCheckable !== true) {
      reasons.push(
        `git-dist ${target} reusable build evidence is not checkable`,
      );
    }

    const sourceRunId = normalizeComparable(source.runId);
    const buildRunId = normalizeComparable(gitDistEvidence.runId);
    if (!buildRunId) {
      reasons.push(`git-dist ${target} build evidence runId is missing`);
    } else if (sourceRunId && sourceRunId !== buildRunId) {
      reasons.push(
        `gitDistSource.runId ${sourceRunId} does not match git-dist build evidence runId ${buildRunId}`,
      );
    }

    const sourceArtifactName = normalizeComparable(source.artifactName);
    const buildArtifactName = normalizeComparable(gitDistEvidence.artifactName);
    if (!buildArtifactName) {
      reasons.push(`git-dist ${target} build evidence artifactName is missing`);
    } else if (sourceArtifactName && sourceArtifactName !== buildArtifactName) {
      reasons.push(
        `gitDistSource.artifactName ${sourceArtifactName} does not match git-dist build evidence artifactName ${buildArtifactName}`,
      );
    }
  }

  return {
    checkable: reasons.length === 0,
    status: reasons.length === 0 ? "pass" : "blocked",
    reasons,
  };
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
    } else if (executable.sha256 !== executable.manifestSha256) {
      reasons.push(`${key} sha256 does not match manifestSha256`);
    }
  }
}

function mergeValidations(...validations) {
  const reasons = validations.flatMap((validation) => validation.reasons ?? []);
  if (reasons.length === 0) {
    return {
      checkable: true,
      status: "pass",
      reasons,
    };
  }
  const firstFailing = validations.find(
    (validation) =>
      (validation.reasons?.length ?? 0) > 0 && validation.status !== "pass",
  );
  return {
    checkable: false,
    status:
      firstFailing?.status && firstFailing.status !== "pass"
        ? firstFailing.status
        : "blocked",
    reasons,
  };
}

function normalizeComparable(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
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
      const stat = statSync(filePath);
      return [
        {
          filePath,
          mtimeMs: stat.mtimeMs,
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
  return report.target ?? report.gitDistSource?.target ?? null;
}

function compareReportsByNewest(left, right) {
  const timeDelta = reportTime(right) - reportTime(left);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  const runDelta = reportRunId(right) - reportRunId(left);
  if (runDelta !== 0) {
    return runDelta;
  }
  const mtimeDelta = (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0);
  if (mtimeDelta !== 0) {
    return mtimeDelta;
  }
  return left.filePath.localeCompare(right.filePath);
}

function reportTime(entry) {
  const value =
    entry.content.generatedAt ??
    entry.content.workflowBuild?.generatedAt ??
    entry.content.workflowBuild?.run?.createdAt ??
    entry.content.ci?.createdAt ??
    null;
  const parsed = Date.parse(value ?? "");
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return entry.mtimeMs ?? 0;
}

function reportRunId(entry) {
  const value =
    entry.content.gitDistSource?.runId ??
    entry.content.workflowBuild?.run?.runId ??
    entry.content.ci?.runId ??
    null;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderMarkdown(value) {
  const lines = [
    "# Phase 12 Evidence Summary",
    "",
    `Artifacts: ${value.artifactsDir}`,
    `E2E required targets: ${value.requiredTargets.e2eFullChain.join(", ")}`,
    `Performance required targets: ${value.requiredTargets.performance.join(", ")}`,
    `Git Distribution evidence targets: ${value.gitDistribution.requiredTargets.join(", ")}`,
    "",
    "| TASKS.md item | Checkable | Status |",
    "| --- | --- | --- |",
    `| E2E full-chain | ${value.tasks.e2eFullChain.checkable ? "yes" : "no"} | ${value.tasks.e2eFullChain.status} |`,
    `| Performance | ${value.tasks.performance.checkable ? "yes" : "no"} | ${value.tasks.performance.status} |`,
    "",
    "## Git Distribution",
    "",
    "| Target | Status | Reusable Artifact | Source Archive Evidence | Artifact | Run |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const [target, result] of Object.entries(
    value.gitDistribution.targets,
  )) {
    const sourceSummary = result.sourceArchive
      ? `${result.sourceArchive.checkable ? "yes" : "no"} (${result.sourceArchive.checkedComponents.join(", ") || "none"} checked; ${result.sourceArchive.blockedComponents.join(", ") || "none"} blocked)`
      : "n/a";
    lines.push(
      `| ${target} | ${result.status} | ${result.reusableArtifactCheckable ? "yes" : "no"} | ${sourceSummary} | ${result.artifactName ?? "n/a"} | ${result.runId ?? "n/a"} |`,
    );
  }

  if (value.gitDistribution.blockers.length > 0) {
    lines.push("", "Git Distribution blockers:");
    for (const blocker of value.gitDistribution.blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  lines.push("");

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
