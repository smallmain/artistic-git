import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { helperCargoBuildArgs } from "./build-git-toolchain-helpers.mjs";
import { loadGitDistConfig } from "./git-dist-lib.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("helper builds use the fixed size-optimized Cargo profile", async () => {
  const { data: config } = await loadGitDistConfig();
  assert.equal(config.helpers.profile, "git-toolchain-helper");
  assert.deepEqual(
    helperCargoBuildArgs({
      profile: config.helpers.profile,
      rustToolchain: config.helpers.rust_toolchain,
      triple: "x86_64-pc-windows-msvc",
    }),
    [
      "+1.96.1",
      "build",
      "--locked",
      "-p",
      "artistic-git-helpers",
      "--bins",
      "--profile",
      "git-toolchain-helper",
      "--target",
      "x86_64-pc-windows-msvc",
    ],
  );

  const cargoToml = await readFile(path.join(repoRoot, "Cargo.toml"), "utf8");
  assert.match(cargoToml, /\[profile\.git-toolchain-helper\]/);
  assert.match(cargoToml, /inherits = "release"/);
  assert.match(cargoToml, /lto = "fat"/);
  assert.match(cargoToml, /opt-level = "z"/);
});

test("helper Cargo arguments fail closed for incomplete build inputs", () => {
  for (const key of ["profile", "rustToolchain", "triple"]) {
    const input = {
      profile: "git-toolchain-helper",
      rustToolchain: "1.96.1",
      triple: "aarch64-apple-darwin",
      [key]: "",
    };
    assert.throws(() => helperCargoBuildArgs(input), new RegExp(key));
  }
});
