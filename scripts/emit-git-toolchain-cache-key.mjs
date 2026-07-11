#!/usr/bin/env node
/* global console, process */

import { appendFile } from "node:fs/promises";

import {
  computeToolchainCacheKeys,
  computeToolchainState,
  normalizeTarget,
} from "./git-toolchain-state.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const targetArg = args.find((arg) => arg.startsWith("--target="));
const unknown = args.filter((arg) => !arg.startsWith("--target="));
if (unknown.length > 0) {
  throw new Error(`unknown cache-key argument: ${unknown[0]}`);
}

const state = await computeToolchainState(
  normalizeTarget(targetArg?.slice("--target=".length)),
);
const { baseKey, helperKey } = computeToolchainCacheKeys(state);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `base-key=${baseKey}`,
      `helper-key=${helperKey}`,
      `base-fingerprint=${state.baseFingerprint}`,
      `helper-fingerprint=${state.helperFingerprint}`,
      "",
    ].join("\n"),
  );
}
console.log(`${baseKey}\n${helperKey}`);
