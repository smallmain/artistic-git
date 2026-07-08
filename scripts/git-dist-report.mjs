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
  node scripts/git-dist-report.mjs --workflow-build --target=${supportedTargets.join("|")} [--output-dir=/path]
  node scripts/git-dist-report.mjs --include-openssh-release [--metadata=/path/to/releases.json] [--output-json=/path] [--output-md=/path]

Writes a machine-readable report for the embedded git-dist build readiness.
The report distinguishes release-ready targets from documented placeholder
blocks; it never treats a blocked target as a real artifact. Build evidence
mode adds a workflow run manifest, artifact index, cache validation summary,
and target provenance for workflow_dispatch build runs.`;

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
  if (args.workflowBuild && targets.length !== 1) {
    fail("--workflow-build requires exactly one --target.");
  }
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
    workflowBuild: null,
  };
  if (args.workflowBuild) {
    report.workflowBuild = workflowBuildEvidence(report.targets[0]);
  }

  const markdown = renderMarkdown(report);
  const buildMarkdown = report.workflowBuild
    ? renderWorkflowBuildMarkdown(report)
    : null;
  const blockerReport =
    report.workflowBuild && report.workflowBuild.target.blocked
      ? workflowBlockerReport(report)
      : null;
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
    if (report.workflowBuild) {
      await writeFile(
        path.join(args.outputDir, "git-dist-build-evidence.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      await writeFile(
        path.join(args.outputDir, "git-dist-build-evidence.md"),
        buildMarkdown,
      );
    }
    if (blockerReport) {
      await writeFile(
        path.join(args.outputDir, "git-dist-blocker.json"),
        `${JSON.stringify(blockerReport, null, 2)}\n`,
      );
      await writeFile(
        path.join(args.outputDir, "git-dist-blocker.md"),
        renderWorkflowBlockerMarkdown(blockerReport),
      );
    }
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
        releaseUrl: source.release_url ?? null,
        assetName: source.asset_name ?? null,
        url: source.url,
        checksumSource: source.checksum?.source ?? null,
        checksum: {
          algorithm: source.checksum?.algorithm ?? null,
          value: source.checksum?.value ?? null,
          source: source.checksum?.source ?? null,
          url: source.checksum?.url ?? null,
        },
        resourcesPath: source.resources_path ?? null,
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
    manifestPlatform: target.manifest_platform,
    runnerArch: target.arch,
    status: blockers.length > 0 ? "blocked" : "ready",
    blockers: dedupeBlockers(blockers),
    sources,
  };
}

function workflowBuildEvidence(target) {
  const blocked = target.status === "blocked";
  const cache = cacheValidationEvidence(target, blocked);
  const artifactIndex = artifactIndexEvidence(target, blocked);

  return {
    schemaVersion: 1,
    mode: args.mode ?? "build",
    run: {
      repository: nullable(args.repository),
      workflow: nullable(args.workflow),
      eventName: nullable(args.eventName),
      runId: nullable(args.runId),
      runAttempt: nullable(args.runAttempt),
      runUrl: nullable(args.runUrl) ?? inferredRunUrl(),
      actor: nullable(args.actor),
      ref: nullable(args.ref),
      refName: nullable(args.refName),
      commitSha: nullable(args.commitSha),
      runner: {
        os: nullable(args.runnerOs),
        arch: nullable(args.runnerArch),
        image: nullable(args.jobOs),
      },
    },
    target: {
      name: target.target,
      platform: target.platform,
      manifestPlatform: target.manifestPlatform,
      artifactName: target.artifactName,
      status: target.status,
      blocked,
      blockers: target.blockers,
    },
    artifactIndex,
    cacheValidation: cache,
    validationSummary: validationSummary(target, blocked, cache),
    provenance: target.sources.map((source) => ({
      ref: source.ref,
      component: source.component,
      kind: source.kind,
      vendor: source.vendor,
      version: source.version,
      stable: source.stable,
      placeholder: source.placeholder,
      placeholderReason: source.placeholderReason,
      releaseUrl: source.releaseUrl,
      assetName: source.assetName,
      url: source.url,
      checksum: source.checksum,
      resourcesPath: source.resourcesPath,
    })),
  };
}

function artifactIndexEvidence(target, blocked) {
  const readinessArtifactName =
    args.readinessArtifactName ?? `git-dist-readiness-${target.target}`;
  const buildEvidenceArtifactName =
    args.buildEvidenceArtifactName ??
    `git-dist-build-evidence-${target.target}`;
  const blockerArtifactName =
    args.blockerArtifactName ?? `git-dist-blocker-${target.target}`;

  const index = [
    {
      name: readinessArtifactName,
      kind: "readiness-report",
      produced: true,
      requiredForAudit: true,
      files: ["git-dist-readiness.json", "git-dist-readiness.md"],
      purpose: "target readiness, source blockers, and release gate summary",
    },
    {
      name: buildEvidenceArtifactName,
      kind: "build-evidence",
      produced: true,
      requiredForAudit: true,
      files: ["git-dist-build-evidence.json", "git-dist-build-evidence.md"],
      purpose:
        "workflow run manifest, artifact index, cache validation, and provenance",
    },
    {
      name: target.artifactName,
      kind: "reusable-git-dist",
      produced: !blocked,
      requiredForAudit: !blocked,
      files: blocked ? [] : ["manifest.json", "git/", "git-lfs/", "helpers/"],
      consumedAs: blocked ? null : "ARTISTIC_GIT_DIST_DIR",
      purpose:
        "embedded Git distribution tree for downstream test and package jobs",
      reason: blocked
        ? "target is blocked by documented non-stable or placeholder source pins"
        : "target passed workflow validation and uploads a reusable distribution artifact",
    },
  ];

  if (blocked) {
    index.push({
      name: blockerArtifactName,
      kind: "blocker-evidence",
      produced: true,
      requiredForAudit: true,
      files: ["git-dist-blocker.json", "git-dist-blocker.md"],
      purpose:
        "explicit blocker artifact proving why no reusable target artifact was produced",
      reason: "blocked targets must not publish placeholder distributions",
    });
  }

  return index;
}

function cacheValidationEvidence(target, blocked) {
  const sourceCacheHit = normalizeCacheHit(args.sourceCacheHit);
  const distCacheHit = normalizeCacheHit(args.distCacheHit);

  return {
    sourceArchiveCache: {
      cacheHit: sourceCacheHit,
      key: nullable(args.sourceCacheKey),
      restoreKeyPrefix: nullable(args.sourceCacheRestoreKey),
      path: nullable(args.sourceCacheDir),
      validation: blocked
        ? skippedValidation(
            "target is placeholder-blocked before cache restore",
          )
        : sourceCacheValidation(sourceCacheHit, distCacheHit, target.target),
    },
    assembledDistributionCache: {
      cacheHit: distCacheHit,
      key: nullable(args.distCacheKey),
      restoreKeyPrefix: nullable(args.distCacheRestoreKey),
      path: nullable(args.distDir),
      validation: blocked
        ? skippedValidation(
            "target is placeholder-blocked before cache restore",
          )
        : assembledCacheValidation(distCacheHit, target.target),
    },
  };
}

function sourceCacheValidation(sourceCacheHit, distCacheHit, targetName) {
  if (distCacheHit === true) {
    return {
      status: "not-needed",
      command: null,
      reason:
        "assembled distribution cache hit was validated directly; source archive cache was not consumed by the build path",
    };
  }
  return {
    status: "passed",
    command: `node scripts/fetch-git-dist.mjs --target="${targetName}" --output="$ARTISTIC_GIT_DIST_DIR" --cache-dir="$ARTISTIC_GIT_DIST_CACHE_DIR" --staging-dir="$ARTISTIC_GIT_DIST_STAGING_DIR"`,
    reason:
      sourceCacheHit === true
        ? "fetch reused cached source archives and rechecked configured SHA-256 values before assembly"
        : "fetch downloaded source archives and checked configured SHA-256 values before assembly",
  };
}

function assembledCacheValidation(distCacheHit, targetName) {
  const command = `node scripts/check-git-dist.mjs --target="${targetName}" --no-exec`;
  if (distCacheHit === true) {
    return {
      status: "passed",
      command,
      reason:
        "workflow validates restored ARTISTIC_GIT_DIST_DIR before publishing or reusing the cache hit",
    };
  }
  return {
    status: "passed",
    command,
    reason:
      "workflow validates the freshly fetched and assembled ARTISTIC_GIT_DIST_DIR before upload",
  };
}

function skippedValidation(reason) {
  return {
    status: "skipped",
    command: null,
    reason,
  };
}

function validationSummary(target, blocked, cache) {
  if (blocked) {
    return {
      status: "placeholder-blocked",
      reusableArtifactProduced: false,
      commands: [
        `node scripts/check-git-dist.mjs --schema-only --real-build --target="${target.target}" --expect-placeholder-rejection`,
      ],
      reason:
        "expected-placeholder validation passed; the workflow writes blocker evidence and intentionally skips reusable artifact upload",
    };
  }

  const distCacheHit = cache.assembledDistributionCache.cacheHit;
  const commands = [
    `node scripts/check-git-dist.mjs --schema-only --real-build --target="${target.target}"`,
  ];
  if (distCacheHit === true) {
    commands.push(cache.assembledDistributionCache.validation.command);
  } else {
    commands.push(
      "cargo build -p artistic-git-helpers --bins --release",
      cache.sourceArchiveCache.validation.command,
      cache.assembledDistributionCache.validation.command,
    );
  }

  return {
    status:
      distCacheHit === true ? "validated-cache-hit" : "validated-fresh-build",
    reusableArtifactProduced: true,
    commands,
    reason:
      "this build evidence is written after the workflow validation steps; any failed command prevents artifact upload",
  };
}

function workflowBlockerReport(report) {
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    config: report.config,
    target: report.workflowBuild.target,
    blockers: report.workflowBuild.target.blockers,
    opensshRelease: report.opensshRelease,
    workflowBuild: report.workflowBuild,
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

  if (report.workflowBuild) {
    lines.push(
      "",
      "## Workflow Build Evidence",
      "",
      `Status: ${report.workflowBuild.validationSummary.status}`,
      "",
      `Reusable artifact produced: ${
        report.workflowBuild.validationSummary.reusableArtifactProduced
          ? "yes"
          : "no"
      }`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderWorkflowBuildMarkdown(report) {
  const build = report.workflowBuild;
  const lines = [
    "# Git Distribution Build Evidence",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Target: ${build.target.name}`,
    "",
    `Status: ${build.validationSummary.status}`,
    "",
    `Reusable artifact produced: ${
      build.validationSummary.reusableArtifactProduced ? "yes" : "no"
    }`,
    "",
    "## Workflow Run",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Repository | ${build.run.repository ?? "unknown"} |`,
    `| Workflow | ${build.run.workflow ?? "unknown"} |`,
    `| Run | ${build.run.runUrl ?? build.run.runId ?? "unknown"} |`,
    `| Attempt | ${build.run.runAttempt ?? "unknown"} |`,
    `| Ref | ${build.run.refName ?? build.run.ref ?? "unknown"} |`,
    `| Commit | ${build.run.commitSha ?? "unknown"} |`,
    `| Runner | ${build.run.runner.os ?? "unknown"} / ${
      build.run.runner.arch ?? "unknown"
    } / ${build.run.runner.image ?? "unknown"} |`,
    "",
    "## Artifact Index",
    "",
    "| Artifact | Kind | Produced | Required | Purpose |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const artifact of build.artifactIndex) {
    lines.push(
      `| ${artifact.name} | ${artifact.kind} | ${
        artifact.produced ? "yes" : "no"
      } | ${artifact.requiredForAudit ? "yes" : "no"} | ${artifact.purpose} |`,
    );
  }

  lines.push(
    "",
    "## Cache Validation",
    "",
    "| Cache | Hit | Validation | Reason |",
    "| --- | --- | --- | --- |",
  );
  for (const [label, cache] of [
    ["source archive", build.cacheValidation.sourceArchiveCache],
    [
      "assembled distribution",
      build.cacheValidation.assembledDistributionCache,
    ],
  ]) {
    lines.push(
      `| ${label} | ${cacheHitLabel(cache.cacheHit)} | ${
        cache.validation.status
      } | ${cache.validation.reason} |`,
    );
  }

  lines.push(
    "",
    "## Provenance",
    "",
    "| Component | Kind | Vendor | Version | Stable | Placeholder | Checksum Source |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const source of build.provenance) {
    lines.push(
      `| ${source.component} | ${source.kind} | ${source.vendor} | ${
        source.version ?? "unknown"
      } | ${source.stable ? "yes" : "no"} | ${
        source.placeholder ? "yes" : "no"
      } | ${source.checksum?.source ?? "unknown"} |`,
    );
  }

  if (build.target.blocked) {
    lines.push(
      "",
      "## Blockers",
      "",
      "| Component | Reason |",
      "| --- | --- |",
    );
    for (const blocker of build.target.blockers) {
      lines.push(`| ${blocker.component} | ${blocker.reason} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderWorkflowBlockerMarkdown(report) {
  const lines = [
    "# Git Distribution Blocker Evidence",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Target: ${report.target.name}`,
    "",
    "Reusable artifact produced: no",
    "",
    "| Component | Reason |",
    "| --- | --- |",
  ];
  for (const blocker of report.blockers) {
    lines.push(`| ${blocker.component} | ${blocker.reason} |`);
  }
  if (report.opensshRelease) {
    const latest = report.opensshRelease.latest;
    lines.push(
      "",
      "## Win32-OpenSSH Release Gate",
      "",
      `Status: ${report.opensshRelease.status}`,
      "",
      `Latest: ${latest?.tagName ?? "unknown"} / ${latest?.name ?? "unknown"}`,
      "",
      `Reason: ${report.opensshRelease.reason}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function normalizeCacheHit(value) {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return null;
}

function cacheHitLabel(value) {
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  return "not-applicable";
}

function nullable(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return String(value);
}

function inferredRunUrl() {
  const repository = nullable(args.repository);
  const runId = nullable(args.runId);
  if (!repository || !runId) {
    return null;
  }
  return `https://github.com/${repository}/actions/runs/${runId}`;
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
    workflowBuild: false,
    mode: undefined,
    runId: undefined,
    runAttempt: undefined,
    runUrl: undefined,
    repository: undefined,
    workflow: undefined,
    eventName: undefined,
    ref: undefined,
    refName: undefined,
    commitSha: undefined,
    actor: undefined,
    runnerOs: undefined,
    runnerArch: undefined,
    jobOs: undefined,
    sourceCacheHit: undefined,
    distCacheHit: undefined,
    sourceCacheKey: undefined,
    sourceCacheRestoreKey: undefined,
    distCacheKey: undefined,
    distCacheRestoreKey: undefined,
    sourceCacheDir: undefined,
    distDir: undefined,
    readinessArtifactName: undefined,
    buildEvidenceArtifactName: undefined,
    blockerArtifactName: undefined,
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
    } else if (arg === "--workflow-build") {
      parsed.workflowBuild = true;
    } else if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length);
    } else if (arg.startsWith("--run-id=")) {
      parsed.runId = arg.slice("--run-id=".length);
    } else if (arg.startsWith("--run-attempt=")) {
      parsed.runAttempt = arg.slice("--run-attempt=".length);
    } else if (arg.startsWith("--run-url=")) {
      parsed.runUrl = arg.slice("--run-url=".length);
    } else if (arg.startsWith("--repository=")) {
      parsed.repository = arg.slice("--repository=".length);
    } else if (arg.startsWith("--workflow=")) {
      parsed.workflow = arg.slice("--workflow=".length);
    } else if (arg.startsWith("--event-name=")) {
      parsed.eventName = arg.slice("--event-name=".length);
    } else if (arg.startsWith("--ref=")) {
      parsed.ref = arg.slice("--ref=".length);
    } else if (arg.startsWith("--ref-name=")) {
      parsed.refName = arg.slice("--ref-name=".length);
    } else if (arg.startsWith("--commit-sha=")) {
      parsed.commitSha = arg.slice("--commit-sha=".length);
    } else if (arg.startsWith("--actor=")) {
      parsed.actor = arg.slice("--actor=".length);
    } else if (arg.startsWith("--runner-os=")) {
      parsed.runnerOs = arg.slice("--runner-os=".length);
    } else if (arg.startsWith("--runner-arch=")) {
      parsed.runnerArch = arg.slice("--runner-arch=".length);
    } else if (arg.startsWith("--job-os=")) {
      parsed.jobOs = arg.slice("--job-os=".length);
    } else if (arg.startsWith("--source-cache-hit=")) {
      parsed.sourceCacheHit = arg.slice("--source-cache-hit=".length);
    } else if (arg.startsWith("--dist-cache-hit=")) {
      parsed.distCacheHit = arg.slice("--dist-cache-hit=".length);
    } else if (arg.startsWith("--source-cache-key=")) {
      parsed.sourceCacheKey = arg.slice("--source-cache-key=".length);
    } else if (arg.startsWith("--source-cache-restore-key=")) {
      parsed.sourceCacheRestoreKey = arg.slice(
        "--source-cache-restore-key=".length,
      );
    } else if (arg.startsWith("--dist-cache-key=")) {
      parsed.distCacheKey = arg.slice("--dist-cache-key=".length);
    } else if (arg.startsWith("--dist-cache-restore-key=")) {
      parsed.distCacheRestoreKey = arg.slice(
        "--dist-cache-restore-key=".length,
      );
    } else if (arg.startsWith("--source-cache-dir=")) {
      parsed.sourceCacheDir = arg.slice("--source-cache-dir=".length);
    } else if (arg.startsWith("--dist-dir=")) {
      parsed.distDir = arg.slice("--dist-dir=".length);
    } else if (arg.startsWith("--readiness-artifact-name=")) {
      parsed.readinessArtifactName = arg.slice(
        "--readiness-artifact-name=".length,
      );
    } else if (arg.startsWith("--build-evidence-artifact-name=")) {
      parsed.buildEvidenceArtifactName = arg.slice(
        "--build-evidence-artifact-name=".length,
      );
    } else if (arg.startsWith("--blocker-artifact-name=")) {
      parsed.blockerArtifactName = arg.slice("--blocker-artifact-name=".length);
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
