#!/usr/bin/env node
/* global console, process */

import { loadToolchainDefinition } from "./git-toolchain-state.mjs";

try {
  const definition = await loadToolchainDefinition();
  console.log(
    `embedded toolchain config is locked at ${definition.revision} for ${Object.keys(definition.targetDefinitions).length} targets`,
  );
} catch (error) {
  console.error(`embedded toolchain config check failed: ${error.message}`);
  process.exitCode = 1;
}
