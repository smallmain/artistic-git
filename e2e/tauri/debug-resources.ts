import { cpSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export function installDebugGitDist(sourceRoot: string, appBinaryPath: string) {
  const source = path.resolve(sourceRoot);
  const destination = path.join(path.dirname(appBinaryPath), "git-dist");
  const staging = `${destination}.staging`;
  const backup = `${destination}.backup`;

  recoverInterruptedInstall(destination, staging, backup);

  if (!statSync(source).isDirectory()) {
    throw new Error(`embedded Git source is not a directory: ${source}`);
  }
  if (!existsSync(path.join(source, "manifest.json"))) {
    throw new Error(`embedded Git source manifest is missing: ${source}`);
  }
  if (source === path.resolve(destination)) {
    throw new Error(
      "embedded Git source and debug resource destination must differ",
    );
  }

  let movedPrevious = false;

  try {
    cpSync(source, staging, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
    if (!existsSync(path.join(staging, "manifest.json"))) {
      throw new Error("copied debug resource manifest is missing");
    }

    if (existsSync(destination)) {
      renameSync(destination, backup);
      movedPrevious = true;
    }
    renameSync(staging, destination);
    try {
      rmSync(backup, { force: true, recursive: true });
    } catch {
      // The new tree is active. A later invocation will finish cleanup.
    }
    return destination;
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    if (movedPrevious && !existsSync(destination) && existsSync(backup)) {
      renameSync(backup, destination);
    }
    throw error;
  }
}

function recoverInterruptedInstall(
  destination: string,
  staging: string,
  backup: string,
) {
  rmSync(staging, { force: true, recursive: true });
  if (!existsSync(backup)) {
    return;
  }

  if (existsSync(destination)) {
    rmSync(backup, { force: true, recursive: true });
    return;
  }

  renameSync(backup, destination);
}
