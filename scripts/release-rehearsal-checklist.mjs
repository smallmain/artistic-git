#!/usr/bin/env node
/* global URL, console, process */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const fromVersion = "0.1.0";
const toVersion = "0.1.1";
const fromTag = `v${fromVersion}`;
const toTag = `v${toVersion}`;
const githubEvidenceBaseUrl = "https://github.com/smallmain/artistic-git";
const githubEvidenceRepository = new URL(
  githubEvidenceBaseUrl,
).pathname.replace(/^\/|\/$/g, "");
const dryRun = process.env.ARTISTIC_GIT_RELEASE_REHEARSAL_DRY_RUN !== "0";
const reportDir =
  process.env.ARTISTIC_GIT_RELEASE_REHEARSAL_REPORT_DIR ??
  (process.env.CI ? path.join("artifacts", "release-rehearsal") : null);

const platforms = [
  {
    id: "macos",
    label: "macOS",
    envPrefix: "MACOS",
    target: "macOS 13+",
  },
  {
    id: "windows",
    label: "Windows",
    envPrefix: "WINDOWS",
    target: "Windows 10 1809+",
  },
  {
    id: "linux",
    label: "Linux",
    envPrefix: "LINUX",
    target: "Linux AppImage/deb target",
  },
];

const requiredSecrets = [
  {
    name: "TAURI_SIGNING_PRIVATE_KEY",
    description: "Tauri updater signing private key used by release packages.",
  },
  {
    name: "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    description: "Password for the Tauri updater signing private key.",
  },
  {
    name: "GH_TOKEN",
    description: "GitHub token available to the release workflow publish step.",
  },
];

const requiredConfiguration = [
  {
    name: "TAURI_UPDATER_PUBLIC_KEY",
    description:
      "Updater public key configured in GitHub Variables or Secrets before publishing.",
  },
];

const operatorMarkers = [
  {
    name: "ARTISTIC_GIT_RELEASE_REHEARSAL_OPERATOR_CONFIRMED",
    expectedValue: "1",
    description:
      "Operator confirms the evidence markers come from a real protected release rehearsal, not from local placeholders.",
  },
  {
    name: "ARTISTIC_GIT_RELEASE_PROTECTED_ENVIRONMENT_APPROVED",
    expectedValue: "1",
    description:
      "GitHub release environment approval was granted for package and publish jobs.",
  },
];

const githubUrlEvidence = [
  {
    name: "ARTISTIC_GIT_RELEASE_010_RUN_URL",
    description: "0.1.0 Release workflow run URL.",
    kind: "actions-run-url",
    version: fromVersion,
    expectedTag: fromTag,
  },
  {
    name: "ARTISTIC_GIT_RELEASE_010_ARTIFACT_URL",
    description: "0.1.0 release artifact or release asset URL.",
    kind: "artifact-or-release-asset-url",
    version: fromVersion,
    expectedTag: fromTag,
  },
  {
    name: "ARTISTIC_GIT_RELEASE_010_RELEASE_URL",
    description: "0.1.0 GitHub Release URL.",
    kind: "release-url",
    version: fromVersion,
    expectedTag: fromTag,
  },
  {
    name: "ARTISTIC_GIT_RELEASE_011_RUN_URL",
    description: "0.1.1 Release workflow run URL used for updater rehearsal.",
    kind: "actions-run-url",
    version: toVersion,
    expectedTag: toTag,
  },
  {
    name: "ARTISTIC_GIT_RELEASE_011_ARTIFACT_URL",
    description: "0.1.1 release artifact or release asset URL.",
    kind: "artifact-or-release-asset-url",
    version: toVersion,
    expectedTag: toTag,
  },
  {
    name: "ARTISTIC_GIT_RELEASE_011_RELEASE_URL",
    description: "0.1.1 GitHub Release URL observed by updater clients.",
    kind: "release-url",
    version: toVersion,
    expectedTag: toTag,
  },
];

const installSmokeMarkers = platforms.map((platform) => ({
  name: `ARTISTIC_GIT_RELEASE_${platform.envPrefix}_INSTALL_OK`,
  expectedValue: "1",
  platform: platform.id,
  description: `${platform.label} ${fromVersion} install smoke passed on ${platform.target}.`,
}));

