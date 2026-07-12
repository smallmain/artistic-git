#!/usr/bin/env node
/* global console, process */

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

function fail(message) {
  throw new Error(message);
}

async function requireRegularFile(filePath, label) {
  const fileStat = await lstat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    fail(`${label} is missing or is not a regular file: ${filePath}`);
  }
  return fileStat;
}

async function gunzipSha256(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath).pipe(createGunzip());
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function runCommandToFile(
  command,
  args,
  outputPath,
  { env = process.env } = {},
) {
  const resolvedOutput = path.resolve(outputPath);
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });

  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(resolvedOutput)),
      exited,
    ]);
  } catch (error) {
    child.kill();
    await rm(resolvedOutput, { force: true });
    throw error;
  }
}

export async function gzipTarWithSystemGzip(
  tarPath,
  outputPath,
  { commandRunner = runCommandToFile } = {},
) {
  await commandRunner(
    "gzip",
    ["-9", "-n", "-c", path.resolve(tarPath)],
    path.resolve(outputPath),
  );
}

export async function recompressUpdaterArchive(
  updaterPath,
  { compressTar = gzipTarWithSystemGzip } = {},
) {
  const resolved = path.resolve(updaterPath);
  const originalStat = await requireRegularFile(
    resolved,
    "macOS updater archive",
  );
  const originalPayloadSha256 = await gunzipSha256(resolved);
  const candidate = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${randomUUID()}.gzip9`,
  );
  const tar = `${candidate}.tar`;

  try {
    await pipeline(
      createReadStream(resolved),
      createGunzip(),
      createWriteStream(tar, { mode: 0o600 }),
    );
    await compressTar(tar, candidate);
    const candidateStat = await requireRegularFile(
      candidate,
      "gzip-9 updater candidate",
    );
    const candidatePayloadSha256 = await gunzipSha256(candidate);
    if (candidatePayloadSha256 !== originalPayloadSha256) {
      fail("gzip-9 updater payload differs from the original tar stream");
    }
    if (candidateStat.size > originalStat.size) {
      fail(
        `gzip-9 updater grew from ${originalStat.size} to ${candidateStat.size} bytes`,
      );
    }
    await chmod(candidate, originalStat.mode & 0o777);
    await rename(candidate, resolved);
    return {
      inputBytes: originalStat.size,
      outputBytes: candidateStat.size,
      savedBytes: originalStat.size - candidateStat.size,
      payloadSha256: originalPayloadSha256,
      compression: "gzip-9-n",
    };
  } finally {
    await Promise.all([
      rm(candidate, { force: true }),
      rm(tar, { force: true }),
    ]);
  }
}

export async function runCommand(command, args, { env = process.env } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr.length > 0 ? stderr : stdout)
        .toString("utf8")
        .trim();
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

export async function signUpdaterWithTauri(
  updaterPath,
  { commandRunner = runCommand, env = process.env } = {},
) {
  await commandRunner(
    "pnpm",
    ["tauri", "signer", "sign", path.resolve(updaterPath)],
    { env },
  );
}

export async function convertDmgToUdbz(
  dmgPath,
  { commandRunner = runCommand } = {},
) {
  const resolved = path.resolve(dmgPath);
  const originalStat = await requireRegularFile(resolved, "macOS DMG");
  const temporaryDirectory = path.join(
    path.dirname(resolved),
    `.artistic-git-udbz-${randomUUID()}`,
  );
  const candidateBase = path.join(temporaryDirectory, "candidate");
  const candidate = `${candidateBase}.dmg`;
  await mkdir(temporaryDirectory);
  try {
    await commandRunner("hdiutil", [
      "convert",
      resolved,
      "-format",
      "UDBZ",
      "-o",
      candidateBase,
    ]);
    const candidateStat = await requireRegularFile(
      candidate,
      "UDBZ DMG candidate",
    );
    await commandRunner("hdiutil", ["verify", candidate]);
    if (candidateStat.size > originalStat.size) {
      fail(
        `UDBZ DMG grew from ${originalStat.size} to ${candidateStat.size} bytes`,
      );
    }
    await chmod(candidate, originalStat.mode & 0o777);
    await rename(candidate, resolved);
    return {
      inputBytes: originalStat.size,
      outputBytes: candidateStat.size,
      savedBytes: originalStat.size - candidateStat.size,
      format: "UDBZ",
      verified: true,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function snapshotFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const fileStat = await requireRegularFile(resolved, label);
  const backup = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${randomUUID()}.rollback`,
  );
  await copyFile(resolved, backup);
  await chmod(backup, fileStat.mode & 0o777);
  return { backup, mode: fileStat.mode & 0o777, path: resolved };
}

