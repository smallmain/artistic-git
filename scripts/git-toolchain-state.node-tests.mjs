import assert from "node:assert/strict";
import test from "node:test";

import {
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
