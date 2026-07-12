#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const budgetMultiplier = 1.1;
const finalBundleSuffixes = [
  [".app.tar.gz.sig", "updater-signature"],
  [".AppImage.tar.gz.sig", "updater-signature"],
  [".exe.zip.sig", "updater-signature"],
  [".app.tar.gz", "updater-archive"],
  [".AppImage.tar.gz", "updater-archive"],
  [".exe.zip", "updater-archive"],
  [".AppImage", "appimage"],
  [".dmg", "dmg"],
  [".deb", "deb"],
  [".exe", "windows-installer"],
  [".sig", "signature"],
];

const scriptPath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function recommendedBudget(bytes) {
  return Math.ceil((bytes * 11) / 10);
}

function inodeKey(stat, relativePath) {
  if (stat.nlink > 1 && stat.ino !== 0) {
    return `${stat.dev}:${stat.ino}`;
  }
  return `path:${relativePath}`;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function scanDirectory(root, { hashFiles = false } = {}) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`size audit directory does not exist: ${root}`);
  }

  const records = [];
  let directoryCount = 1;

  async function walk(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = normalizePath(
        path.join(relativeDirectory, entry.name),
      );
      const stat = await lstat(entryPath);

      if (stat.isDirectory()) {
        directoryCount += 1;
        await walk(entryPath, relativePath);
        continue;
      }

      const record = {
        relativePath,
        bytes: stat.size,
        type: stat.isFile()
          ? "file"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other",
      };
      if (stat.isFile()) {
        record.inodeKey = inodeKey(stat, relativePath);
        if (hashFiles) {
          record.sha256 = await sha256File(entryPath);
        }
      }
      records.push(record);
    }
  }

  await walk(root);
  return { records, directoryCount };
}

function summarizeRecords(records, directoryCount) {
  const regularFiles = records.filter((record) => record.type === "file");
  const symlinks = records.filter((record) => record.type === "symlink");
  const otherEntries = records.filter((record) => record.type === "other");
  const physicalFiles = new Map();
  for (const record of regularFiles) {
    physicalFiles.set(record.inodeKey, record.bytes);
  }

  return {
    logicalBytes: records.reduce((total, record) => total + record.bytes, 0),
    regularFileBytes: regularFiles.reduce(
      (total, record) => total + record.bytes,
      0,
    ),
    physicalRegularFileBytes: [...physicalFiles.values()].reduce(
      (total, bytes) => total + bytes,
      0,
    ),
    symlinkBytes: symlinks.reduce((total, record) => total + record.bytes, 0),
    otherEntryBytes: otherEntries.reduce(
      (total, record) => total + record.bytes,
      0,
    ),
    fileCount: regularFiles.length,
    physicalFileCount: physicalFiles.size,
    symlinkCount: symlinks.length,
    otherEntryCount: otherEntries.length,
    directoryCount,
  };
}

function summarizeTopLevel(records) {
  const grouped = new Map();
  for (const record of records) {
    const component = record.relativePath.split("/")[0];
    const values = grouped.get(component) ?? [];
    values.push(record);
    grouped.set(component, values);
  }

  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([component, componentRecords]) => {
        const summary = summarizeRecords(componentRecords, undefined);
        delete summary.directoryCount;
        return [component, summary];
      }),
  );
}

function summarizeLargestFiles(records, limit = 25) {
  return records
    .filter((record) => record.type === "file")
    .sort(
      (left, right) =>
        right.bytes - left.bytes ||
        left.relativePath.localeCompare(right.relativePath),
    )
    .slice(0, limit)
    .map(({ relativePath: filePath, bytes }) => ({ path: filePath, bytes }));
}

function summarizeLargestDirectories(records, limit = 25) {
  const directories = new Map();
  for (const record of records) {
    const parts = record.relativePath.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join("/");
      const summary = directories.get(directory) ?? {
        path: directory,
        logicalBytes: 0,
        entryCount: 0,
      };
      summary.logicalBytes += record.bytes;
      summary.entryCount += 1;
      directories.set(directory, summary);
    }
  }
  return [...directories.values()]
    .sort(
      (left, right) =>
        right.logicalBytes - left.logicalBytes ||
        left.path.localeCompare(right.path),
    )
    .slice(0, limit);
}

