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
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const gitDistDir = path.join(
  repositoryRoot,
  "src-tauri",
  "resources",
  "git-dist",
);

const report = {
  checkedAt: new Date().toISOString(),
  command: "pnpm e2e:tauri:ci",
  gitDistDir,
  gitDistSource: {
    source: "workspace-resource",
    target: null,
  },
  platform: process.platform,
  runnerOs: process.env.RUNNER_OS ?? null,
  schemaVersion: 2,
  gitDist: {
    dir: gitDistDir,
    manifestPath: path.join(gitDistDir, "manifest.json"),
    manifest: null,
    executableEvidence: [],
    versions: null,
  },
};

if (!existsSync(gitDistDir)) {
  finish(
    "failed",
    `Embedded Git resource directory does not exist: ${gitDistDir}.`,
    1,
  );
}

const manifestPath = path.join(gitDistDir, "manifest.json");
if (!existsSync(manifestPath)) {
  finish(
    "failed",
    `Embedded Git resource directory is missing manifest.json: ${manifestPath}.`,
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
report.gitDistSource.target = manifest.target ?? manifest.platform ?? null;
const manifestContractError = validateManifestContract(manifest);
if (manifestContractError) {
  finish("failed", manifestContractError, 1);
}

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
      `${key} resolves outside the embedded Git resource directory (${realPath}).`,
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
    target: manifest.target ?? null,
    toolchainRevision: manifest.toolchainRevision ?? null,
    baseFingerprint: manifest.baseFingerprint ?? null,
    helperFingerprint: manifest.helperFingerprint ?? null,
    distributionFingerprint: manifest.distributionFingerprint ?? null,
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

function validateManifestContract(manifest) {
  if (manifest?.schemaVersion !== 2) {
    return `manifest.schemaVersion must be 2, got ${manifest?.schemaVersion ?? "missing"}.`;
  }
  for (const field of [
    "target",
    "toolchainRevision",
    "baseFingerprint",
    "helperFingerprint",
    "distributionFingerprint",
  ]) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      return `manifest.${field} must be a non-empty string.`;
    }
  }
  return null;
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
