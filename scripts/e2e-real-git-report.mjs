#!/usr/bin/env node
/* global console, process */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const reportPath = nonEmpty(process.env.ARTISTIC_GIT_E2E_REPORT)
  ? path.resolve(process.env.ARTISTIC_GIT_E2E_REPORT)
  : path.resolve(
      "artifacts",
      `e2e-real-git-report-${process.env.RUNNER_OS ?? process.platform}.json`,
    );
const gitDistDir = nonEmpty(process.env.ARTISTIC_GIT_DIST_DIR);
const realGitRequested = process.env.ARTISTIC_GIT_E2E_REAL_GIT === "1";

const baseReport = {
  checkedAt: new Date().toISOString(),
  command:
    "ARTISTIC_GIT_E2E_REAL_GIT=1 ARTISTIC_GIT_DIST_DIR=<git-dist> pnpm e2e:tauri:ci",
  gitDistDir,
  platform: process.platform,
  realGitRequested,
  runnerOs: process.env.RUNNER_OS ?? null,
  schemaVersion: 1,
};

if (!gitDistDir) {
  finish(
    realGitRequested ? "failed" : "skipped",
    realGitRequested
      ? "ARTISTIC_GIT_E2E_REAL_GIT=1 but ARTISTIC_GIT_DIST_DIR is not set. Refusing to search PATH or use system Git."
      : "ARTISTIC_GIT_DIST_DIR is not set. Real Git full-chain E2E is skipped; system Git fallback is forbidden.",
    realGitRequested ? 1 : 0,
  );
}

if (!existsSync(gitDistDir)) {
  finish(
    "failed",
    `ARTISTIC_GIT_DIST_DIR does not exist: ${gitDistDir}. Refusing to search PATH or use system Git.`,
    1,
  );
}

const manifestPath = path.join(gitDistDir, "manifest.json");
if (!existsSync(manifestPath)) {
  finish(
    "failed",
    `ARTISTIC_GIT_DIST_DIR is missing manifest.json: ${manifestPath}.`,
    1,
  );
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  finish(
    "failed",
    `Could not parse git-dist manifest.json: ${error.message}`,
    1,
  );
}

const gitExecutable = manifest?.paths?.gitExecutable;
if (typeof gitExecutable !== "string" || gitExecutable.trim() === "") {
  finish(
    "failed",
    "manifest.paths.gitExecutable must be a non-empty string.",
    1,
  );
}

const gitPath = path.resolve(gitDistDir, gitExecutable);
if (!isInside(gitDistDir, gitPath)) {
  finish(
    "failed",
    `manifest.paths.gitExecutable must stay inside ARTISTIC_GIT_DIST_DIR: ${gitExecutable}`,
    1,
  );
}

if (!existsSync(gitPath)) {
  finish("failed", `embedded git executable was not found at ${gitPath}.`, 1);
}

const version = spawnSync(gitPath, ["--version"], {
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: path.dirname(gitPath),
  },
});

if (version.error) {
  finish(
    "failed",
    `embedded git executable could not be launched: ${version.error.message}`,
    1,
    { gitPath },
  );
}

if (version.status !== 0) {
  finish(
    "failed",
    `embedded git --version failed with exit code ${version.status}.`,
    1,
    {
      gitPath,
      stderr: version.stderr,
      stdout: version.stdout,
    },
  );
}

finish("ready", `real embedded Git is available at ${gitPath}`, 0, {
  gitPath,
  gitVersion: version.stdout.trim(),
});

function finish(status, reason, exitCode, extra = {}) {
  const report = {
    ...baseReport,
    ...extra,
    reason,
    status,
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeGitHubOutput({
    ready: status === "ready" ? "true" : "false",
    report_path: reportPath,
    status,
  });

  const prefix = status === "failed" ? "failed" : status;
  const message = `E2E real-git ${prefix}: ${reason}`;
  if (status === "failed") {
    console.error(message);
    console.error(`Wrote E2E real-git report to ${reportPath}`);
  } else {
    console.log(message);
    console.log(`Wrote E2E real-git report to ${reportPath}`);
  }
  process.exit(exitCode);
}

function writeGitHubOutput(values) {
  const outputPath = nonEmpty(process.env.GITHUB_OUTPUT);
  if (!outputPath) {
    return;
  }

  appendFileSync(
    outputPath,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join(os.EOL) + os.EOL,
  );
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
