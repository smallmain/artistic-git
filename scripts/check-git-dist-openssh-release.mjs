#!/usr/bin/env node
/* global AbortSignal, URL, console, fetch, process */

import { readFile } from "node:fs/promises";

const defaultRepo = "PowerShell/Win32-OpenSSH";
const defaultAsset = "OpenSSH-Win64.zip";
const args = parseArgs(process.argv.slice(2));

const usage = `Usage:
  node scripts/check-git-dist-openssh-release.mjs --expect-no-stable-release
  node scripts/check-git-dist-openssh-release.mjs --expect-no-stable-release --metadata=/path/to/releases.json

Checks GitHub release metadata for the latest Win32-OpenSSH release. Tags or
names containing Preview/Beta/RC/Alpha are treated as non-stable even when the
GitHub prerelease flag is false.`;

if (args.help) {
  console.log(usage);
  process.exit(0);
}

function info(message) {
  console.log(`git-dist openssh release: ${message}`);
}

function fail(message) {
  console.error(`git-dist openssh release failed: ${message}`);
  process.exit(1);
}

async function run() {
  if (!args.expectNoStableRelease) {
    fail(
      "--expect-no-stable-release is required until the Windows pin is resolved.",
    );
  }

  const releases = await loadReleaseMetadata();
  const latest = latestPublishedRelease(releases);
  if (!latest) {
    fail(`no non-draft releases found for ${args.repo}`);
  }

  const stability = classifyRelease(latest, args.asset);
  const label = `${latest.tag_name ?? "(untagged)"}${
    latest.name ? ` / ${latest.name}` : ""
  }`;

  if (stability.stable) {
    const assetNote = stability.hasRequiredAsset
      ? `contains ${args.asset}`
      : `does not contain ${args.asset}`;
    fail(
      `latest Win32-OpenSSH release appears stable (${label}, published ${latest.published_at}) and ${assetNote}. Update git-dist.toml, remove the placeholder gate, and run real artifact validation before checking Windows/three-platform 1A items.`,
    );
  }

  info(
    `latest release remains non-stable (${label}, published ${latest.published_at}; reason: ${stability.reason}). Windows git-dist stays placeholder-blocked.`,
  );
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
      "User-Agent": "artistic-git-dist-openssh-release-check",
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

function parseArgs(argv) {
  const parsed = {
    help: false,
    expectNoStableRelease: false,
    metadata: undefined,
    repo: defaultRepo,
    asset: defaultAsset,
    timeoutMs: 60_000,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--expect-no-stable-release") {
      parsed.expectNoStableRelease = true;
    } else if (arg.startsWith("--metadata=")) {
      parsed.metadata = arg.slice("--metadata=".length);
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

await run();
