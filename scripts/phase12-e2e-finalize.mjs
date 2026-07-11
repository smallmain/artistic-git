#!/usr/bin/env node
/* global console, process */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = parseArgs(process.argv.slice(2));
const runnerLabel = process.env.RUNNER_OS ?? process.platform;
const availabilityReportPath = path.resolve(
  cli.availabilityReportPath ??
    nonEmptyEnv("ARTISTIC_GIT_PHASE12_E2E_AVAILABILITY_REPORT") ??
    path.join("artifacts", `e2e-real-git-report-${runnerLabel}.json`),
);
const reportPath = path.resolve(
  cli.reportPath ??
    nonEmptyEnv("ARTISTIC_GIT_PHASE12_E2E_FINAL_REPORT") ??
    path.join(
      "artifacts",
      `phase12-e2e-full-chain-evidence-${runnerLabel}.json`,
    ),
);
const markdownPath = reportPath.replace(/\.json$/i, ".md");

const availability = readAvailabilityReport(availabilityReportPath);
const target = inferTarget(availability);
const outcomes = {
  linux: normalizeOutcome(
    cli.linuxOutcome ?? nonEmptyEnv("ARTISTIC_GIT_PHASE12_E2E_LINUX_OUTCOME"),
  ),
  windows: normalizeOutcome(
    cli.windowsOutcome ??
      nonEmptyEnv("ARTISTIC_GIT_PHASE12_E2E_WINDOWS_OUTCOME"),
  ),
};
const selectedOutcome = selectOutcome(outcomes, runnerLabel);
const statusEvaluation = evaluateStatus(availability, selectedOutcome);
const executableEvidence = validateExecutableEvidence(availability);
const reasons = [...statusEvaluation.reasons];
let status = statusEvaluation.status;
if (status === "pass" && !executableEvidence.checkable) {
  status = "blocker";
  reasons.push(...executableEvidence.reasons);
}
const platformEvidenceCheckable =
  status === "pass" && executableEvidence.checkable;

const report = {
  schemaVersion: 1,
  kind: "phase12-e2e-full-chain-runtime",
  generatedAt: new Date().toISOString(),
  status,
  result: status,
  target,
  ci: collectCiEnvironment(),
  availabilityReport: {
    path: availabilityReportPath,
    found: Boolean(availability),
    status: availability?.status ?? null,
    reason: availability?.reason ?? null,
    schemaVersion: availability?.schemaVersion ?? null,
  },
  gitDistSource: availability?.gitDistSource ?? null,
  gitDist: {
    manifest: availability?.gitDist?.manifest ?? null,
    executableEvidence: availability?.gitDist?.executableEvidence ?? [],
    versions: availability?.gitDist?.versions ?? null,
  },
  wdio: {
    command: "pnpm e2e:tauri:ci",
    outcomes,
    selectedOutcome,
    embeddedToolchainReady: availability?.status === "ready",
  },
  taskReadiness: {
    fullChainItemCheckable: false,
    platformEvidenceCheckable,
    status: platformEvidenceCheckable ? "platform-pass" : "blocked",
    reasons: [
      ...reasons,
      "Use the phase12-evidence-summary artifact to confirm Linux and Windows before checking the TASKS.md E2E item.",
    ],
    requiredEvidence: [
      "e2e-real-git-report status=ready with sha256-verified embedded git and git-lfs",
      "WDIO full-chain step outcome=success using the fixed embedded toolchain",
      "phase12-evidence-summary.json with tasks.e2eFullChain.checkable=true",
    ],
  },
};

mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(markdownPath, renderMarkdown(report));

console.log(`Phase 12 E2E runtime evidence: ${status}; wrote ${reportPath}`);
if (status !== "pass") {
  process.exitCode = 1;
}

