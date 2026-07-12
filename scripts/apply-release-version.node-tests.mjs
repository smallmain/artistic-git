import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyReleaseVersion,
  isDirectCliInvocation,
  releaseVersionManifests,
  replaceJsonVersionField,
  validateReleaseVersion,
} from "./apply-release-version.mjs";

test("rejects missing and invalid release versions", () => {
  assert.throws(() => validateReleaseVersion(""), /release version is required/);
  assert.throws(
    () => validateReleaseVersion("v0.2.2"),
    /invalid release version/,
  );
  assert.equal(validateReleaseVersion("0.2.2"), "0.2.2");

test("preserves surrounding JSON formatting when rewriting version", () => {
  const raw = `{
  "name": "artistic-git",
  "version": "0.1.0",
  "targets": ["app", "dmg"]
}
`;
  assert.equal(
    replaceJsonVersionField(raw, "0.2.2"),
    `{
  "name": "artistic-git",
  "version": "0.2.2",
  "targets": ["app", "dmg"]
}
`,
  );
});
});

test("writes the release version into package and cargo manifests", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-release-version-"));
  await mkdir(path.join(tmpDir, "src-tauri"), { recursive: true });
  await mkdir(path.join(tmpDir, "crates", "app"), { recursive: true });
  await writeFile(
    path.join(tmpDir, "package.json"),
    `${JSON.stringify({ name: "artistic-git", version: "0.1.0" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(tmpDir, "src-tauri", "tauri.conf.json"),
    `${JSON.stringify({ productName: "Artistic Git", version: "0.1.0" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(tmpDir, "src-tauri", "Cargo.toml"),
    `[package]\nname = "artistic-git-shell"\nversion = "0.1.0"\nedition = "2021"\n`,
  );
  await writeFile(
    path.join(tmpDir, "crates", "app", "Cargo.toml"),
    `[package]\nname = "artistic-git-app"\nversion = "0.1.0"\nedition = "2021"\n`,
  );

  const result = await applyReleaseVersion({
    version: "0.2.2",
    cwd: tmpDir,
  });

  assert.equal(result.version, "0.2.2");
  assert.deepEqual(
    result.files,
    releaseVersionManifests.map((item) => item.path),
  );
  assert.equal(
    JSON.parse(await readFile(path.join(tmpDir, "package.json"), "utf8"))
      .version,
    "0.2.2",
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(tmpDir, "src-tauri", "tauri.conf.json"), "utf8"),
    ).version,
    "0.2.2",
  );
  assert.match(
    await readFile(path.join(tmpDir, "src-tauri", "Cargo.toml"), "utf8"),
    /^version = "0\.2\.2"$/m,
  );
  assert.match(
    await readFile(path.join(tmpDir, "crates", "app", "Cargo.toml"), "utf8"),
    /^version = "0\.2\.2"$/m,
  );
});

test("detects direct CLI invocation with resolved filesystem paths", () => {
  const currentFile = fileURLToPath(import.meta.url);
  assert.equal(isDirectCliInvocation(import.meta.url, currentFile), true);
  assert.equal(
    isDirectCliInvocation(
      import.meta.url,
      path.join(path.dirname(currentFile), "other.mjs"),
    ),
    false,
  );
});
