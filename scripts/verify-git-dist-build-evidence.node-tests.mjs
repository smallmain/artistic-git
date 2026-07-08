/* global process */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.join(
  import.meta.dirname,
  "verify-git-dist-build-evidence.mjs",
);
const target = "linux-x86_64";
const runId = "123456789";
const artifactName = `artistic-git-dist-${target}`;
const runtimeSmokeCommand = `node scripts/check-git-dist.mjs --target="${target}"`;

function cleanEnv() {
  const env = { ...process.env };
  delete env.ARTISTIC_GIT_DIST_ARTIFACT_NAME;
  delete env.ARTISTIC_GIT_DIST_BUILD_EVIDENCE;
  delete env.ARTISTIC_GIT_DIST_RUN_ID;
  delete env.ARTISTIC_GIT_DIST_TARGET;
  return env;
}

function buildEvidence({
  artifactIndexProduced = true,
  artifactNameValue = artifactName,
  reusableArtifactProduced = true,
  runIdValue = runId,
  targetName = target,
  validationCommands = [runtimeSmokeCommand],
} = {}) {
  return {
    workflowBuild: {
      run: {
        runId: runIdValue,
      },
      mode: "build",
      target: {
        name: targetName,
        artifactName: artifactNameValue,
        blocked: false,
        status: "ready",
      },
      validationSummary: {
        reusableArtifactProduced,
        status: "validated-fresh-build",
        commands: validationCommands,
      },
      artifactIndex: [
        {
          kind: "reusable-git-dist",
          name: artifactNameValue,
          produced: artifactIndexProduced,
        },
      ],
    },
  };
}

async function runVerifier(evidence, options = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ag-git-dist-build-"));

  try {
    const evidencePath = path.join(tmpDir, "git-dist-build-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    return spawnSync(
      process.execPath,
      [
        scriptPath,
        `--evidence=${evidencePath}`,
        `--target=${options.expectedTarget ?? target}`,
        `--run-id=${options.expectedRunId ?? runId}`,
      ],
      {
        encoding: "utf8",
        env: cleanEnv(),
      },
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
}

async function assertVerifierFails(evidence, expectedMessage, options = {}) {
  const result = await runVerifier(evidence, options);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, expectedMessage);
}

test("verifies target, run id, produced artifact, and runtime smoke evidence", async () => {
  const result = await runVerifier(buildEvidence());

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /git-dist build evidence verified: artistic-git-dist-linux-x86_64 from run 123456789/,
  );
});

test("rejects evidence for a different target", async () => {
  await assertVerifierFails(
    buildEvidence({ targetName: "darwin-aarch64" }),
    /workflowBuild\.target\.name mismatch: expected linux-x86_64, got darwin-aarch64/,
  );
});

test("rejects evidence for a different run id", async () => {
  await assertVerifierFails(
    buildEvidence({ runIdValue: "987654321" }),
    /workflowBuild\.run\.runId mismatch: expected 123456789, got 987654321/,
  );
});

test("rejects reusable artifact evidence that was not produced", async () => {
  await assertVerifierFails(
    buildEvidence({ artifactIndexProduced: false }),
    /reusable git-dist artifact was not produced/,
  );
});

test("rejects validation summaries without a produced reusable artifact", async () => {
  await assertVerifierFails(
    buildEvidence({ reusableArtifactProduced: false }),
    /workflowBuild\.validationSummary\.reusableArtifactProduced must be true/,
  );
});

test("rejects evidence without a non --no-exec runtime smoke command", async () => {
  await assertVerifierFails(
    buildEvidence({
      validationCommands: [`${runtimeSmokeCommand} --no-exec`],
    }),
    /build evidence does not record target runtime validation/,
  );
});