function readAvailabilityReport(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      status: "failed",
      reason: `Could not parse availability report ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function evaluateStatus(currentAvailability, selectedWdioOutcome) {
  if (!currentAvailability) {
    return {
      status: "blocker",
      reasons: [`Missing E2E availability report: ${availabilityReportPath}`],
    };
  }
  if (currentAvailability.status !== "ready") {
    return {
      status: "blocker",
      reasons: [
        currentAvailability.reason ??
          `E2E availability status is ${currentAvailability.status}.`,
      ],
    };
  }
  if (selectedWdioOutcome !== "success") {
    return {
      status: "blocker",
      reasons: [
        `WDIO full-chain step outcome is ${selectedWdioOutcome ?? "missing"}.`,
      ],
    };
  }
  return {
    status: "pass",
    reasons: [],
  };
}

function validateExecutableEvidence(currentAvailability) {
  const reasons = [];
  const executables = currentAvailability?.gitDist?.executableEvidence;
  if (!Array.isArray(executables) || executables.length < 2) {
    reasons.push("gitDist.executableEvidence is incomplete");
  } else {
    for (const key of ["gitExecutable", "gitLfsExecutable"]) {
      const executable = executables.find((entry) => entry.key === key);
      if (!executable) {
        reasons.push(`gitDist.executableEvidence is missing ${key}`);
        continue;
      }
      if (executable.resolvesInsideDistDir !== true) {
        reasons.push(
          `${key} does not resolve inside the embedded Git resource directory`,
        );
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

  return {
    checkable: reasons.length === 0,
    reasons,
  };
}

function selectOutcome(currentOutcomes, currentRunnerLabel) {
  const normalizedRunner = currentRunnerLabel.toLowerCase();
  if (normalizedRunner.includes("linux")) {
    return currentOutcomes.linux;
  }
  if (normalizedRunner.includes("windows")) {
    return currentOutcomes.windows;
  }
  return Object.values(currentOutcomes).find((outcome) => outcome) ?? null;
}

function normalizeOutcome(value) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["success", "failure", "cancelled", "skipped"].includes(normalized)) {
    return normalized;
  }
  return normalized;
}

function inferTarget(currentAvailability) {
  const sourceTarget = currentAvailability?.gitDistSource?.target;
  if (sourceTarget) {
    return sourceTarget;
  }
  const runnerOs = process.env.RUNNER_OS ?? "";
  if (runnerOs === "Linux") {
    return "linux-x86_64";
  }
  if (runnerOs === "Windows") {
    return "windows-x86_64";
  }
  return null;
}

function collectCiEnvironment() {
  return {
    ci: process.env.CI ?? null,
    githubActions: process.env.GITHUB_ACTIONS ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
    ref: process.env.GITHUB_REF ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null,
    eventName: process.env.GITHUB_EVENT_NAME ?? null,
  };
}

function renderMarkdown(value) {
  const lines = [
    "# Phase 12 E2E Runtime Evidence",
    "",
    `Status: ${value.status}`,
    `Target: ${value.target ?? "unknown"}`,
    `Availability: ${value.availabilityReport.status ?? "missing"}`,
    `WDIO outcome: ${value.wdio.selectedOutcome ?? "missing"}`,
    `Artifact source: ${value.gitDistSource?.source ?? "unknown"}`,
  ];
  if (value.gitDistSource?.runId) {
    lines.push(
      `Git Distribution run: ${
        value.gitDistSource.runUrl ?? value.gitDistSource.runId
      }`,
      `Git Distribution artifact: ${
        value.gitDistSource.artifactName ?? "unknown"
      }`,
    );
  }
  if (value.taskReadiness.reasons.length > 0) {
    lines.push("", "## Reasons", "");
    for (const reason of value.taskReadiness.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push("");
  return `${lines.join(os.EOL)}${os.EOL}`;
}

function nonEmptyEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value : null;
}

function parseArgs(args) {
  const parsed = {
    availabilityReportPath: null,
    linuxOutcome: null,
    reportPath: null,
    windowsOutcome: null,
  };
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("--availability-report=")) {
      parsed.availabilityReportPath = arg.slice(
        "--availability-report=".length,
      );
    } else if (arg.startsWith("--linux-outcome=")) {
      parsed.linuxOutcome = arg.slice("--linux-outcome=".length);
    } else if (arg.startsWith("--report=")) {
      parsed.reportPath = arg.slice("--report=".length);
    } else if (arg.startsWith("--windows-outcome=")) {
      parsed.windowsOutcome = arg.slice("--windows-outcome=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
