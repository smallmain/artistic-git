#!/usr/bin/env node
/* global clearInterval, console, process, setInterval, setTimeout */

import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildGitToolchainHelpers } from "./build-git-toolchain-helpers.mjs";
import { checkDistRoot } from "./check-git-dist.mjs";
import { buildGitToolchainBase } from "./fetch-git-dist.mjs";
import {
  assembleGitDistFromBase,
  regularFileResourcePaths,
  repoRoot,
  sha256File,
} from "./git-dist-lib.mjs";
import {
  activeToolchainRoot,
  computeToolchainState,
  ensureCacheDirectories,
  normalizeTarget,
  pathExists,
} from "./git-toolchain-state.mjs";

export async function ensureGitToolchain(targetName) {
  let state = await computeToolchainState(targetName);
  if (verifyActive(state, { quiet: true })) {
    console.log(
      `embedded toolchain ${state.revision} is ready for ${state.target}`,
    );
    return state;
  }

  const paths = await ensureCacheDirectories(state);
  await ensureHelperCache(state, paths);
  await ensureBaseCache(state, paths);

  let activated = false;
  await withDirectoryLock(paths.locksRoot, "activate", async () => {
    state = await computeToolchainState(targetName);
    if (verifyActive(state, { quiet: true })) {
      return;
    }
    await assertCacheEntry({
      fingerprint: state.baseFingerprint,
      kind: "base",
      metadataPath: baseMetadataPath(paths),
      root: paths.baseRoot,
      target: state.target,
    });
    await assertCacheEntry({
      fingerprint: state.helperFingerprint,
      kind: "helper",
      metadataPath: helperMetadataPath(paths),
      root: paths.helperRoot,
      target: state.target,
    });
    const beforePublish = await computeToolchainState(targetName);
    if (
      beforePublish.distributionFingerprint !== state.distributionFingerprint
    ) {
      throw new Error(
        "toolchain inputs changed while ensure was running; retry",
      );
    }

    const candidateRoot = path.join(
      path.dirname(activeToolchainRoot),
      `.git-dist.activation-${process.pid}-${Date.now()}`,
    );
    await rm(candidateRoot, { recursive: true, force: true });
    try {
      await assembleGitDistFromBase({
        baseDir: paths.baseRoot,
        baseFingerprint: state.baseFingerprint,
        config: state.config,
        distributionFingerprint: state.distributionFingerprint,
        helperDir: paths.helperRoot,
        helperFingerprint: state.helperFingerprint,
        helperVersion: state.helperVersion,
        outputDir: candidateRoot,
        targetName: state.target,
        toolchainRevision: state.revision,
      });
      await validateAndActivateCandidate({ candidateRoot, state });
    } finally {
      await rm(candidateRoot, { recursive: true, force: true });
    }
    activated = true;
  });

  console.log(
    activated
      ? `embedded toolchain ${state.revision} assembled for ${state.target}`
      : `embedded toolchain ${state.revision} is ready for ${state.target}`,
  );
  return state;
}

export async function validateAndActivateCandidate({
  activeRoot = activeToolchainRoot,
  candidateRoot,
  state,
  validateCandidate = checkDistRoot,
}) {
  await validateCandidate(state, candidateRoot);
  await atomicPublishDirectory(candidateRoot, activeRoot);
}

async function ensureBaseCache(state, paths) {
  await withDirectoryLock(
    paths.locksRoot,
    `base-${state.target}-${state.baseFingerprint}`,
    async () => {
      if (
        await cacheEntryIsValid({
          fingerprint: state.baseFingerprint,
          kind: "base",
          metadataPath: baseMetadataPath(paths),
          root: paths.baseRoot,
          target: state.target,
        })
      ) {
        return;
      }

      await rm(path.dirname(paths.baseRoot), { recursive: true, force: true });
      if (await seedBaseFromActive(state, paths)) {
        return;
      }
      await mkdir(path.dirname(paths.baseRoot), { recursive: true });
      await buildGitToolchainBase({
        config: state.config,
        downloadsRoot: paths.downloadsRoot,
        locksRoot: paths.locksRoot,
        outputDir: paths.baseRoot,
        target: state.target,
        workRoot: paths.workRoot,
      });
      await writeCacheMetadata({
        fingerprint: state.baseFingerprint,
        kind: "base",
        metadataPath: baseMetadataPath(paths),
        root: paths.baseRoot,
        target: state.target,
      });
    },
  );
}

