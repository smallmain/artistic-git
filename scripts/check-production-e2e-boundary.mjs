/* global console, process */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const forbiddenMarkers = [
  "wdioTauri",
  "__wdio_mocks__",
  "plugin:wdio",
  "wdio:default",
];
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map"]);

export async function findProductionE2eMarkers(root) {
  const matches = [];
  for (const file of await listTextFiles(root)) {
    const source = await readFile(file, "utf8");
    for (const marker of forbiddenMarkers) {
      if (source.includes(marker)) {
        matches.push({ file, marker });
      }
    }
  }
  return matches;
}

async function listTextFiles(root) {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTextFiles(entryPath)));
    } else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function main() {
  const root = path.resolve(process.argv[2] ?? "dist");
  const matches = await findProductionE2eMarkers(root);
  if (matches.length > 0) {
    for (const match of matches) {
      console.error(
        `${path.relative(process.cwd(), match.file)}: ${match.marker}`,
      );
    }
    throw new Error(
      "production frontend contains E2E-only WDIO instrumentation",
    );
  }
  console.log(`production E2E boundary passed: ${root}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
