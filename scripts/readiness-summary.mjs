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
const artifactsDirs =
  cli.artifactsDirs.length > 0
    ? cli.artifactsDirs
    : process.env.ARTISTIC_GIT_READINESS_ARTIFACTS_DIR
      ? process.env.ARTISTIC_GIT_READINESS_ARTIFACTS_DIR.split(path.delimiter)
      : ["artifacts"];
const reportDir = path.resolve(
  cli.reportDir ??
    process.env.ARTISTIC_GIT_READINESS_REPORT_DIR ??
    path.join("artifacts", "readiness-summary"),
);

const reports = loadReports(artifactsDirs.map((dir) => path.resolve(dir)));
const phase12Summary = selectLatest((content) => {
  return content.kind === "phase12-evidence-summary";
});
const releaseRehearsalReports = reports
  .filter((entry) => entry.content.kind === "release-rehearsal-checklist")
  .sort(compareReportsByNewest);
const releaseRehearsal = releaseRehearsalReports[0] ?? null;
const opensshReport = selectLatest((content) => {
  return Boolean(content.opensshRelease);
});
const gitDistribution = phase12Summary?.content.gitDistribution ?? null;
const releaseRehearsalCandidates = releaseRehearsalReports.map(
  releaseRehearsalEvidence,
);

const items = [
  evaluateOpenSshGate(),
  evaluateWindowsGitDist(),
  evaluateGitLfsDistribution(),
  evaluateDevResourcesScript(),
  evaluatePhase12Task({
    id: "phase12-e2e-full-chain",
    title: "Phase 12 E2E full-chain",
    taskKey: "e2eFullChain",
    nextAction:
      "Produce Linux and Windows artifact-backed real-git E2E evidence in phase12-evidence-summary.",
  }),
  evaluatePhase12Task({
    id: "phase12-performance",
    title: "Phase 12 performance",
    taskKey: "performance",
    nextAction:
      "Produce Linux, macOS, and Windows artifact-backed heavy performance evidence in phase12-evidence-summary.",
  }),
  evaluateReleaseRehearsal(),
];
const remainingBlockers = items.flatMap((item) => item.blockers);
const summary = {
  schemaVersion: 2,
  kind: "readiness-summary",
  generatedAt: new Date().toISOString(),
  artifactsDirs: artifactsDirs.map((dir) => path.resolve(dir)),
  overallStatus: remainingBlockers.length === 0 ? "ready" : "blocked",
  source: {
    jsonFileCount: reports.length,
    phase12SummaryPath: phase12Summary?.filePath ?? null,
    releaseRehearsalPath: releaseRehearsal?.filePath ?? null,
    releaseRehearsalCandidateCount: releaseRehearsalCandidates.length,
    selectedReleaseRehearsal: releaseRehearsalCandidates[0] ?? null,
    releaseRehearsalCandidates,
    opensshEvidencePath: opensshReport?.filePath ?? null,
    gitDistBuildReportCount: reports.filter(
      (entry) => entry.content.workflowBuild?.schemaVersion === 1,
    ).length,
    gitDistSourceReportCount: reports.filter(
      (entry) => entry.content.mode === "source-evidence-only",
    ).length,
    gitDistBlockerReportCount: reports.filter(
      (entry) => entry.content.workflowBuild?.target?.blocked === true,
    ).length,
  },
  items,
  remainingBlockers,
};

mkdirSync(reportDir, { recursive: true });
const jsonPath = path.join(reportDir, "readiness-summary.json");
const markdownPath = path.join(reportDir, "readiness-summary.md");
writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(markdownPath, renderMarkdown(summary));

console.log(
  `Readiness summary: ${summary.overallStatus}; ${remainingBlockers.length} blocker(s); wrote ${jsonPath}`,
);