export async function auditDirectory(root, { label = "tree" } = {}) {
  const { records, directoryCount } = await scanDirectory(root, {
    hashFiles: true,
  });
  const summary = summarizeRecords(records, directoryCount);
  return {
    label,
    ...summary,
    duplicateContent: buildDuplicateReport(records),
    topLevel: summarizeTopLevel(records),
    largestDirectories: summarizeLargestDirectories(records),
    largestFiles: summarizeLargestFiles(records),
    recommendedBudgetBytes: recommendedBudget(summary.logicalBytes),
  };
}

function buildDuplicateReport(records) {
  const groupsByHash = new Map();
  for (const record of records) {
    if (record.type !== "file") {
      continue;
    }
    const values = groupsByHash.get(record.sha256) ?? [];
    values.push(record);
    groupsByHash.set(record.sha256, values);
  }

  const groups = [...groupsByHash.entries()]
    .filter(([, recordsForHash]) => recordsForHash.length > 1)
    .map(([sha256, recordsForHash]) => {
      const paths = recordsForHash
        .map((record) => record.relativePath)
        .sort((left, right) => left.localeCompare(right));
      const physicalFileCount = new Set(
        recordsForHash.map((record) => record.inodeKey),
      ).size;
      const fileBytes = recordsForHash[0].bytes;
      const totalBytes = recordsForHash.reduce(
        (total, record) => total + record.bytes,
        0,
      );
      return {
        sha256,
        fileBytes,
        fileCount: recordsForHash.length,
        physicalFileCount,
        totalBytes,
        reclaimableBytes: totalBytes - fileBytes,
        alreadySharedByHardlinksBytes:
          totalBytes - physicalFileCount * fileBytes,
        paths,
      };
    })
    .sort(
      (left, right) =>
        right.reclaimableBytes - left.reclaimableBytes ||
        left.sha256.localeCompare(right.sha256),
    );

  return {
    groupCount: groups.length,
    repeatedPathCount: groups.reduce(
      (total, group) => total + group.fileCount,
      0,
    ),
    totalBytes: groups.reduce((total, group) => total + group.totalBytes, 0),
    reclaimableBytes: groups.reduce(
      (total, group) => total + group.reclaimableBytes,
      0,
    ),
    alreadySharedByHardlinksBytes: groups.reduce(
      (total, group) => total + group.alreadySharedByHardlinksBytes,
      0,
    ),
    groups,
  };
}

export async function auditGitDist(root) {
  const { records, directoryCount } = await scanDirectory(root, {
    hashFiles: true,
  });
  const summary = summarizeRecords(records, directoryCount);
  const topLevel = summarizeTopLevel(records);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  return {
    target: manifest.target,
    toolchainRevision: manifest.toolchainRevision,
    distributionFingerprint: manifest.distributionFingerprint,
    ...summary,
    components: topLevel,
    duplicateContent: buildDuplicateReport(records),
    recommendedBudgetBytes: recommendedBudget(summary.logicalBytes),
    recommendedComponentBudgetBytes: Object.fromEntries(
      Object.entries(topLevel).map(([component, componentSummary]) => [
        component,
        recommendedBudget(componentSummary.logicalBytes),
      ]),
    ),
  };
}

function classifyBundle(relativePath) {
  return finalBundleSuffixes.find(([suffix]) =>
    relativePath.endsWith(suffix),
  )?.[1];
}

export async function auditBundles(
  roots,
  { compressionBasis = null, compressionBasesByType = {} } = {},
) {
  const files = [];
  for (const root of roots) {
    const { records } = await scanDirectory(root);
    for (const record of records) {
      if (record.type !== "file") {
        continue;
      }
      const type = classifyBundle(record.relativePath);
      if (!type) {
        continue;
      }
      const bundle = {
        root: normalizePath(root),
        path: record.relativePath,
        type,
        bytes: record.bytes,
        recommendedBudgetBytes: recommendedBudget(record.bytes),
      };
      const selectedCompressionBasis =
        compressionBasesByType[type] ?? compressionBasis;
      if (
        selectedCompressionBasis &&
        !type.endsWith("signature") &&
        selectedCompressionBasis.logicalBytes > 0
      ) {
        bundle.compression = {
          basisTree: selectedCompressionBasis.label,
          expandedLogicalBytes: selectedCompressionBasis.logicalBytes,
          packageToExpandedRatio: Number(
            (record.bytes / selectedCompressionBasis.logicalBytes).toFixed(6),
          ),
          estimatedReductionPercent: Number(
            (
              (1 - record.bytes / selectedCompressionBasis.logicalBytes) *
              100
            ).toFixed(2),
          ),
        };
      }
      files.push(bundle);
    }
  }
  files.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.root.localeCompare(right.root),
  );
  if (files.length === 0) {
    throw new Error("size audit found no final bundle files");
  }
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
  };
}

