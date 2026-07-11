#!/usr/bin/env node
/* global console, process */

import {
  createToolchainLock,
  writeToolchainLock,
} from "./git-toolchain-state.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const revisionArg = args.find((arg) => arg.startsWith("--revision="));
const unknown = args.filter((arg) => !arg.startsWith("--revision="));
if (unknown.length > 0 || !revisionArg) {
  console.error(
    "usage: pnpm git-toolchain:update -- --revision=<new-revision>",
  );
  process.exit(1);
}

const revision = revisionArg.slice("--revision=".length).trim();
if (!revision) {
  console.error("toolchain revision must not be empty");
  process.exit(1);
}

try {
  const lock = await createToolchainLock(revision);
  await writeToolchainLock(lock);
  console.log(`locked embedded toolchain revision ${revision}`);
} catch (error) {
  console.error(`embedded toolchain update failed: ${error.message}`);
  process.exitCode = 1;
}