async function restoreSnapshot(snapshot) {
  try {
    await rename(snapshot.backup, snapshot.path);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !["EACCES", "EEXIST", "EPERM"].includes(error?.code)
    ) {
      throw error;
    }
    await rm(snapshot.path, { force: true });
    await rename(snapshot.backup, snapshot.path);
  }
}

export async function optimizeMacosReleaseBundles({
  dmgPath,
  updaterPath,
  reportPath,
  convertDmg = convertDmgToUdbz,
  recompressUpdater = recompressUpdaterArchive,
  signUpdater = signUpdaterWithTauri,
}) {
  const resolvedReport = path.resolve(reportPath);
  const resolvedUpdater = path.resolve(updaterPath);
  const signaturePath = `${resolvedUpdater}.sig`;
  const reportCandidate = path.join(
    path.dirname(resolvedReport),
    `.${path.basename(resolvedReport)}.${randomUUID()}.candidate`,
  );
  const snapshots = [];
  const retainedBackups = new Set();

  try {
    snapshots.push(await snapshotFile(dmgPath, "macOS DMG"));
    snapshots.push(await snapshotFile(updaterPath, "macOS updater archive"));
    snapshots.push(
      await snapshotFile(signaturePath, "macOS updater signature"),
    );
    const dmg = await convertDmg(dmgPath);
    const updater = await recompressUpdater(updaterPath);
    await rm(signaturePath);
    await signUpdater(resolvedUpdater);
    const signatureStat = await requireRegularFile(
      signaturePath,
      "optimized macOS updater signature",
    );
    if (signatureStat.size === 0) {
      fail(`optimized macOS updater signature is empty: ${signaturePath}`);
    }
    const report = {
      schemaVersion: 1,
      platform: "macos",
      dmg,
      updater,
      signature: {
        bytes: signatureStat.size,
        path: path.basename(signaturePath),
      },
    };
    await writeFile(reportCandidate, `${JSON.stringify(report, null, 2)}\n`);
    await rename(reportCandidate, resolvedReport);
    return report;
  } catch (error) {
    const rollbackErrors = [];
    for (const snapshot of snapshots.reverse()) {
      try {
        await restoreSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        retainedBackups.add(snapshot.backup);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "macOS bundle optimization failed and rollback was incomplete",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await Promise.all([
      rm(reportCandidate, { force: true }),
      ...snapshots
        .filter(({ backup }) => !retainedBackups.has(backup))
        .map(({ backup }) => rm(backup, { force: true })),
    ]);
  }
}

function optionValue(args, index, name) {
  const argument = args[index];
  if (argument === name) {
    if (!args[index + 1]) fail(`${name} requires a value`);
    return { value: args[index + 1], consumed: 2 };
  }
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) fail(`${name} requires a value`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length;) {
    let parsed;
    if ((parsed = optionValue(args, index, "--dmg"))) {
      options.dmgPath = parsed.value;
    } else if ((parsed = optionValue(args, index, "--updater"))) {
      options.updaterPath = parsed.value;
    } else if ((parsed = optionValue(args, index, "--report"))) {
      options.reportPath = parsed.value;
    } else {
      fail(`unknown macOS bundle optimization argument: ${args[index]}`);
    }
    index += parsed.consumed;
  }
  for (const [key, option] of [
    ["dmgPath", "--dmg"],
    ["updaterPath", "--updater"],
    ["reportPath", "--report"],
  ]) {
    if (!options[key]) fail(`${option} is required`);
  }
  return options;
}

export async function runCli(args = process.argv.slice(2)) {
  if (process.platform !== "darwin") {
    fail("macOS release bundle optimization must run on macOS");
  }
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    fail("TAURI_SIGNING_PRIVATE_KEY is required to re-sign the macOS updater");
  }
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    fail(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required to re-sign the macOS updater",
    );
  }
  const report = await optimizeMacosReleaseBundles({
    ...parseArgs(args),
    signUpdater: (updaterPath) =>
      signUpdaterWithTauri(updaterPath, { env: process.env }),
  });
  console.log(
    `optimized macOS DMG by ${report.dmg.savedBytes} bytes and updater by ${report.updater.savedBytes} bytes`,
  );
  return report;
}

if (isMain) {
  await runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
