#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage:
  node scripts/verify-git-dist-build-evidence.mjs --evidence=/path/git-dist-build-evidence.json --target=<target> --run-id=<run-id>

Verifies that a release job is consuming a reusable git-dist artifact produced
by the expected Git Distribution workflow run and target.`);
  process.exit(0);
}

const evidencePath =
  args.evidence ?? process.env.ARTISTIC_GIT_DIST_BUILD_EVIDENCE ?? null;
const expectedTarget =
  args.target ?? process.env.ARTISTIC_GIT_DIST_TARGET ?? null;
const expectedRunId =
  args.runId ?? process.env.ARTISTIC_GIT_DIST_RUN_ID ?? null;
const expectedArtifactName =
  args.artifactName ??
  process.env.ARTISTIC_GIT_DIST_ARTIFACT_NAME ??
  (expectedTarget ? `artistic-git-dist-${expectedTarget}` : null);

if (!evidencePath) {
  fail("--evidence or ARTISTIC_GIT_DIST_BUILD_EVIDENCE is required.");
}
if (!expectedTarget) {
  fail("--target or ARTISTIC_GIT_DIST_TARGET is required.");
}
if (!expectedRunId) {
  fail("--run-id or ARTISTIC_GIT_DIST_RUN_ID is required.");
}

const evidence = readJson(evidencePath);
const build = evidence.workflowBuild;

if (!build || typeof build !== "object") {
  fail("workflowBuild evidence is missing.");
}
if (String(build.run?.runId ?? "") !== String(expectedRunId)) {
  fail(
    `workflowBuild.run.runId mismatch: expected ${expectedRunId}, got ${
      build.run?.runId ?? "missing"
    }.`,
  );
}
if (build.mode !== "build") {
  fail(`workflowBuild.mode must be build, got ${build.mode ?? "missing"}.`);
}
if (build.target?.name !== expectedTarget) {
  fail(
    `workflowBuild.target.name mismatch: expected ${expectedTarget}, got ${
      build.target?.name ?? "missing"
    }.`,
  );
}
if (build.target?.artifactName !== expectedArtifactName) {
  fail(
    `workflowBuild.target.artifactName mismatch: expected ${expectedArtifactName}, got ${
      build.target?.artifactName ?? "missing"
    }.`,
  );
}
if (build.target?.blocked === true || build.target?.status !== "ready") {
  fail(
    `workflowBuild target is not reusable: status=${
      build.target?.status ?? "missing"
    }, blocked=${String(build.target?.blocked)}.`,
  );
}
if (build.validationSummary?.reusableArtifactProduced !== true) {
  fail(
    "workflowBuild.validationSummary.reusableArtifactProduced must be true.",
  );
}
if (
  !["validated-cache-hit", "validated-fresh-build"].includes(
    build.validationSummary?.status,
  )
) {
  fail(
    `workflowBuild.validationSummary.status is not reusable: ${
      build.validationSummary?.status ?? "missing"
    }.`,
  );
}

const reusableArtifact = Array.isArray(build.artifactIndex)
  ? build.artifactIndex.find(
      (artifact) => artifact.kind === "reusable-git-dist",
    )
  : null;
if (!reusableArtifact) {
  fail("workflowBuild.artifactIndex is missing reusable-git-dist.");
}
if (reusableArtifact.name !== expectedArtifactName) {
  fail(
    `reusable artifact name mismatch: expected ${expectedArtifactName}, got ${reusableArtifact.name}.`,
  );
}
if (reusableArtifact.produced !== true) {
  fail("reusable git-dist artifact was not produced.");
}

const validationCommands = build.validationSummary?.commands;
if (!Array.isArray(validationCommands)) {
  fail("workflowBuild.validationSummary.commands must be an array.");
}
if (
  !validationCommands.includes(
    `node scripts/check-git-dist.mjs --target="${expectedTarget}"`,
  )
) {
  fail("build evidence does not record target runtime validation.");
}
if (
  validationCommands.some((command) => String(command).includes("--no-exec"))
) {
  fail(
    "build evidence records --no-exec validation, which is not release-ready.",
  );
}

console.log(
  `git-dist build evidence verified: ${expectedArtifactName} from run ${expectedRunId}`,
);

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    fail(`could not read build evidence ${filePath}: ${error.message}`);
  }
}

function parseArgs(rawArgs) {
  const parsed = {
    artifactName: null,
    evidence: null,
    help: false,
    runId: null,
    target: null,
  };
  for (const arg of rawArgs) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg.startsWith("--artifact-name=")) {
      parsed.artifactName = arg.slice("--artifact-name=".length);
    } else if (arg.startsWith("--evidence=")) {
      parsed.evidence = arg.slice("--evidence=".length);
    } else if (arg.startsWith("--run-id=")) {
      parsed.runId = arg.slice("--run-id=".length);
    } else if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function fail(message) {
  console.error(`git-dist build evidence verification failed: ${message}`);
  process.exit(1);
}