function sortedKeys(value) {
  return Object.keys(value ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
}

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateByteMap(validation, key, value) {
  if (!isObjectRecord(value)) {
    validation.failures.push(`${key} must be an object`);
    return {};
  }
  for (const [entry, bytes] of Object.entries(value)) {
    if (entry.length === 0) {
      validation.failures.push(`${key} keys must not be empty`);
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      validation.failures.push(
        `${key}.${entry || "<empty>"} must be a non-negative integer`,
      );
    }
  }
  return value;
}

function validateKeySet(validation, label, actualKeys, baselineKeys) {
  const actual = [...actualKeys].sort((left, right) =>
    left.localeCompare(right),
  );
  const expected = [...baselineKeys].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    validation.failures.push(
      `${label} keys differ: observed [${actual.join(", ")}], baseline [${expected.join(", ")}]`,
    );
  }
}

function addBudgetCheck(validation, key, actualBytes, baselineBytes) {
  if (!Number.isSafeInteger(baselineBytes) || baselineBytes < 0) {
    validation.failures.push(`${key} baseline must be a non-negative integer`);
    return;
  }
  const budgetBytes = recommendedBudget(baselineBytes);
  const status = actualBytes <= budgetBytes ? "passed" : "failed";
  validation.checks.push({
    key,
    actualBytes,
    baselineBytes,
    budgetBytes,
    status,
  });
  if (status === "failed") {
    validation.failures.push(
      `${key} uses ${actualBytes} bytes; budget is ${budgetBytes} bytes from baseline ${baselineBytes}`,
    );
  }
}

function observedBundleBytes(bundleReport, validation) {
  const observed = {};
  for (const bundle of bundleReport.files) {
    if (bundle.type.endsWith("signature")) {
      continue;
    }
    if (observed[bundle.type] !== undefined) {
      validation.failures.push(
        `bundle type ${bundle.type} is ambiguous; expected one measured artifact`,
      );
      continue;
    }
    observed[bundle.type] = bundle.bytes;
  }
  return observed;
}

export function validateSizeBaseline(
  report,
  baseline,
  { source = "tracked baseline" } = {},
) {
  const validation = {
    schemaVersion: 1,
    status: "passed",
    source,
    multiplier: budgetMultiplier,
    checks: [],
    failures: [],
  };
  if (baseline?.schemaVersion !== 1) {
    validation.failures.push("size baseline schemaVersion must be 1");
    validation.status = "failed";
    return validation;
  }

  if (!isObjectRecord(baseline.targets)) {
    validation.failures.push("size baseline targets must be an object");
    validation.status = "failed";
    return validation;
  }

  const targetBaseline = baseline.targets[report.target];
  if (!isObjectRecord(targetBaseline)) {
    validation.failures.push(
      `size baseline is missing target ${report.target}`,
    );
    validation.status = "failed";
    return validation;
  }
  const gitDistBaseline = isObjectRecord(targetBaseline.gitDist)
    ? targetBaseline.gitDist
    : null;
  if (!gitDistBaseline) {
    validation.failures.push(
      `size baseline target ${report.target} gitDist must be an object`,
    );
  } else {
    addBudgetCheck(
      validation,
      "gitDist.logicalBytes",
      report.gitDist.logicalBytes,
      gitDistBaseline.logicalBytes,
    );
    addBudgetCheck(
      validation,
      "gitDist.duplicateReclaimableBytes",
      report.gitDist.duplicateContent.reclaimableBytes,
      gitDistBaseline.duplicateReclaimableBytes,
    );
    const observedComponents = Object.fromEntries(
      Object.entries(report.gitDist.components).map(([component, summary]) => [
        component,
        summary.logicalBytes,
      ]),
    );
    const baselineComponents = validateByteMap(
      validation,
      "gitDist.components",
      gitDistBaseline.components,
    );
    validateKeySet(
      validation,
      "gitDist.components",
      sortedKeys(observedComponents),
      sortedKeys(baselineComponents),
    );
    for (const component of sortedKeys(observedComponents)) {
      if (baselineComponents[component] === undefined) {
        continue;
      }
      addBudgetCheck(
        validation,
        `gitDist.components.${component}`,
        observedComponents[component],
        baselineComponents[component],
      );
    }
  }

  const baselineTrees = validateByteMap(
    validation,
    "installedTrees",
    targetBaseline.installedTrees,
  );
  const baselineBundles = validateByteMap(
    validation,
    "bundles",
    targetBaseline.bundles,
  );
  const hasReleaseMeasurements =
    report.installedTrees.length > 0 || report.bundles !== undefined;
  validation.scope = hasReleaseMeasurements ? "release" : "git-dist";
  if (hasReleaseMeasurements) {
    const observedTrees = Object.fromEntries(
      report.installedTrees.map((tree) => [tree.label, tree.logicalBytes]),
    );
    validateKeySet(
      validation,
      "installedTrees",
      sortedKeys(observedTrees),
      sortedKeys(baselineTrees),
    );
    for (const label of sortedKeys(observedTrees)) {
      if (baselineTrees[label] === undefined) {
        continue;
      }
      addBudgetCheck(
        validation,
        `installedTrees.${label}`,
        observedTrees[label],
        baselineTrees[label],
      );
    }

    const observedBundles = report.bundles
      ? observedBundleBytes(report.bundles, validation)
      : {};
    validateKeySet(
      validation,
      "bundles",
      sortedKeys(observedBundles),
      sortedKeys(baselineBundles),
    );
    for (const type of sortedKeys(observedBundles)) {
      if (baselineBundles[type] === undefined) {
        continue;
      }
      addBudgetCheck(
        validation,
        `bundles.${type}`,
        observedBundles[type],
        baselineBundles[type],
      );
    }
  }

  validation.status = validation.failures.length === 0 ? "passed" : "failed";
  return validation;
}