const updateMarkers = platforms.map((platform) => ({
  name: `ARTISTIC_GIT_RELEASE_${platform.envPrefix}_UPDATE_011_OK`,
  expectedValue: "1",
  platform: platform.id,
  description: `${platform.label} updater rehearsal passed from ${fromVersion} to ${toVersion}.`,
}));

const updateRecordJsonSchema = buildUpdateRecordSchema();
const updateRecordExample = buildUpdateRecordExample();

const secretChecks = requiredSecrets.map((item) => ({
  ...item,
  present: hasEnv(item.name),
}));
const configurationChecks = requiredConfiguration.map((item) => ({
  ...item,
  present: hasEnv(item.name),
}));
const operatorMarkerChecks = operatorMarkers.map(checkMarker);
const urlChecks = githubUrlEvidence.map(checkGithubUrlEvidence);
const installChecks = installSmokeMarkers.map(checkMarker);
const updateChecks = updateMarkers.map(checkMarker);
const updateRecord = readUpdateRecord();

const missingSecrets = secretChecks
  .filter((item) => !item.present)
  .map((item) => item.name);
const missingConfiguration = configurationChecks
  .filter((item) => !item.present)
  .map((item) => item.name);
const missingOperatorMarkers = operatorMarkerChecks
  .filter((item) => item.status !== "pass")
  .map((item) => item.name);
const missingOrInvalidUrls = urlChecks
  .filter((item) => item.status !== "pass")
  .map((item) => item.name);
const missingInstallEvidence = installChecks
  .filter((item) => item.status !== "pass")
  .map((item) => item.name);
const missingUpdateEvidence = updateChecks
  .filter((item) => item.status !== "pass")
  .map((item) => item.name);
const updateRecordEvidenceName =
  "ARTISTIC_GIT_RELEASE_UPDATE_REHEARSAL_RECORD_JSON or ARTISTIC_GIT_RELEASE_UPDATE_REHEARSAL_RECORD_FILE";

const missingEvidence = [
  ...missingOperatorMarkers,
  ...missingOrInvalidUrls,
  ...missingInstallEvidence,
  ...missingUpdateEvidence,
  ...(updateRecord.status === "pass" ? [] : [updateRecordEvidenceName]),
];

const operatorBlockers = [
  ...missingSecrets.map((name) => blocker("missing-secret", name)),
  ...missingConfiguration.map((name) => blocker("missing-configuration", name)),
  ...operatorMarkerChecks
    .filter((item) => item.status !== "pass")
    .map((item) => blocker("missing-operator-marker", item.name, item.reason)),
  ...urlChecks
    .filter((item) => item.status !== "pass")
    .map((item) => blocker("invalid-github-url", item.name, item.reason)),
  ...installChecks
    .filter((item) => item.status !== "pass")
    .map((item) => blocker("missing-install-smoke", item.name, item.reason)),
  ...updateChecks
    .filter((item) => item.status !== "pass")
    .map((item) => blocker("missing-update-rehearsal", item.name, item.reason)),
  ...(updateRecord.status === "pass"
    ? []
    : [
        blocker(
          "invalid-update-record",
          updateRecordEvidenceName,
          updateRecord.reason,
        ),
      ]),
];

const status = dryRun
  ? "skipped"
  : operatorBlockers.length > 0
    ? "blocker"
    : "pass";

