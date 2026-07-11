#!/usr/bin/env node
/* global Buffer, console, performance, process */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  cpus,
  freemem,
  release as osRelease,
  tmpdir,
  totalmem,
  type as osType,
} from "node:os";
import path from "node:path";

const scriptStartedAt = new Date();
const scriptStartedMs = performance.now();
const cli = parseArgs(process.argv.slice(2));

if (cli.help) {
  console.log(usage());
  process.exit(0);
}

const heavy =
  cli.profile === "heavy" ||
  (cli.profile !== "light" && process.env.ARTISTIC_GIT_PERF_HEAVY === "1");
const profileName = heavy ? "heavy" : "light";
const reportPath =
  cli.reportPath ??
  process.env.ARTISTIC_GIT_PHASE12_PERF_REPORT ??
  (process.env.CI ? path.join("artifacts", "phase12-perf-report.json") : null);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const gitDistDir = path.join(
  repositoryRoot,
  "src-tauri",
  "resources",
  "git-dist",
);
const keep = process.env.ARTISTIC_GIT_PERF_KEEP_TEMP === "1";
const report = {
  schemaVersion: 2,
  kind: "phase12-perf",
  generatedAt: scriptStartedAt.toISOString(),
  profileName,
  heavy,
  command: {
    argv: process.argv.slice(2),
    reportPath,
  },
  environment: collectEnvironment(),
  ci: collectCiEnvironment(),
  profile: null,
  thresholds: null,
  status: "running",
  result: "running",
  gitDistDir,
  gitDistSource: collectGitDistSource(),
  gitDist: {
    dir: gitDistDir,
    manifestPath: gitDistDir ? path.join(gitDistDir, "manifest.json") : null,
    manifest: null,
    executableEvidence: [],
    versions: null,
  },
  blockers: [],
  checks: [],
  nextActions: buildNextActions(),
  taskReadiness: null,
};

try {
  report.profile = buildProfile(heavy);
  report.thresholds = buildThresholds(report.profile);
} catch (error) {
  finishBlocker(error);
}

let root = null;
let repo = null;
let gitPath = null;
let env = null;
let exitCode = 0;

