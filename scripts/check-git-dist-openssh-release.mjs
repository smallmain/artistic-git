#!/usr/bin/env node
/* global AbortSignal, URL, console, fetch, process */

import { readFile } from "node:fs/promises";

const defaultRepo = "PowerShell/Win32-OpenSSH";
const defaultAsset = "OpenSSH-Win64.zip";
const releasesPerPage = 100;
const maxReleasePages = 10;
const args = parseArgs(process.argv.slice(2));

const usage = `Usage:
  node scripts/check-git-dist-openssh-release.mjs --verify-preferred-release-policy
  node scripts/check-git-dist-openssh-release.mjs --verify-preferred-release-policy --metadata=/path/to/releases.json

Checks GitHub release metadata for Win32-OpenSSH releases. Tags, names, or
release notes containing Preview/Beta/RC/Alpha are treated as non-stable even
when the GitHub prerelease flag is false. The selected policy is: use a stable
OpenSSH-Win64.zip release when one exists; otherwise accept the latest preview
OpenSSH-Win64.zip release as an explicit fallback.`;

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
  if (!args.verifyPreferredReleasePolicy) {
    fail(
      "--verify-preferred-release-policy is required to confirm the stable-first preview fallback rule.",
    );
  }

  const releases = await loadReleaseMetadata();
  const latest = latestPublishedRelease(releases);
  if (!latest) {
    fail(`no non-draft releases found for ${args.repo}`);
  }

  const releaseScan = scanReleases(releases, args.asset);
  const stability = releaseScan.latest.stability;
  const label = `${latest.tag_name ?? "(untagged)"}${
    latest.name ? ` / ${latest.name}` : ""
  }`;

  if (releaseScan.stableWithRequiredAsset.length > 0) {
    const stableLabels = releaseScan.stableWithRequiredAsset
      .map((entry) => releaseLabel(entry.release))
      .join(", ");
    fail(
      `found stable Win32-OpenSSH release(s) with ${args.asset}: ${stableLabels}. Update git-dist.toml to the stable release, remove preview fallback metadata, and run real artifact validation before checking Windows/three-platform 1A items.`,
    );
  }

  if (stability.stable) {
    const assetNote = stability.hasRequiredAsset
      ? `contains ${args.asset}`
      : `does not contain ${args.asset}`;
    fail(
      `latest Win32-OpenSSH release appears stable (${label}, published ${latest.published_at}) and ${assetNote}. Update git-dist.toml to the stable release, remove preview fallback metadata, and run real artifact validation before checking Windows/three-platform 1A items.`,
    );
  }

  if (stability.channel !== "preview") {
    fail(
      `latest Win32-OpenSSH release is non-stable but not an accepted preview fallback (${label}, published ${latest.published_at}; reason: ${stability.reason}; scanned ${releaseScan.checkedReleaseCount} non-draft releases, stable ${args.asset} releases=0).`,
    );
  }

  if (!stability.hasRequiredAsset) {
    fail(
      `latest Win32-OpenSSH preview fallback does not contain ${args.asset} (${label}, published ${latest.published_at}; scanned ${releaseScan.checkedReleaseCount} non-draft releases, stable ${args.asset} releases=0).`,
    );
  }

  info(
    `no stable ${args.asset} release was found; latest preview fallback is accepted (${label}, published ${latest.published_at}; reason: ${stability.reason}; scanned ${releaseScan.checkedReleaseCount} non-draft releases, stable ${args.asset} releases=0).`,
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

  const releases = [];
  for (let page = 1; page <= maxReleasePages; page += 1) {
    const url = new URL(`https://api.github.com/repos/${args.repo}/releases`);
    url.searchParams.set("per_page", String(releasesPerPage));
    url.searchParams.set("page", String(page));
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

    const pageReleases = await response.json();
    if (!Array.isArray(pageReleases)) {
      fail("GitHub releases API response was not an array");
    }
    releases.push(...pageReleases);
    if (pageReleases.length < releasesPerPage) {
      break;
    }
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

function scanReleases(releases, requiredAssetName) {
  const checked = releases
    .filter((release) => release && release.draft !== true)
    .sort((left, right) =>
      String(right.published_at ?? "").localeCompare(
        String(left.published_at ?? ""),
      ),
    )
    .map((release) => ({
      release,
      stability: classifyRelease(release, requiredAssetName),
    }));

  return {
    checkedReleaseCount: checked.length,
    latest: checked[0],
    stableWithRequiredAsset: checked.filter(
      (entry) => entry.stability.stable && entry.stability.hasRequiredAsset,
    ),
    previewWithRequiredAsset: checked.filter(
      (entry) =>
        entry.stability.channel === "preview" &&
        entry.stability.hasRequiredAsset,
    ),
  };
}

function classifyRelease(release, requiredAssetName) {
  if (release.prerelease === true) {
    return {
      stable: false,
      channel: "prerelease",
      reason: "github-prerelease=true",
      hasRequiredAsset: hasAsset(release, requiredAssetName),
    };
  }

  const label = `${release.tag_name ?? ""} ${release.name ?? ""}`;
  const body = String(release.body ?? "");
  const channel = label.match(/\b(preview|beta|rc|alpha)\b/i)?.[1];
  if (channel) {
    return {
      stable: false,
      channel: channel.toLowerCase(),
      reason: `${channel.toLowerCase()} label`,
      hasRequiredAsset: hasAsset(release, requiredAssetName),
    };
  }

  const bodyChannel = body.match(/\b(preview|beta|rc|alpha)\b/i)?.[1];
  if (bodyChannel) {
    return {
      stable: false,
      channel: bodyChannel.toLowerCase(),
      reason: `${bodyChannel.toLowerCase()} release notes`,
      hasRequiredAsset: hasAsset(release, requiredAssetName),
    };
  }

  if (/\bnon[- ]production ready\b/i.test(body)) {
    return {
      stable: false,
      channel: "non-production",
      reason: "release notes say non-production ready",
      hasRequiredAsset: hasAsset(release, requiredAssetName),
    };
  }

  return {
    stable: true,
    channel: "stable",
    reason: "no prerelease/channel marker",
    hasRequiredAsset: hasAsset(release, requiredAssetName),
  };
}

function releaseLabel(release) {
  const tag = release.tag_name ?? "(untagged)";
  return release.name ? `${tag} / ${release.name}` : tag;
}

function hasAsset(release, requiredAssetName) {
  return Array.isArray(release.assets)
    ? release.assets.some((asset) => asset?.name === requiredAssetName)
    : false;
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    verifyPreferredReleasePolicy: false,
    metadata: undefined,
    repo: defaultRepo,
    asset: defaultAsset,
    timeoutMs: 60_000,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (
      arg === "--verify-preferred-release-policy" ||
      arg === "--expect-no-stable-release"
    ) {
      parsed.verifyPreferredReleasePolicy = true;
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
