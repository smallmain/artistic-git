import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { browser } from "@wdio/globals";

import { waitForStartScreenReady } from "./start-screen";

type GitDistManifest = {
  paths: {
    gitExecutable: string;
    gitLfsExecutable?: string;
  };
};

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const gitDistDir = path.join(
  repositoryRoot,
  "src-tauri",
  "resources",
  "git-dist",
);
const progressEvents: FullChainProgressEvent[] = [];
const gitCommandTimeoutMs = readPositiveIntegerEnv(
  "ARTISTIC_GIT_E2E_GIT_TIMEOUT_MS",
  120_000,
);

describe("Artistic Git Tauri real-git full chain", () => {
  let fixture: RealGitFixture;

  before(() => {
    fixture = recordStepSync("create fixture", () => RealGitFixture.create());
  });

  after(() => {
    fixture?.cleanup();
  });

  it("drives clone/commit/sync/conflict/revert through UI controls with a real remote", async () => {
    await recordStep("verify WDIO bridge", verifyWdioBridge);
    await recordStep("wait for start screen", waitForStartScreen);
    await recordStep("clone local repository through UI", () =>
      cloneThroughUi(fixture.remotePath, fixture.parentPath, "local"),
    );
    const localPath = path.join(fixture.parentPath, "local");
    await recordStep("wait for cloned repository", () =>
      waitForRepository(localPath),
    );
    recordStepSync("configure local repository identity", () => {
      fixture.configureIdentity(localPath);
    });

    recordStepSync("write local.txt", () => {
      fixture.write("local", "local.txt", "local\n");
    });
    await recordStep("commit and push local.txt through UI", () =>
      commitThroughUi("local.txt", "add local file", true),
    );
    const localAddOid = fixture.git(["rev-parse", "HEAD"], localPath).trim();
    recordStepSync("verify local.txt reached remote", () => {
      assert.equal(
        fixture.git(["show", "refs/heads/main:local.txt"], fixture.remotePath),
        "local\n",
      );
    });

    recordStepSync("peer pushes peer.txt", () => {
      fixture.clone("peer");
      fixture.write("peer", "peer.txt", "peer\n");
      fixture.git(["add", "peer.txt"], fixture.repoPath("peer"));
      fixture.git(
        ["commit", "-m", "peer pushes file"],
        fixture.repoPath("peer"),
      );
      fixture.git(["push"], fixture.repoPath("peer"));
    });

    await recordStep("sync peer.txt through UI", async () => {
      await syncAllThroughUi();
    });
    recordStepSync("verify peer.txt synced", () => {
      assert.equal(
        readFileSync(path.join(localPath, "peer.txt"), "utf8"),
        "peer\n",
      );
      assertClean(fixture, localPath);
    });

    recordStepSync("write local conflict edit", () => {
      fixture.write("local", "tracked.txt", "local conflicting edit\n");
    });
    await recordStep("commit local conflict edit through UI", () =>
      commitThroughUi("tracked.txt", "local conflicting edit", false),
    );

    recordStepSync("peer pushes conflicting edit", () => {
      fixture.write("peer", "tracked.txt", "peer conflicting edit\n");
      fixture.git(["add", "tracked.txt"], fixture.repoPath("peer"));
      fixture.git(
        ["commit", "-m", "peer conflicting edit"],
        fixture.repoPath("peer"),
      );
      fixture.git(["push"], fixture.repoPath("peer"));
    });

    await recordStep("sync conflicting edit through UI", async () => {
      await syncAllThroughUi();
    });
    await recordStep("wait for conflict overlay", async () => {
      await waitForConflictOverlay("tracked.txt");
    });
    await recordStep(
      "assert close guard during conflict",
      assertCloseGuardBlocksWindowShortcutDuringConflict,
    );
    recordStepSync("verify repository has tracked.txt conflict", () => {
      assert.match(
        fixture.git(["status", "--porcelain=v1"], localPath),
        /UU tracked\.txt/,
      );
    });
    await recordStep("resolve conflict with local version", () =>
      resolveConflictWithOwnVersion("tracked.txt"),
    );
    recordStepSync("verify conflict resolution", () => {
      assert.equal(
        readFileSync(path.join(localPath, "tracked.txt"), "utf8"),
        "local conflicting edit\n",
      );
      assertClean(fixture, localPath);
    });

    await recordStep("sync resolved conflict through UI", async () => {
      await syncAllThroughUi();
    });
    recordStepSync("verify peer can fast-forward resolved conflict", () => {
      fixture.git(["pull", "--ff-only"], fixture.repoPath("peer"));
      assert.equal(
        readFileSync(
          path.join(fixture.repoPath("peer"), "tracked.txt"),
          "utf8",
        ),
        "local conflicting edit\n",
      );
    });

    await recordStep("revert local.txt commit through UI", () =>
      revertCommitThroughUi(fixture, localPath, localAddOid, "add local file"),
    );

    recordStepSync("verify revert reached peer", () => {
      fixture.git(["pull", "--ff-only"], fixture.repoPath("peer"));
      assert.equal(
        existsSync(path.join(fixture.repoPath("peer"), "local.txt")),
        false,
      );
      assertClean(fixture, localPath);
    });
  });
});