try {
  const manifestPath = path.join(gitDistDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`git distribution manifest is missing at ${manifestPath}`);
  }

  const manifest = readManifest(manifestPath);
  report.gitDist.manifest = summarizeManifest(manifest);
  report.gitDistSource.target = manifest.target ?? manifest.platform ?? null;
  validateManifestContract(manifest);
  if (!manifest.paths?.gitExecutable || !manifest.paths?.gitLfsExecutable) {
    throw new Error(
      `git distribution manifest has invalid executable paths at ${manifestPath}`,
    );
  }

  const distRootReal = realpathSync(gitDistDir);
  const gitEvidence = executableEvidence({
    distRoot: gitDistDir,
    distRootReal,
    key: "gitExecutable",
    relativePath: manifest.paths.gitExecutable,
    manifest,
  });
  const gitLfsEvidence = executableEvidence({
    distRoot: gitDistDir,
    distRootReal,
    key: "gitLfsExecutable",
    relativePath: manifest.paths.gitLfsExecutable,
    manifest,
  });
  report.gitDist.executableEvidence.push(gitEvidence, gitLfsEvidence);
  gitPath = gitEvidence.absolutePath;
  const gitLfsPath = gitLfsEvidence.absolutePath;

  root = mkdtempSync(path.join(tmpdir(), "ag-phase12-perf-"));
  repo = path.join(root, "repo");
  env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: path.join(root, "home"),
    PATH: [
      path.dirname(gitPath),
      path.dirname(gitLfsPath),
      process.env.PATH ?? "",
    ].join(path.delimiter),
  };

  mkdirSync(env.HOME, { recursive: true });
  report.gitDist.versions = {
    git: runGit(["--version"], undefined).trim(),
    gitLfsViaGit: runGit(["lfs", "version"], undefined).trim(),
    gitLfsExecutable: runToolChecked(
      gitLfsPath,
      ["version"],
      undefined,
      "git-lfs executable",
    ).stdout.trim(),
  };
  runGit(["init", "-b", "main", repo]);
  runGit(["config", "user.name", "Phase 12 Perf"], repo);
  runGit(["config", "user.email", "phase12-perf@example.test"], repo);
  runGit(["config", "core.fsmonitor", "true"], repo);
  runGit(["config", "core.untrackedCache", "true"], repo);

  verifyHistoryPagination();
  verifyLargeStatus();
  verifyLargeBinaryAndLfs();

  finishReport("pass", {
    rootKept: keep ? root : null,
  });
  writeReport();
  console.log(
    `PASS phase12 perf verification (${profileName}): ` +
      `${report.profile.commitCount} commits, ${report.profile.fileCount} files, ` +
      `${report.profile.binaryBytes} byte binary.`,
  );
} catch (error) {
  markBlocker(error);
  console.error(
    `BLOCKER phase12 perf verification: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  if (
    process.env.ARTISTIC_GIT_PHASE12_PERF_DEBUG === "1" &&
    error instanceof Error &&
    error.stack
  ) {
    console.error(error.stack);
  }
  exitCode = 1;
} finally {
  if (root) {
    if (keep) {
      console.log(`Keeping perf fixture at ${root}`);
    } else {
      cleanupTempRoot(root);
    }
  }
}

if (exitCode !== 0) {
  process.exit(exitCode);
}

function verifyHistoryPagination() {
  const fixtureStarted = performance.now();
  const historyDir = path.join(repo, "history");
  const seedRelativePath = path.join("history", "seed.txt");
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(path.join(repo, seedRelativePath), "phase 12 history seed\n");
  runGit(["add", seedRelativePath], repo);
  const tree = runGit(["write-tree"], repo).trim();

  let parent = null;
  for (let index = 0; index < report.profile.commitCount; index += 1) {
    const args = ["commit-tree", tree, "-m", `history ${index}`];
    if (parent) {
      args.push("-p", parent);
    }
    parent = runGit(args, repo).trim();
    runGit(["update-ref", "refs/heads/main", parent], repo);
  }

  const fixtureCreateMs = performance.now() - fixtureStarted;
  const paginationStarted = performance.now();
  const firstPageStarted = performance.now();
  const firstPage = logPage(0);
  const firstPageMs = performance.now() - firstPageStarted;
  assertEqual(
    firstPage.length,
    Math.min(200, report.profile.commitCount),
    "first history page size",
  );
  assert(
    firstPage[0]?.includes(`history ${report.profile.commitCount - 1}`),
    "history is newest-first",
  );

  let secondPage = [];
  let secondPageMs = 0;
  if (report.profile.commitCount > 200) {
    const secondPageStarted = performance.now();
    secondPage = logPage(200);
    secondPageMs = performance.now() - secondPageStarted;
    assert(secondPage.length > 0, "second history page is available");
    assertNotEqual(
      firstPage.at(-1),
      secondPage[0],
      "history pages do not overlap at boundary",
    );
  }

  const elapsedMs = Math.round(performance.now() - paginationStarted);
  assert(
    elapsedMs <= report.thresholds.historyPagination.maxElapsedMs,
    `history pagination query took ${elapsedMs}ms, budget ${report.thresholds.historyPagination.maxElapsedMs}ms`,
  );
  recordCheck("historyPagination", {
    thresholds: report.thresholds.historyPagination,
    metrics: {
      elapsedMs,
      fixtureCreateMs: Math.round(fixtureCreateMs),
      fixtureStrategy: "commit-tree-linear-single-tree",
      firstPageMs: Math.round(firstPageMs),
      secondPageMs: Math.round(secondPageMs),
      commitCount: report.profile.commitCount,
      firstPageSize: firstPage.length,
      secondPageSize: secondPage.length,
      secondPageChecked: report.profile.commitCount > 200,
    },
    evidence: {
      pageSize: 200,
      fixtureStrategy: "commit-tree-linear-single-tree",
      seedPath: seedRelativePath,
      newestFirstSubject: firstPage[0]?.split("\x01").at(-1) ?? null,
    },
  });
}

function verifyLargeStatus() {
  const bulkDir = path.join(repo, "bulk");
  mkdirSync(bulkDir, { recursive: true });
  for (let index = 0; index < report.profile.fileCount; index += 1) {
    writeFileSync(
      path.join(bulkDir, `${index.toString().padStart(6, "0")}.txt`),
      `${index}\n`,
    );
  }

  const untrackedCacheProbe = runGit(
    ["update-index", "--test-untracked-cache"],
    repo,
  ).trim();
  const started = performance.now();
  const status = runGit(
    ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    repo,
  );
  const elapsed = performance.now() - started;
  const statusEntries = status.split("\0").filter(Boolean);
  const fsmonitorProbe = probeFsmonitorDaemon();
  assert(
    elapsed <= report.thresholds.largeStatus.maxElapsedMs,
    `status took ${Math.round(elapsed)}ms, budget ${report.thresholds.largeStatus.maxElapsedMs}ms`,
  );
  assert(
    status.includes("?? bulk/000000.txt"),
    "status reports untracked bulk files",
  );
  assertEqual(
    statusEntries.length,
    report.profile.fileCount,
    "status entry count for untracked bulk files",
  );
  assertEqual(
    runGit(["config", "--get", "core.fsmonitor"], repo).trim(),
    "true",
    "core.fsmonitor config",
  );
  assertEqual(
    runGit(["config", "--get", "core.untrackedCache"], repo).trim(),
    "true",
    "core.untrackedCache config",
  );
  if (report.thresholds.largeStatus.requireFsmonitorDaemonWatching) {
    assert(
      fsmonitorProbe.watching,
      `fsmonitor daemon is not watching this repository: ${fsmonitorProbe.output}`,
    );
  }
  recordCheck("largeStatus", {
    thresholds: report.thresholds.largeStatus,
    metrics: {
      elapsedMs: Math.round(elapsed),
      fileCount: report.profile.fileCount,
      statusItemCount: statusEntries.length,
      fsmonitorConfigured: true,
      untrackedCacheConfigured: true,
      untrackedCacheProbePassed: true,
    },
    evidence: {
      untrackedCacheProbe,
      fsmonitorDaemon: fsmonitorProbe,
    },
  });
}

function verifyLargeBinaryAndLfs() {
  const started = performance.now();

  runGit(["lfs", "install", "--local"], repo);
  runGit(["lfs", "track", "*.bin"], repo);
  writeFileSync(
    path.join(repo, "large.bin"),
    Buffer.alloc(report.profile.binaryBytes, 7),
  );
  runGit(["add", ".gitattributes", "large.bin"], repo);
  runGit(["commit", "-m", "add lfs binary"], repo);

  const pointer = runGit(["show", "HEAD:large.bin"], repo);
  assert(
    pointer.startsWith("version https://git-lfs.github.com/spec/v1"),
    "large binary is stored as an LFS pointer in Git history",
  );
  const pointerSize = Buffer.byteLength(pointer);
  assert(
    pointerSize < 1024,
    `LFS pointer should be small; got ${pointerSize} bytes`,
  );
  assertEqual(
    readFileSync(path.join(repo, "large.bin")).length,
    report.profile.binaryBytes,
    "working tree binary size",
  );
  const elapsedMs = Math.round(performance.now() - started);
  assert(
    elapsedMs <= report.thresholds.largeBinaryLfs.maxElapsedMs,
    `LFS binary check took ${elapsedMs}ms, budget ${report.thresholds.largeBinaryLfs.maxElapsedMs}ms`,
  );
  recordCheck("largeBinaryLfs", {
    thresholds: report.thresholds.largeBinaryLfs,
    metrics: {
      elapsedMs,
      binaryBytes: report.profile.binaryBytes,
      pointerSize,
      pointerStored: true,
      workingTreeBytes: report.profile.binaryBytes,
    },
    evidence: {
      pointerHeader: pointer.split("\n")[0],
      oidLinePresent: pointer
        .split("\n")
        .some((line) => line.startsWith("oid ")),
    },
  });
}

function logPage(skip) {
  return runGit(
    [
      "log",
      "--topo-order",
      "--parents",
      "--format=%H%x01%P%x01%s",
      "-n",
      "200",
      "--skip",
      String(skip),
    ],
    repo,
  )
    .trim()
    .split("\n")
    .filter(Boolean);
}

function probeFsmonitorDaemon() {
  const probe = runGitForEvidence(["fsmonitor--daemon", "status"], repo);
  const output = [probe.stdout, probe.stderr].filter(Boolean).join("\n").trim();
  return {
    exitCode: probe.status,
    supported: !/not supported/i.test(output),
    watching: probe.status === 0 && /is watching/i.test(output),
    output,
  };
}

function runGit(args, cwd) {
  const result = runGitForEvidence(args, cwd);
  if (result.error || result.status !== 0) {
    throw commandFailureError("git", gitPath, args, cwd, result);
  }
  return result.stdout;
}

function runGitForEvidence(args, cwd) {
  return runTool(gitPath, args, cwd, env);
}

function runTool(toolPath, args, cwd, extraEnv = process.env) {
  return spawnSync(toolPath, args, {
    cwd,
    env: extraEnv,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runToolChecked(toolPath, args, cwd, label, extraEnv = env) {
  const result = runTool(toolPath, args, cwd, extraEnv);
  if (result.error || result.status !== 0) {
    throw commandFailureError(label, toolPath, args, cwd, result);
  }
  return {
    ...result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandFailureError(label, toolPath, args, cwd, result) {
  const message = [
    `${label} ${args.join(" ")} failed in ${cwd ?? process.cwd()}`,
    `tool: ${toolPath}`,
    `status: ${result.status ?? "not-started"}`,
    `signal: ${result.signal ?? "none"}`,
    result.error ? formatSpawnError(result.error) : null,
    "stdout:",
    safeOutput(result.stdout),
    "stderr:",
    safeOutput(result.stderr),
  ]
    .filter((line) => line !== null)
    .join("\n");
  return new Error(message, { cause: result.error });
}

function formatSpawnError(error) {
  const details = [`spawn error: ${error.message}`];
  if (error.code) {
    details.push(`code=${error.code}`);
  }
  if (error.errno !== undefined) {
    details.push(`errno=${error.errno}`);
  }
  if (error.path) {
    details.push(`path=${error.path}`);
  }
  if (Array.isArray(error.spawnargs)) {
    details.push(`spawnargs=${JSON.stringify(error.spawnargs)}`);
  }
  return details.join("\n");
}

function safeOutput(value) {
  if (value === null || value === undefined || value === "") {
    return "<empty>";
  }
  return String(value);
}

function cleanupTempRoot(rootPath) {
  try {
    rmSync(rootPath, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(
      `WARN phase12 perf cleanup failed for ${rootPath}: ${formatError(error)}`,
    );
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildProfile(isHeavy) {
  return {
    binaryBytes: numberFromEnv(
      "ARTISTIC_GIT_PERF_BINARY_BYTES",
      isHeavy ? 128 * 1024 * 1024 : 5 * 1024 * 1024,
    ),
    commitCount: numberFromEnv(
      "ARTISTIC_GIT_PERF_COMMITS",
      isHeavy ? 10_000 : 300,
    ),
    fileCount: numberFromEnv(
      "ARTISTIC_GIT_PERF_FILES",
      isHeavy ? 50_000 : 2_000,
    ),
  };
}

function buildThresholds(currentProfile) {
  return {
    gitDist: {
      requireManifestSha256For: ["gitExecutable", "gitLfsExecutable"],
      requireExecutablesInsideDistDir: true,
      rejectSystemGitFallback: true,
    },
    historyPagination: {
      minCommits: currentProfile.commitCount,
      pageSize: 200,
      maxElapsedMs: numberFromEnv(
        "ARTISTIC_GIT_PERF_HISTORY_BUDGET_MS",
        heavy ? 300_000 : 60_000,
      ),
    },
    largeStatus: {
      minUntrackedFiles: currentProfile.fileCount,
      maxElapsedMs: numberFromEnv(
        "ARTISTIC_GIT_PERF_STATUS_BUDGET_MS",
        heavy ? 30_000 : 10_000,
      ),
      requireFsmonitorConfig: true,
      requireFsmonitorDaemonWatching:
        process.env.ARTISTIC_GIT_PERF_REQUIRE_FSMONITOR_DAEMON === "1" ||
        process.platform === "darwin" ||
        process.platform === "win32",
      requireUntrackedCacheConfig: true,
      requireUntrackedCacheProbe: true,
    },
    largeBinaryLfs: {
      minBinaryBytes: currentProfile.binaryBytes,
      maxElapsedMs: numberFromEnv(
        "ARTISTIC_GIT_PERF_LFS_BUDGET_MS",
        heavy ? 120_000 : 30_000,
      ),
      requirePointerStored: true,
      maxPointerBytes: 1024,
      requireWorkingTreeBytes: currentProfile.binaryBytes,
    },
  };
}

function executableEvidence({
  distRoot,
  distRootReal,
  key,
  relativePath,
  manifest,
}) {
  assertRelativeManifestPath(relativePath, key);
  const absolutePath = path.join(distRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`${key} is missing at ${absolutePath}`);
  }
  const realPath = realpathSync(absolutePath);
  if (!isPathInside(realPath, distRootReal)) {
    throw new Error(
      `${key} resolves outside the embedded Git resource directory (${realPath}).`,
    );
  }

  const expectedSha256 = manifest.sha256?.[relativePath] ?? null;
  if (!expectedSha256) {
    throw new Error(
      `manifest sha256 is missing for ${key} (${relativePath}); refusing unverifiable git-dist evidence.`,
    );
  }
  const actualSha256 = sha256File(absolutePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `manifest sha256 mismatch for ${key} (${relativePath}): expected ${expectedSha256}, got ${actualSha256}`,
    );
  }

  return {
    key,
    relativePath,
    absolutePath,
    realPath,
    symlink: lstatSync(absolutePath).isSymbolicLink(),
    resolvesInsideDistDir: true,
    sha256: actualSha256,
    manifestSha256: expectedSha256,
  };
}

function readManifest(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `git distribution manifest is not valid JSON at ${filePath}: ${message}`,
      { cause: error },
    );
  }
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
    throw new Error(
      `git distribution manifest schemaVersion must be 2, got ${manifest?.schemaVersion ?? "missing"}`,
    );
  }
  for (const field of [
    "target",
    "toolchainRevision",
    "baseFingerprint",
    "helperFingerprint",
    "distributionFingerprint",
  ]) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      throw new Error(
        `git distribution manifest ${field} must be a non-empty string`,
      );
    }
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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

function isPathInside(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertNotEqual(actual, expected, label) {
  if (actual === expected) {
    throw new Error(`${label}: both values were ${actual}`);
  }
}

function recordCheck(name, { metrics, thresholds, evidence }) {
  report.checks.push({
    name,
    status: "pass",
    metrics,
    thresholds,
    evidence,
  });
}

function markBlocker(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!report.blockers.some((blocker) => blocker.message === message)) {
    report.blockers.push({
      id: "phase12-perf-blocker",
      message,
    });
  }
  finishReport("blocker", {
    error: message,
  });
  writeReport();
}

function finishBlocker(error, id = "phase12-perf-blocker") {
  const message = error instanceof Error ? error.message : String(error);
  report.blockers.push({
    id,
    message,
  });
  finishReport("blocker", {
    error: message,
  });
  writeReport();
  console.error(`BLOCKER phase12 perf verification: ${message}`);
  process.exit(1);
}

function finishReport(status, extra = {}) {
  report.status = status;
  report.result = status;
  report.completedAt = new Date().toISOString();
  report.durationMs = Math.round(performance.now() - scriptStartedMs);
  report.environment.memory.freeBytesAtEnd = freemem();
  report.summary = {
    status,
    profileName,
    checkCount: report.checks.length,
    blockerCount: report.blockers.length,
    gitDistSource: report.gitDistSource.source,
    gitDistTarget: report.gitDistSource.target,
    gitDistDir,
  };
  report.taskReadiness = buildTaskReadiness(status);
  Object.assign(report, extra);
}

function writeReport() {
  if (!reportPath) {
    return;
  }
  const absoluteReportPath = path.resolve(reportPath);
  mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
  writeFileSync(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownReportPath(absoluteReportPath), renderMarkdown(report));
  console.log(`Wrote phase12 perf report to ${absoluteReportPath}`);
}

function markdownReportPath(jsonPath) {
  return jsonPath.endsWith(".json")
    ? `${jsonPath.slice(0, -".json".length)}.md`
    : `${jsonPath}.md`;
}

function renderMarkdown(currentReport) {
  const lines = [
    "# Phase 12 perf evidence",
    "",
    `Status: ${currentReport.status}`,
    `Profile: ${currentReport.profileName}`,
    `Generated: ${currentReport.generatedAt}`,
    `Completed: ${currentReport.completedAt ?? "not completed"}`,
    `Git dist: ${currentReport.gitDistDir ?? "not provided"}`,
    "",
    "## Checks",
    "",
    "| Check | Status | Key metrics |",
    "| --- | --- | --- |",
  ];

  for (const check of currentReport.checks) {
    lines.push(
      `| ${check.name} | ${check.status} | ${formatMetrics(check.metrics)} |`,
    );
  }
  if (currentReport.checks.length === 0) {
    lines.push("| none | n/a | no real git-dist run was executed |");
  }

  if (currentReport.blockers.length > 0) {
    lines.push("", "## Blockers", "");
    for (const blocker of currentReport.blockers) {
      lines.push(`- ${blocker.id}: ${blocker.message}`);
    }
  }

  lines.push("", "## Next actions", "");
  for (const action of currentReport.nextActions) {
    lines.push(`- ${action.id}: ${action.command}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatMetrics(metrics) {
  return Object.entries(metrics)
    .filter(([, value]) => typeof value !== "object")
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function collectEnvironment() {
  const cpuList = cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: {
      type: osType(),
      release: osRelease(),
    },
    cpu: {
      logicalCount: cpuList.length,
      model: cpuList[0]?.model ?? null,
    },
    memory: {
      totalBytes: totalmem(),
      freeBytesAtStart: freemem(),
      freeBytesAtEnd: null,
    },
    repository: {
      head: captureCommand("git", ["rev-parse", "--verify", "HEAD"]).stdout,
      branch: captureCommand("git", ["branch", "--show-current"]).stdout,
    },
  };
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

function collectGitDistSource() {
  return {
    source: "workspace-resource",
    target: null,
  };
}

function captureCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.status === 0 ? result.stdout.trim() : null,
    stderr: result.status === 0 ? result.stderr.trim() : null,
  };
}

function buildTaskReadiness(status) {
  const reasons = [];
  const requiredCheckNames = [
    "historyPagination",
    "largeStatus",
    "largeBinaryLfs",
  ];
  const passedCheckNames = new Set(
    report.checks
      .filter((check) => check.status === "pass")
      .map((check) => check.name),
  );
  const missingChecks = requiredCheckNames.filter(
    (name) => !passedCheckNames.has(name),
  );
  const executableEvidenceComplete =
    report.gitDist.executableEvidence.length >= 2 &&
    report.gitDist.executableEvidence.every(
      (executable) =>
        executable.resolvesInsideDistDir === true &&
        typeof executable.sha256 === "string" &&
        executable.sha256.length > 0,
    );
  const profileScale = {
    binaryBytes:
      typeof report.profile?.binaryBytes === "number"
        ? report.profile.binaryBytes >= 128 * 1024 * 1024
        : false,
    commitCount:
      typeof report.profile?.commitCount === "number"
        ? report.profile.commitCount >= 10_000
        : false,
    fileCount:
      typeof report.profile?.fileCount === "number"
        ? report.profile.fileCount >= 50_000
        : false,
  };
  const profileScaleMeetsHeavyTask = Object.values(profileScale).every(Boolean);
  const platformEvidenceCheckable =
    status === "pass" &&
    heavy &&
    profileScaleMeetsHeavyTask &&
    executableEvidenceComplete &&
    missingChecks.length === 0;

  if (status === "blocker") {
    reasons.push("The perf gate found a blocker that must be resolved first.");
  }
  if (!heavy) {
    reasons.push("The heavy profile was not run.");
  }
  if (heavy && !profileScaleMeetsHeavyTask) {
    reasons.push(
      "The heavy profile scale was overridden below the TASKS.md requirement.",
    );
  }
  if (missingChecks.length > 0) {
    reasons.push(`Missing required perf checks: ${missingChecks.join(", ")}.`);
  }
  reasons.push(
    "Use the phase12-evidence-summary artifact to confirm all required targets before checking the TASKS.md performance item.",
  );

  return {
    performanceItemCheckable: false,
    platformEvidenceCheckable,
    profileScale,
    profileScaleMeetsHeavyTask,
    status: platformEvidenceCheckable
      ? "platform-pass"
      : status === "pass"
        ? "partial-evidence"
        : "blocked",
    reasons,
    requiredEvidence: [
      "fixed embedded Git manifest with sha256-verified git and git-lfs executables",
      "heavy profile run at or above 10000 commits, 50000 files, and 128MB LFS binary",
      "phase12-evidence-summary.json with tasks.performance.checkable=true",
    ],
  };
}

function buildNextActions() {
  return [
    {
      id: "light-real-git-dist",
      command: "pnpm -s phase12:perf",
    },
    {
      id: "heavy-required-gate",
      command: "pnpm -s phase12:perf -- --heavy",
    },
    {
      id: "manual-ci-gate",
      command: "workflow_dispatch: phase12_perf_profile=heavy",
    },
  ];
}

function parseArgs(args) {
  const parsed = {
    help: false,
    profile: null,
    reportPath: null,
  };

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--heavy") {
      parsed.profile = "heavy";
    } else if (arg === "--light") {
      parsed.profile = "light";
    } else if (arg.startsWith("--profile=")) {
      const profile = arg.slice("--profile=".length);
      if (profile !== "light" && profile !== "heavy") {
        throw new Error("--profile must be light or heavy");
      }
      parsed.profile = profile;
    } else if (arg.startsWith("--report=")) {
      parsed.reportPath = arg.slice("--report=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function usage() {
  return `Usage: node scripts/phase12-perf-verify.mjs [--light|--heavy] [--report=path]

The command always validates and exercises src-tauri/resources/git-dist.
Missing or invalid embedded tools are blockers.`;
}