async function ensureHelperCache(state, paths) {
  await withDirectoryLock(
    paths.locksRoot,
    `helper-${state.target}-${state.helperFingerprint}`,
    async () => {
      if (
        await cacheEntryIsValid({
          fingerprint: state.helperFingerprint,
          kind: "helper",
          metadataPath: helperMetadataPath(paths),
          root: paths.helperRoot,
          target: state.target,
        })
      ) {
        return;
      }
      await rm(path.dirname(paths.helperRoot), {
        recursive: true,
        force: true,
      });
      await mkdir(path.dirname(paths.helperRoot), { recursive: true });
      await buildGitToolchainHelpers({
        config: state.config,
        outputDir: paths.helperRoot,
        rustToolchain: state.helperRustToolchain,
        target: state.target,
        workRoot: paths.workRoot,
      });
      await writeCacheMetadata({
        fingerprint: state.helperFingerprint,
        kind: "helper",
        metadataPath: helperMetadataPath(paths),
        root: paths.helperRoot,
        target: state.target,
      });
    },
  );
}

async function seedBaseFromActive(state, paths) {
  const manifestPath = path.join(activeToolchainRoot, "manifest.json");
  const manifest = await readJson(manifestPath).catch(() => null);
  if (
    manifest?.schemaVersion !== 2 ||
    manifest.target !== state.target ||
    manifest.toolchainRevision !== state.revision ||
    manifest.baseFingerprint !== state.baseFingerprint
  ) {
    return false;
  }

  const helperPrefix = `${state.config.resources.layout.helpers.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  const baseHashes = Object.fromEntries(
    Object.entries(manifest.sha256 ?? {}).filter(
      ([relativePath]) => !relativePath.startsWith(helperPrefix),
    ),
  );
  const manifestRelativePath =
    state.config.resources.layout.manifest.replaceAll("\\", "/");
  const actualBaseFiles = (await regularFileResourcePaths(activeToolchainRoot))
    .filter(
      (relativePath) =>
        relativePath !== manifestRelativePath &&
        !relativePath.startsWith(helperPrefix),
    )
    .sort();
  const expectedBaseFiles = Object.keys(baseHashes).sort();
  if (JSON.stringify(actualBaseFiles) !== JSON.stringify(expectedBaseFiles)) {
    return false;
  }
  if (!(await hashesMatch(activeToolchainRoot, baseHashes))) {
    return false;
  }

  const temporary = path.join(
    paths.workRoot,
    `seed-base-${process.pid}-${Date.now()}`,
  );
  const validationRoot = `${temporary}-validation`;
  await rm(temporary, { recursive: true, force: true });
  await rm(validationRoot, { recursive: true, force: true });
  try {
    await cp(activeToolchainRoot, temporary, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await rm(path.join(temporary, manifestRelativePath), { force: true });
    await rm(path.join(temporary, state.config.resources.layout.helpers), {
      recursive: true,
      force: true,
    });
    await assembleGitDistFromBase({
      baseDir: temporary,
      baseFingerprint: state.baseFingerprint,
      config: state.config,
      distributionFingerprint: state.distributionFingerprint,
      helperDir: paths.helperRoot,
      helperFingerprint: state.helperFingerprint,
      helperVersion: state.helperVersion,
      outputDir: validationRoot,
      targetName: state.target,
      toolchainRevision: state.revision,
    });
    await checkDistRoot(state, validationRoot);
    await atomicPublishDirectory(temporary, paths.baseRoot);
    await writeCacheMetadata({
      fingerprint: state.baseFingerprint,
      kind: "base",
      metadataPath: baseMetadataPath(paths),
      root: paths.baseRoot,
      target: state.target,
    });
    console.log(
      "reused the validated third-party base from the active toolchain",
    );
    return true;
  } catch (error) {
    console.log(`active third-party base cannot be reused: ${error.message}`);
    return false;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(validationRoot, { recursive: true, force: true });
  }
}

function verifyActive(state, { quiet }) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "check-git-dist.mjs"),
      `--target=${state.target}`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (!quiet || result.status === 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result.status === 0;
}

async function cacheEntryIsValid(options) {
  try {
    await assertCacheEntry(options);
    return true;
  } catch {
    return false;
  }
}

async function assertCacheEntry({
  fingerprint,
  kind,
  metadataPath,
  root,
  target: expectedTarget,
}) {
  const metadata = await readJson(metadataPath);
  if (
    metadata.schemaVersion !== 1 ||
    metadata.kind !== kind ||
    metadata.target !== expectedTarget ||
    metadata.fingerprint !== fingerprint
  ) {
    throw new Error(`invalid ${kind} cache metadata`);
  }
  const files = await regularFileResourcePaths(root);
  if (files.length !== Object.keys(metadata.sha256 ?? {}).length) {
    throw new Error(`${kind} cache file list does not match metadata`);
  }
  if (!(await hashesMatch(root, metadata.sha256))) {
    throw new Error(`${kind} cache checksum mismatch`);
  }
}

async function writeCacheMetadata({
  fingerprint,
  kind,
  metadataPath,
  root,
  target: entryTarget,
}) {
  const sha256 = {};
  for (const relativePath of await regularFileResourcePaths(root)) {
    sha256[relativePath] = await sha256File(path.join(root, relativePath));
  }
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind,
        target: entryTarget,
        fingerprint,
        sha256,
      },
      null,
      2,
    )}\n`,
  );
}