function evaluateOpenSshGate() {
  const windowsTarget = gitDistTarget("windows-x86_64");
  if (windowsTarget?.reusableArtifactCheckable === true) {
    return readyItem({
      id: "win32-openssh-gate",
      title: "Win32-OpenSSH release gate",
      evidencePath: windowsTarget.evidencePath,
      details: {
        resolution: "windows reusable git-dist artifact is checkable",
        targetStatus: windowsTarget.status,
      },
    });
  }

  const release = opensshReport?.content.opensshRelease;
  if (!release) {
    return blockedItem({
      id: "win32-openssh-gate",
      title: "Win32-OpenSSH release gate",
      blocker: {
        category: "missing-evidence",
        message: "Win32-OpenSSH release gate evidence is missing.",
        nextAction:
          "Run Git Distribution contract/build evidence so opensshRelease metadata is available.",
        sourceKind: "openssh-release",
      },
    });
  }

  const stableCount = release.scan?.stableWithRequiredAssetCount ?? 0;
  const latestLabel = [release.latest?.tagName, release.latest?.name]
    .filter(Boolean)
    .join(" / ");
  const status = release.status;
  const message =
    status === "non-stable"
      ? `Win32-OpenSSH remains non-stable (${latestLabel || "unknown latest"}; stable ${release.requiredAsset} releases=${stableCount}).`
      : `Win32-OpenSSH gate requires action (${latestLabel || status}; stable ${release.requiredAsset} releases=${stableCount}).`;
  return blockedItem({
    id: "win32-openssh-gate",
    title: "Win32-OpenSSH release gate",
    evidencePath: opensshReport.filePath,
    details: {
      latest: release.latest ?? null,
      requiredAsset: release.requiredAsset ?? null,
      scan: release.scan ?? null,
      status,
    },
    blocker: {
      category:
        status === "non-stable" ? "external-upstream" : "action-required",
      message,
      nextAction:
        status === "non-stable"
          ? "Wait for an official stable PowerShell/Win32-OpenSSH release with OpenSSH-Win64.zip."
          : "Update git-dist.toml, remove the placeholder gate, and rerun Windows reusable git-dist validation.",
      sourceKind: "openssh-release",
      target: "windows-x86_64",
    },
  });
}

function evaluateWindowsGitDist() {
  const target = gitDistTarget("windows-x86_64");
  if (target?.reusableArtifactCheckable === true) {
    return readyItem({
      id: "windows-git-dist",
      title: "Windows reusable git distribution",
      evidencePath: target.evidencePath,
      details: target,
    });
  }
  const sourceNote =
    target?.sourceArchiveCheckable === true
      ? " Partial source evidence is checkable, but reusable artifact evidence is still missing."
      : "";
  return blockedItem({
    id: "windows-git-dist",
    title: "Windows reusable git distribution",
    evidencePath: target?.evidencePath ?? null,
    details: target,
    blocker: {
      category: "missing-artifact",
      message: `Windows reusable git-dist artifact is not checkable.${sourceNote}`,
      nextAction:
        "Resolve the Win32-OpenSSH stable release blocker, then run Git Distribution build mode until artistic-git-dist-windows-x86_64 is produced and validated.",
      sourceKind: "git-distribution",
      target: "windows-x86_64",
    },
  });
}

function evaluateGitLfsDistribution() {
  const targets = ["macos-universal", "linux-x86_64", "windows-x86_64"].map(
    (target) => [target, gitDistTarget(target)],
  );
  const missing = targets
    .filter(([, evidence]) => evidence?.reusableArtifactCheckable !== true)
    .map(([target]) => target);
  if (missing.length === 0) {
    return readyItem({
      id: "git-lfs-distribution",
      title: "Three-platform git-lfs distribution",
      details: Object.fromEntries(targets),
    });
  }
  const windows = gitDistTarget("windows-x86_64");
  return blockedItem({
    id: "git-lfs-distribution",
    title: "Three-platform git-lfs distribution",
    evidencePath: windows?.evidencePath ?? null,
    details: {
      targets: Object.fromEntries(targets),
      missingReusableTargets: missing,
    },
    blocker: {
      category: "missing-artifact",
      message: `git-lfs cannot be marked three-platform complete; reusable git-dist evidence is missing for ${missing.join(", ")}.`,
      nextAction:
        "Produce reusable git-dist artifacts for all three targets, including Windows after Win32-OpenSSH is stable.",
      sourceKind: "git-distribution",
      target: missing.join(","),
    },
  });
}

function evaluateDevResourcesScript() {
  const windows = gitDistTarget("windows-x86_64");
  if (windows?.reusableArtifactCheckable === true) {
    return readyItem({
      id: "dev-resources-script",
      title: "Local dev resources script",
      evidencePath: windows.evidencePath,
      details: {
        windowsGitDist: windows,
      },
    });
  }
  return blockedItem({
    id: "dev-resources-script",
    title: "Local dev resources script",
    evidencePath: windows?.evidencePath ?? null,
    details: {
      windowsGitDist: windows,
    },
    blocker: {
      category: "missing-artifact",
      message:
        "The local dev resources script cannot be fully checked until Windows can legally produce complete git-dist resources.",
      nextAction:
        "After Windows reusable git-dist is produced, run pnpm fetch:git-dist -- --dev-resources --target=windows-x86_64 and verify ARTISTIC_GIT_DIST_DIR output.",
      sourceKind: "git-distribution",
      target: "windows-x86_64",
    },
  });
}

