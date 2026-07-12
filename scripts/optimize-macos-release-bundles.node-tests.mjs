import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  convertDmgToUdbz,
  gzipTarWithSystemGzip,
  optimizeMacosReleaseBundles,
  parseArgs,
  recompressUpdaterArchive,
  signUpdaterWithTauri,
} from "./optimize-macos-release-bundles.mjs";

test("gzip-9 updater recompression preserves the exact tar stream", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-macos-updater-"));
  try {
    const updater = path.join(root, "Artistic Git.app.tar.gz");
    const payload = Buffer.from("repeated updater payload\n".repeat(100_000));
    await writeFile(updater, gzipSync(payload, { level: 1 }));
    const result = await recompressUpdaterArchive(updater, {
      compressTar: async (tarPath, candidatePath) => {
        await writeFile(
          candidatePath,
          gzipSync(await readFile(tarPath), { level: 9 }),
        );
      },
    });

    assert.ok(result.savedBytes > 0);
    assert.equal(result.outputBytes, (await stat(updater)).size);
    assert.equal(result.compression, "gzip-9-n");
    assert.equal(
      result.payloadSha256,
      createHash("sha256").update(payload).digest("hex"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("system gzip compressor pins maximum deterministic compression", async () => {
  const calls = [];
  await gzipTarWithSystemGzip("fixture.tar", "fixture.tar.gz", {
    commandRunner: async (command, args, outputPath) => {
      calls.push({ command, args, outputPath });
    },
  });
  assert.deepEqual(calls, [
    {
      command: "gzip",
      args: ["-9", "-n", "-c", path.resolve("fixture.tar")],
      outputPath: path.resolve("fixture.tar.gz"),
    },
  ]);
});

test("Tauri signer targets the optimized updater with the provided environment", async () => {
  const calls = [];
  const env = { TAURI_SIGNING_PRIVATE_KEY: "fixture" };
  await signUpdaterWithTauri("fixture.tar.gz", {
    env,
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
    },
  });
  assert.deepEqual(calls, [
    {
      command: "pnpm",
      args: ["tauri", "signer", "sign", path.resolve("fixture.tar.gz")],
      options: { env },
    },
  ]);
});

test("UDBZ conversion verifies the candidate before atomically replacing the DMG", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-macos-dmg-"));
  try {
    const dmg = path.join(root, "Artistic Git.dmg");
    await writeFile(dmg, Buffer.alloc(100, 1));
    const calls = [];
    const result = await convertDmgToUdbz(dmg, {
      commandRunner: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "convert") {
          const outputBase = args.at(-1);
          await writeFile(`${outputBase}.dmg`, Buffer.alloc(40, 2));
        }
      },
    });

    assert.equal(result.savedBytes, 60);
    assert.equal(result.verified, true);
    assert.equal((await readFile(dmg)).equals(Buffer.alloc(40, 2)), true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 2), ["hdiutil", "convert"]);
    assert.deepEqual(calls[1].slice(0, 2), ["hdiutil", "verify"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optimizer writes evidence only after both bundle transforms succeed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-macos-optimize-"));
  try {
    const dmgPath = path.join(root, "fixture.dmg");
    const updaterPath = path.join(root, "fixture.tar.gz");
    const signaturePath = `${updaterPath}.sig`;
    const reportPath = path.join(root, "macos-bundle-optimization.json");
    await writeFile(dmgPath, "original dmg");
    await writeFile(updaterPath, "original updater");
    await writeFile(signaturePath, "original signature");
    const calls = [];
    const report = await optimizeMacosReleaseBundles({
      dmgPath,
      updaterPath,
      reportPath,
      convertDmg: async (filePath) => {
        calls.push("dmg");
        await writeFile(filePath, "optimized dmg");
        return { savedBytes: 10, verified: true };
      },
      recompressUpdater: async (filePath) => {
        calls.push("updater");
        await writeFile(filePath, "optimized updater");
        return { savedBytes: 5, payloadSha256: "fixture" };
      },
      signUpdater: async () => {
        calls.push("sign");
        await writeFile(signaturePath, "optimized signature");
      },
    });
    assert.deepEqual(calls, ["dmg", "updater", "sign"]);
    assert.equal(report.dmg.savedBytes, 10);
    assert.equal(report.signature.bytes, 19);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
    assert.equal(await readFile(dmgPath, "utf8"), "optimized dmg");
    assert.equal(await readFile(updaterPath, "utf8"), "optimized updater");
    assert.equal(await readFile(signaturePath, "utf8"), "optimized signature");

    const missingReport = path.join(root, "missing", "report.json");
    await writeFile(dmgPath, "original dmg");
    await writeFile(updaterPath, "original updater");
    await writeFile(signaturePath, "original signature");
    await assert.rejects(
      optimizeMacosReleaseBundles({
        dmgPath,
        updaterPath,
        reportPath: missingReport,
        convertDmg: async (filePath) => {
          await writeFile(filePath, "optimized dmg");
          return { savedBytes: 10 };
        },
        recompressUpdater: async (filePath) => {
          await writeFile(filePath, "optimized updater");
          return { savedBytes: 5 };
        },
        signUpdater: async () => {
          await writeFile(signaturePath, "optimized signature");
        },
      }),
      /ENOENT/,
    );
    assert.equal(await readFile(dmgPath, "utf8"), "original dmg");
    assert.equal(await readFile(updaterPath, "utf8"), "original updater");
    assert.equal(await readFile(signaturePath, "utf8"), "original signature");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI parser exposes no format, verification, or signing bypass", () => {
  assert.deepEqual(
    parseArgs([
      "--dmg=fixture.dmg",
      "--updater",
      "fixture.tar.gz",
      "--report=report.json",
    ]),
    {
      dmgPath: "fixture.dmg",
      updaterPath: "fixture.tar.gz",
      reportPath: "report.json",
    },
  );
  for (const bypass of ["--skip-verify", "--format=UDZO", "--skip-sign"]) {
    assert.throws(
      () =>
        parseArgs([
          "--dmg=fixture.dmg",
          "--updater=fixture.tar.gz",
          "--report=report.json",
          bypass,
        ]),
      /unknown macOS bundle optimization argument/,
    );
  }
});
