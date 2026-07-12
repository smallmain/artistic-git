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
const phase12Candidates = reports
  .filter((entry) => entry.content.kind === "phase12-evidence-summary")
  .sort(compareByFreshnessThenNewest(phase12CommitSha));
const releaseCandidates = reports
  .filter((entry) => entry.content.kind === "release-rehearsal-checklist")
  .sort(compareByFreshnessThenNewest(releaseCommitSha));
const phase12 = phase12Candidates[0] ?? null;
const release = releaseCandidates[0] ?? null;

const items = [
  evaluatePhase12Task(
    "e2eFullChain",
    "phase12-e2e-full-chain",
    "Phase 12 E2E full-chain",
  ),
  evaluatePhase12Task(
    "performance",
    "phase12-performance",
    "Phase 12 performance",
  ),
  evaluateReleaseRehearsal(),
];
const remainingBlockers = items.flatMap((item) => item.blockers);
const summary = {
  schemaVersion: 3,
  kind: "readiness-summary",
  generatedAt: new Date().toISOString(),
  artifactsDirs: artifactsDirs.map((dir) => path.resolve(dir)),
  overallStatus: remainingBlockers.length === 0 ? "ready" : "blocked",
  source: {
    expectedHeadSha: expectedHead.sha,
    expectedHeadShaSource: expectedHead.source,
    jsonFileCount: reports.length,
    phase12SummaryPath: phase12?.filePath ?? null,
    selectedPhase12Summary: phase12 ? phase12Evidence(phase12) : null,
    releaseRehearsalPath: release?.filePath ?? null,
    releaseRehearsalCandidateCount: releaseCandidates.length,
    selectedReleaseRehearsal: release ? releaseEvidence(release) : null,
    releaseRehearsalCandidates: releaseCandidates.map(releaseEvidence),
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
const softOperatorBlockers =
  process.env.ARTISTIC_GIT_READINESS_SOFT_OPERATOR_BLOCKERS === "1";
const hardBlockers = softOperatorBlockers
  ? remainingBlockers.filter((entry) => entry.category !== "operator-evidence")
  : remainingBlockers;
if (hardBlockers.length > 0) {
  process.exitCode = 1;
}

function evaluatePhase12Task(taskKey, id, title) {
  if (!phase12) {
    return blockedItem(
      id,
      title,
      null,
      "Phase 12 evidence summary is missing.",
      "Run all required platform evidence jobs and regenerate the summary.",
    );
  }
  const freshness = evidenceFreshness(phase12CommitSha(phase12.content));
  if (isBlockingFreshness(freshness)) {
    return blockedItem(
      id,
      title,
      phase12.filePath,
      freshnessMessage("Phase 12 evidence summary", freshness),
      "Regenerate the Phase 12 evidence summary for the current commit.",
      freshness.status === "stale" ? "stale-evidence" : "missing-provenance",
    );
  }
  const task = phase12.content.tasks?.[taskKey];
  if (task?.status === "pass" && task.checkable === true) {
    return readyItem(id, title, phase12.filePath, task);
  }
  const messages =
    Array.isArray(task?.blockers) && task.blockers.length > 0
      ? task.blockers
      : [`${title} is ${task?.status ?? "missing"}.`];
  return {
    id,
    title,
    status: "blocked",
    checkable: false,
    evidencePath: phase12.filePath,
    details: task ?? null,
    blockers: messages.map((message, index) =>
      blocker({
        id: `${id}:${index + 1}`,
        itemId: id,
        category: "task-blocker",
        message,
        evidencePath: phase12.filePath,
        nextAction:
          "Resolve the runtime evidence blocker and regenerate the Phase 12 summary.",
      }),
    ),
  };
}

function evaluateReleaseRehearsal() {
  const id = "release-rehearsal";
  const title = "Release rehearsal";
  if (!release) {
    return blockedItem(
      id,
      title,
      null,
      "Release rehearsal evidence is missing.",
      "Run and record an operator-confirmed release rehearsal.",
    );
  }
  const freshness = evidenceFreshness(releaseCommitSha(release.content));
  if (isBlockingFreshness(freshness)) {
    return blockedItem(
      id,
      title,
      release.filePath,
      freshnessMessage("Release rehearsal evidence", freshness),
      "Run the release rehearsal for the current commit.",
      freshness.status === "stale" ? "stale-evidence" : "missing-provenance",
    );
  }
  if (release.content.status === "pass" && release.content.result === "pass") {
    return readyItem(id, title, release.filePath, release.content);
  }
  const messages =
    Array.isArray(release.content.blockers) &&
    release.content.blockers.length > 0
      ? release.content.blockers.map((entry) => entry.message ?? String(entry))
      : [
          `Release rehearsal status/result is ${release.content.status}/${release.content.result}.`,
        ];
  return {
    id,
    title,
    status: "blocked",
    checkable: false,
    evidencePath: release.filePath,
    details: release.content,
    blockers: messages.map((message, index) =>
      blocker({
        id: `${id}:${index + 1}`,
        itemId: id,
        category: "operator-evidence",
        message,
        evidencePath: release.filePath,
        nextAction:
          "Provide operator-confirmed release rehearsal evidence for the current commit.",
      }),
    ),
  };
}

function readyItem(id, title, evidencePath, details) {
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

function blockedItem(
  id,
  title,
  evidencePath,
  message,
  nextAction,
  category = "missing-evidence",
) {
  return {
    id,
    title,
    status: "blocked",
    checkable: false,
    evidencePath,
    details: null,
    blockers: [
      blocker({
        id: `${id}:1`,
        itemId: id,
        category,
        message,
        evidencePath,
        nextAction,
      }),
    ],
  };
}

function blocker(value) {
  return { ...value, target: null, sourceKind: value.itemId };
}

function phase12Evidence(entry) {
  const sha = phase12CommitSha(entry.content);
  return {
    filePath: entry.filePath,
    generatedAt: entry.content.generatedAt ?? null,
    status: entry.content.status ?? null,
    currentHeadSha: sha,
    freshness: evidenceFreshness(sha),
  };
}

function releaseEvidence(entry) {
  const artifact = entry.content.ciDryRunArtifact ?? {};
  const sha = releaseCommitSha(entry.content);
  return {
    filePath: entry.filePath,
    generatedAt: entry.content.generatedAt ?? null,
    status: entry.content.status ?? null,
    result: entry.content.result ?? null,
    artifactName: artifact.expectedArtifactName ?? null,
    workflowRunUrl: artifact.workflowRunUrl ?? null,
    workflowRunUrlValid: artifact.workflowRunUrlValid ?? null,
    workflowSha: sha,
    freshness: evidenceFreshness(sha),
  };
}

function phase12CommitSha(content) {
  return normalizeOptionalString(content.source?.currentHeadSha);
}

function releaseCommitSha(content) {
  return normalizeOptionalString(content.ciDryRunArtifact?.workflowSha);
}

function evidenceFreshness(actualSha) {
  const actual = normalizeOptionalString(actualSha);
  if (!expectedHead.sha) {
    return {
      status: "unknown-expected-head",
      expectedSha: null,
      actualSha: actual,
    };
  }
  if (!actual) {
    return {
      status: "missing-provenance",
      expectedSha: expectedHead.sha,
      actualSha: null,
    };
  }
  return sameCommitSha(actual, expectedHead.sha)
    ? { status: "current", expectedSha: expectedHead.sha, actualSha: actual }
    : { status: "stale", expectedSha: expectedHead.sha, actualSha: actual };
}

function isBlockingFreshness(value) {
  return value.status !== "current" && value.status !== "unknown-expected-head";
}

function freshnessMessage(label, value) {
  if (value.status === "stale") {
    return `${label} commit ${value.actualSha} does not match current HEAD ${value.expectedSha}.`;
  }
  return `${label} is missing commit SHA provenance for current HEAD ${value.expectedSha}.`;
}

function compareByFreshnessThenNewest(shaSelector) {
  return (left, right) => {
    const rankDelta =
      freshnessRank(evidenceFreshness(shaSelector(right.content))) -
      freshnessRank(evidenceFreshness(shaSelector(left.content)));
    return rankDelta !== 0 ? rankDelta : compareByNewest(left, right);
  };
}

function freshnessRank(value) {
  return (
    {
      current: 3,
      "unknown-expected-head": 2,
      stale: 1,
      "missing-provenance": 0,
    }[value.status] ?? -1
  );
}

function compareByNewest(left, right) {
  const delta = reportTime(right) - reportTime(left);
  return delta !== 0 ? delta : left.filePath.localeCompare(right.filePath);
}

function reportTime(entry) {
  const parsed = Date.parse(entry.content.generatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : entry.mtimeMs;
}

function resolveExpectedHead() {
  const cliSha = normalizeOptionalString(cli.expectedHeadSha);
  if (cliSha) return { sha: cliSha, source: "cli" };
  const envSha = normalizeOptionalString(
    process.env.ARTISTIC_GIT_READINESS_EXPECTED_HEAD_SHA,
  );
  if (envSha) return { sha: envSha, source: "readiness-env" };
  const githubSha = normalizeOptionalString(process.env.GITHUB_SHA);
  if (githubSha) return { sha: githubSha, source: "GITHUB_SHA" };
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0
    ? { sha: normalizeOptionalString(result.stdout), source: "git" }
    : { sha: null, source: "unresolved" };
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function sameCommitSha(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return (
    a === b ||
    (a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)))
  );
}

function loadReports(rootDirs) {
  return rootDirs.flatMap((rootDir) => {
    if (!existsSync(rootDir)) return [];
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
  });
}

function listJsonFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (statSync(current).isDirectory()) {
      for (const entry of readdirSync(current))
        stack.push(path.join(current, entry));
    } else if (current.endsWith(".json")) {
      files.push(current);
    }
  }
  return files;
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
    for (const entry of value.remainingBlockers) {
      lines.push(`- ${entry.itemId}: ${entry.message}`);
      lines.push(`  Next: ${entry.nextAction}`);
    }
  }
  lines.push("");
  return `${lines.join(os.EOL)}${os.EOL}`;
}

function parseArgs(args) {
  const parsed = { artifactsDirs: [], expectedHeadSha: null, reportDir: null };
  for (const arg of args) {
    if (arg === "--") continue;
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
