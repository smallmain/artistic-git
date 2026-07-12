#!/usr/bin/env node
/* global console, process */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runnerLabel = process.env.RUNNER_OS ?? process.platform;
const reportPath =
  nonEmptyEnv("ARTISTIC_GIT_PHASE9_CRASH_ISOLATION_AUDIT_REPORT") ??
  (process.env.CI
    ? path.resolve(
        "artifacts",
        `phase9-crash-isolation-audit-${runnerLabel}.json`,
      )
    : null);
const markdownPath = reportPath?.replace(/\.json$/i, ".md");

const sourceFiles = {
  app: "src/App.tsx",
  appTest: "src/App.test.tsx",
  boundary: "src/components/layout/AppErrorBoundary.tsx",
  ci: ".github/workflows/release.yml",
  commands: "src/lib/ipc/commands.ts",
  crashDialog: "src/components/dialogs/CrashDetailsDialog.tsx",
  crashInjectionE2e: "e2e/tauri/crash-isolation.e2e.ts",
  i18n: "src/i18n/resources.ts",
  logging: "crates/core/src/logging.rs",
  packageJson: "package.json",
  tauriLib: "src-tauri/src/lib.rs",
  updaterRuntime: "src-tauri/src/updater_runtime.rs",
  wdioConfig: "wdio.tauri.conf.ts",
};
const source = Object.fromEntries(
  Object.entries(sourceFiles).map(([key, relativePath]) => [
    key,
    read(relativePath),
  ]),
);
const packageJson = JSON.parse(source.packageJson);