function evaluatePhase12Task({ id, nextAction, taskKey, title }) {
  const task = phase12Summary?.content.tasks?.[taskKey];
  if (task?.checkable === true) {
    return readyItem({
      id,
      title,
      evidencePath: phase12Summary.filePath,
      details: task,
    });
  }
  return blockedItem({
    id,
    title,
    evidencePath: phase12Summary?.filePath ?? null,
    details: task ?? null,
    blocker: {
      category: task ? "task-not-checkable" : "missing-evidence",
      message: task
        ? `${title} is ${task.status ?? "not checkable"}.`
        : `${title} evidence summary is missing.`,
      nextAction,
      sourceKind: "phase12-evidence-summary",
    },
    extraBlockers: Array.isArray(task?.blockers)
      ? task.blockers.map((message, index) => ({
          category: "task-blocker",
          idSuffix: `detail-${index + 1}`,
          message,
          nextAction,
          sourceKind: "phase12-evidence-summary",
        }))
      : [],
  });
}

function evaluateReleaseRehearsal() {
  const rehearsal = releaseRehearsal?.content;
  if (rehearsal?.status === "pass") {
    return readyItem({
      id: "release-rehearsal",
      title: "0.1.0 release rehearsal",
      evidencePath: releaseRehearsal.filePath,
      details: {
        status: rehearsal.status,
        release: rehearsal.release,
        taskCheckbox: rehearsal.taskCheckbox,
      },
    });
  }
  return blockedItem({
    id: "release-rehearsal",
    title: "0.1.0 release rehearsal",
    evidencePath: releaseRehearsal?.filePath ?? null,
    details: rehearsal
      ? {
          status: rehearsal.status,
          dryRun: rehearsal.dryRun,
          missingEvidence: rehearsal.missingEvidence ?? [],
          missingSecrets: rehearsal.missingSecrets ?? [],
          taskCheckbox: rehearsal.taskCheckbox,
        }
      : null,
    blocker: {
      category: rehearsal ? "operator-evidence" : "missing-evidence",
      message: rehearsal
        ? `Release rehearsal status is ${rehearsal.status}; TASKS.md checkbox remains ${rehearsal.taskCheckbox ?? "unchecked"}.`
        : "Release rehearsal checklist evidence is missing.",
      nextAction:
        "Run the protected Release workflow with signing secrets, install-smoke all three platform assets, and record the 0.1.0 to 0.1.1 updater rehearsal.",
      sourceKind: "release-rehearsal-checklist",
    },
    extraBlockers: Array.isArray(rehearsal?.blockers)
      ? rehearsal.blockers.map((blocker, index) => ({
          category: blocker.id ?? "release-blocker",
          idSuffix: `detail-${index + 1}`,
          message: blocker.message ?? String(blocker),
          nextAction:
            "Provide the missing release rehearsal operator evidence.",
          sourceKind: "release-rehearsal-checklist",
        }))
      : [],
  });
}

function gitDistTarget(targetName) {
  const fromSummary = gitDistribution?.targets?.[targetName];
  if (fromSummary) {
    return {
      ...fromSummary,
      evidencePath:
        fromSummary.buildEvidencePath ??
        fromSummary.blockerEvidencePath ??
        phase12Summary?.filePath ??
        null,
    };
  }

  const build = selectLatest(
    (content) => content.workflowBuild?.target?.name === targetName,
  );
  if (build) {
    const workflowBuild = build.content.workflowBuild;
    const sourceArchive = workflowBuild.sourceArchiveValidation ?? null;
    return {
      status:
        workflowBuild.validationSummary?.reusableArtifactProduced === true
          ? "reusable-ready"
          : sourceArchive
            ? "source-partial"
            : (workflowBuild.target?.status ?? "blocked"),
      reusableArtifactCheckable:
        workflowBuild.validationSummary?.reusableArtifactProduced === true,
      sourceArchiveCheckable: Boolean(sourceArchive?.summary?.checked),
      buildEvidencePath: build.filePath,
      blockerEvidencePath:
        workflowBuild.target?.blocked === true ? build.filePath : null,
      evidencePath: build.filePath,
      blockers: Array.isArray(workflowBuild.target?.blockers)
        ? workflowBuild.target.blockers.map((blocker) =>
            blocker.reason
              ? `${blocker.component}: ${blocker.reason}`
              : String(blocker),
          )
        : [],
      runId: workflowBuild.run?.runId ?? null,
      artifactName: workflowBuild.target?.artifactName ?? null,
    };
  }

  const readiness = selectLatest((content) =>
    Array.isArray(content.targets)
      ? content.targets.some((target) => target.target === targetName)
      : false,
  );
  const target = readiness?.content.targets?.find(
    (entry) => entry.target === targetName,
  );
  if (target) {
    return {
      status: target.status,
      reusableArtifactCheckable: false,
      sourceArchiveCheckable: false,
      evidencePath: readiness.filePath,
      blockers: Array.isArray(target.blockers)
        ? target.blockers.map((blocker) =>
            blocker.reason
              ? `${blocker.component}: ${blocker.reason}`
              : String(blocker),
          )
        : [],
      artifactName: target.artifactName ?? null,
      runId: null,
    };
  }

  return null;
}

