import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  auditBundles,
  auditDirectory,
  auditGitDist,
  buildSizeAuditReport,
  parseArgs,
  runCli,
  validateSizeBaseline,
} from "./size-audit.mjs";

async function writeFixtureGitDist(root) {
  const files = new Map([
    ["git/bin/git", "same-binary"],
    ["git/libexec/git-core/git", "same-binary"],
    ["git/libexec/git-core/git-fetch", "different"],
    ["git-lfs/git-lfs", "lfs"],
    ["helpers/credential", "helper"],
    ["helpers/askpass", "helper"],
  ]);
  for (const [relativePath, contents] of files) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      target: "fixture-target",
      toolchainRevision: "fixture-r1",
      distributionFingerprint: "d".repeat(64),
    })}\n`,
  );
}

function baselineFromReport(report) {
  return {
    schemaVersion: 1,
    targets: {
      [report.target]: {
        gitDist: {
          logicalBytes: report.gitDist.logicalBytes,
          duplicateReclaimableBytes:
            report.gitDist.duplicateContent.reclaimableBytes,
          components: Object.fromEntries(
            Object.entries(report.gitDist.components).map(
              ([component, summary]) => [component, summary.logicalBytes],
            ),
          ),
        },
        installedTrees: Object.fromEntries(
          report.installedTrees.map((tree) => [tree.label, tree.logicalBytes]),
        ),
        bundles: Object.fromEntries(
          (report.bundles?.files ?? [])
            .filter((bundle) => !bundle.type.endsWith("signature"))
            .map((bundle) => [bundle.type, bundle.bytes]),
        ),
      },
    },
  };
}

test("audits component bytes and every duplicate SHA group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-git-dist-"));
  try {
    await writeFixtureGitDist(root);
    const audit = await auditGitDist(root);

    assert.equal(audit.target, "fixture-target");
    assert.equal(audit.components.git.logicalBytes, 31);
    assert.equal(audit.components["git-lfs"].logicalBytes, 3);
    assert.equal(audit.components.helpers.logicalBytes, 12);
    assert.equal(audit.duplicateContent.groupCount, 2);
    assert.equal(audit.duplicateContent.reclaimableBytes, 17);
    assert.deepEqual(
      audit.duplicateContent.groups.map((group) => group.paths),
      [
        ["git/bin/git", "git/libexec/git-core/git"],
        ["helpers/askpass", "helpers/credential"],
      ],
    );
    assert.equal(
      audit.recommendedBudgetBytes,
      Math.ceil(audit.logicalBytes * 1.1),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "separates logical hardlink bytes from physical bytes and counts symlinks",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-tree-"));
    try {
      await mkdir(path.join(root, "bin"));
      await writeFile(path.join(root, "bin", "canonical"), "12345678");
      await link(
        path.join(root, "bin", "canonical"),
        path.join(root, "bin", "hardlink"),
      );
      await symlink("canonical", path.join(root, "bin", "symlink"));

      const audit = await auditDirectory(root, { label: "installed" });
      assert.equal(audit.label, "installed");
      assert.equal(audit.regularFileBytes, 16);
      assert.equal(audit.physicalRegularFileBytes, 8);
      assert.equal(audit.fileCount, 2);
      assert.equal(audit.physicalFileCount, 1);
      assert.equal(audit.symlinkCount, 1);
      assert.equal(audit.symlinkBytes, 9);
      assert.deepEqual(audit.largestDirectories, [
        { path: "bin", logicalBytes: 25, entryCount: 3 },
      ]);
      assert.deepEqual(audit.largestFiles, [
        { path: "bin/canonical", bytes: 8 },
        { path: "bin/hardlink", bytes: 8 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("reports final bundles and compression ratios against a measured tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-bundles-"));
  try {
    await writeFile(path.join(root, "Artistic Git.dmg"), Buffer.alloc(25));
    await writeFile(
      path.join(root, "Artistic Git.app.tar.gz"),
      Buffer.alloc(20),
    );
    await writeFile(
      path.join(root, "Artistic Git.app.tar.gz.sig"),
      Buffer.alloc(4),
    );
    await writeFile(path.join(root, "ignored.txt"), Buffer.alloc(100));

    const bundles = await auditBundles([root], {
      compressionBasis: { label: "installed", logicalBytes: 100 },
    });
    assert.equal(bundles.fileCount, 3);
    assert.equal(bundles.totalBytes, 49);
    assert.equal(bundles.files[0].compression.packageToExpandedRatio, 0.2);
    assert.equal(bundles.files[1].compression, undefined);
    assert.equal(bundles.files[2].compression.packageToExpandedRatio, 0.25);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies macOS, Linux, and Windows release artifact types", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-platforms-"));
  try {
    const fixtures = [
      {
        platform: "macos",
        files: [
          "Artistic Git.dmg",
          "Artistic Git.app.tar.gz",
          "Artistic Git.app.tar.gz.sig",
        ],
        types: ["updater-archive", "updater-signature", "dmg"],
      },
      {
        platform: "linux",
        files: [
          "artistic-git.AppImage",
          "artistic-git.AppImage.tar.gz",
          "artistic-git.AppImage.tar.gz.sig",
          "artistic-git.deb",
        ],
        types: ["appimage", "updater-archive", "updater-signature", "deb"],
      },
      {
        platform: "windows",
        files: [
          "Artistic Git-setup.exe",
          "Artistic Git-setup.exe.zip",
          "Artistic Git-setup.exe.zip.sig",
        ],
        types: ["windows-installer", "updater-archive", "updater-signature"],
      },
    ];
    for (const fixture of fixtures) {
      const platformRoot = path.join(root, fixture.platform);
      await mkdir(platformRoot);
      for (const file of fixture.files) {
        await writeFile(path.join(platformRoot, file), file);
      }
      const bundles = await auditBundles([platformRoot]);
      assert.deepEqual(
        bundles.files.map((bundle) => bundle.type).sort(),
        [...fixture.types].sort(),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "accepts a directory symlink as an audit root",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-root-link-"));
    try {
      const bundlesRoot = path.join(root, "bundles");
      const linkedRoot = path.join(root, "linked-bundles");
      await mkdir(bundlesRoot);
      await writeFile(path.join(bundlesRoot, "Artistic Git.dmg"), "bundle");
      await symlink(bundlesRoot, linkedRoot, "dir");

      const bundles = await auditBundles([linkedRoot]);
      assert.equal(bundles.fileCount, 1);
      assert.equal(bundles.files[0].bytes, 6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("builds recommendations only for artifacts present in this report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-report-"));
  try {
    const gitDistRoot = path.join(root, "git-dist");
    const installedRoot = path.join(root, "installed");
    await mkdir(gitDistRoot);
    await mkdir(installedRoot);
    await writeFixtureGitDist(gitDistRoot);
    await writeFile(path.join(installedRoot, "app"), Buffer.alloc(100));

    const report = await buildSizeAuditReport({
      target: "fixture-target",
      gitDistRoot,
      trees: [{ label: "installed", root: installedRoot }],
    });
    assert.equal(report.budgetRecommendation.multiplier, 1.1);
    assert.equal(report.installedTrees[0].recommendedBudgetBytes, 110);
    assert.equal(report.bundles, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compares all duplicate content with an explicit legacy baseline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-baseline-"));
  try {
    await writeFixtureGitDist(root);
    const report = await buildSizeAuditReport({
      gitDistRoot: root,
      legacyDuplicateBaselineBytes: 100,
    });
    assert.deepEqual(report.gitDist.legacyDuplicateComparison, {
      baselineBytes: 100,
      maximumBytesForEightyPercentReduction: 20,
      reductionPercent: 83,
    });
    await assert.rejects(
      () =>
        buildSizeAuditReport({
          gitDistRoot: root,
          legacyDuplicateBaselineBytes: 80,
        }),
      /80% reduction/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates every observed size against a tracked baseline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-budget-"));
  try {
    const gitDistRoot = path.join(root, "git-dist");
    const installedRoot = path.join(root, "installed");
    const bundleRoot = path.join(root, "bundles");
    await mkdir(gitDistRoot);
    await mkdir(installedRoot);
    await mkdir(bundleRoot);
    await writeFixtureGitDist(gitDistRoot);
    await writeFile(path.join(installedRoot, "app"), Buffer.alloc(100));
    await writeFile(
      path.join(bundleRoot, "Artistic Git.dmg"),
      Buffer.alloc(25),
    );

    const observed = await buildSizeAuditReport({
      gitDistRoot,
      trees: [{ label: "installed", root: installedRoot }],
      bundleRoots: [bundleRoot],
    });
    const baseline = baselineFromReport(observed);
    const validated = await buildSizeAuditReport({
      gitDistRoot,
      trees: [{ label: "installed", root: installedRoot }],
      bundleRoots: [bundleRoot],
      baseline,
      baselineSource: "size-baselines.json",
    });

    assert.equal(validated.baselineValidation.status, "passed");
    assert.equal(validated.baselineValidation.scope, "release");
    assert.equal(validated.baselineValidation.source, "size-baselines.json");
    assert.ok(validated.baselineValidation.checks.length >= 5);
    assert.ok(
      validated.baselineValidation.checks.every(
        (check) => check.status === "passed",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows exactly the rounded 10 percent budget and rejects one byte more", () => {
  const report = {
    target: "fixture-target",
    gitDist: {
      logicalBytes: 11,
      duplicateContent: { reclaimableBytes: 0 },
      components: { git: { logicalBytes: 11 } },
    },
    installedTrees: [],
  };
  const baseline = {
    schemaVersion: 1,
    targets: {
      "fixture-target": {
        gitDist: {
          logicalBytes: 10,
          duplicateReclaimableBytes: 0,
          components: { git: 10 },
        },
        installedTrees: {},
        bundles: {},
      },
    },
  };

  const atBudget = validateSizeBaseline(report, baseline);
  assert.equal(atBudget.status, "passed");
  assert.equal(atBudget.scope, "git-dist");
  assert.equal(
    atBudget.checks.find((check) => check.key === "gitDist.logicalBytes")
      .budgetBytes,
    11,
  );

  report.gitDist.logicalBytes = 12;
  const overBudget = validateSizeBaseline(report, baseline);
  assert.equal(overBudget.status, "failed");
  assert.match(overBudget.failures.join("\n"), /uses 12 bytes; budget is 11/);
});

test("fails tracked baseline validation for growth and missing keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-budget-"));
  try {
    await writeFixtureGitDist(root);
    const observed = await buildSizeAuditReport({ gitDistRoot: root });
    const baseline = baselineFromReport(observed);
    baseline.targets[observed.target].gitDist.logicalBytes = 1;
    delete baseline.targets[observed.target].gitDist.components.helpers;

    const validated = await buildSizeAuditReport({
      gitDistRoot: root,
      baseline,
    });
    assert.equal(validated.baselineValidation.status, "failed");
    assert.match(validated.baselineValidation.failures.join("\n"), /budget/);
    assert.match(
      validated.baselineValidation.failures.join("\n"),
      /components keys differ/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git-dist scope skips release keys while partial release scope fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-budget-"));
  try {
    const gitDistRoot = path.join(root, "git-dist");
    const installedRoot = path.join(root, "installed");
    const bundleRoot = path.join(root, "bundles");
    await mkdir(gitDistRoot);
    await mkdir(installedRoot);
    await mkdir(bundleRoot);
    await writeFixtureGitDist(gitDistRoot);
    await writeFile(path.join(installedRoot, "app"), Buffer.alloc(100));
    await writeFile(
      path.join(bundleRoot, "Artistic Git.dmg"),
      Buffer.alloc(25),
    );
    const completeReport = await buildSizeAuditReport({
      gitDistRoot,
      trees: [{ label: "installed", root: installedRoot }],
      bundleRoots: [bundleRoot],
    });

    const baseline = baselineFromReport(completeReport);
    const gitDistReport = await buildSizeAuditReport({
      gitDistRoot,
      baseline,
    });
    assert.equal(gitDistReport.baselineValidation.status, "passed");
    assert.equal(gitDistReport.baselineValidation.scope, "git-dist");

    const incompleteReport = await buildSizeAuditReport({
      gitDistRoot,
      trees: [{ label: "installed", root: installedRoot }],
      baseline,
    });
    assert.equal(incompleteReport.baselineValidation.status, "failed");
    assert.equal(incompleteReport.baselineValidation.scope, "release");
    assert.match(
      incompleteReport.baselineValidation.failures.join("\n"),
      /bundles keys differ: observed \[\], baseline \[dmg\]/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed tracked baseline schema without throwing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-schema-"));
  try {
    await writeFixtureGitDist(root);
    const report = await buildSizeAuditReport({
      gitDistRoot: root,
      baseline: {
        schemaVersion: 1,
        targets: {
          "fixture-target": {
            gitDist: {
              logicalBytes: "large",
              duplicateReclaimableBytes: -1,
              components: [],
            },
            installedTrees: null,
            bundles: { dmg: 1.5 },
          },
        },
      },
    });

    assert.equal(report.baselineValidation.status, "failed");
    assert.match(
      report.baselineValidation.failures.join("\n"),
      /gitDist.logicalBytes baseline must be a non-negative integer/,
    );
    assert.match(
      report.baselineValidation.failures.join("\n"),
      /gitDist.components must be an object/,
    );
    assert.match(
      report.baselineValidation.failures.join("\n"),
      /installedTrees must be an object/,
    );
    assert.match(
      report.baselineValidation.failures.join("\n"),
      /bundles.dmg must be a non-negative integer/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate bundle types instead of hiding one measurement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-duplicates-"));
  try {
    const gitDistRoot = path.join(root, "git-dist");
    const installedRoot = path.join(root, "installed");
    const bundleRoot = path.join(root, "bundles");
    await mkdir(gitDistRoot);
    await mkdir(installedRoot);
    await mkdir(bundleRoot);
    await writeFixtureGitDist(gitDistRoot);
    await writeFile(path.join(installedRoot, "app"), "app");
    await writeFile(path.join(bundleRoot, "first.dmg"), "first");
    await writeFile(path.join(bundleRoot, "second.dmg"), "second");
    const observed = await buildSizeAuditReport({
      gitDistRoot,
      trees: [{ label: "installed", root: installedRoot }],
      bundleRoots: [bundleRoot],
    });
    const baseline = baselineFromReport(observed);
    const validated = await buildSizeAuditReport({
      gitDistRoot,
      trees: [{ label: "installed", root: installedRoot }],
      bundleRoots: [bundleRoot],
      baseline,
    });

    assert.equal(validated.baselineValidation.status, "failed");
    assert.match(
      validated.baselineValidation.failures.join("\n"),
      /bundle type dmg is ambiguous/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI writes failed baseline evidence before returning nonzero", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-budget-cli-"));
  try {
    const gitDistRoot = path.join(root, "git-dist");
    const baselinePath = path.join(root, "baseline.json");
    const output = path.join(root, "report.json");
    await mkdir(gitDistRoot);
    await writeFixtureGitDist(gitDistRoot);
    const observed = await buildSizeAuditReport({ gitDistRoot });
    const baseline = baselineFromReport(observed);
    baseline.targets[observed.target].gitDist.logicalBytes = 1;
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);

    await assert.rejects(
      runCli([
        `--git-dist=${gitDistRoot}`,
        `--baseline=${baselinePath}`,
        `--output=${output}`,
      ]),
      /exceeded tracked baseline/,
    );
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.baselineValidation.status, "failed");

    const schemaOutput = path.join(root, "schema-report.json");
    baseline.schemaVersion = 2;
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);
    await assert.rejects(
      runCli([
        `--git-dist=${gitDistRoot}`,
        `--baseline=${baselinePath}`,
        `--output=${schemaOutput}`,
      ]),
      /exceeded tracked baseline/,
    );
    const schemaReport = JSON.parse(await readFile(schemaOutput, "utf8"));
    assert.equal(schemaReport.baselineValidation.status, "failed");
    assert.deepEqual(schemaReport.baselineValidation.failures, [
      "size baseline schemaVersion must be 1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses repeatable trees and bundle directories", () => {
  assert.deepEqual(
    parseArgs([
      "--target=linux-x86_64",
      "--git-dist",
      "dist",
      "--tree=installed=app-dir",
      "--bundle-dir=assets-one",
      "--bundle-dir",
      "assets-two",
      "--compression-basis=installed",
      "--baseline=size-baselines.json",
      "--output=report.json",
    ]),
    {
      target: "linux-x86_64",
      gitDistRoot: "dist",
      trees: [{ label: "installed", root: "app-dir" }],
      bundleRoots: ["assets-one", "assets-two"],
      compressionBasisLabel: "installed",
      baselinePath: "size-baselines.json",
      output: "report.json",
    },
  );
});

test("rejects missing roots and target mismatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "size-audit-errors-"));
  try {
    await assert.rejects(() => auditDirectory(path.join(root, "missing")), {
      message: /directory does not exist/,
    });
    const gitDistRoot = path.join(root, "git-dist");
    await mkdir(gitDistRoot);
    await writeFixtureGitDist(gitDistRoot);
    await assert.rejects(
      () =>
        buildSizeAuditReport({
          target: "wrong-target",
          gitDistRoot,
        }),
      /does not match/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