const rehearsal = {
  schemaVersion: 2,
  kind: "release-rehearsal-checklist",
  generatedAt: new Date().toISOString(),
  mode: dryRun ? "dry-run checklist" : "operator-confirmed rehearsal",
  dryRun,
  status,
  result: status,
  release: {
    fromVersion,
    toVersion,
    fromTag,
    toTag,
  },
  ciDryRunArtifact: {
    expectedArtifactName:
      process.env.ARTISTIC_GIT_RELEASE_REHEARSAL_ARTIFACT_NAME ?? null,
    workflowRunUrl: process.env.ARTISTIC_GIT_RELEASE_WORKFLOW_RUN_URL ?? null,
    workflowRunUrlValid: process.env.ARTISTIC_GIT_RELEASE_WORKFLOW_RUN_URL
      ? validateGithubUrl(
          process.env.ARTISTIC_GIT_RELEASE_WORKFLOW_RUN_URL,
          "actions-run-url",
        ).valid
      : false,
    workflowAttempt: process.env.ARTISTIC_GIT_RELEASE_WORKFLOW_ATTEMPT ?? null,
    workflowSha:
      process.env.ARTISTIC_GIT_RELEASE_WORKFLOW_SHA ??
      process.env.GITHUB_SHA ??
      null,
    plannedVersion: process.env.ARTISTIC_GIT_RELEASE_PLAN_VERSION ?? null,
    plannedTag: process.env.ARTISTIC_GIT_RELEASE_PLAN_TAG ?? null,
    releaseModeReason: process.env.ARTISTIC_GIT_RELEASE_MODE_REASON ?? null,
  },
  requiredSecrets: secretChecks,
  missingSecrets,
  requiredConfiguration: configurationChecks,
  missingConfiguration,
  operatorConfirmation: {
    requiredMarkers: operatorMarkerChecks,
    missingMarkers: missingOperatorMarkers,
  },
  githubUrlEvidence: {
    requiredUrls: urlChecks,
    missingOrInvalidUrls,
  },
  platformInstallSmoke: installChecks,
  updateRehearsal: {
    fromVersion,
    toVersion,
    requiredMarkers: updateChecks,
    missingMarkers: missingUpdateEvidence,
    record: updateRecord,
    recordSchema: updateRecordJsonSchema,
    recordExample: updateRecordExample,
  },
  missingEvidence,
  skips: dryRun
    ? [
        {
          id: "dry-run",
          message:
            "Dry-run checklist artifact generated; signed release, protected environment approval, installation, and updater rehearsal were not executed.",
        },
      ]
    : [],
  blockers:
    status === "pass"
      ? []
      : [
          ...(dryRun
            ? [
                {
                  id: "formal-rehearsal-not-run",
                  message:
                    "This run is not operator-confirmed evidence and cannot check the TASKS.md release rehearsal item.",
                },
              ]
            : []),
          ...operatorBlockers,
        ],
  taskCheckbox:
    status === "pass"
      ? "eligible-after-artifact-review"
      : "must-remain-unchecked",
  cannotCheckTask:
    status !== "pass"
      ? "TASKS.md release rehearsal remains unchecked until signed artifacts are built, approved through the release environment, installed, and update-tested from 0.1.0 to 0.1.1 on macOS, Windows, and Linux with valid GitHub evidence URLs."
      : null,
};

const markdown = renderMarkdown(rehearsal);

console.log(markdown);
writeReports(markdown, rehearsal);

if (status === "blocker") {
  throw new Error(
    `Cannot mark operator-confirmed rehearsal: ${operatorBlockers
      .map((item) => item.name)
      .join(", ")}.`,
  );
}

function hasEnv(name) {
  return Boolean(process.env[name]);
}

function checkMarker(item) {
  const rawValue = process.env[item.name] ?? "";
  const present = rawValue.length > 0;
  const status = rawValue === item.expectedValue ? "pass" : "missing";
  return {
    ...item,
    expectedValue: item.expectedValue,
    present,
    status,
    value: present ? "provided" : "missing",
    reason:
      status === "pass"
        ? null
        : `${item.name} must be set to ${item.expectedValue}.`,
  };
}

function checkGithubUrlEvidence(item) {
  const rawValue = process.env[item.name] ?? "";
  const present = rawValue.length > 0;
  if (!present) {
    return {
      ...item,
      present,
      status: "missing",
      value: "missing",
      normalizedUrl: null,
      reason: `${item.name} is required and must be a GitHub ${item.kind}.`,
    };
  }

  const validation = validateGithubUrl(rawValue, item.kind, item.expectedTag);
  return {
    ...item,
    present,
    status: validation.valid ? "pass" : "invalid",
    value: "provided",
    normalizedUrl: validation.normalizedUrl,
    reason: validation.valid ? null : validation.reason,
  };
}

