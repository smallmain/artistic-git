import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedUrl, shouldIgnore } from "./check-privacy-network.mjs";

test("privacy audit excludes the generated embedded toolchain", () => {
  assert.equal(
    shouldIgnore("src-tauri/resources/git-dist/git-lfs/CHANGELOG.md"),
    true,
  );
  assert.equal(
    shouldIgnore("src-tauri/resources/git-dist/git-lfs/README.md"),
    true,
  );
});

test("privacy audit still scans owned Tauri resources and source", () => {
  assert.equal(
    shouldIgnore("src-tauri/resources/application-data.json"),
    false,
  );
  assert.equal(shouldIgnore("src-tauri/src/lib.rs"), false);
});

test("privacy audit permits only loopback literals used by local tests", () => {
  assert.equal(isAllowedUrl("http://127.0.0.1:3000/status"), true);
  assert.equal(isAllowedUrl("https://127.0.0.1:${port}/repo.git"), true);
  assert.equal(
    isAllowedUrl(["https:", "//127.0.0.2:3000/status"].join("")),
    false,
  );
  assert.equal(
    isAllowedUrl(["https:", "//example.com/status"].join("")),
    false,
  );
});
