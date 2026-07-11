import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  atomicPublishDirectory,
  renameDirectoryWithRetry,
} from "./atomic-directory-publish.mjs";

test("Windows transient rename failures are retried", async () => {
  let attempts = 0;
  const delays = [];

  await renameDirectoryWithRetry("source", "destination", {
    platform: "win32",
    renameDirectory: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
      }
    },
    retryDelaysMs: [10, 20],
    wait: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("non-transient rename failures fail immediately", async () => {
  let attempts = 0;
  const expected = Object.assign(new Error("invalid source"), {
    code: "ENOENT",
  });

  await assert.rejects(
    renameDirectoryWithRetry("source", "destination", {
      platform: "win32",
      renameDirectory: async () => {
        attempts += 1;
        throw expected;
      },
      retryDelaysMs: [0, 0],
      wait: async () => {},
    }),
    (error) => error === expected,
  );
  assert.equal(attempts, 1);
});

test("transient rename failures fail after the retry budget is exhausted", async () => {
  let attempts = 0;
  const expected = Object.assign(new Error("still locked"), { code: "EACCES" });

  await assert.rejects(
    renameDirectoryWithRetry("source", "destination", {
      platform: "win32",
      renameDirectory: async () => {
        attempts += 1;
        throw expected;
      },
      retryDelaysMs: [0, 0, 0],
      wait: async () => {},
    }),
    (error) => error === expected,
  );
  assert.equal(attempts, 4);
});

test("failed publication restores the existing active directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-atomic-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = path.join(root, "active");
  const candidate = path.join(root, "candidate");
  await mkdir(active);
  await mkdir(candidate);
  await writeFile(path.join(active, "marker"), "active\n");
  await writeFile(path.join(candidate, "marker"), "candidate\n");
  const expected = Object.assign(new Error("publish failed"), { code: "EIO" });

  await assert.rejects(
    atomicPublishDirectory(candidate, active, {
      platform: "win32",
      renameDirectory: async (source, destination) => {
        if (source === candidate && destination === active) {
          throw expected;
        }
        await rename(source, destination);
      },
      retryDelaysMs: [0],
      wait: async () => {},
    }),
    (error) => error === expected,
  );

  assert.equal(await readFile(path.join(active, "marker"), "utf8"), "active\n");
  assert.equal(
    await readFile(path.join(candidate, "marker"), "utf8"),
    "candidate\n",
  );
});

test("destination stat permission errors fail without mutating either tree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-atomic-stat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = path.join(root, "active");
  const candidate = path.join(root, "candidate");
  await mkdir(active);
  await mkdir(candidate);
  await writeFile(path.join(active, "marker"), "active\n");
  await writeFile(path.join(candidate, "marker"), "candidate\n");
  let renameAttempts = 0;
  let removeAttempts = 0;

  for (const code of ["EACCES", "EPERM"]) {
    const expected = Object.assign(new Error(`access denied: ${code}`), {
      code,
    });
    await assert.rejects(
      atomicPublishDirectory(candidate, active, {
        removeDirectory: async () => {
          removeAttempts += 1;
        },
        renameDirectory: async () => {
          renameAttempts += 1;
        },
        statPath: async () => {
          throw expected;
        },
      }),
      (error) => error === expected,
    );
  }

  assert.equal(renameAttempts, 0);
  assert.equal(removeAttempts, 0);
  assert.equal(await readFile(path.join(active, "marker"), "utf8"), "active\n");
  assert.equal(
    await readFile(path.join(candidate, "marker"), "utf8"),
    "candidate\n",
  );
  assert.deepEqual(await backupEntries(root), []);
});

test("atomic publication retries a transient Windows rename and removes its backup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-atomic-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = path.join(root, "active");
  const candidate = path.join(root, "candidate");
  await mkdir(active);
  await mkdir(candidate);
  await writeFile(path.join(active, "marker"), "active\n");
  await writeFile(path.join(candidate, "marker"), "candidate\n");
  let publishAttempts = 0;

  await atomicPublishDirectory(candidate, active, {
    platform: "win32",
    renameDirectory: async (source, destination) => {
      if (source === candidate && destination === active) {
        publishAttempts += 1;
        if (publishAttempts === 1) {
          throw Object.assign(new Error("temporarily locked"), {
            code: "EPERM",
          });
        }
      }
      await rename(source, destination);
    },
    retryDelaysMs: [0],
    wait: async () => {},
  });

  assert.equal(publishAttempts, 2);
  assert.equal(
    await readFile(path.join(active, "marker"), "utf8"),
    "candidate\n",
  );
  assert.deepEqual(await readdir(root), ["active"]);
  assert.deepEqual(await backupEntries(root), []);
});

