import assert from "node:assert/strict";
import test from "node:test";

import {
  computeToolchainCacheKeys,
  normalizeFingerprintPath,
  sha256Canonical,
  sha256FingerprintText,
} from "./git-toolchain-state.mjs";

test("fingerprint paths use the same representation on Windows and POSIX", () => {
  const posixPath = normalizeFingerprintPath(
    "scripts/build-git-toolchain-helpers.mjs",
  );
  const windowsPath = normalizeFingerprintPath(
    "scripts\\build-git-toolchain-helpers.mjs",
  );

  assert.equal(windowsPath, posixPath);
  assert.equal(windowsPath, "scripts/build-git-toolchain-helpers.mjs");
  assert.equal(
    sha256Canonical({ builderFiles: { [windowsPath]: "checksum" } }),
    sha256Canonical({ builderFiles: { [posixPath]: "checksum" } }),
  );
});

test("fingerprint text hashes are independent of checkout line endings", () => {
  const lf = "first line\nsecond line\n";
  const crlf = "first line\r\nsecond line\r\n";

  assert.equal(sha256FingerprintText(crlf), sha256FingerprintText(lf));
});

test("base and helper caches have independent exact keys", () => {
  const initial = computeToolchainCacheKeys({
    target: "linux-x86_64",
    baseFingerprint: "base-a",
    helperFingerprint: "helper-a",
  });
  const helperChanged = computeToolchainCacheKeys({
    target: "linux-x86_64",
    baseFingerprint: "base-a",
    helperFingerprint: "helper-b",
  });
  const baseChanged = computeToolchainCacheKeys({
    target: "linux-x86_64",
    baseFingerprint: "base-b",
    helperFingerprint: "helper-a",
  });

  assert.equal(initial.baseKey, helperChanged.baseKey);
  assert.notEqual(initial.helperKey, helperChanged.helperKey);
  assert.notEqual(initial.baseKey, baseChanged.baseKey);
  assert.equal(initial.helperKey, baseChanged.helperKey);
});
