#!/usr/bin/env node
/* global AbortSignal, URL, console, fetch, process */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GitDistConfigError,
  configPath,
  getTarget,
  getTargetSources,
  loadGitDistConfig,
  supportedTargets,
  validateGitDistConfig,
} from "./git-dist-lib.mjs";

const defaultRepo = "PowerShell/Win32-OpenSSH";
const defaultAsset = "OpenSSH-Win64.zip";
const args = parseArgs(process.argv.slice(2));

const usage = `Usage:
  node scripts/git-dist-report.mjs [--target=${supportedTargets.join("|")}] [--output-dir=/path]
  node scripts/git-dist-report.mjs --include-openssh-release [--metadata=/path/to/releases.json] [--output-json=/path] [--output-md=/path]

Writes a machine-readable report for the embedded git-dist build readiness.
The report distinguishes release-ready targets from documented placeholder
blocks; it never treats a blocked target as a real artifact.`;

if (args.help) {
  console.log(usage);
  process.exit(0);
}

function fail(message) {
  console.error(`git-dist report failed: ${message}`);
  process.exit(1);
}

async function run() {
  const { data: config } = await loadGitDistConfig(configPath);
  const targets = args.target
    ? [normalizeTargetArg(args.target)]
    : supportedTargets;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: {
      path: path.relative(process.cwd(), configPath),
      lastVerified: config.meta?.last_verified ?? null,
      gitVersion: config.versions?.git ?? null,
      gitForWindowsVersion: config.versions?.git_for_windows ?? null,
      gitLfsVersion: config.versions?.git_lfs ?? null,
      win32OpenSshVersion: config.versions?.win32_openssh ?? null,
    },
    targets: targets.map((targetName) => targetReadiness(config, targetName)),
    opensshRelease: args.includeOpenSshRelease
      ? await openSshReleaseReadiness()
      : null,
  };

  const markdown = renderMarkdown(report);
  if (args.outputDir) {
    await mkdir(args.outputDir, { recursive: true });
    await writeFile(
      path.join(args.outputDir, "git-dist-readiness.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      path.join(args.outputDir, "git-dist-readiness.md"),
      markdown,
    );
  }
  if (args.outputJson) {
    await mkdir(path.dirname(args.outputJson), { recursive: true });
    await writeFile(args.outputJson, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.outputMd) {
    await mkdir(path.dirname(args.outputMd), { recursive: true });
    await writeFile(args.outputMd, markdown);
  }

  console.log(markdown.trimEnd());
}

function targetReadiness(config, targetName) {
  const target = getTarget(config, targetName);
  const sources = getTargetSources(config, targetName).map(
    ({ ref, source }) => {
      const versionKey = source.version_key;
      return {
        ref,
        component: source.component,
        kind: source.kind,
        vendor: source.vendor,
        version: versionKey ? config.versions?.[versionKey] : null,
        stable: source.stable === true,
        placeholder: source.placeholder === true,
        placeholderReason: source.placeholder_reason ?? null,
        url: source.url,
        checksumSource: source.checksum?.source ?? null,
      };
    },
  );

  const blockers = sources
    .filter((source) => source.placeholder || !source.stable)
    .map((source) => ({
      ref: source.ref,
      component: source.component,
      reason:
        source.placeholderReason ??
        (source.stable
          ? "source is marked as a placeholder"
          : "source is not marked stable"),
    }));

  try {
    validateGitDistConfig(config, {
      targetName,
      realBuild: true,
      allowPlaceholders: false,
    });
  } catch (error) {
    if (error instanceof GitDistConfigError) {
      blockers.push(
        ...error.details.map((detail) => ({
          ref: targetName,
          component: "validation",
          reason: detail,
        })),
      );
    } else {
      throw error;
    }
  }

  return {
    target: targetName,
    artifactName: target.artifact_name,
    platform: target.platform,
    status: blockers.length > 0 ? "blocked" : "ready",
    blockers: dedupeBlockers(blockers),
    sources,
  };
}

function dedupeBlockers(blockers) {
  const seen = new Set();
  return blockers.filter((blocker) => {
    const key = `${blocker.ref}\0${blocker.component}\0${blocker.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function openSshReleaseReadiness() {
  const releases = await loadReleaseMetadata();
  const latest = latestPublishedRelease(releases);
  if (!latest) {
    return {
      repo: args.repo,
      requiredAsset: args.asset,
      status: "blocked",
      latest: null,
      reason: "no non-draft releases found",
    };
  }

  const stability = classifyRelease(latest, args.asset);
  return {
    repo: args.repo,
    requiredAsset: args.asset,
    status: stability.stable ? "stable-release-available" : "non-stable",
    latest: {
      tagName: latest.tag_name ?? null,
      name: latest.name ?? null,
      publishedAt: latest.published_at ?? null,
      prerelease: latest.prerelease === true,
      draft: latest.draft === true,
      hasRequiredAsset: stability.hasRequiredAsset,
    },
    reason: stability.reason,
  };
}

async function loadReleaseMetadata() {
  if (args.metadata) {
    const parsed = JSON.parse(await readFile(args.metadata, "utf8"));
    if (!Array.isArray(parsed)) {
      fail(
        `metadata file must contain a GitHub releases JSON array: ${args.metadata}`,
      );
    }
    return parsed;
  }

  const url = new URL(`https://api.github.com/repos/${args.repo}/releases`);
  url.searchParams.set("per_page", "20");
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "artistic-git-dist-readiness-report",
    },
    signal: AbortSignal.timeout(args.timeoutMs),
  });

  if (!response.ok) {
    fail(
      `GitHub releases API returned HTTP ${response.status} ${response.statusText}`,
    );
  }

  const releases = await response.json();
  if (!Array.isArray(releases)) {
    fail("GitHub releases API response was not an array");
  }
  return releases;
}

