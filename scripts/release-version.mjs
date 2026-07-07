#!/usr/bin/env node
/* global console, process */

import { spawnSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const initialVersion = "0.1.0";

const bumpRank = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
};

const releaseSections = [
  ["breaking", "Breaking Changes"],
  ["features", "Features"],
  ["fixes", "Fixes"],
  ["refactors", "Refactors"],
  ["other", "Other Changes"],
];

export function parseSemverTag(tag) {
  if (!tag) {
    return null;
  }

  const match = String(tag)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatSemver(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function incrementVersion(versionText, bump) {
  const version = parseSemverTag(versionText);
  if (!version) {
    throw new Error(`invalid semver version: ${versionText}`);
  }

  if (bump === "major") {
    return `${version.major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${version.major}.${version.minor + 1}.0`;
  }
  if (bump === "patch") {
    return `${version.major}.${version.minor}.${version.patch + 1}`;
  }
  if (bump === "none") {
    return formatSemver(version);
  }

  throw new Error(`unknown version bump: ${bump}`);
}

export function parseConventionalCommit(message) {
  const normalized = String(message ?? "").trim();
  const [rawSubject = "", ...bodyLines] = normalized.split(/\r?\n/);
  const subject = rawSubject.trim();
  const body = bodyLines.join("\n");
  const header = subject.match(
    /^([a-z][a-z0-9-]*)(?:\(([^()\r\n]+)\))?(!)?:\s+(.+)$/i,
  );
  const footerBreaking = /^BREAKING(?: CHANGE|-CHANGE)?:\s+.+/im.test(body);

  if (!header) {
    return {
      parsed: false,
      type: null,
      scope: null,
      description: subject || "(empty commit message)",
      breaking: footerBreaking,
    };
  }

  return {
    parsed: true,
    type: header[1].toLowerCase(),
    scope: header[2] ?? null,
    description: header[4].trim(),
    breaking: Boolean(header[3]) || footerBreaking,
  };
}

export function classifyCommit(commit) {
  const parsed = parseConventionalCommit(commit.message);
  let bump = "patch";
  let section = "other";

  if (parsed.breaking) {
    bump = "major";
    section = "breaking";
  } else if (parsed.type === "feat") {
    bump = "minor";
    section = "features";
  } else if (parsed.type === "refactor") {
    bump = "minor";
    section = "refactors";
  } else if (parsed.type === "fix") {
    section = "fixes";
  }

  return {
    ...commit,
    ...parsed,
    bump,
    section,
    shortHash: commit.hash ? commit.hash.slice(0, 7) : null,
  };
}

export function analyzeCommits(commits) {
  const entries = commits.map(classifyCommit);
  let bump = entries.length > 0 ? "patch" : "none";

  for (const entry of entries) {
    if (bumpRank[entry.bump] > bumpRank[bump]) {
      bump = entry.bump;
    }
  }

  const sections = Object.fromEntries(
    releaseSections.map(([section]) => [section, []]),
  );
  for (const entry of entries) {
    sections[entry.section].push(entry);
  }

  return {
    bump,
    entries,
    sections,
    unparsedCommitCount: entries.filter((entry) => !entry.parsed).length,
  };
}

export function createReleasePlan({
  previousTag = null,
  commits = [],
  bumpOverride = null,
  now = new Date(),
} = {}) {
  const previousVersion = previousTag
    ? formatSemver(parseSemverTag(previousTag))
    : null;
  const analysis = analyzeCommits(commits);
  const selectedBump =
    previousVersion && bumpOverride
      ? validateBumpOverride(bumpOverride)
      : analysis.bump;
  const version = previousVersion
    ? incrementVersion(previousVersion, selectedBump)
    : initialVersion;

  const plan = {
    previousTag,
    previousVersion,
    version,
    tag: `v${version}`,
    bump: previousVersion ? selectedBump : "initial",
    bumpOverride: previousVersion ? bumpOverride : null,
    hasChanges: commits.length > 0 || !previousTag,
    commitCount: commits.length,
    unparsedCommitCount: analysis.unparsedCommitCount,
    generatedAt: now.toISOString(),
    sections: analysis.sections,
    entries: analysis.entries,
  };

  plan.releaseNotes = renderReleaseNotes(plan);
  plan.changelogEntry = renderChangelogEntry(plan);
  plan.latestJson = buildLatestJson({
    version: plan.version,
    notes: plan.releaseNotes,
    pubDate: plan.generatedAt,
  });

  return plan;
}

export function validateBumpOverride(value) {
  if (value === "patch" || value === "minor" || value === "major") {
    return value;
  }
  throw new Error(`invalid bump override: ${value}`);
}

export function renderReleaseNotes(plan) {
  const lines = [
    `# Artistic Git ${plan.tag}`,
    "",
    plan.previousTag
      ? `Changes since ${plan.previousTag}.`
      : "Initial release baseline.",
    "",
  ];

  appendSections(lines, plan.sections);

  if (plan.commitCount === 0) {
    lines.push("No commits were found after the previous release tag.", "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function renderChangelogEntry(plan) {
  const date = plan.generatedAt.slice(0, 10);
  const lines = [`## ${plan.tag} - ${date}`, "", `Bump: ${plan.bump}`, ""];

  appendSections(lines, plan.sections);
  return lines.join("\n").trimEnd() + "\n";
}

export function buildLatestJson({ version, notes, pubDate, platforms = {} }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}

export function parseGitLog(raw) {
  return String(raw)
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\x1f");
      if (separator === -1) {
        return {
          hash: null,
          message: record,
        };
      }

      return {
        hash: record.slice(0, separator),
        message: record.slice(separator + 1).trim(),
      };
    });
}

function appendSections(lines, sections) {
  let wroteSection = false;

  for (const [section, title] of releaseSections) {
    const entries = sections[section] ?? [];
    if (entries.length === 0) {
      continue;
    }

    lines.push(`## ${title}`);
    for (const entry of entries) {
      lines.push(`- ${formatCommitEntry(entry)}`);
    }
    lines.push("");
    wroteSection = true;
  }

  if (!wroteSection) {
    lines.push("## Changes", "", "- No user-visible changes.", "");
  }
}

function formatCommitEntry(entry) {
  const scope = entry.scope ? `**${entry.scope}:** ` : "";
  const hash = entry.shortHash ? ` (${entry.shortHash})` : "";
  return `${scope}${entry.description}${hash}`;
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }

  return result.stdout;
}

async function findPreviousTag(options) {
  const raw = git(
    ["tag", "--merged", options.head, "--list", "--sort=-creatordate"],
    options,
  );
  const tag = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => parseSemverTag(line));

  return tag ?? null;
}

