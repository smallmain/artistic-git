import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("phase 9 crash isolation audit writes machine-readable gaps and gates", () => {
  const reportPath = path.join(
    mkdtempSync(path.join(tmpdir(), "phase9-crash-audit-")),
    "report.json",
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/check-phase9-crash-isolation-audit.mjs"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ARTISTIC_GIT_PHASE9_CRASH_ISOLATION_AUDIT_REPORT: reportPath,
      },
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.kind, "phase9-crash-isolation");
  assert.equal(report.result, "static-pass");
  assert.equal(report.taskCheckable, false);

  assert.ok(
    report.gaps.some(
      (gap) =>
        gap.id === "windows-native-webview-crash-detection" &&
        gap.status === "unsupported",
    ),
  );
  assert.ok(
    report.gaps.some(
      (gap) =>
        gap.id === "linux-native-webview-crash-detection" &&
        gap.status === "unsupported",
    ),
  );
  assert.ok(
    report.gates.some(
      (gate) =>
        gate.id === "tauri-driver-injection-gate" && gate.status === "pass",
    ),
  );
});