export async function buildSizeAuditReport({
  target,
  gitDistRoot,
  trees = [],
  bundleRoots = [],
  compressionBasisLabel,
  bundleCompressionBasisLabels = {},
  legacyDuplicateBaselineBytes,
  baseline,
  baselineSource,
  provenance = {},
}) {
  const gitDist = await auditGitDist(gitDistRoot);
  if (target && gitDist.target !== target) {
    throw new Error(
      `size audit target ${target} does not match git-dist manifest target ${gitDist.target}`,
    );
  }
  if (legacyDuplicateBaselineBytes !== undefined) {
    const maximumBytesForEightyPercentReduction = Math.floor(
      legacyDuplicateBaselineBytes * 0.2,
    );
    const reclaimableBytes = gitDist.duplicateContent.reclaimableBytes;
    gitDist.legacyDuplicateComparison = {
      baselineBytes: legacyDuplicateBaselineBytes,
      maximumBytesForEightyPercentReduction,
      reductionPercent: Number(
        ((1 - reclaimableBytes / legacyDuplicateBaselineBytes) * 100).toFixed(
          2,
        ),
      ),
    };
    if (reclaimableBytes > maximumBytesForEightyPercentReduction) {
      throw new Error(
        `duplicate content can reclaim ${reclaimableBytes} bytes; expected at most ${maximumBytesForEightyPercentReduction} bytes for an 80% reduction from the legacy baseline`,
      );
    }
  }

  const installedTrees = [];
  for (const tree of trees) {
    installedTrees.push(
      await auditDirectory(tree.root, {
        label: tree.label,
      }),
    );
  }
  const duplicateLabels = installedTrees
    .map((tree) => tree.label)
    .filter((label, index, labels) => labels.indexOf(label) !== index);
  if (duplicateLabels.length > 0) {
    throw new Error(
      `size audit tree labels must be unique: ${duplicateLabels[0]}`,
    );
  }

  let bundles;
  if (bundleRoots.length > 0) {
    const compressionBasis = compressionBasisLabel
      ? installedTrees.find((tree) => tree.label === compressionBasisLabel)
      : null;
    if (compressionBasisLabel && !compressionBasis) {
      throw new Error(
        `compression basis tree was not measured: ${compressionBasisLabel}`,
      );
    }
    const compressionBasesByType = {};
    for (const [type, label] of Object.entries(bundleCompressionBasisLabels)) {
      const selected = installedTrees.find((tree) => tree.label === label);
      if (!selected) {
        throw new Error(
          `compression basis tree for bundle type ${type} was not measured: ${label}`,
        );
      }
      compressionBasesByType[type] = selected;
    }
    bundles = await auditBundles(bundleRoots, {
      compressionBasis,
      compressionBasesByType,
    });
  }

  const report = {
    schemaVersion: 1,
    target: gitDist.target,
    generatedAt: new Date().toISOString(),
    provenance: Object.fromEntries(
      Object.entries(provenance).filter(([, value]) => Boolean(value)),
    ),
    budgetRecommendation: {
      status: "observed-baseline-proposal",
      multiplier: budgetMultiplier,
      note: "Recommendations are derived only from artifacts measured in this report; they are not enforced budgets.",
    },
    gitDist,
    installedTrees,
    ...(bundles ? { bundles } : {}),
  };
  if (baseline) {
    report.baselineValidation = validateSizeBaseline(report, baseline, {
      source: baselineSource,
    });
  }
  return report;
}

