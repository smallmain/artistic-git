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
const expectedHead = resolveExpectedHead();

const reports = loadReports(artifactsDirs.map((dir) => path.resolve(dir)));
const phase12Summaries = reports.filter(
  (entry) => entry.content.kind === "phase12-evidence-summary",
);
const phase12Summary = selectFreshest(
  phase12Summaries,
  phase12SummaryCommitSha,
);
const selectedPhase12Summary = phase12Summary
  ? phase12SummaryEvidence(phase12Summary)
  : null;
const selectedPhase12Freshness = selectedPhase12Summary?.freshness ?? null;
const releaseRehearsalReports = reports
  .filter((entry) => entry.content.kind === "release-rehearsal-checklist")
  .sort(compareReportsByFreshnessThenNewest(releaseRehearsalCommitSha));
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
    expectedHeadSha: expectedHead.sha,
    expectedHeadShaSource: expectedHead.source,
    jsonFileCount: reports.length,
    phase12SummaryPath: phase12Summary?.filePath ?? null,
    selectedPhase12Summary,
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
  const freshnessBlocker = phase12FreshnessBlocker({
    id: "win32-openssh-gate",
    title: "Win32-OpenSSH release gate",
    nextAction:
      "Regenerate phase12-evidence-summary for the current HEAD before using Windows git-dist readiness.",
    target: "windows-x86_64",
  });
  const windowsTarget = gitDistTarget("windows-x86_64");
  if (freshnessBlocker && windowsTarget) {
    return freshnessBlocker;
  }
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
  const freshnessBlocker = phase12FreshnessBlocker({
    id: "windows-git-dist",
    title: "Windows reusable git distribution",
    nextAction:
      "Regenerate phase12-evidence-summary for the current HEAD, then re-check Windows reusable git-dist evidence.",
    target: "windows-x86_64",
  });
  if (freshnessBlocker) {
    return freshnessBlocker;
  }
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
  const freshnessBlocker = phase12FreshnessBlocker({
    id: "git-lfs-distribution",
    title: "Three-platform git-lfs distribution",
    nextAction:
      "Regenerate phase12-evidence-summary for the current HEAD, then re-check all git-lfs distribution targets.",
  });
  if (freshnessBlocker) {
    return freshnessBlocker;
  }
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
  const freshnessBlocker = phase12FreshnessBlocker({
    id: "dev-resources-script",
    title: "Local dev resources script",
    nextAction:
      "Regenerate phase12-evidence-summary for the current HEAD before using it to validate local dev resources.",
    target: "windows-x86_64",
  });
  if (freshnessBlocker) {
    return freshnessBlocker;
  }
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
  const freshnessBlocker = phase12FreshnessBlocker({
    id,
    title,
    nextAction,
  });
  if (freshnessBlocker) {
    return freshnessBlocker;
  }
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
  const freshness = releaseRehearsal
    ? evidenceFreshness(releaseRehearsalCommitSha(rehearsal))
    : null;
  if (rehearsal?.status === "pass") {
    if (isBlockingFreshness(freshness)) {
      return blockedItem({
        id: "release-rehearsal",
        title: "0.1.0 release rehearsal",
        evidencePath: releaseRehearsal.filePath,
        details: {
          status: rehearsal.status,
          release: rehearsal.release,
          taskCheckbox: rehearsal.taskCheckbox,
          freshness,
        },
        blocker: {
          category: freshnessCategory(freshness),
          message: freshnessMessage("Release rehearsal evidence", freshness),
          nextAction:
            "Run the protected Release workflow for the current HEAD and attach that release rehearsal evidence.",
          sourceKind: "release-rehearsal-checklist",
        },
      });
    }
    return readyItem({
      id: "release-rehearsal",
      title: "0.1.0 release rehearsal",
      evidencePath: releaseRehearsal.filePath,
      details: {
        status: rehearsal.status,
        release: rehearsal.release,
        taskCheckbox: rehearsal.taskCheckbox,
        freshness,
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
          freshness,
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

function phase12FreshnessBlocker({ id, nextAction, target = null, title }) {
  if (!phase12Summary || !isBlockingFreshness(selectedPhase12Freshness)) {
    return null;
  }
  return blockedItem({
    id,
    title,
    evidencePath: phase12Summary.filePath,
    details: {
      phase12Summary: selectedPhase12Summary,
      freshness: selectedPhase12Freshness,
    },
    blocker: {
      category: freshnessCategory(selectedPhase12Freshness),
      message: freshnessMessage(
        "Phase 12 evidence summary",
        selectedPhase12Freshness,
      ),
      nextAction,
      sourceKind: "phase12-evidence-summary",
      target,
    },
  });
}

function gitDistTarget(targetName) {
  const fromSummary = gitDistribution?.targets?.[targetName];
  if (fromSummary) {
    return {
      ...fromSummary,
      freshness: selectedPhase12Freshness,
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
    const freshness = evidenceFreshness(workflowBuild.run?.commitSha);
    const freshnessBlockers = isBlockingFreshness(freshness)
      ? [freshnessMessage(`git-dist ${targetName} build evidence`, freshness)]
      : [];
    const reusableArtifactProduced =
      workflowBuild.validationSummary?.reusableArtifactProduced === true;
    return {
      status:
        reusableArtifactProduced && freshnessBlockers.length === 0
          ? "reusable-ready"
          : sourceArchive
            ? "source-partial"
            : (workflowBuild.target?.status ?? "blocked"),
      reusableArtifactCheckable:
        reusableArtifactProduced && freshnessBlockers.length === 0,
      sourceArchiveCheckable: Boolean(sourceArchive?.summary?.checked),
      buildEvidencePath: build.filePath,
      blockerEvidencePath:
        workflowBuild.target?.blocked === true ? build.filePath : null,
      evidencePath: build.filePath,
      blockers: [
        ...(Array.isArray(workflowBuild.target?.blockers)
          ? workflowBuild.target.blockers.map((blocker) =>
              blocker.reason
                ? `${blocker.component}: ${blocker.reason}`
                : String(blocker),
            )
          : []),
        ...freshnessBlockers,
      ],
      freshness,
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

function selectFreshest(entries, shaSelector) {
  return [...entries].sort(compareReportsByFreshnessThenNewest(shaSelector))[0];
}

function compareReportsByFreshnessThenNewest(shaSelector) {
  return (left, right) => {
    const freshnessDelta =
      freshnessRank(evidenceFreshness(shaSelector(right.content))) -
      freshnessRank(evidenceFreshness(shaSelector(left.content)));
    if (freshnessDelta !== 0) {
      return freshnessDelta;
    }
    return compareReportsByNewest(left, right);
  };
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

function phase12SummaryEvidence(entry) {
  const content = entry.content;
  const sha = phase12SummaryCommitSha(content);
  return {
    filePath: entry.filePath,
    generatedAt: content.generatedAt ?? null,
    status: content.overallStatus ?? null,
    currentHeadSha: sha,
    freshness: evidenceFreshness(sha),
  };
}

function releaseRehearsalEvidence(entry) {
  const content = entry.content;
  const dryRunArtifact = content.ciDryRunArtifact ?? {};
  const workflowSha = releaseRehearsalCommitSha(content);
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
    workflowSha,
    freshness: evidenceFreshness(workflowSha),
    plannedVersion: dryRunArtifact.plannedVersion ?? null,
    plannedTag: dryRunArtifact.plannedTag ?? null,
    releaseModeReason: dryRunArtifact.releaseModeReason ?? null,
  };
}

function phase12SummaryCommitSha(content) {
  return normalizeOptionalString(
    content.source?.currentHeadSha ??
      content.source?.workflowSha ??
      content.provenance?.workflowSha,
  );
}

function releaseRehearsalCommitSha(content) {
  return normalizeOptionalString(content.ciDryRunArtifact?.workflowSha);
}

function evidenceFreshness(actualSha) {
  const normalizedActual = normalizeOptionalString(actualSha);
  if (!expectedHead.sha) {
    return {
      status: "unknown-expected-head",
      expectedSha: null,
      actualSha: normalizedActual,
    };
  }
  if (!normalizedActual) {
    return {
      status: "missing-provenance",
      expectedSha: expectedHead.sha,
      actualSha: null,
    };
  }
  if (sameCommitSha(normalizedActual, expectedHead.sha)) {
    return {
      status: "current",
      expectedSha: expectedHead.sha,
      actualSha: normalizedActual,
    };
  }
  return {
    status: "stale",
    expectedSha: expectedHead.sha,
    actualSha: normalizedActual,
  };
}

function freshnessRank(freshness) {
  switch (freshness?.status) {
    case "current":
      return 3;
    case "unknown-expected-head":
      return 2;
    case "stale":
      return 1;
    case "missing-provenance":
      return 0;
    default:
      return -1;
  }
}

function isBlockingFreshness(freshness) {
  return (
    freshness &&
    freshness.status !== "current" &&
    freshness.status !== "unknown-expected-head"
  );
}

function freshnessCategory(freshness) {
  if (freshness?.status === "stale") {
    return "stale-evidence";
  }
  if (freshness?.status === "missing-provenance") {
    return "missing-provenance";
  }
  return freshness?.status ?? "missing-provenance";
}

function freshnessMessage(label, freshness) {
  if (freshness?.status === "missing-provenance") {
    return `${label} is missing commit SHA provenance for current HEAD ${freshness.expectedSha}.`;
  }
  if (freshness?.status === "stale") {
    return `${label} commit ${freshness.actualSha} does not match current HEAD ${freshness.expectedSha}.`;
  }
  return `${label} freshness is ${freshness?.status ?? "unknown"}.`;
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function sameCommitSha(left, right) {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft === normalizedRight;
}

function resolveExpectedHead() {
  const cliSha = normalizeOptionalString(cli.expectedHeadSha);
  if (cliSha) {
    return { sha: cliSha, source: "cli" };
  }
  const envSha = normalizeOptionalString(
    process.env.ARTISTIC_GIT_READINESS_EXPECTED_HEAD_SHA,
  );
  if (envSha) {
    return {
      sha: envSha,
      source: "ARTISTIC_GIT_READINESS_EXPECTED_HEAD_SHA",
    };
  }
  const githubSha = normalizeOptionalString(process.env.GITHUB_SHA);
  if (githubSha) {
    return { sha: githubSha, source: "GITHUB_SHA" };
  }
  const gitSha = resolveCurrentHeadSha();
  if (gitSha) {
    return { sha: gitSha, source: "git" };
  }
  return { sha: null, source: "unresolved" };
}

function resolveCurrentHeadSha() {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  return normalizeOptionalString(result.stdout);
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
    expectedHeadSha: null,
    reportDir: null,
  };
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      parsed.artifactsDirs.push(arg.slice("--artifacts-dir=".length));
    } else if (arg.startsWith("--expected-head-sha=")) {
      parsed.expectedHeadSha = arg.slice("--expected-head-sha=".length);
    } else if (arg.startsWith("--report-dir=")) {
      parsed.reportDir = arg.slice("--report-dir=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