function validateGithubUrl(rawValue, kind, expectedTag = null) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    return {
      valid: false,
      normalizedUrl: null,
      reason: "URL is not parseable.",
    };
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    return {
      valid: false,
      normalizedUrl: parsed.href,
      reason: "URL must use the GitHub HTTPS host.",
    };
  }

  const pathName = parsed.pathname.replace(/\/+$/, "");
  if (!pathName.startsWith(`/${githubEvidenceRepository}/`)) {
    return {
      valid: false,
      normalizedUrl: parsed.href,
      reason: `URL must belong to ${githubEvidenceRepository}.`,
    };
  }

  const escapedTag = expectedTag?.replaceAll(".", "\\.");
  const checks = {
    "actions-run-url": /^\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/.*)?$/,
    "artifact-or-release-asset-url": new RegExp(
      `^(?:/[^/]+/[^/]+/actions/runs/\\d+/artifacts/\\d+(?:/.*)?|/[^/]+/[^/]+/releases/download/${escapedTag ?? "v\\d+\\.\\d+\\.\\d+"}/[^/]+)$`,
    ),
    "release-url": new RegExp(
      `^/[^/]+/[^/]+/releases/tag/${escapedTag ?? "v\\d+\\.\\d+\\.\\d+"}$`,
    ),
    "github-evidence-url": /^\/[^/]+\/[^/]+\/(?:actions|releases)\/.+$/,
  };
  const pattern = checks[kind];

  if (!pattern?.test(pathName)) {
    return {
      valid: false,
      normalizedUrl: parsed.href,
      reason: expectedTag
        ? `URL must be a GitHub ${kind} for ${expectedTag}.`
        : `URL must be a GitHub ${kind}.`,
    };
  }

  return {
    valid: true,
    normalizedUrl: parsed.href,
    reason: null,
  };
}

function readUpdateRecord() {
  const filePath =
    process.env.ARTISTIC_GIT_RELEASE_UPDATE_REHEARSAL_RECORD_FILE;
  const inlineJson =
    process.env.ARTISTIC_GIT_RELEASE_UPDATE_REHEARSAL_RECORD_JSON;

  if (!filePath && !inlineJson) {
    return {
      source: null,
      present: false,
      status: "missing",
      reason:
        "Provide ARTISTIC_GIT_RELEASE_UPDATE_REHEARSAL_RECORD_JSON or ARTISTIC_GIT_RELEASE_UPDATE_REHEARSAL_RECORD_FILE with the 0.1.0 to 0.1.1 update record.",
      validationErrors: ["update rehearsal record is missing"],
      value: null,
    };
  }

  if (filePath && !existsSync(filePath)) {
    return {
      source: "file",
      filePath,
      present: false,
      status: "invalid",
      reason: `Update rehearsal record file does not exist: ${filePath}`,
      validationErrors: [`record file does not exist: ${filePath}`],
      value: null,
    };
  }

  const source = filePath ? "file" : "inline-json";
  const raw = filePath ? readFileSync(filePath, "utf8") : inlineJson;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      source,
      filePath: filePath ?? null,
      present: true,
      status: "invalid",
      reason: `Update rehearsal record JSON is invalid: ${message}`,
      validationErrors: [message],
      value: null,
    };
  }

  const validationErrors = validateUpdateRecord(parsed);
  return {
    source,
    filePath: filePath ?? null,
    present: true,
    status: validationErrors.length === 0 ? "pass" : "invalid",
    reason:
      validationErrors.length === 0
        ? null
        : `Update rehearsal record failed schema validation: ${validationErrors.join("; ")}`,
    validationErrors,
    value: parsed,
  };
}