function parseTree(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`--tree must use label=path, got: ${value}`);
  }
  return {
    label: value.slice(0, separator),
    root: value.slice(separator + 1),
  };
}

function parseBundleCompressionBasis(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `--bundle-compression-basis must use bundle-type=tree-label, got: ${value}`,
    );
  }
  return {
    type: value.slice(0, separator),
    label: value.slice(separator + 1),
  };
}

function optionValue(args, index, name) {
  const argument = args[index];
  if (argument === name) {
    if (!args[index + 1]) {
      throw new Error(`${name} requires a value`);
    }
    return { value: args[index + 1], consumed: 2 };
  }
  if (argument.startsWith(`${name}=`)) {
    return { value: argument.slice(name.length + 1), consumed: 1 };
  }
  return null;
}

export function parseArgs(args) {
  const options = {
    gitDistRoot: "src-tauri/resources/git-dist",
    trees: [],
    bundleRoots: [],
    bundleCompressionBasisLabels: {},
  };
  for (let index = 0; index < args.length;) {
    let parsed;
    if ((parsed = optionValue(args, index, "--target"))) {
      options.target = parsed.value;
    } else if ((parsed = optionValue(args, index, "--git-dist"))) {
      options.gitDistRoot = parsed.value;
    } else if ((parsed = optionValue(args, index, "--output"))) {
      options.output = parsed.value;
    } else if ((parsed = optionValue(args, index, "--baseline"))) {
      options.baselinePath = parsed.value;
    } else if ((parsed = optionValue(args, index, "--tree"))) {
      options.trees.push(parseTree(parsed.value));
    } else if ((parsed = optionValue(args, index, "--bundle-dir"))) {
      options.bundleRoots.push(parsed.value);
    } else if ((parsed = optionValue(args, index, "--compression-basis"))) {
      options.compressionBasisLabel = parsed.value;
    } else if (
      (parsed = optionValue(args, index, "--bundle-compression-basis"))
    ) {
      const { type, label } = parseBundleCompressionBasis(parsed.value);
      if (options.bundleCompressionBasisLabels[type]) {
        throw new Error(
          `duplicate --bundle-compression-basis for bundle type: ${type}`,
        );
      }
      options.bundleCompressionBasisLabels[type] = label;
    } else if (
      (parsed = optionValue(args, index, "--legacy-duplicate-baseline"))
    ) {
      options.legacyDuplicateBaselineBytes = Number(parsed.value);
      if (
        !Number.isSafeInteger(options.legacyDuplicateBaselineBytes) ||
        options.legacyDuplicateBaselineBytes <= 0
      ) {
        throw new Error(
          `--legacy-duplicate-baseline must be a positive integer, got: ${parsed.value}`,
        );
      }
    } else {
      throw new Error(`unknown size audit argument: ${args[index]}`);
    }
    index += parsed.consumed;
  }
  if (!options.output) {
    throw new Error("--output is required");
  }
  return options;
}

export async function runCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const baseline = options.baselinePath
    ? JSON.parse(await readFile(options.baselinePath, "utf8"))
    : undefined;
  const report = await buildSizeAuditReport({
    ...options,
    baseline,
    baselineSource: options.baselinePath,
    provenance: {
      commitSha: process.env.GITHUB_SHA,
      workflowRunUrl:
        process.env.GITHUB_SERVER_URL &&
        process.env.GITHUB_REPOSITORY &&
        process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : undefined,
    },
  });
  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`size-audit: wrote ${options.output}`);
  if (report.baselineValidation?.status === "failed") {
    throw new Error(
      `size audit exceeded tracked baseline: ${report.baselineValidation.failures.join("; ")}`,
    );
  }
}

if (isMain) {
  await runCli();
}
