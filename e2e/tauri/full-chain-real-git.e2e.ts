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

type ToolGitIdentity = {
  name: string | null;
  email: string | null;
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

  it("drives UI clone and completes clone/open/commit/sync/conflict/revert through the Tauri backend", async () => {
    await waitForStartScreen();
    await cloneThroughUi(fixture.remotePath, fixture.parentPath, "local");
    const localPath = path.join(fixture.parentPath, "local");
    await waitForRepository(localPath);

    const localAddOid = await appInvoke<CommitResponse>("commit_changes", {
      request: commitRequest(
        localPath,
        "local.txt",
        "local\n",
        "add local file",
        true,
      ),
    }).then((response) => committedOid(response, "local commit"));
    assert.equal(
      fixture.git(["show", "refs/heads/main:local.txt"], fixture.remotePath),
      "local\n",
    );

    fixture.clone("peer");
    fixture.write("peer", "peer.txt", "peer\n");
    fixture.git(["add", "peer.txt"], fixture.repoPath("peer"));
    fixture.git(["commit", "-m", "peer pushes file"], fixture.repoPath("peer"));
    fixture.git(["push"], fixture.repoPath("peer"));

    const pulled = await appInvoke<SyncCurrentBranchResponse>(
      "sync_current_branch",
      {
        request: {
          repositoryPath: localPath,
          operationId: "wdio-full-chain-pull",
        },
      },
    );
    assert.equal(pulled.status, "pulled");
    assert.equal(
      readFileSync(path.join(localPath, "peer.txt"), "utf8"),
      "peer\n",
    );
    assertClean(fixture, localPath);

    await appInvoke<CommitResponse>("commit_changes", {
      request: commitRequest(
        localPath,
        "tracked.txt",
        "local conflicting edit\n",
        "local conflicting edit",
        false,
      ),
    }).then((response) => committedOid(response, "local conflicting commit"));

    fixture.write("peer", "tracked.txt", "peer conflicting edit\n");
    fixture.git(["add", "tracked.txt"], fixture.repoPath("peer"));
    fixture.git(
      ["commit", "-m", "peer conflicting edit"],
      fixture.repoPath("peer"),
    );
    fixture.git(["push"], fixture.repoPath("peer"));

    const conflict = await appInvoke<SyncCurrentBranchResponse>(
      "sync_current_branch",
      {
        request: {
          repositoryPath: localPath,
          operationId: "wdio-full-chain-conflict",
        },
      },
    );
    assert.equal(conflict.status, "conflicts");
    assert.ok(
      conflict.conflict?.files.some((file) => file.path === "tracked.txt"),
    );
    assert.match(
      fixture.git(["status", "--porcelain=v1"], localPath),
      /UU tracked\.txt/,
    );

    await appInvoke("save_conflict_resolution", {
      request: {
        repositoryPath: localPath,
        path: "tracked.txt",
        content: "resolved full chain\n",
        pendingHunks: 0,
      },
    });
    await appInvoke("complete_conflict_resolution", {
      request: {
        repositoryPath: localPath,
        operationId: "wdio-full-chain-conflict",
        paths: ["tracked.txt"],
      },
    });
    assert.equal(
      readFileSync(path.join(localPath, "tracked.txt"), "utf8"),
      "resolved full chain\n",
    );
    assertClean(fixture, localPath);

    const pushedResolution = await appInvoke<SyncCurrentBranchResponse>(
      "sync_current_branch",
      {
        request: {
          repositoryPath: localPath,
          operationId: "wdio-full-chain-push-resolution",
        },
      },
    );
    assert.ok(
      pushedResolution.status === "pushed" ||
        pushedResolution.status === "alreadyUpToDate",
      `unexpected resolution push status: ${pushedResolution.status}`,
    );
    fixture.git(["pull", "--ff-only"], fixture.repoPath("peer"));
    assert.equal(
      readFileSync(path.join(fixture.repoPath("peer"), "tracked.txt"), "utf8"),
      "resolved full chain\n",
    );

    const reverted = await appInvoke<RevertCommitResponse>("revert_commit", {
      request: {
        repositoryPath: localPath,
        oid: localAddOid,
        pushAfterRevert: true,
      },
    });
    assert.equal(reverted.status, "reverted");
    if (reverted.status !== "reverted") {
      throw new Error(
        `unexpected revert response: ${JSON.stringify(reverted)}`,
      );
    }
    const revertedCommit = reverted as Extract<
      RevertCommitResponse,
      { status: "reverted" }
    >;
    assert.equal(revertedCommit.message, "Revert: add local file");
    assert.equal(revertedCommit.pushed, true);

    fixture.git(["pull", "--ff-only"], fixture.repoPath("peer"));
    assert.equal(
      existsSync(path.join(fixture.repoPath("peer"), "local.txt")),
      false,
    );
    assertClean(fixture, localPath);
  });
});

type CommitResponse =
  | {
      status: "committed";
      oid: string;
      committedPaths: string[];
      lfsTrackedPaths: string[];
    }
  | { status: string };

type RevertCommitResponse =
  | { status: "reverted"; oid: string; message: string; pushed: boolean }
  | { status: string };

type SyncCurrentBranchResponse = {
  repositoryPath: string;
  branchName: string;
  upstream: string | null;
  status: string;
  attempts: number;
  conflict: null | {
    files: Array<{ path: string }>;
  };
  stashRecovery: unknown;
  remoteHistoryChange: unknown;
};

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
  const directoryInput = await $('[data-testid="clone-directory-name-input"]');
  await directoryInput.setValue(directoryName);
  await $('button[form="clone-repository"]').click();
}

async function waitForStartScreen() {
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        Boolean(document.querySelector('[data-testid="start-screen"]')),
      ),
    {
      timeout: 60_000,
      timeoutMsg: "start screen did not become ready",
    },
  );
}

async function waitForRepository(repositoryPath: string) {
  await browser.waitUntil(
    async () => {
      if (!existsSync(path.join(repositoryPath, ".git"))) {
        return false;
      }
      try {
        await appInvoke("repository_summary", {
          request: { repositoryPath },
        });
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 90_000,
      timeoutMsg: `cloned repository did not become usable at ${repositoryPath}`,
    },
  );
}

function commitRequest(
  repositoryPath: string,
  relativePath: string,
  content: string,
  message: string,
  pushImmediately: boolean,
) {
  writeFileSync(path.join(repositoryPath, relativePath), content);
  return {
    repositoryPath,
    paths: [relativePath],
    message,
    largeFileThresholdMb: null,
    largeFileDecision: "prompt",
    disableRepositoryGpgsign: false,
    pushImmediately,
  };
}

function committedOid(response: CommitResponse, label: string) {
  assert.equal(response.status, "committed", `${label} should commit`);
  return (response as Extract<CommitResponse, { status: "committed" }>).oid;
}

function assertClean(fixture: RealGitFixture, repositoryPath: string) {
  assert.equal(
    fixture.git(["status", "--porcelain=v1"], repositoryPath).trim(),
    "",
  );
}

function appInvoke<T = unknown>(command: string, args: unknown): Promise<T> {
  return browser.execute(
    async (name, payload) => {
      const tauri = (
        window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke<TResponse>(
              command: string,
              args?: unknown,
            ): Promise<TResponse>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!tauri?.invoke) {
        throw new Error("Tauri invoke API is not available in the WebView.");
      }
      return tauri.invoke<T>(name, payload);
    },
    command,
    args,
  ) as Promise<T>;
}