function latestPublishedRelease(releases) {
  return releases
    .filter((release) => release && release.draft !== true)
    .sort((left, right) =>
      String(right.published_at ?? "").localeCompare(
        String(left.published_at ?? ""),
      ),
    )[0];
}

function classifyRelease(release, requiredAssetName) {
  if (release.prerelease === true) {
    return {
      stable: false,
      reason: "github-prerelease=true",
      hasRequiredAsset: hasAsset(release, requiredAssetName),
    };
  }

  const label = `${release.tag_name ?? ""} ${release.name ?? ""}`;
  const channel = label.match(/\b(preview|beta|rc|alpha)\b/i)?.[1];
  if (channel) {
    return {
      stable: false,
      reason: `${channel.toLowerCase()} label`,
      hasRequiredAsset: hasAsset(release, requiredAssetName),
    };
  }

  return {
    stable: true,
    reason: "no prerelease/channel marker",
    hasRequiredAsset: hasAsset(release, requiredAssetName),
  };
}

function hasAsset(release, requiredAssetName) {
  return Array.isArray(release.assets)
    ? release.assets.some((asset) => asset?.name === requiredAssetName)
    : false;
}

function renderMarkdown(report) {
  const lines = [
    "# Git Distribution Readiness",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Target | Status | Blockers |",
    "| --- | --- | --- |",
  ];

  for (const target of report.targets) {
    const blockers =
      target.blockers.length === 0
        ? "none"
        : target.blockers
            .map((blocker) => `${blocker.component}: ${blocker.reason}`)
            .join("<br>");
    lines.push(`| ${target.target} | ${target.status} | ${blockers} |`);
  }

  if (report.opensshRelease) {
    const latest = report.opensshRelease.latest;
    lines.push("", "## Win32-OpenSSH Release Gate", "");
    if (latest) {
      lines.push(
        `Status: ${report.opensshRelease.status}`,
        "",
        `Latest: ${latest.tagName ?? "(untagged)"} / ${latest.name ?? "(unnamed)"}`,
        "",
        `Published: ${latest.publishedAt ?? "unknown"}`,
        "",
        `Reason: ${report.opensshRelease.reason}`,
        "",
        `Required asset present: ${latest.hasRequiredAsset ? "yes" : "no"}`,
      );
    } else {
      lines.push(
        `Status: ${report.opensshRelease.status}`,
        "",
        `Reason: ${report.opensshRelease.reason}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    target: undefined,
    outputDir: undefined,
    outputJson: undefined,
    outputMd: undefined,
    includeOpenSshRelease: false,
    metadata: undefined,
    repo: defaultRepo,
    asset: defaultAsset,
    timeoutMs: 60_000,
  };

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else if (arg.startsWith("--output-dir=")) {
      parsed.outputDir = path.resolve(arg.slice("--output-dir=".length));
    } else if (arg.startsWith("--output-json=")) {
      parsed.outputJson = path.resolve(arg.slice("--output-json=".length));
    } else if (arg.startsWith("--output-md=")) {
      parsed.outputMd = path.resolve(arg.slice("--output-md=".length));
    } else if (arg === "--include-openssh-release") {
      parsed.includeOpenSshRelease = true;
    } else if (arg.startsWith("--metadata=")) {
      parsed.metadata = arg.slice("--metadata=".length);
      parsed.includeOpenSshRelease = true;
    } else if (arg.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg.startsWith("--asset=")) {
      parsed.asset = arg.slice("--asset=".length);
    } else if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        fail(`--timeout-ms must be a positive number: ${arg}`);
      }
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function normalizeTargetArg(targetName) {
  if (!supportedTargets.includes(targetName)) {
    fail(
      `unsupported target '${targetName}'. Supported targets: ${supportedTargets.join(", ")}`,
    );
  }
  return targetName;
}

await run();
