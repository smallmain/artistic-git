#!/usr/bin/env node
/* global console, process */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function validateUpdaterPublicKey(publicKey) {
  if (typeof publicKey !== "string" || publicKey.trim().length === 0) {
    throw new Error(
      "TAURI_UPDATER_PUBLIC_KEY must be configured before release packaging.",
    );
  }

  if (/REPLACE|TODO|PLACEHOLDER/i.test(publicKey)) {
    throw new Error(
      "TAURI_UPDATER_PUBLIC_KEY must be the generated Tauri updater public key, not a placeholder.",
    );
  }

  return publicKey.trim();
}

export async function applyUpdaterPublicKey({ configPath, publicKey }) {
  const normalizedPublicKey = validateUpdaterPublicKey(publicKey);
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  config.plugins ??= {};
  config.plugins.updater ??= {};
  config.plugins.updater.pubkey = normalizedPublicKey;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = [...argv];
  let configPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      configPath = path.resolve(args[index + 1] ?? "");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  TAURI_UPDATER_PUBLIC_KEY=<public-key> node scripts/apply-tauri-updater-public-key.mjs [--config src-tauri/tauri.conf.json]

Injects the generated Tauri updater public key into tauri.conf.json for release packaging.`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { configPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { configPath } = parseArgs(process.argv.slice(2));
    await applyUpdaterPublicKey({
      configPath,
      publicKey: process.env.TAURI_UPDATER_PUBLIC_KEY,
    });
    console.log("tauri updater public key injected.");
  } catch (error) {
    console.error(
      `tauri updater public key injection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
