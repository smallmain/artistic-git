#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const heavy = process.env.ARTISTIC_GIT_PERF_HEAVY === "1";
const keep = process.env.ARTISTIC_GIT_PERF_KEEP_TEMP === "1";
const profile = {
  binaryBytes: numberFromEnv(
    "ARTISTIC_GIT_PERF_BINARY_BYTES",
    heavy ? 128 * 1024 * 1024 : 5 * 1024 * 1024,
  ),
  commitCount: numberFromEnv("ARTISTIC_GIT_PERF_COMMITS", heavy ? 10_000 : 300),
  fileCount: numberFromEnv("ARTISTIC_GIT_PERF_FILES", heavy ? 50_000 : 2_000),
  statusBudgetMs: numberFromEnv(
    "ARTISTIC_GIT_PERF_STATUS_BUDGET_MS",
    heavy ? 30_000 : 10_000,
  ),
};

const gitDistDir = process.env.ARTISTIC_GIT_DIST_DIR;
if (!gitDistDir) {
  console.log(
    "SKIP phase12 perf verification: ARTISTIC_GIT_DIST_DIR is not set.",
  );
  process.exit(0);
}

const manifestPath = path.join(gitDistDir, "manifest.json");
if (!existsSync(manifestPath)) {
  throw new Error(`git distribution manifest is missing at ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const gitPath = path.join(gitDistDir, manifest.paths.gitExecutable);
const gitLfsPath = path.join(gitDistDir, manifest.paths.gitLfsExecutable);
if (!existsSync(gitPath)) {
  throw new Error(`embedded git executable is missing at ${gitPath}`);
}

const root = mkdtempSync(path.join(tmpdir(), "ag-phase12-perf-"));
const repo = path.join(root, "repo");
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: path.join(root, "home"),
  PATH: [
    path.dirname(gitPath),
    path.dirname(gitLfsPath),
    process.env.PATH ?? "",
  ].join(path.delimiter),
};

try {
  mkdirSync(env.HOME, { recursive: true });
  runGit(["init", "-b", "main", repo]);
  runGit(["config", "user.name", "Phase 12 Perf"], repo);
  runGit(["config", "user.email", "phase12-perf@example.test"], repo);
  runGit(["config", "core.fsmonitor", "true"], repo);
  runGit(["config", "core.untrackedCache", "true"], repo);

  verifyHistoryPagination();
  verifyLargeStatus();
  verifyLargeBinaryAndLfs();

  console.log(
    `PASS phase12 perf verification (${heavy ? "heavy" : "light"}): ` +
      `${profile.commitCount} commits, ${profile.fileCount} files, ${profile.binaryBytes} byte binary.`,
  );
} finally {
  if (keep) {
    console.log(`Keeping perf fixture at ${root}`);
  } else {
    rmSync(root, { force: true, recursive: true });
  }
}

function verifyHistoryPagination() {
  writeFileSync(path.join(repo, "history.txt"), "0\n");
  runGit(["add", "history.txt"], repo);
  runGit(["commit", "-m", "history 0"], repo);

  for (let index = 1; index < profile.commitCount; index += 1) {
    writeFileSync(path.join(repo, "history.txt"), `${index}\n`);
    runGit(["add", "history.txt"], repo);
    runGit(["commit", "-m", `history ${index}`], repo);
  }

  const firstPage = logPage(0);
  assertEqual(
    firstPage.length,
    Math.min(200, profile.commitCount),
    "first history page size",
  );
  assert(
    firstPage[0]?.includes(`history ${profile.commitCount - 1}`),
    "history is newest-first",
  );

  if (profile.commitCount > 200) {
    const secondPage = logPage(200);
    assert(secondPage.length > 0, "second history page is available");
    assertNotEqual(
      firstPage.at(-1),
      secondPage[0],
      "history pages do not overlap at boundary",
    );
  }
}

function verifyLargeStatus() {
  const bulkDir = path.join(repo, "bulk");
  mkdirSync(bulkDir, { recursive: true });
  for (let index = 0; index < profile.fileCount; index += 1) {
    writeFileSync(
      path.join(bulkDir, `${index.toString().padStart(6, "0")}.txt`),
      `${index}\n`,
    );
  }

  const started = performance.now();
  const status = runGit(["status", "--porcelain=v1", "-z"], repo);
  const elapsed = performance.now() - started;
  assert(
    elapsed <= profile.statusBudgetMs,
    `status took ${Math.round(elapsed)}ms, budget ${profile.statusBudgetMs}ms`,
  );
  assert(
    status.includes("?? bulk/000000.txt"),
    "status reports untracked bulk files",
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
}

function verifyLargeBinaryAndLfs() {
  if (!existsSync(gitLfsPath)) {
    throw new Error(`embedded git-lfs executable is missing at ${gitLfsPath}`);
  }

  runGit(["lfs", "install", "--local"], repo);
  runGit(["lfs", "track", "*.bin"], repo);
  writeFileSync(
    path.join(repo, "large.bin"),
    Buffer.alloc(profile.binaryBytes, 7),
  );
  runGit(["add", ".gitattributes", "large.bin"], repo);
  runGit(["commit", "-m", "add lfs binary"], repo);

  const pointer = runGit(["show", "HEAD:large.bin"], repo);
  assert(
    pointer.startsWith("version https://git-lfs.github.com/spec/v1"),
    "large binary is stored as an LFS pointer in Git history",
  );
  assertEqual(
    readFileSync(path.join(repo, "large.bin")).length,
    profile.binaryBytes,
    "working tree binary size",
  );
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

function runGit(args, cwd) {
  const result = spawnSync(gitPath, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd ?? process.cwd()}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
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
