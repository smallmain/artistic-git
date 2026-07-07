import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLatestJson as buildTauriLatestJson,
  selectUpdaterAssets,
} from "./generate-tauri-latest-json.mjs";
import {
  analyzeCommits,
  buildLatestJson,
  createReleasePlan,
  incrementVersion,
  parseConventionalCommit,
  parseGitLog,
  validateBumpOverride,
} from "./release-version.mjs";

test("computes patch, minor, and major bumps from Conventional Commits", () => {
  assert.equal(
    analyzeCommits([{ message: "fix: keep selected files after restore" }])
      .bump,
    "patch",
  );
  assert.equal(
    analyzeCommits([{ message: "feat(history): add search filters" }]).bump,
    "minor",
  );
  assert.equal(
    analyzeCommits([{ message: "refactor(core): split git runner" }]).bump,
    "minor",
  );
  assert.equal(
    analyzeCommits([{ message: "feat!: replace repository storage layout" }])
      .bump,
    "major",
  );
  assert.equal(
    analyzeCommits([
      {
        message:
          "fix: preserve state\n\nBREAKING CHANGE: settings are migrated once",
      },
    ]).bump,
    "major",
  );
});

test("falls back to patch for unparsed commits", () => {
  const analysis = analyzeCommits([{ message: "update release bits" }]);

  assert.equal(analysis.bump, "patch");
  assert.equal(analysis.unparsedCommitCount, 1);
  assert.equal(analysis.sections.other[0].description, "update release bits");
});

test("uses 0.1.0 for the initial release", () => {
  const plan = createReleasePlan({
    previousTag: null,
    commits: [{ hash: "abcdef123456", message: "feat: initial workbench" }],
    now: new Date("2026-07-07T00:00:00.000Z"),
  });

  assert.equal(plan.version, "0.1.0");
  assert.equal(plan.tag, "v0.1.0");
  assert.equal(plan.bump, "initial");
  assert.match(plan.releaseNotes, /Initial release baseline/);
});

test("increments from the previous semver tag", () => {
  assert.equal(incrementVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(incrementVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(incrementVersion("1.2.3", "major"), "2.0.0");

  const plan = createReleasePlan({
    previousTag: "v1.2.3",
    commits: [
      { hash: "1111111", message: "fix: handle empty remotes" },
      { hash: "2222222", message: "feat: add branch sync view" },
    ],
    now: new Date("2026-07-07T00:00:00.000Z"),
  });

  assert.equal(plan.version, "1.3.0");
  assert.equal(plan.bump, "minor");
  assert.match(plan.changelogEntry, /## v1\.3\.0 - 2026-07-07/);
  assert.match(plan.releaseNotes, /branch sync view/);
});

test("allows workflow_dispatch to override the calculated bump level", () => {
  const plan = createReleasePlan({
    previousTag: "v1.2.3",
    bumpOverride: "major",
    commits: [{ hash: "1111111", message: "fix: handle empty remotes" }],
    now: new Date("2026-07-07T00:00:00.000Z"),
  });

  assert.equal(plan.version, "2.0.0");
  assert.equal(plan.bump, "major");
  assert.equal(plan.bumpOverride, "major");
  assert.equal(validateBumpOverride("minor"), "minor");
  assert.throws(() => validateBumpOverride("auto"), /invalid bump override/);
});

test("parses git log records separated by control characters", () => {
  const commits = parseGitLog(
    "\x1eabc123\x1ffeat: add graph\n\nbody\n\x1edef456\x1ffix: load repo",
  );

  assert.deepEqual(commits, [
    { hash: "abc123", message: "feat: add graph\n\nbody" },
    { hash: "def456", message: "fix: load repo" },
  ]);
});

test("detects scopes, bang breaking markers, and latest.json shape", () => {
  assert.deepEqual(parseConventionalCommit("refactor(core)!: move runner"), {
    parsed: true,
    type: "refactor",
    scope: "core",
    description: "move runner",
    breaking: true,
  });

  assert.deepEqual(
    buildLatestJson({
      version: "0.2.0",
      notes: "notes",
      pubDate: "2026-07-07T00:00:00.000Z",
    }),
    {
      version: "0.2.0",
      notes: "notes",
      pub_date: "2026-07-07T00:00:00.000Z",
      platforms: {},
    },
  );
});

test("selects one updater asset per Tauri platform", () => {
  assert.deepEqual(
    selectUpdaterAssets([
      "Artistic Git_0.1.0_x64.dmg",
      "Artistic Git.app.tar.gz",
      "Artistic Git.app.tar.gz.sig",
      "Artistic Git_0.1.0_x64-setup.exe",
      "Artistic Git_0.1.0_x64-setup.exe.zip",
      "Artistic Git_0.1.0_x64-setup.exe.zip.sig",
      "artistic-git_0.1.0_amd64.deb",
      "artistic-git_0.1.0_amd64.AppImage",
      "artistic-git_0.1.0_amd64.AppImage.tar.gz",
      "artistic-git_0.1.0_amd64.AppImage.tar.gz.sig",
    ]),
    [
      "Artistic Git.app.tar.gz",
      "Artistic Git_0.1.0_x64-setup.exe.zip",
      "artistic-git_0.1.0_amd64.AppImage.tar.gz",
    ],
  );

  assert.throws(
    () =>
      selectUpdaterAssets([
        "Artistic Git.app.tar.gz",
        "other.app.tar.gz",
        "Artistic Git_0.1.0_x64-setup.exe",
        "artistic-git_0.1.0_amd64.AppImage",
      ]),
    /multiple macOS/,
  );
});

test("builds Tauri latest.json from signed release artifacts", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "artistic-git-release-"));

  try {
    await writeFile(path.join(tmpDir, "Artistic Git.app.tar.gz"), "");
    await writeFile(
      path.join(tmpDir, "Artistic Git.app.tar.gz.sig"),
      "macsig\n",
    );
    await writeFile(
      path.join(tmpDir, "Artistic Git_0.1.0_x64-setup.exe.zip"),
      "",
    );
    await writeFile(
      path.join(tmpDir, "Artistic Git_0.1.0_x64-setup.exe.zip.sig"),
      "winsig\n",
    );
    await writeFile(
      path.join(tmpDir, "artistic-git_0.1.0_amd64.AppImage.tar.gz"),
      "",
    );
    await writeFile(
      path.join(tmpDir, "artistic-git_0.1.0_amd64.AppImage.tar.gz.sig"),
      "linuxsig\n",
    );

    const latestJson = await buildTauriLatestJson({
      assetsDir: tmpDir,
      version: "v0.1.0",
      notes: "Release notes",
      pubDate: "2026-07-07T00:00:00.000Z",
      repo: "smallmain/artistic-git",
      tag: "v0.1.0",
    });

    assert.equal(latestJson.version, "0.1.0");
    assert.equal(latestJson.pub_date, "2026-07-07T00:00:00.000Z");
    assert.equal(latestJson.platforms["darwin-x86_64"].signature, "macsig");
    assert.equal(latestJson.platforms["darwin-aarch64"].signature, "macsig");
    assert.equal(latestJson.platforms["windows-x86_64"].signature, "winsig");
    assert.equal(latestJson.platforms["linux-x86_64"].signature, "linuxsig");
    assert.match(
      latestJson.platforms["darwin-x86_64"].url,
      /Artistic%20Git\.app\.tar\.gz$/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
