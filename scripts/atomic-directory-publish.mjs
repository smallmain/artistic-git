/* global process, setTimeout */

import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const windowsTransientRenameCodes = new Set([
  "EACCES",
  "EBUSY",
  "ENOTEMPTY",
  "EPERM",
]);

export const defaultWindowsRenameRetryDelaysMs = Object.freeze([
  50, 100, 200, 400, 800, 1_600, 3_200, 5_000,
]);

export async function renameDirectoryWithRetry(
  source,
  destination,
  {
    platform = process.platform,
    renameDirectory = rename,
    retryDelaysMs = defaultWindowsRenameRetryDelaysMs,
    wait = delay,
  } = {},
) {
  let retryIndex = 0;
  while (true) {
    try {
      await renameDirectory(source, destination);
      return;
    } catch (error) {
      const retryDelay = retryDelaysMs[retryIndex];
      if (
        platform !== "win32" ||
        !windowsTransientRenameCodes.has(error?.code) ||
        retryDelay === undefined
      ) {
        throw error;
      }
      retryIndex += 1;
      await wait(retryDelay);
    }
  }
}

export async function atomicPublishDirectory(
  source,
  destination,
  {
    makeDirectory = mkdir,
    platform = process.platform,
    removeDirectory = rm,
    renameDirectory = rename,
    retryDelaysMs = defaultWindowsRenameRetryDelaysMs,
    statPath = stat,
    wait = delay,
  } = {},
) {
  await makeDirectory(path.dirname(destination), { recursive: true });
  const backup = `${destination}.backup-${process.pid}-${Date.now()}`;
  const existing = await statIfExists(destination, statPath);
  const renameOptions = {
    platform,
    renameDirectory,
    retryDelaysMs,
    wait,
  };
  const removeOptions = recursiveRemoveOptions(platform);
  let movedExisting = false;

  if (existing) {
    await renameDirectoryWithRetry(destination, backup, renameOptions);
    movedExisting = true;
  }
  try {
    await renameDirectoryWithRetry(source, destination, renameOptions);
  } catch (publishError) {
    const recoveryErrors = [];
    try {
      await removeDirectory(destination, removeOptions);
    } catch (cleanupError) {
      recoveryErrors.push(cleanupError);
    }
    if (movedExisting) {
      try {
        await renameDirectoryWithRetry(backup, destination, renameOptions);
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError);
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [publishError, ...recoveryErrors],
        `atomic directory publication failed for ${source} -> ${destination}; recovery also failed`,
        { cause: publishError },
      );
    }
    throw publishError;
  }

  if (movedExisting) {
    await removeDirectory(backup, removeOptions);
  }
}

async function statIfExists(filePath, statPath) {
  try {
    return await statPath(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function recursiveRemoveOptions(platform) {
  const options = { recursive: true, force: true };
  if (platform === "win32") {
    options.maxRetries = 8;
    options.retryDelay = 100;
  }
  return options;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
