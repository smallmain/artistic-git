import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyUpdaterPublicKey,
  validateUpdaterPublicKey,
} from "./apply-tauri-updater-public-key.mjs";

test("rejects missing and placeholder updater public keys", () => {
  assert.throws(
    () => validateUpdaterPublicKey(""),
    /TAURI_UPDATER_PUBLIC_KEY must be configured/,
  );
  assert.throws(
    () => validateUpdaterPublicKey("REPLACE_WITH_PUBLIC_KEY"),
    /not a placeholder/,
  );
});

test("writes the generated updater public key into tauri config", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-updater-pubkey-"));
  const configPath = path.join(tmpDir, "tauri.conf.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          updater: {
            endpoints: ["https://example.test/latest.json"],
            pubkey: "REPLACE_WITH_PUBLIC_KEY",
          },
        },
      },
      null,
      2,
    ),
  );

  await applyUpdaterPublicKey({
    configPath,
    publicKey: "generated-public-key",
  });

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.plugins.updater.pubkey, "generated-public-key");
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://example.test/latest.json",
  ]);
});