function readCommits(previousTag, options) {
  const range = previousTag ? `${previousTag}..${options.head}` : options.head;
  const raw = git(
    ["log", "--reverse", "--format=%x1e%H%x1f%B", range],
    options,
  );
  return parseGitLog(raw);
}

function parseArgs(argv) {
  const options = {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    head: "HEAD",
    outputDir: null,
    githubOutput: null,
    baseTag: undefined,
    bumpOverride: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      if (arg.includes("=")) {
        return arg.slice(arg.indexOf("=") + 1);
      }
      index += 1;
      if (!argv[index]) {
        throw new Error(`${name} requires a value`);
      }
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--output-dir" || arg.startsWith("--output-dir=")) {
      options.outputDir = readValue("--output-dir");
    } else if (
      arg === "--github-output" ||
      arg.startsWith("--github-output=")
    ) {
      options.githubOutput = readValue("--github-output");
    } else if (arg === "--base-tag" || arg.startsWith("--base-tag=")) {
      options.baseTag = readValue("--base-tag");
    } else if (arg === "--bump" || arg.startsWith("--bump=")) {
      options.bumpOverride = validateBumpOverride(readValue("--bump"));
    } else if (arg === "--head" || arg.startsWith("--head=")) {
      options.head = readValue("--head");
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      options.cwd = readValue("--cwd");
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return `Usage:
  node scripts/release-version.mjs [--output-dir .tmp/release] [--github-output "$GITHUB_OUTPUT"]
  node scripts/release-version.mjs --base-tag v0.1.0 --head HEAD [--bump patch|minor|major]

Calculates the next release version from Conventional Commits since the
previous semver tag. Initial releases start at ${initialVersion}.`;
}

async function writeOutputs(plan, outputDir) {
  await mkdir(outputDir, { recursive: true });

  const notesPath = path.join(outputDir, "RELEASE_NOTES.md");
  const changelogPath = path.join(outputDir, "CHANGELOG_ENTRY.md");
  const latestJsonPath = path.join(outputDir, "latest.json");
  const planPath = path.join(outputDir, "release-plan.json");

  await writeFile(notesPath, plan.releaseNotes);
  await writeFile(changelogPath, plan.changelogEntry);
  await writeFile(
    latestJsonPath,
    `${JSON.stringify(plan.latestJson, null, 2)}\n`,
  );
  await writeFile(
    planPath,
    `${JSON.stringify(toSerializablePlan(plan), null, 2)}\n`,
  );

  return {
    notesPath,
    changelogPath,
    latestJsonPath,
    planPath,
  };
}

async function writeGithubOutput(filePath, values) {
  if (!filePath) {
    return;
  }

  const lines = Object.entries(values).map(
    ([key, value]) => `${key}=${value}\n`,
  );
  await appendFile(filePath, lines.join(""));
}

function toSerializablePlan(plan) {
  return {
    previousTag: plan.previousTag,
    previousVersion: plan.previousVersion,
    version: plan.version,
    tag: plan.tag,
    bump: plan.bump,
    bumpOverride: plan.bumpOverride,
    hasChanges: plan.hasChanges,
    commitCount: plan.commitCount,
    unparsedCommitCount: plan.unparsedCommitCount,
    generatedAt: plan.generatedAt,
    sections: Object.fromEntries(
      Object.entries(plan.sections).map(([section, entries]) => [
        section,
        entries.map((entry) => ({
          hash: entry.hash,
          shortHash: entry.shortHash,
          type: entry.type,
          scope: entry.scope,
          description: entry.description,
          parsed: entry.parsed,
          breaking: entry.breaking,
          bump: entry.bump,
        })),
      ]),
    ),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const previousTag =
    options.baseTag === undefined
      ? await findPreviousTag(options)
      : options.baseTag || null;
  const commits = readCommits(previousTag, options);
  const plan = createReleasePlan({
    previousTag,
    commits,
    bumpOverride: options.bumpOverride,
  });
  const paths = options.outputDir
    ? await writeOutputs(plan, options.outputDir)
    : {};

  await writeGithubOutput(options.githubOutput, {
    version: plan.version,
    tag: plan.tag,
    previous_tag: plan.previousTag ?? "",
    bump: plan.bump,
    has_changes: String(plan.hasChanges),
    commit_count: String(plan.commitCount),
    unparsed_commit_count: String(plan.unparsedCommitCount),
    notes_path: paths.notesPath ?? "",
    changelog_path: paths.changelogPath ?? "",
    latest_json_path: paths.latestJsonPath ?? "",
    plan_path: paths.planPath ?? "",
  });

  console.log(
    JSON.stringify({ ...toSerializablePlan(plan), ...paths }, null, 2),
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(`release version failed: ${error.message}`);
    process.exit(1);
  });
}