function readyItem({ details = null, evidencePath = null, id, title }) {
  return {
    id,
    title,
    status: "ready",
    checkable: true,
    evidencePath,
    details,
    blockers: [],
  };
}

function blockedItem({
  blocker,
  details = null,
  evidencePath = null,
  extraBlockers = [],
  id,
  title,
}) {
  const blockers = [blocker, ...extraBlockers].map((entry, index) => ({
    id: `${id}:${entry.idSuffix ?? index + 1}`,
    itemId: id,
    category: entry.category,
    target: entry.target ?? null,
    message: entry.message,
    evidencePath,
    sourceKind: entry.sourceKind,
    nextAction: entry.nextAction,
  }));
  return {
    id,
    title,
    status: "blocked",
    checkable: false,
    evidencePath,
    details,
    blockers,
  };
}

function selectLatest(predicate) {
  return reports
    .filter((entry) => predicate(entry.content))
    .sort(compareReportsByNewest)[0];
}

function compareReportsByNewest(left, right) {
  const timeDelta = reportTime(right) - reportTime(left);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  return left.filePath.localeCompare(right.filePath);
}

function reportTime(entry) {
  const parsed = Date.parse(entry.content.generatedAt ?? "");
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return entry.mtimeMs;
}

function releaseRehearsalEvidence(entry) {
  const content = entry.content;
  const dryRunArtifact = content.ciDryRunArtifact ?? {};
  return {
    filePath: entry.filePath,
    generatedAt: content.generatedAt ?? null,
    mode: content.mode ?? null,
    status: content.status ?? null,
    result: content.result ?? null,
    dryRun: content.dryRun ?? null,
    taskCheckbox: content.taskCheckbox ?? null,
    artifactName: dryRunArtifact.expectedArtifactName ?? null,
    workflowRunUrl: dryRunArtifact.workflowRunUrl ?? null,
    workflowRunUrlValid: dryRunArtifact.workflowRunUrlValid ?? null,
    workflowAttempt: dryRunArtifact.workflowAttempt ?? null,
    workflowSha: dryRunArtifact.workflowSha ?? null,
    plannedVersion: dryRunArtifact.plannedVersion ?? null,
    plannedTag: dryRunArtifact.plannedTag ?? null,
    releaseModeReason: dryRunArtifact.releaseModeReason ?? null,
  };
}

function loadReports(rootDirs) {
  return rootDirs.flatMap((rootDir) => {
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

function renderMarkdown(value) {
  const lines = [
    "# Readiness Summary",
    "",
    `Status: ${value.overallStatus}`,
    `Blockers: ${value.remainingBlockers.length}`,
    `Release rehearsal evidence candidates: ${value.source.releaseRehearsalCandidateCount}`,
    `Selected release rehearsal evidence: ${value.source.selectedReleaseRehearsal?.artifactName ?? value.source.releaseRehearsalPath ?? "n/a"}`,
    "",
    "| Item | Status | Evidence |",
    "| --- | --- | --- |",
  ];
  for (const item of value.items) {
    lines.push(
      `| ${item.title} | ${item.status} | ${item.evidencePath ?? "n/a"} |`,
    );
  }
  if (value.remainingBlockers.length > 0) {
    lines.push("", "## Remaining Blockers", "");
    for (const blocker of value.remainingBlockers) {
      const target = blocker.target ? ` (${blocker.target})` : "";
      lines.push(`- ${blocker.itemId}${target}: ${blocker.message}`);
      lines.push(`  Next: ${blocker.nextAction}`);
    }
  }
  lines.push("");
  return `${lines.join(os.EOL)}${os.EOL}`;
}

function parseArgs(args) {
  const parsed = {
    artifactsDirs: [],
    reportDir: null,
  };
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      parsed.artifactsDirs.push(arg.slice("--artifacts-dir=".length));
    } else if (arg.startsWith("--report-dir=")) {
      parsed.reportDir = arg.slice("--report-dir=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
