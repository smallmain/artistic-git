#!/usr/bin/env node
/* global console, process */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
const markdownPath = reportPath.endsWith(".json")
  ? `${reportPath.slice(0, -".json".length)}.md`
  : `${reportPath}.md`;
const gitDistDir = nonEmpty(process.env.ARTISTIC_GIT_DIST_DIR);
const realGitRequested = process.env.ARTISTIC_GIT_E2E_REAL_GIT === "1";

const report = {
  checkedAt: new Date().toISOString(),
  command:
    "ARTISTIC_GIT_E2E_REAL_GIT=1 ARTISTIC_GIT_DIST_DIR=<git-dist> pnpm e2e:tauri:ci",
  gitDistDir,
  gitDistSource: {
    source:
      nonEmpty(process.env.ARTISTIC_GIT_PHASE12_GIT_DIST_SOURCE) ??
      (gitDistDir ? "direct-env" : "none"),
    artifactName: nonEmpty(
      process.env.ARTISTIC_GIT_PHASE12_GIT_DIST_ARTIFACT_NAME,
    ),
    runId: nonEmpty(process.env.ARTISTIC_GIT_PHASE12_GIT_DIST_RUN_ID),
    runUrl: nonEmpty(process.env.ARTISTIC_GIT_PHASE12_GIT_DIST_RUN_URL),
    target: nonEmpty(process.env.ARTISTIC_GIT_PHASE12_GIT_DIST_TARGET),
    downloadDir: nonEmpty(
      process.env.ARTISTIC_GIT_PHASE12_GIT_DIST_DOWNLOAD_DIR,
    ),
  },
  platform: process.platform,
  realGitRequested,
  runnerOs: process.env.RUNNER_OS ?? null,
  schemaVersion: 2,
  gitDist: {
    dir: gitDistDir,
    manifestPath: gitDistDir ? path.join(gitDistDir, "manifest.json") : null,
    manifest: null,
    executableEvidence: [],
    versions: null,
  },
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

report.gitDist.manifest = summarizeManifest(manifest);

if (!manifest?.paths || typeof manifest.paths !== "object") {
  finish("failed", "manifest.paths must be an object.", 1);
}
if (
  typeof manifest.paths.gitExecutable !== "string" ||
  manifest.paths.gitExecutable.trim() === ""
) {
  finish(
    "failed",
    "manifest.paths.gitExecutable must be a non-empty string.",
    1,
  );
}
if (
  typeof manifest.paths.gitLfsExecutable !== "string" ||
  manifest.paths.gitLfsExecutable.trim() === ""
) {
  finish(
    "failed",
    "manifest.paths.gitLfsExecutable must be a non-empty string.",
    1,
  );
}

const distRoot = path.resolve(gitDistDir);
const distRootReal = realpathSync(distRoot);
const gitEvidence = executableEvidence({
  distRoot,
  distRootReal,
  key: "gitExecutable",
  manifest,
  relativePath: manifest.paths.gitExecutable,
});
const gitLfsEvidence = executableEvidence({
  distRoot,
  distRootReal,
  key: "gitLfsExecutable",
  manifest,
  relativePath: manifest.paths.gitLfsExecutable,
});
report.gitDist.executableEvidence.push(gitEvidence, gitLfsEvidence);

const versionEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  PATH: [
    path.dirname(gitEvidence.absolutePath),
    path.dirname(gitLfsEvidence.absolutePath),
  ].join(path.delimiter),
};

const gitVersion = runTool(
  gitEvidence.absolutePath,
  ["--version"],
  "embedded git",
  versionEnv,
);
const gitLfsExecutableVersion = runTool(
  gitLfsEvidence.absolutePath,
  ["version"],
  "embedded git-lfs",
  versionEnv,
);
const gitLfsViaGitVersion = runTool(
  gitEvidence.absolutePath,
  ["lfs", "version"],
  "embedded git lfs",
  versionEnv,
);

report.gitDist.versions = {
  git: gitVersion.stdout.trim(),
  gitLfsExecutable: gitLfsExecutableVersion.stdout.trim(),
  gitLfsViaGit: gitLfsViaGitVersion.stdout.trim(),
};

finish(
  "ready",
  `real embedded Git is available at ${gitEvidence.absolutePath}`,
  0,
  {
    gitLfsPath: gitLfsEvidence.absolutePath,
    gitPath: gitEvidence.absolutePath,
    gitVersion: report.gitDist.versions.git,
  },
);