async function hashesMatch(root, hashes) {
  for (const [relativePath, expected] of Object.entries(hashes ?? {})) {
    const filePath = path.join(root, relativePath);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile() || (await sha256File(filePath)) !== expected) {
      return false;
    }
  }
  return true;
}

function baseMetadataPath(paths) {
  return path.join(path.dirname(paths.baseRoot), "metadata.json");
}

function helperMetadataPath(paths) {
  return path.join(path.dirname(paths.helperRoot), "metadata.json");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function withDirectoryLock(locksRoot, name, callback) {
  await mkdir(locksRoot, { recursive: true });
  const lockPath = path.join(locksRoot, `${name}.lock`);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await staleLockCanBeRemoved(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        const owner = await readJson(path.join(lockPath, "owner.json")).catch(
          () => null,
        );
        throw new Error(
          `timed out waiting for toolchain lock ${name}${owner ? ` owned by pid ${owner.pid} on ${owner.hostname}` : ""}`,
          { cause: error },
        );
      }
      await delay(250);
    }
  }

  const ownerPath = path.join(lockPath, "owner.json");
  await writeFile(
    ownerPath,
    `${JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    })}\n`,
  );
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(ownerPath, now, now).catch(() => {});
  }, 10_000);
  heartbeat.unref();
  try {
    return await callback();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function staleLockCanBeRemoved(lockPath) {
  const ownerPath = path.join(lockPath, "owner.json");
  const ownerStat = await stat(ownerPath).catch(() => null);
  if (!ownerStat || Date.now() - ownerStat.mtimeMs < 60_000) {
    return false;
  }
  const owner = await readJson(ownerPath).catch(() => null);
  if (!owner || owner.hostname !== hostname()) {
    return Date.now() - ownerStat.mtimeMs > 30 * 60 * 1000;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function atomicPublishDirectory(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const backup = `${destination}.backup-${process.pid}-${Date.now()}`;
  const existing = await pathExists(destination);
  if (existing) await rename(destination, backup);
  try {
    await rename(source, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (existing) await rename(backup, destination);
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const targetArg = args.find((arg) => arg.startsWith("--target="));
  const unknownArgs = args.filter((arg) => !arg.startsWith("--target="));
  if (unknownArgs.length > 0) {
    throw new Error(`unknown git-toolchain ensure argument: ${unknownArgs[0]}`);
  }
  await ensureGitToolchain(
    normalizeTarget(targetArg?.slice("--target=".length)),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(`embedded toolchain ensure failed: ${error.message}`);
    process.exitCode = 1;
  }
}