function validateUpdateRecord(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["record must be a JSON object"];
  }
  if (value.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (value.fromVersion !== fromVersion) {
    errors.push(`fromVersion must be ${fromVersion}`);
  }
  if (value.toVersion !== toVersion) {
    errors.push(`toVersion must be ${toVersion}`);
  }
  if (!Array.isArray(value.platformRecords)) {
    errors.push("platformRecords must be an array");
    return errors;
  }

  for (const platform of platforms) {
    const record = value.platformRecords.find(
      (item) => item?.platform === platform.id,
    );
    if (!record) {
      errors.push(`platformRecords must include ${platform.id}`);
      continue;
    }
    expectEqual(
      errors,
      record.installedVersionBefore,
      fromVersion,
      `${platform.id}.installedVersionBefore`,
    );
    expectEqual(
      errors,
      record.discoveredVersion,
      toVersion,
      `${platform.id}.discoveredVersion`,
    );
    expectEqual(
      errors,
      record.installedVersionAfter,
      toVersion,
      `${platform.id}.installedVersionAfter`,
    );
    expectEqual(
      errors,
      record.installSmokePassed,
      true,
      `${platform.id}.installSmokePassed`,
    );
    expectEqual(
      errors,
      record.updateDownloaded,
      true,
      `${platform.id}.updateDownloaded`,
    );
    expectEqual(
      errors,
      record.restartGateVerified,
      true,
      `${platform.id}.restartGateVerified`,
    );
    expectEqual(
      errors,
      record.postUpdateSmokePassed,
      true,
      `${platform.id}.postUpdateSmokePassed`,
    );
    if (
      typeof record.operator !== "string" ||
      record.operator.trim().length === 0
    ) {
      errors.push(`${platform.id}.operator must be a non-empty string`);
    }
    if (Number.isNaN(Date.parse(record.recordedAt))) {
      errors.push(`${platform.id}.recordedAt must be an ISO timestamp`);
    }
    const evidenceUrl = validateGithubUrl(
      record.evidenceUrl,
      "github-evidence-url",
    );
    if (!evidenceUrl.valid) {
      errors.push(`${platform.id}.evidenceUrl ${evidenceUrl.reason}`);
    }
  }

  return errors;
}