test("post-commit backup cleanup failure does not roll back the published tree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-atomic-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = path.join(root, "active");
  const candidate = path.join(root, "candidate");
  await mkdir(active);
  await mkdir(candidate);
  await writeFile(path.join(active, "marker"), "active\n");
  await writeFile(path.join(candidate, "marker"), "candidate\n");
  const cleanupError = Object.assign(new Error("backup cleanup failed"), {
    code: "EACCES",
  });
  let backup = null;
  let rollbackAttempts = 0;

  await assert.rejects(
    atomicPublishDirectory(candidate, active, {
      platform: "win32",
      removeDirectory: async (directory) => {
        if (directory === backup) {
          throw cleanupError;
        }
        await rm(directory, { recursive: true, force: true });
      },
      renameDirectory: async (source, destination) => {
        if (source === active) {
          backup = destination;
        } else if (source === backup && destination === active) {
          rollbackAttempts += 1;
        }
        await rename(source, destination);
      },
    }),
    (error) => error === cleanupError,
  );

  assert.equal(rollbackAttempts, 0);
  assert.equal(
    await readFile(path.join(active, "marker"), "utf8"),
    "candidate\n",
  );
  assert.equal(await readFile(path.join(backup, "marker"), "utf8"), "active\n");
  assert.deepEqual(await backupEntries(root), [path.basename(backup)]);
});

test("cleanup failure still restores through a transient rollback and preserves every error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-atomic-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = path.join(root, "active");
  const candidate = path.join(root, "candidate");
  await mkdir(active);
  await mkdir(candidate);
  await writeFile(path.join(active, "marker"), "active\n");
  await writeFile(path.join(candidate, "marker"), "candidate\n");
  const publishError = Object.assign(new Error("publish failed"), {
    code: "EIO",
  });
  const cleanupError = Object.assign(new Error("cleanup failed"), {
    code: "EACCES",
  });
  let backup = null;
  let rollbackAttempts = 0;

  let caught;
  await assert.rejects(
    atomicPublishDirectory(candidate, active, {
      platform: "win32",
      removeDirectory: async (directory) => {
        if (directory === active) {
          throw cleanupError;
        }
        await rm(directory, { recursive: true, force: true });
      },
      renameDirectory: async (source, destination) => {
        if (source === active) {
          backup = destination;
        } else if (source === candidate && destination === active) {
          throw publishError;
        } else if (source === backup && destination === active) {
          rollbackAttempts += 1;
          if (rollbackAttempts === 1) {
            throw Object.assign(new Error("rollback temporarily locked"), {
              code: "EPERM",
            });
          }
        }
        await rename(source, destination);
      },
      retryDelaysMs: [0],
      wait: async () => {},
    }),
    (error) => {
      caught = error;
      return true;
    },
  );

  assert.ok(caught instanceof AggregateError);
  assert.match(caught.message, /publication failed.*recovery also failed/);
  assert.equal(caught.cause, publishError);
  assert.deepEqual(caught.errors, [publishError, cleanupError]);
  assert.equal(rollbackAttempts, 2);
  assert.equal(await readFile(path.join(active, "marker"), "utf8"), "active\n");
  assert.equal(
    await readFile(path.join(candidate, "marker"), "utf8"),
    "candidate\n",
  );
  assert.deepEqual(await backupEntries(root), []);
});

test("exhausted rollback keeps the backup and reports all recovery errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-atomic-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = path.join(root, "active");
  const candidate = path.join(root, "candidate");
  await mkdir(active);
  await mkdir(candidate);
  await writeFile(path.join(active, "marker"), "active\n");
  await writeFile(path.join(candidate, "marker"), "candidate\n");
  const publishError = Object.assign(new Error("publish failed"), {
    code: "EIO",
  });
  const cleanupError = Object.assign(new Error("cleanup failed"), {
    code: "EACCES",
  });
  const rollbackError = Object.assign(new Error("rollback failed"), {
    code: "EIO",
  });
  let backup = null;

  let caught;
  await assert.rejects(
    atomicPublishDirectory(candidate, active, {
      platform: "win32",
      removeDirectory: async (directory) => {
        if (directory === active) {
          throw cleanupError;
        }
        await rm(directory, { recursive: true, force: true });
      },
      renameDirectory: async (source, destination) => {
        if (source === active) {
          backup = destination;
        } else if (source === candidate && destination === active) {
          throw publishError;
        } else if (source === backup && destination === active) {
          throw rollbackError;
        }
        await rename(source, destination);
      },
      retryDelaysMs: [],
      wait: async () => {},
    }),
    (error) => {
      caught = error;
      return true;
    },
  );

  assert.ok(caught instanceof AggregateError);
  assert.equal(caught.cause, publishError);
  assert.deepEqual(caught.errors, [publishError, cleanupError, rollbackError]);
  assert.equal(await readFile(path.join(backup, "marker"), "utf8"), "active\n");
  assert.deepEqual(await backupEntries(root), [path.basename(backup)]);
});

async function backupEntries(root) {
  return (await readdir(root)).filter((entry) =>
    entry.startsWith("active.backup-"),
  );
}
