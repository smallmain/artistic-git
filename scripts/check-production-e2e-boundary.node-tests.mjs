import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findProductionE2eMarkers } from "./check-production-e2e-boundary.mjs";

test("accepts a production frontend without E2E instrumentation", async (context) => {
  const root = await fixtureRoot(context);
  await writeFile(path.join(root, "index.html"), "<main>Artistic Git</main>");

  assert.deepEqual(await findProductionE2eMarkers(root), []);
});

test("reports E2E-only WDIO markers in nested production chunks", async (context) => {
  const root = await fixtureRoot(context);
  const assets = path.join(root, "assets");
  await mkdir(assets);
  const chunk = path.join(assets, "index.js");
  await writeFile(chunk, "window.wdioTauri = { execute() {} };\n");

  assert.deepEqual(await findProductionE2eMarkers(root), [
    { file: chunk, marker: "wdioTauri" },
  ]);
});

async function fixtureRoot(context) {
  const root = await mkdtemp(path.join(tmpdir(), "artistic-git-boundary-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}
