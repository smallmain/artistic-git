import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { browser } from "@wdio/globals";

type GitDistManifest = {
  paths: {
    gitExecutable: string;
  };
};

const runRealGitE2e = process.env.ARTISTIC_GIT_E2E_REAL_GIT === "1";
const describeRealGit = runRealGitE2e ? describe : describe.skip;

describeRealGit("Artistic Git Tauri real-git full chain", () => {
  let fixture: RealGitFixture;

  before(() => {
    fixture = RealGitFixture.create();
  });

  after(() => {
    fixture?.cleanup();
  });

  it("drives clone/commit/sync/conflict/revert through UI controls with a real remote", async () => {
    await waitForStartScreen();
    await cloneThroughUi(fixture.remotePath, fixture.parentPath, "local");
    const localPath = path.join(fixture.parentPath, "local");
    await waitForRepository(localPath);

    fixture.write("local", "local.txt", "local\n");
    await commitThroughUi("local.txt", "add local file", true);
    const localAddOid = fixture.git(["rev-parse", "HEAD"], localPath).trim();
    assert.equal(
      fixture.git(["show", "refs/heads/main:local.txt"], fixture.remotePath),
      "local\n",
    );

    fixture.clone("peer");
    fixture.write("peer", "peer.txt", "peer\n");
    fixture.git(["add", "peer.txt"], fixture.repoPath("peer"));
    fixture.git(["commit", "-m", "peer pushes file"], fixture.repoPath("peer"));
    fixture.git(["push"], fixture.repoPath("peer"));

    await syncAllThroughUi();
    assert.equal(
      readFileSync(path.join(localPath, "peer.txt"), "utf8"),
      "peer\n",
    );
    assertClean(fixture, localPath);

    fixture.write("local", "tracked.txt", "local conflicting edit\n");
    await commitThroughUi("tracked.txt", "local conflicting edit", false);

    fixture.write("peer", "tracked.txt", "peer conflicting edit\n");
    fixture.git(["add", "tracked.txt"], fixture.repoPath("peer"));
    fixture.git(
      ["commit", "-m", "peer conflicting edit"],
      fixture.repoPath("peer"),
    );
    fixture.git(["push"], fixture.repoPath("peer"));

    await syncAllThroughUi();
    await waitForConflictOverlay("tracked.txt");
    await assertCloseGuardBlocksWindowShortcutDuringConflict();
    assert.match(
      fixture.git(["status", "--porcelain=v1"], localPath),
      /UU tracked\.txt/,
    );
    await resolveConflictWithOwnVersion("tracked.txt");
    assert.equal(
      readFileSync(path.join(localPath, "tracked.txt"), "utf8"),
      "local conflicting edit\n",
    );
    assertClean(fixture, localPath);

    await syncAllThroughUi();
    fixture.git(["pull", "--ff-only"], fixture.repoPath("peer"));
    assert.equal(
      readFileSync(path.join(fixture.repoPath("peer"), "tracked.txt"), "utf8"),
      "local conflicting edit\n",
    );

    await revertCommitThroughUi(
      fixture,
      localPath,
      localAddOid,
      "add local file",
    );

    fixture.git(["pull", "--ff-only"], fixture.repoPath("peer"));
    assert.equal(
      existsSync(path.join(fixture.repoPath("peer"), "local.txt")),
      false,
    );
    assertClean(fixture, localPath);
  });
});

class RealGitFixture {
  private constructor(
    readonly parentPath: string,
    readonly remotePath: string,
    private readonly gitPath: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  static create() {
    const gitDist = process.env.ARTISTIC_GIT_DIST_DIR;
    if (!gitDist) {
      throw new Error("ARTISTIC_GIT_DIST_DIR is required for real-git E2E.");
    }

    const manifest = JSON.parse(
      readFileSync(path.join(gitDist, "manifest.json"), "utf8"),
    ) as GitDistManifest;
    const gitPath = path.join(gitDist, manifest.paths.gitExecutable);
    if (!existsSync(gitPath)) {
      throw new Error(`embedded git executable was not found at ${gitPath}`);
    }

    const parentPath = mkdtempSync(path.join(tmpdir(), "ag-wdio-full-chain-"));
    const remotePath = path.join(parentPath, "remote.git");
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: path.join(parentPath, "home"),
      PATH: path.dirname(gitPath),
    };
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
    });
    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed in ${cwd ?? process.cwd()}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    return result.stdout;
  }
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
  await $('[data-testid="history-revert-confirm"]').click();
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
  await $('[data-testid="start-screen"]').waitForExist({ timeout: 60_000 });
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="start-open-project"]').isEnabled()) &&
      (await $('[data-testid="start-clone-project"]').isEnabled()),
    {
      timeout: 60_000,
      timeoutMsg: "start screen controls did not become ready",
    },
  );
}

async function waitForRepository(repositoryPath: string) {
  await browser.waitUntil(
    async () =>
      existsSync(path.join(repositoryPath, ".git")) &&
      (await elementWithAttribute(
        "repository-shell",
        "data-repository-path",
        repositoryPath,
      )) !== null &&
      (await $('[data-testid="history-scroll-viewport"]').isExisting()),
    {
      timeout: 90_000,
      timeoutMsg: `cloned repository did not open in the UI at ${repositoryPath}`,
    },
  );
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