function expectEqual(errors, actual, expected, label) {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}`);
  }
}

function blocker(id, name, message = null) {
  return {
    id,
    name,
    message:
      message ??
      `${name} is required before the TASKS.md release rehearsal checkbox can be checked.`,
  };
}

function buildUpdateRecordSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Artistic Git 0.1.0 to 0.1.1 update rehearsal record",
    type: "object",
    required: ["schemaVersion", "fromVersion", "toVersion", "platformRecords"],
    properties: {
      schemaVersion: { const: 1 },
      fromVersion: { const: fromVersion },
      toVersion: { const: toVersion },
      platformRecords: {
        type: "array",
        minItems: platforms.length,
        items: {
          type: "object",
          required: [
            "platform",
            "installedVersionBefore",
            "discoveredVersion",
            "installedVersionAfter",
            "installSmokePassed",
            "updateDownloaded",
            "restartGateVerified",
            "postUpdateSmokePassed",
            "evidenceUrl",
            "recordedAt",
            "operator",
          ],
          properties: {
            platform: { enum: platforms.map((platform) => platform.id) },
            installedVersionBefore: { const: fromVersion },
            discoveredVersion: { const: toVersion },
            installedVersionAfter: { const: toVersion },
            installSmokePassed: { const: true },
            updateDownloaded: { const: true },
            restartGateVerified: { const: true },
            postUpdateSmokePassed: { const: true },
            evidenceUrl: {
              type: "string",
              pattern: "^https:\\/\\/github\\.com/.+/(actions|releases)/.+",
            },
            recordedAt: { type: "string", format: "date-time" },
            operator: { type: "string", minLength: 1 },
            rollbackNotes: { type: "string" },
          },
        },
      },
    },
  };
}

function buildUpdateRecordExample() {
  return {
    schemaVersion: 1,
    fromVersion,
    toVersion,
    platformRecords: platforms.map((platform) => ({
      platform: platform.id,
      installedVersionBefore: fromVersion,
      discoveredVersion: toVersion,
      installedVersionAfter: toVersion,
      installSmokePassed: true,
      updateDownloaded: true,
      restartGateVerified: true,
      postUpdateSmokePassed: true,
      evidenceUrl: `${githubEvidenceBaseUrl}/actions/runs/1234567890/artifacts/${platform.id}`,
      recordedAt: "2026-07-08T00:00:00.000Z",
      operator: "release-operator",
      rollbackNotes: "none",
    })),
  };
}

function renderMarkdown(content) {
  const lines = [
    "# Artistic Git 0.1.0 release rehearsal checklist",
    "",
    "This script is a checklist entry point, not a local substitute for the formal release rehearsal. The TASKS.md release item can only be checked after signed artifacts are built, approved, installed, and update-tested on all three target platforms.",
    "",
    `Mode: ${content.mode}`,
    `Status: ${content.status}`,
    `Task checkbox: ${content.taskCheckbox}`,
    "",
    "## CI dry-run artifact context",
    "",
    `- Expected artifact name: ${content.ciDryRunArtifact.expectedArtifactName ?? "not provided"}`,
    `- Workflow run URL: ${content.ciDryRunArtifact.workflowRunUrl ?? "not provided"}`,
    `- Workflow run URL valid: ${content.ciDryRunArtifact.workflowRunUrlValid ? "yes" : "no"}`,
    `- Planned release: ${content.ciDryRunArtifact.plannedTag ?? "unknown"} (${content.ciDryRunArtifact.plannedVersion ?? "unknown"})`,
    `- Release mode reason: ${content.ciDryRunArtifact.releaseModeReason ?? "not provided"}`,
    "",
    "## Operator-confirmed evidence markers",
    "",
    "| Marker | Expected | Status | Description |",
    "| --- | --- | --- | --- |",
    ...content.operatorConfirmation.requiredMarkers.map(
      (item) =>
        `| ${item.name} | ${item.expectedValue} | ${item.status} | ${item.description} |`,
    ),
    "",
    "## GitHub URL evidence",
    "",
    "| Env | Kind | Version | Status | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...content.githubUrlEvidence.requiredUrls.map(
      (item) =>
        `| ${item.name} | ${item.kind} | ${item.version} | ${item.status} | ${item.reason ?? item.normalizedUrl} |`,
    ),
    "",
    "## Platform install smoke markers",
    "",
    "| Platform | Marker | Status | Description |",
    "| --- | --- | --- | --- |",
    ...content.platformInstallSmoke.map(
      (item) =>
        `| ${item.platform} | ${item.name} | ${item.status} | ${item.description} |`,
    ),
    "",
    "## 0.1.0 to 0.1.1 update rehearsal",
    "",
    "| Platform | Marker | Status | Description |",
    "| --- | --- | --- | --- |",
    ...content.updateRehearsal.requiredMarkers.map(
      (item) =>
        `| ${item.platform} | ${item.name} | ${item.status} | ${item.description} |`,
    ),
    "",
    `Update record status: ${content.updateRehearsal.record.status}`,
    `Update record source: ${content.updateRehearsal.record.source ?? "not provided"}`,
    `Update record detail: ${content.updateRehearsal.record.reason ?? "valid"}`,
    "",
    "Required update record JSON schema is written to `release-update-rehearsal-record.schema.json`; an operator-fillable example is written to `release-update-rehearsal-record.example.json`.",
    "",
    "## Blockers",
    "",
    ...(content.blockers.length > 0
      ? content.blockers.map(
          (item) =>
            `- ${item.id}: ${item.name ?? "rehearsal"} - ${item.message}`,
        )
      : ["- none"]),
    "",
    "## TASKS.md release item",
    "",
    content.cannotCheckTask ??
      "Operator prerequisites are present; review the generated evidence artifacts before checking the TASKS.md release rehearsal item.",
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function writeReports(markdownContent, jsonContent) {
  if (!reportDir) {
    return;
  }
  const absoluteReportDir = path.resolve(reportDir);
  mkdirSync(absoluteReportDir, { recursive: true });
  writeFileSync(
    path.join(absoluteReportDir, "release-rehearsal-checklist.md"),
    markdownContent,
  );
  writeFileSync(
    path.join(absoluteReportDir, "release-rehearsal-checklist.json"),
    `${JSON.stringify(jsonContent, null, 2)}\n`,
  );
  writeFileSync(
    path.join(absoluteReportDir, "release-update-rehearsal-record.schema.json"),
    `${JSON.stringify(updateRecordJsonSchema, null, 2)}\n`,
  );
  writeFileSync(
    path.join(
      absoluteReportDir,
      "release-update-rehearsal-record.example.json",
    ),
    `${JSON.stringify(updateRecordExample, null, 2)}\n`,
  );
  console.log(
    `Wrote release rehearsal checklist artifacts to ${absoluteReportDir}`,
  );
}