const evidenceChecks = [
  {
    id: "renderer-injection-ts-command",
    layer: "renderer",
    requirement: "renderer crash injection command is exposed to TypeScript",
    source: "commands",
    pattern:
      /inject_renderer_crash: \{ request: RendererCrashInjectionRequest \}/,
  },
  {
    id: "renderer-injection-shared-path",
    layer: "renderer",
    requirement:
      "renderer crash injection command reaches the shared reload path",
    source: "tauriLib",
    pattern: /fn inject_renderer_crash\([\s\S]*handle_renderer_crash\(/,
  },
  {
    id: "native-hook-registered-macos-ios",
    layer: "renderer",
    requirement:
      "native WebView process termination hook is registered where Tauri exposes it",
    source: "tauriLib",
    pattern:
      /#\[cfg\(any\(target_os = "macos", target_os = "ios"\)\)\][\s\S]*on_web_content_process_terminate\(handle_web_content_process_terminate\)/,
  },
  {
    id: "native-hook-shared-path",
    layer: "renderer",
    requirement:
      "native WebView process termination hook uses the shared renderer crash path",
    source: "tauriLib",
    pattern:
      /fn handle_web_content_process_terminate\([\s\S]*handle_renderer_crash\(&app, &registry, &label, default_renderer_crash_summary\(\)\)/,
  },
  {
    id: "native-hook-platform-gate",
    layer: "renderer",
    requirement:
      "native WebView crash hook support is platform-gated with explicit unsupported evidence",
    source: "tauriLib",
    pattern:
      /native_renderer_crash_hook_gate\(\) -> &'static str[\s\S]*native-webview-process-terminate-hook:supported:macos-ios[\s\S]*native_renderer_crash_hook_gate\(\) -> &'static str[\s\S]*native-webview-process-terminate-hook:unsupported:windows-linux:requires-tauri-driver-crash-injection-evidence/,
  },
  {
    id: "renderer-reload-target-window",
    layer: "renderer",
    requirement:
      "renderer crash path stores a pending crash and reloads only the affected window",
    source: "tauriLib",
    pattern:
      /fn handle_renderer_crash\([\s\S]*registry_set_pending_crash\(registry, label, crash\)\?;[\s\S]*app\.get_webview_window\(label\)[\s\S]*window\.reload\(\)/,
  },
  {
    id: "pending-crash-window-context",
    layer: "renderer",
    requirement: "pending renderer crash is exposed idempotently through window_context",
    source: "tauriLib",
    pattern:
      /fn window_context\([\s\S]*let pending_crash = registry_peek_pending_crash\(&registry, &label\);[\s\S]*pending_crash,/,
  },
  {
    id: "pending-crash-ack-command",
    layer: "renderer",
    requirement:
      "pending renderer crash is cleared only after the frontend acknowledges it",
    source: "tauriLib",
    pattern:
      /fn acknowledge_renderer_crash\([\s\S]*registry_clear_pending_crash\(&registry, window\.label\(\)\)/,
  },
  {
    id: "pending-crash-frontend-dialog",
    layer: "renderer",
    requirement:
      "frontend stores a pending renderer crash in app state and reopens it as a crash dialog after reload",
    source: "app",
    pattern:
      /(?=[\s\S]*context\.pendingCrash[\s\S]*onCrash\(context\.pendingCrash\))(?=[\s\S]*<GlobalErrorDialogs[\s\S]*crash=\{globalCrash\})/,
  },
  {
    id: "pending-crash-frontend-ack",
    layer: "renderer",
    requirement:
      "frontend acknowledges a pending renderer crash after moving it into app state",
    source: "app",
    pattern:
      /context\.pendingCrash[\s\S]*onCrash\(context\.pendingCrash\);[\s\S]*acknowledgeRendererCrash\(\)\.catch\(onError\)/,
  },
  {
    id: "pending-crash-component-test",
    layer: "renderer",
    requirement: "renderer crash reload dialog has a component test",
    source: "appTest",
    pattern: /opens a pending renderer crash after a window reload/,
  },
  {
    id: "tauri-driver-crash-injection-e2e",
    layer: "renderer",
    requirement:
      "tauri-driver E2E invokes renderer crash injection through the live Tauri IPC bridge",
    source: "crashInjectionE2e",
    pattern:
      /renderer crash injection did not reload into CrashDetailsDialog[\s\S]*__TAURI_INTERNALS__[\s\S]*invoke\("inject_renderer_crash"/,
  },
  {
    id: "tauri-driver-crash-injection-dialog-assertion",
    layer: "renderer",
    requirement:
      "tauri-driver E2E observes reload into CrashDetailsDialog, expands technical details, and verifies the start screen after dismissal",
    source: "crashInjectionE2e",
    pattern:
      /state\.diagnostics\.hasCrashDialogTestId[\s\S]*state\.diagnostics\.navigationType === "reload"[\s\S]*showCrashTechnicalDetails\(\)[\s\S]*state\.detailsVisible[\s\S]*assert\.equal\(state\.diagnostics\.navigationType, "reload"\)[\s\S]*dismissCrashDialogIfOpen\(\)[\s\S]*startScreenStillInteractive/,
  },
  {
    id: "tauri-driver-crash-injection-runtime-report",
    layer: "renderer",
    requirement:
      "tauri-driver E2E writes a machine-readable crash injection runtime report",
    source: "crashInjectionE2e",
    pattern:
      /kind: "phase9-crash-isolation-runtime"[\s\S]*taskCheckable: true[\s\S]*ARTISTIC_GIT_PHASE9_CRASH_ISOLATION_E2E_REPORT/,
  },
  {
    id: "react-root-boundary",
    layer: "react",
    requirement: "each WebView root is wrapped in an AppErrorBoundary",
    source: "app",
    pattern:
      /<AppErrorBoundary>[\s\S]*<AppRouter \/>[\s\S]*<\/AppErrorBoundary>/,
  },
  {
    id: "react-boundary-local-reset",
    layer: "react",
    requirement:
      "React error boundary stores errors locally and can reset itself",
    source: "boundary",
    pattern:
      /getDerivedStateFromError[\s\S]*this\.setState\(\{ error: null \}\)/,
  },
  {
    id: "react-boundary-isolation-test",
    layer: "react",
    requirement:
      "React error boundary isolation is covered by a per-root component test",
    source: "appTest",
    pattern: /isolates React error boundary state per mounted root/,
  },
  {
    id: "panic-hook-reporter",
    layer: "rust",
    requirement:
      "panic hook logs the panic report and invokes a reporter without panicking the hook",
    source: "logging",
    pattern:
      /install_panic_hook_with_reporter[\s\S]*tracing::error![\s\S]*panic_payload[\s\S]*panic::catch_unwind\(panic::AssertUnwindSafe\(\|\| reporter\(report\)\)\)/,
  },
  {
    id: "panic-hook-tauri-event",
    layer: "rust",
    requirement:
      "Tauri setup maps panic hook reports into crash-reported events",
    source: "tauriLib",
    pattern:
      /install_panic_hook_with_reporter\(move \|report\| \{[\s\S]*app_handle\.emit\("crash-reported", crash_payload_from_panic_report\(report\)\)/,
  },
  {
    id: "panic-payload-normalized",
    layer: "rust",
    requirement: "Rust panic payloads are normalized for the crash dialog",
    source: "tauriLib",
    pattern:
      /fn crash_payload_from_panic_report\([\s\S]*CrashDialogSource::RustPanic[\s\S]*summary: format!\("Rust panic: \{\}", report\.payload\)/,
  },
  {
    id: "panic-frontend-listener",
    layer: "rust",
    requirement: "frontend listens for Rust panic crash reports",
    source: "app",
    pattern: /listen<CrashDialogPayload>\("crash-reported"/,
  },
  {
    id: "panic-dialog-component-test",
    layer: "rust",
    requirement: "Rust panic reports open the crash dialog in a component test",
    source: "appTest",
    pattern: /opens the crash dialog from Rust panic reports emitted by Tauri/,
  },
  {
    id: "crash-dialog-restart-action",
    layer: "dialog",
    requirement: "crash dialog invokes the restart action",
    source: "crashDialog",
    pattern: /onClick=\{\(\) => \{[\s\S]*onRestart\?\.\(\)/,
  },
  {
    id: "crash-dialog-restart-copy",
    layer: "dialog",
    requirement: "crash dialog restart action has visible copy",
    source: "i18n",
    pattern: /restartApp: "Restart app"/,
  },
];

const gates = [
  {
    id: "windows-linux-native-hook-unsupported",
    requirement:
      "Windows/Linux native WebView crash detection is explicitly marked unsupported until platform hook or runtime evidence lands",
    source: "tauriLib",
    tokens: [
      "native-webview-process-terminate-hook:unsupported:windows-linux:requires-tauri-driver-crash-injection-evidence",
      '#[cfg(not(any(target_os = "macos", target_os = "ios")))]',
    ],
    forbidden: [
      /target_os = "windows"[\s\S]{0,240}on_web_content_process_terminate/,
      /target_os = "linux"[\s\S]{0,240}on_web_content_process_terminate/,
    ],
  },
  {
    id: "tauri-driver-injection-gate",
    requirement:
      "CI keeps a tauri-driver transport gate available for renderer crash injection evidence",
    source: "wdioConfig",
    tokens: [
      "@wdio/tauri-service",
      'driverProvider: "external"',
      "autoInstallTauriDriver: false",
      "tauriDriverPath",
      "TAURI_DRIVER",
      "TAURI_DRIVER_PORT",
    ],
    extraSources: [
      {
        source: "ci",
        tokens: [
          "Install tauri-driver",
          "cargo install tauri-driver",
          "Run Tauri E2E on Linux",
          "Run Tauri E2E on Windows",
          "pnpm e2e:tauri:ci",
        ],
      },
    ],
    scriptTokens: {
      "e2e:tauri:ci": ["wdio run ./wdio.tauri.conf.ts"],
    },
  },
  {
    id: "tauri-driver-crash-injection-runtime-artifact",
    requirement:
      "Linux/Windows tauri-driver E2E uploads renderer crash injection runtime evidence",
    source: "ci",
    tokens: [
      "ARTISTIC_GIT_PHASE9_CRASH_ISOLATION_E2E_REPORT",
      "Upload phase 9 crash isolation E2E evidence",
      "phase9-crash-isolation-e2e-${{ runner.os }}",
      "${{ runner.temp }}/phase9-crash-isolation-e2e/",
    ],
    extraSources: [
      {
        source: "crashInjectionE2e",
        tokens: [
          "phase9-crash-isolation-runtime",
          "inject_renderer_crash",
          "CrashDetailsDialog",
          "taskCheckable: true",
        ],
      },
    ],
  },
  {
    id: "crash-audit-ci-artifact",
    requirement:
      "CI uploads machine-readable Phase 9C crash isolation audit artifacts",
    source: "ci",
    tokens: [
      "ARTISTIC_GIT_PHASE9_CRASH_ISOLATION_AUDIT_REPORT",
      "pnpm phase9:crash-isolation:audit",
      "phase9-crash-isolation-${{ runner.os }}",
      "${{ runner.temp }}/phase9-crash-isolation/",
    ],
    scriptTokens: {
      "phase9:crash-isolation:audit": [
        "node scripts/check-phase9-crash-isolation-audit.mjs",
      ],
    },
  },
];

const evidence = evidenceChecks.map((check) => evaluatePattern(check));
const commandReturnAudit = auditTauriCommandsReturnAppResult([
  ["src-tauri/src/lib.rs", source.tauriLib],
  ["src-tauri/src/updater_runtime.rs", source.updaterRuntime],
]);
const gateResults = gates.map((gate) => evaluateGate(gate));
const knownGaps = buildKnownGaps();
const platformSupport = buildPlatformSupport(evidence);
const coverageSegments = buildCoverageSegments({
  commandReturnAudit,
  evidence,
  gates: gateResults,
});

const failures = [
  ...evidence
    .filter((item) => item.status !== "pass")
    .map((item) => `${item.id}: ${item.failure}`),
  ...commandReturnAudit.failures,
  ...gateResults
    .filter((gate) => gate.status !== "pass")
    .map((gate) => `${gate.id}: ${gate.failures.join("; ")}`),
];

const report = {
  checkedAt: new Date().toISOString(),
  commandReturnAudit,
  coverageSegments,
  evidence,
  gates: gateResults,
  gaps: knownGaps,
  kind: "phase9-crash-isolation",
  platformSupport,
  result: failures.length === 0 ? "static-pass" : "failed",
  runtimeEvidence: {
    nativeWebviewCrash:
      "not-run-by-audit; macOS/iOS native hook is statically wired, Windows/Linux native hook is unsupported in this code path",
    tauriDriverCrashInjection:
      "runtime-spec-wired; Linux/Windows CI now runs e2e/tauri/crash-isolation.e2e.ts through tauri-driver and uploads phase9-crash-isolation-e2e-* evidence; checking TASKS.md still requires a successful uploaded runtime artifact",
  },
  schemaVersion: 2,
  sources: sourceFiles,
  taskCheckable: false,
  taskCheckableReason:
    "Static crash-isolation and CI wiring evidence passes, but this audit does not itself execute tauri-driver; check TASKS.md only after successful phase9-crash-isolation-e2e-* runtime artifacts exist.",
};

writeReport(report);

if (failures.length > 0) {
  console.error("Phase 9C crash isolation audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  if (reportPath) {
    console.error(
      `Wrote Phase 9C crash isolation audit report to ${reportPath}`,
    );
  }
  process.exit(1);
}

const suffix = reportPath ? `; wrote ${reportPath}` : "";
console.log(`Phase 9C crash isolation audit static-pass${suffix}.`);
console.log(
  "native hook: macOS/iOS WebView terminate hook is wired; Windows/Linux are explicitly unsupported without runtime evidence",
);
console.log(
  "renderer reload: injection path and tauri-driver spec are wired, but a successful runtime artifact is still required",
);
console.log("react: per-root AppErrorBoundary isolation is covered");
console.log(
  "rust: Tauri commands return AppResult and panic reports reach the crash dialog",
);
console.log(
  "known gaps: Windows/Linux native WebView crash detection is unsupported in this Tauri hook path; tauri-driver crash-injection runtime is wired but still needs a successful uploaded CI artifact before checking TASKS.md",
);

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function evaluatePattern(check) {
  const fileSource = source[check.source];
  const matched = check.pattern.test(fileSource);
  return {
    id: check.id,
    layer: check.layer,
    requirement: check.requirement,
    source: sourceFiles[check.source],
    status: matched ? "pass" : "fail",
    ...(matched ? {} : { failure: `missing ${check.pattern}` }),
  };
}

function evaluateGate(gate) {
  const failures = [];
  const fileSource = source[gate.source];
  if (typeof fileSource !== "string") {
    failures.push(`unknown source ${gate.source}`);
  } else {
    for (const token of gate.tokens ?? []) {
      if (!fileSource.includes(token)) {
        failures.push(`${gate.source} is missing ${token}`);
      }
    }
    for (const pattern of gate.forbidden ?? []) {
      if (pattern.test(fileSource)) {
        failures.push(`${gate.source} contains forbidden pattern ${pattern}`);
      }
    }
  }

  for (const extra of gate.extraSources ?? []) {
    const extraSource = source[extra.source];
    for (const token of extra.tokens) {
      if (!extraSource?.includes(token)) {
        failures.push(`${extra.source} is missing ${token}`);
      }
    }
  }

  for (const [scriptName, tokens] of Object.entries(gate.scriptTokens ?? {})) {
    const script = packageJson.scripts?.[scriptName];
    if (typeof script !== "string") {
      failures.push(`package.json is missing script ${scriptName}`);
      continue;
    }
    for (const token of tokens) {
      if (!script.includes(token)) {
        failures.push(`${scriptName} script is missing ${token}`);
      }
    }
  }

  return {
    id: gate.id,
    failures,
    requirement: gate.requirement,
    status: failures.length === 0 ? "pass" : "fail",
  };
}

function auditTauriCommandsReturnAppResult(files) {
  const auditedFiles = [];
  const failures = [];

  for (const [label, fileSource] of files) {
    const commands = [
      ...fileSource.matchAll(
        /#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\([\s\S]*?\)\s*->\s*([^{]+)\{/g,
      ),
    ].map((match) => ({
      name: match[1],
      returnType: match[2].trim(),
    }));

    if (commands.length === 0) {
      failures.push(`${label}: no Tauri commands found`);
    }

    for (const command of commands) {
      if (
        !/\b(?:artistic_git_contracts::)?AppResult\s*</.test(command.returnType)
      ) {
        failures.push(
          `${label}:${command.name}: Tauri command must return AppResult, got ${command.returnType}`,
        );
      }
    }

    auditedFiles.push({
      commands,
      commandCount: commands.length,
      file: label,
    });
  }

  return {
    failures,
    files: auditedFiles,
    status: failures.length === 0 ? "pass" : "fail",
  };
}

function buildPlatformSupport(items) {
  const evidencePassed = (id) =>
    items.some((item) => item.id === id && item.status === "pass");
  const macIosSupported =
    evidencePassed("native-hook-registered-macos-ios") &&
    evidencePassed("native-hook-shared-path") &&
    evidencePassed("native-hook-platform-gate");

  return [
    {
      nativeWebviewTerminationHook: macIosSupported
        ? "supported-static"
        : "missing-static-evidence",
      platform: "macos",
      requiredRuntimeEvidence:
        "native WebView process termination or renderer crash injection run",
    },
    {
      nativeWebviewTerminationHook: macIosSupported
        ? "supported-static"
        : "missing-static-evidence",
      platform: "ios",
      requiredRuntimeEvidence:
        "native WebView process termination or renderer crash injection run",
    },
    {
      nativeWebviewTerminationHook: "unsupported-by-current-tauri-hook",
      platform: "windows",
      requiredRuntimeEvidence:
        "platform native hook implementation or successful tauri-driver crash-injection artifact",
    },
    {
      nativeWebviewTerminationHook: "unsupported-by-current-tauri-hook",
      platform: "linux",
      requiredRuntimeEvidence:
        "platform native hook implementation or successful tauri-driver crash-injection artifact",
    },
  ];
}

function buildKnownGaps() {
  return [
    {
      id: "windows-native-webview-crash-detection",
      platform: "windows",
      requiredEvidence:
        "native WebView process termination hook or a successful phase9-crash-isolation-e2e-Windows artifact observing target-window reload and CrashDetailsDialog",
      status: "unsupported",
    },
    {
      id: "linux-native-webview-crash-detection",
      platform: "linux",
      requiredEvidence:
        "native WebView process termination hook or a successful phase9-crash-isolation-e2e-Linux artifact observing target-window reload and CrashDetailsDialog",
      status: "unsupported",
    },
    {
      id: "tauri-driver-crash-injection-runtime-artifact",
      platform: "linux/windows",
      requiredEvidence:
        "CI artifact from e2e/tauri/crash-isolation.e2e.ts invoking inject_renderer_crash and asserting reload plus CrashDetailsDialog",
      status: "ci-wired-pending-successful-run",
    },
  ];
}

function buildCoverageSegments({ commandReturnAudit, evidence, gates }) {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const gateById = new Map(gates.map((gate) => [gate.id, gate]));

  const segment = ({
    id,
    title,
    status,
    summary,
    evidenceIds = [],
    gateIds = [],
    missingRuntimeEvidence = null,
    notes = [],
  }) => {
    const evidenceItems = evidenceIds.map((evidenceId) => {
      const item = evidenceById.get(evidenceId);
      return {
        id: evidenceId,
        status: item?.status ?? "missing",
      };
    });
    const gateItems = gateIds.map((gateId) => {
      const item = gateById.get(gateId);
      return {
        id: gateId,
        status: item?.status ?? "missing",
      };
    });
    const failedEvidence = evidenceItems.filter(
      (item) => item.status !== "pass",
    );
    const failedGates = gateItems.filter((item) => item.status !== "pass");

    return {
      evidence: evidenceItems,
      gates: gateItems,
      id,
      missingRuntimeEvidence,
      notes,
      status:
        failedEvidence.length === 0 && failedGates.length === 0
          ? status
          : "failed",
      summary,
      title,
    };
  };

  return [
    segment({
      evidenceIds: [
        "native-hook-registered-macos-ios",
        "native-hook-shared-path",
        "native-hook-platform-gate",
      ],
      gateIds: ["windows-linux-native-hook-unsupported"],
      id: "native-hook-coverage",
      missingRuntimeEvidence:
        "Windows/Linux native WebView crash hook is unsupported in the current Tauri API path; require platform hook support or successful phase9-crash-isolation-e2e Windows/Linux artifacts.",
      status: "partial-platform-coverage",
      summary:
        "macOS/iOS native WebView process termination hook is statically wired to the shared renderer crash path; Windows/Linux are explicitly marked unsupported.",
      title: "Native Hook Coverage",
    }),
    segment({
      evidenceIds: [
        "renderer-injection-ts-command",
        "renderer-injection-shared-path",
        "renderer-reload-target-window",
        "pending-crash-window-context",
        "pending-crash-frontend-dialog",
        "pending-crash-component-test",
        "tauri-driver-crash-injection-e2e",
        "tauri-driver-crash-injection-dialog-assertion",
        "tauri-driver-crash-injection-runtime-report",
      ],
      gateIds: [
        "tauri-driver-injection-gate",
        "tauri-driver-crash-injection-runtime-artifact",
      ],
      id: "renderer-reload-evidence",
      missingRuntimeEvidence:
        "A successful uploaded phase9-crash-isolation-e2e-* runtime artifact is still required before this task can be checked.",
      status: "runtime-artifact-pending",
      summary:
        "Renderer crash injection reaches the shared reload path, stores a pending crash, reloads only the affected window, and has a tauri-driver spec wired for runtime evidence.",
      title: "Renderer Reload Evidence",
    }),
    segment({
      evidenceIds: [
        "react-root-boundary",
        "react-boundary-local-reset",
        "react-boundary-isolation-test",
      ],
      id: "react-boundary-evidence",
      status: "covered",
      summary:
        "Each WebView root is wrapped in AppErrorBoundary and component tests cover per-root isolation.",
      title: "React Boundary Evidence",
    }),
    segment({
      evidenceIds: [
        "panic-hook-reporter",
        "panic-hook-tauri-event",
        "panic-payload-normalized",
        "panic-frontend-listener",
        "panic-dialog-component-test",
      ],
      id: "rust-panic-hook-evidence",
      notes: [
        `Tauri command Result audit: ${commandReturnAudit.status}; ${commandReturnAudit.files
          .map((file) => `${file.file}:${file.commandCount}`)
          .join(", ")}`,
      ],
      status: commandReturnAudit.status === "pass" ? "covered" : "failed",
      summary:
        "Rust commands return AppResult, panic hook reports are emitted as crash-reported events, and frontend tests cover the crash dialog path.",
      title: "Rust Panic Hook Evidence",
    }),
  ];
}

function writeReport(value) {
  if (!reportPath) {
    return;
  }

  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(value));
}

function renderMarkdown(value) {
  const lines = [
    "# Phase 9C Crash Isolation Audit",
    "",
    `- Result: ${value.result}`,
    `- Task checkable: ${value.taskCheckable}`,
    `- Task reason: ${value.taskCheckableReason}`,
    "",
    "## Coverage Segments",
    "",
    "| Segment | Status | Summary | Missing Runtime Evidence |",
    "| --- | --- | --- | --- |",
    ...value.coverageSegments.map(
      (segment) =>
        `| ${segment.title} | ${segment.status} | ${escapePipe(
          segment.summary,
        )} | ${escapePipe(segment.missingRuntimeEvidence ?? "")} |`,
    ),
    "",
    "## Platform Support",
    "",
    "| Platform | Native WebView Hook | Required Runtime Evidence |",
    "| --- | --- | --- |",
    ...value.platformSupport.map(
      (item) =>
        `| ${item.platform} | ${item.nativeWebviewTerminationHook} | ${escapePipe(
          item.requiredRuntimeEvidence,
        )} |`,
    ),
    "",
    "## Gates",
    "",
    "| Gate | Status | Requirement |",
    "| --- | --- | --- |",
    ...value.gates.map(
      (gate) =>
        `| ${gate.id} | ${gate.status} | ${escapePipe(gate.requirement)} |`,
    ),
    "",
    "## Known Gaps",
    "",
    "| Gap | Platform | Status | Required Evidence |",
    "| --- | --- | --- | --- |",
    ...value.gaps.map(
      (gap) =>
        `| ${gap.id} | ${gap.platform} | ${gap.status} | ${escapePipe(
          gap.requiredEvidence,
        )} |`,
    ),
    "",
  ];
  return `${lines.join(os.EOL)}${os.EOL}`;
}

function escapePipe(value) {
  return value.replaceAll("|", "\\|");
}

function nonEmptyEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