function executableEvidence({
  distRoot,
  distRootReal,
  key,
  relativePath,
  manifest,
}) {
  try {
    assertRelativeManifestPath(relativePath, key);
  } catch (error) {
    finish("failed", error.message, 1);
  }

  const absolutePath = path.join(distRoot, relativePath);
  if (!existsSync(absolutePath)) {
    finish("failed", `${key} was not found at ${absolutePath}.`, 1);
  }

  const realPath = realpathSync(absolutePath);
  if (!isInside(distRootReal, realPath)) {
    finish(
      "failed",
      `${key} resolves outside ARTISTIC_GIT_DIST_DIR (${realPath}). Refusing to search PATH or use system Git.`,
      1,
    );
  }

  const manifestSha256 = manifest.sha256?.[relativePath];
  if (typeof manifestSha256 !== "string" || manifestSha256.trim() === "") {
    finish(
      "failed",
      `manifest.sha256 must include ${relativePath} for ${key}. Refusing unverifiable git-dist evidence.`,
      1,
    );
  }

  const actualSha256 = sha256File(absolutePath);
  if (actualSha256 !== manifestSha256.toLowerCase()) {
    finish(
      "failed",
      `manifest.sha256 mismatch for ${key} (${relativePath}): expected ${manifestSha256}, got ${actualSha256}`,
      1,
    );
  }

  return {
    absolutePath,
    key,
    manifestSha256,
    realPath,
    relativePath,
    resolvesInsideDistDir: true,
    sha256: actualSha256,
    symlink: lstatSync(absolutePath).isSymbolicLink(),
  };
}

function runTool(command, args, label, env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
  });

  if (result.error) {
    finish(
      "failed",
      `${label} could not be launched: ${result.error.message}`,
      1,
      { failedCommand: command },
    );
  }
  if (result.status !== 0) {
    finish("failed", `${label} failed with exit code ${result.status}.`, 1, {
      failedCommand: command,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }

  return result;
}

function summarizeManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion ?? null,
    platform: manifest.platform ?? null,
    gitVersion: manifest.gitVersion ?? null,
    gitLfsVersion: manifest.gitLfsVersion ?? null,
    windowsOpenSshVersion: manifest.windowsOpenSshVersion ?? null,
    helperVersion: manifest.helperVersion ?? null,
    paths: manifest.paths ?? null,
    sha256EntryCount:
      manifest.sha256 && typeof manifest.sha256 === "object"
        ? Object.keys(manifest.sha256).length
        : 0,
  };
}

function finish(status, reason, exitCode, extra = {}) {
  const finalReport = {
    ...report,
    ...extra,
    reason,
    status,
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(finalReport));
  writeGitHubOutput({
    markdown_path: markdownPath,
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

function renderMarkdown(value) {
  const lines = [
    "# E2E Real-Git Evidence",
    "",
    `Status: ${value.status}`,
    `Reason: ${value.reason}`,
    `Git dist: ${value.gitDistDir ?? "not provided"}`,
    `Source: ${value.gitDistSource.source}`,
  ];

  if (value.gitDistSource.runId) {
    lines.push(
      `Artifact: ${value.gitDistSource.artifactName ?? "unknown"}`,
      `Git Distribution run: ${value.gitDistSource.runUrl ?? value.gitDistSource.runId}`,
    );
  }

  lines.push("", "## Executables", "");
  if (value.gitDist.executableEvidence.length === 0) {
    lines.push("No real git-dist executable evidence was collected.");
  } else {
    lines.push("| Key | Relative path | SHA-256 verified | Inside dist |");
    lines.push("| --- | --- | --- | --- |");
    for (const executable of value.gitDist.executableEvidence) {
      lines.push(
        `| ${executable.key} | ${executable.relativePath} | yes | ${
          executable.resolvesInsideDistDir ? "yes" : "no"
        } |`,
      );
    }
  }

  if (value.gitDist.versions) {
    lines.push(
      "",
      "## Versions",
      "",
      `- git: ${value.gitDist.versions.git}`,
      `- git-lfs executable: ${value.gitDist.versions.gitLfsExecutable}`,
      `- git lfs via git: ${value.gitDist.versions.gitLfsViaGit}`,
    );
  }

  lines.push("", "## Runtime Command", "", "```sh", value.command, "```", "");
  return `${lines.join(os.EOL)}${os.EOL}`;
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

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function assertRelativeManifestPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`manifest paths.${label} must be a relative resource path`);
  }
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