type FullChainProgressEvent = {
  at: string;
  detail?: string;
  error?: string;
  step: string;
  status: "start" | "pass" | "fail";
};

async function recordStep<T>(step: string, action: () => Promise<T>) {
  writeFullChainProgress(step, "start");
  try {
    const value = await action();
    writeFullChainProgress(step, "pass");
    return value;
  } catch (error) {
    writeFullChainProgress(step, "fail", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function recordStepSync<T>(step: string, action: () => T) {
  writeFullChainProgress(step, "start");
  try {
    const value = action();
    writeFullChainProgress(step, "pass");
    return value;
  } catch (error) {
    writeFullChainProgress(step, "fail", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function writeFullChainProgress(
  step: string,
  status: FullChainProgressEvent["status"],
  fields: Pick<FullChainProgressEvent, "detail" | "error"> = {},
) {
  const event = {
    at: new Date().toISOString(),
    step,
    status,
    ...fields,
  };
  progressEvents.push(event);
  console.log(`[phase12-full-chain] ${JSON.stringify(event)}`);

  const outputDir = path.resolve("artifacts");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    path.join(
      outputDir,
      `e2e-real-git-report-full-chain-progress-${process.env.RUNNER_OS ?? process.platform}.json`,
    ),
    `${JSON.stringify(
      {
        events: progressEvents,
        kind: "phase12-e2e-full-chain-progress",
        schemaVersion: 1,
      },
      null,
      2,
    )}\n`,
  );
}

class RealGitFixture {
  private constructor(
    readonly parentPath: string,
    readonly remotePath: string,
    private readonly gitPath: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  static create() {
    const manifest = JSON.parse(
      readFileSync(path.join(gitDistDir, "manifest.json"), "utf8"),
    ) as GitDistManifest;
    const gitPath = path.join(gitDistDir, manifest.paths.gitExecutable);
    if (!existsSync(gitPath)) {
      throw new Error(`embedded git executable was not found at ${gitPath}`);
    }

    const parentPath = mkdtempSync(path.join(tmpdir(), "ag-wdio-full-chain-"));
    const remotePath = path.join(parentPath, "remote.git");
    const env = createEmbeddedGitEnv({
      gitDist: gitDistDir,
      gitPath,
      home: path.join(parentPath, "home"),
      manifest,
    });
    const fixture = new RealGitFixture(parentPath, remotePath, gitPath, env);
    fixture.git(["init", "--bare", "-b", "main", remotePath]);
    fixture.git(["init", "-b", "main", fixture.repoPath("seed")]);
    fixture.configureIdentity(fixture.repoPath("seed"));
    fixture.write("seed", "tracked.txt", "initial\n");
    fixture.git(["add", "tracked.txt"], fixture.repoPath("seed"));
    fixture.git(["commit", "-m", "initial"], fixture.repoPath("seed"));
    fixture.git(
      ["remote", "add", "origin", remotePath],
      fixture.repoPath("seed"),
    );
    fixture.git(["push", "-u", "origin", "main"], fixture.repoPath("seed"));
    return fixture;
  }

  cleanup() {
    rmSync(this.parentPath, { force: true, recursive: true });
  }

  repoPath(name: string) {
    return path.join(this.parentPath, name);
  }

  clone(name: string) {
    this.git(["clone", this.remotePath, this.repoPath(name)]);
    this.configureIdentity(this.repoPath(name));
  }

  configureIdentity(cwd: string) {
    this.git(["config", "user.name", "Artistic Git WDIO"], cwd);
    this.git(["config", "user.email", "wdio@example.test"], cwd);
  }

  write(repoName: string, relativePath: string, content: string) {
    writeFileSync(path.join(this.repoPath(repoName), relativePath), content);
  }

  git(args: string[], cwd?: string) {
    const result = spawnSync(this.gitPath, args, {
      cwd,
      env: this.env,
      encoding: "utf8",
      timeout: gitCommandTimeoutMs,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed in ${cwd ?? process.cwd()} after timeoutMs=${gitCommandTimeoutMs}\nstatus: ${result.status ?? "null"}\nsignal: ${result.signal ?? "null"}\nerror: ${result.error?.message ?? "none"}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    return result.stdout;
  }
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

function createEmbeddedGitEnv({
  gitDist,
  gitPath,
  home,
  manifest,
}: {
  gitDist: string;
  gitPath: string;
  home: string;
  manifest: GitDistManifest;
}) {
  const gitExecPath = firstExistingDirectory(gitDist, [
    "git/libexec/git-core",
    "git/mingw64/libexec/git-core",
    "git/usr/libexec/git-core",
  ]);
  if (!gitExecPath) {
    throw new Error(`embedded git exec-path was not found under ${gitDist}`);
  }

  const gitLfsPath = manifest.paths.gitLfsExecutable
    ? path.join(gitDist, manifest.paths.gitLfsExecutable)
    : null;
  const pathEntries = uniquePaths([
    path.dirname(gitPath),
    gitExecPath,
    gitLfsPath ? path.dirname(gitLfsPath) : null,
    path.join(gitDist, "git", "cmd"),
    path.join(gitDist, "git", "mingw64", "bin"),
    path.join(gitDist, "git", "usr", "bin"),
  ]);

  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EXEC_PATH: gitExecPath,
    HOME: home,
    PATH: pathEntries.join(path.delimiter),
  };
}

function firstExistingDirectory(root: string, relativePaths: string[]) {
  return relativePaths
    .map((relativePath) => path.join(root, relativePath))
    .find((candidate) => {
      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
}

function uniquePaths(paths: Array<null | string | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    if (!entry) {
      continue;
    }
    const normalized = path.resolve(entry);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function cloneThroughUi(
  remotePath: string,
  parentPath: string,
  directoryName: string,
) {
  await browser.execute((value) => {
    window.localStorage.setItem("artistic-git:last-clone-parent-dir", value);
  }, parentPath);
  await $('[data-testid="start-clone-project"]').click();
  await $('[data-testid="clone-url-input"]').setValue(remotePath);
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="clone-parent-directory-input"]').getValue()) ===
      parentPath,
    {
      timeout: 10_000,
      timeoutMsg: `clone parent directory was not prefilled with ${parentPath}`,
    },
  );
  const directoryInput = await $('[data-testid="clone-directory-name-input"]');
  await directoryInput.setValue(directoryName);
  const submit = await $('[data-testid="clone-submit"]');
  await browser.waitUntil(async () => submit.isEnabled(), {
    timeout: 10_000,
    timeoutMsg: "clone submit button was not enabled",
  });
  await submit.click();
}

async function commitThroughUi(
  relativePath: string,
  message: string,
  pushImmediately: boolean,
) {
  await openLocalChangesTab();
  await waitForLocalChange(relativePath);
  await setLocalChangeChecked(relativePath, true);
  await $('[data-testid="local-changes-commit"]').click();
  await $('[data-testid="commit-message-input"]').setValue(message);
  const pushCheckbox = await $('[data-testid="commit-push-immediately"]');
  if (await pushCheckbox.isExisting()) {
    const checked = await pushCheckbox.isSelected();
    if (checked !== pushImmediately) {
      await pushCheckbox.click();
    }
  }
  await $('[data-testid="commit-dialog-submit"]').click();
  await waitForCommitDialogClosedOrCommitted();
}

async function syncAllThroughUi() {
  const syncButton = await $('[data-testid="repository-sync-all"]');
  await browser.waitUntil(async () => syncButton.isEnabled(), {
    timeout: 30_000,
    timeoutMsg: "repository sync button was not enabled before click",
  });
  await syncButton.click();
  await browser.waitUntil(
    async () => await $('[data-testid="repository-sync-all"]').isEnabled(),
    {
      timeout: 90_000,
      timeoutMsg: "repository sync button did not become enabled",
    },
  );
}

async function waitForConflictOverlay(relativePath: string) {
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="conflict-resolution-overlay"]').isExisting()) &&
      (await elementWithAttribute(
        "conflict-file-row",
        "data-conflict-path",
        relativePath,
      )) !== null,
    {
      timeout: 90_000,
      timeoutMsg: `conflict overlay did not show ${relativePath}`,
    },
  );
}

async function assertCloseGuardBlocksWindowShortcutDuringConflict() {
  await requestWindowCloseShortcut();
  await browser.waitUntil(async () => (await closeGuardDialogState()).open, {
    timeout: 30_000,
    timeoutMsg:
      "close guard dialog did not open for Cmd/Ctrl+W during conflict",
  });

  const state = await closeGuardDialogState();
  assert.match(state.text, /Close window\?/);
  assert.match(state.text, /Closing will cancel it and restore/);

  const dismissed = await browser.execute(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const closeDialog = dialogs.find((dialog) =>
      dialog.textContent?.includes("Close window?"),
    );
    const buttons = Array.from(closeDialog?.querySelectorAll("button") ?? []);
    const cancelButton = buttons.find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    if (!(cancelButton instanceof HTMLButtonElement)) {
      return false;
    }
    cancelButton.click();
    return true;
  });
  assert.equal(dismissed, true);

  await browser.waitUntil(async () => !(await closeGuardDialogState()).open, {
    timeout: 10_000,
    timeoutMsg: "close guard dialog did not dismiss",
  });
  assert.equal(
    await $('[data-testid="conflict-resolution-overlay"]').isExisting(),
    true,
  );
}

async function requestWindowCloseShortcut() {
  await browser.execute((useMetaKey) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyW",
        ctrlKey: !useMetaKey,
        key: "w",
        metaKey: useMetaKey,
      }),
    );
  }, process.platform === "darwin");
}

function closeGuardDialogState() {
  return browser.execute(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const closeDialog = dialogs.find((dialog) =>
      dialog.textContent?.includes("Close window?"),
    );
    return {
      open: Boolean(closeDialog),
      text: closeDialog?.textContent ?? "",
    };
  }) as Promise<{ open: boolean; text: string }>;
}

async function resolveConflictWithOwnVersion(relativePath: string) {
  const row = await elementWithAttribute(
    "conflict-file-row",
    "data-conflict-path",
    relativePath,
  );
  assert.ok(row, `conflict row for ${relativePath} should exist`);
  await row.click();
  await $('[data-testid="conflict-detail-use-own"]').click();
  const complete = await $('[data-testid="conflict-complete"]');
  await browser.waitUntil(async () => complete.isEnabled(), {
    timeout: 30_000,
    timeoutMsg: "conflict complete button did not become enabled",
  });
  await complete.click();
  await browser.waitUntil(
    async () =>
      !(await $('[data-testid="conflict-resolution-overlay"]').isExisting()),
    {
      timeout: 90_000,
      timeoutMsg: "conflict overlay did not close",
    },
  );
}

async function revertCommitThroughUi(
  fixture: RealGitFixture,
  repositoryPath: string,
  oid: string,
  message: string,
) {
  await openHistoryTab();
  await waitForHistoryCommit(oid, message);
  const row = await elementWithAttribute(
    "history-commit-row",
    "data-commit-id",
    oid,
  );
  assert.ok(row, `history row for ${message} (${oid}) should exist`);
  await row.click();
  await $('[data-testid="history-revert-open"]').click();
  const pushCheckbox = await $(
    '[data-testid="history-revert-push-immediately"]',
  );
  await pushCheckbox.waitForExist({
    timeout: 30_000,
    timeoutMsg: "revert push checkbox did not appear for remote repository",
  });
  if (!(await pushCheckbox.isSelected())) {
    await pushCheckbox.click();
  }
  await $('[data-testid="history-revert-confirm"]').click();
  await browser.waitUntil(
    async () => {
      const status = await $('[data-testid="history-revert-status"]');
      return (await status.getText()).includes("Created and pushed");
    },
    {
      timeout: 180_000,
      timeoutMsg: "revert did not report that it was pushed",
    },
  );
  await browser.waitUntil(
    async () => {
      const status = fixture.git(["status", "--porcelain=v1"], repositoryPath);
      return status.trim() === "";
    },
    {
      timeout: 90_000,
      timeoutMsg: "revert did not leave a clean repository",
    },
  );
}

async function openLocalChangesTab() {
  await $('[data-testid="repository-tab-local-changes"]').click();
  await $('[data-testid="local-changes-panel"]').waitForExist({
    timeout: 30_000,
  });
}

async function openHistoryTab() {
  await $('[data-testid="repository-tab-history"]').click();
  await $('[data-testid="history-scroll-viewport"]').waitForExist({
    timeout: 30_000,
  });
}

async function waitForLocalChange(relativePath: string) {
  await browser.waitUntil(
    async () =>
      (await elementWithAttribute(
        "local-change-row",
        "data-change-path",
        relativePath,
      )) !== null,
    {
      timeout: 60_000,
      timeoutMsg: `local change did not appear in UI: ${relativePath}`,
    },
  );
}

async function waitForHistoryCommit(oid: string, message: string) {
  await browser.waitUntil(
    async () =>
      (await elementWithAttribute(
        "history-commit-row",
        "data-commit-id",
        oid,
      )) !== null,
    {
      timeout: 60_000,
      timeoutMsg: `history commit did not appear in UI: ${message} (${oid.slice(
        0,
        7,
      )})`,
    },
  );
}

async function setLocalChangeChecked(relativePath: string, checked: boolean) {
  const row = await elementWithAttribute(
    "local-change-row",
    "data-change-path",
    relativePath,
  );
  assert.ok(row, `local change row for ${relativePath} should exist`);
  const checkbox = await row.$('[data-testid="local-change-checkbox"]');
  if ((await checkbox.isSelected()) !== checked) {
    await checkbox.click();
  }
}

async function waitForCommitDialogClosedOrCommitted() {
  await browser.waitUntil(
    async () => {
      const dialogSubmit = await $('[data-testid="commit-dialog-submit"]');
      if (!(await dialogSubmit.isExisting())) {
        return true;
      }
      if (!(await dialogSubmit.isEnabled())) {
        return false;
      }
      const status = await $('[data-testid="commit-dialog-status"]');
      return (await status.getText()).length > 0;
    },
    {
      timeout: 90_000,
      timeoutMsg: "commit dialog did not finish",
    },
  );
  const submit = await $('[data-testid="commit-dialog-submit"]');
  if (await submit.isExisting()) {
    await browser.keys("Escape");
  }
}

async function waitForStartScreen() {
  await waitForStartScreenReady();
}

async function verifyWdioBridge() {
  const ready = await browser.execute(() => {
    const bridge = (
      window as typeof window & {
        wdioTauri?: { execute?: unknown };
      }
    ).wdioTauri;
    return typeof bridge?.execute === "function";
  });
  assert.equal(ready, true, "the E2E-only WDIO bridge was not initialized");
}

async function waitForRepository(repositoryPath: string) {
  await browser.waitUntil(
    async () =>
      existsSync(path.join(repositoryPath, ".git")) &&
      (await repositoryShellForPath(repositoryPath)) !== null &&
      (await $('[data-testid="history-scroll-viewport"]').isExisting()),
    {
      timeout: 90_000,
      timeoutMsg: `cloned repository did not open in the UI at ${repositoryPath}`,
    },
  );
}

async function repositoryShellForPath(repositoryPath: string) {
  const elements = await $$('[data-testid="repository-shell"]');
  for (const element of elements) {
    const candidate = await element.getAttribute("data-repository-path");
    if (candidate && sameFilesystemPath(candidate, repositoryPath)) {
      return element;
    }
  }
  return null;
}

function sameFilesystemPath(left: string, right: string) {
  const leftPath = comparableFilesystemPath(left);
  const rightPath = comparableFilesystemPath(right);
  if (process.platform === "win32") {
    return leftPath.toLowerCase() === rightPath.toLowerCase();
  }
  return leftPath === rightPath;
}

function comparableFilesystemPath(value: string) {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function assertClean(fixture: RealGitFixture, repositoryPath: string) {
  assert.equal(
    fixture.git(["status", "--porcelain=v1"], repositoryPath).trim(),
    "",
  );
}

async function elementWithAttribute(
  testId: string,
  attribute: string,
  value: string,
) {
  const elements = await $$(`[data-testid="${testId}"]`);
  for (const element of elements) {
    if ((await element.getAttribute(attribute)) === value) {
      return element;
    }
  }
  return null;
}
