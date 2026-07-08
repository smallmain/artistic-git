#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const source = {
  app: read("src/App.tsx"),
  appTest: read("src/App.test.tsx"),
  boundary: read("src/components/layout/AppErrorBoundary.tsx"),
  commands: read("src/lib/ipc/commands.ts"),
  crashDialog: read("src/components/dialogs/CrashDetailsDialog.tsx"),
  i18n: read("src/i18n/resources.ts"),
  logging: read("crates/core/src/logging.rs"),
  tauriLib: read("src-tauri/src/lib.rs"),
  updaterRuntime: read("src-tauri/src/updater_runtime.rs"),
};

const failures = [];

const evidence = [
  [
    "renderer crash injection command is exposed to TypeScript",
    source.commands,
    /inject_renderer_crash: \{ request: RendererCrashInjectionRequest \}/,
  ],
  [
    "renderer crash injection command reaches the shared reload path",
    source.tauriLib,
    /fn inject_renderer_crash\([\s\S]*handle_renderer_crash\(/,
  ],
  [
    "native WebView process termination hook is registered where Tauri exposes it",
    source.tauriLib,
    /#\[cfg\(any\(target_os = "macos", target_os = "ios"\)\)\][\s\S]*on_web_content_process_terminate\(handle_web_content_process_terminate\)/,
  ],
  [
    "native WebView process termination hook uses the shared renderer crash path",
    source.tauriLib,
    /fn handle_web_content_process_terminate\([\s\S]*handle_renderer_crash\(&app, &registry, &label, default_renderer_crash_summary\(\)\)/,
  ],
  [
    "renderer crash path stores a pending crash and reloads only the affected window",
    source.tauriLib,
    /fn handle_renderer_crash\([\s\S]*registry_set_pending_crash\(registry, label, crash\)\?;[\s\S]*app\.get_webview_window\(label\)[\s\S]*window\.reload\(\)/,
  ],
  [
    "pending renderer crash is consumed through window_context",
    source.tauriLib,
    /fn window_context\([\s\S]*let pending_crash = registry_take_pending_crash\(&registry, &label\);[\s\S]*pending_crash,/,
  ],
  [
    "frontend reopens pending renderer crash as a crash dialog after reload",
    source.app,
    /context\.pendingCrash[\s\S]*dispatchAppCrash\(context\.pendingCrash\)/,
  ],
  [
    "renderer crash reload dialog has a component test",
    source.appTest,
    /opens a pending renderer crash after a window reload/,
  ],
  [
    "each WebView root is wrapped in an AppErrorBoundary",
    source.app,
    /<AppErrorBoundary>[\s\S]*<AppRouter \/>[\s\S]*<\/AppErrorBoundary>/,
  ],
  [
    "React error boundary stores errors locally and can reset itself",
    source.boundary,
    /getDerivedStateFromError[\s\S]*this\.setState\(\{ error: null \}\)/,
  ],
  [
    "React error boundary isolation is covered by a per-root component test",
    source.appTest,
    /isolates React error boundary state per mounted root/,
  ],
  [
    "panic hook logs the panic report and invokes a reporter without panicking the hook",
    source.logging,
    /install_panic_hook_with_reporter[\s\S]*tracing::error![\s\S]*panic_payload[\s\S]*panic::catch_unwind\(panic::AssertUnwindSafe\(\|\| reporter\(report\)\)\)/,
  ],
  [
    "Tauri setup maps panic hook reports into crash-reported events",
    source.tauriLib,
    /install_panic_hook_with_reporter\(move \|report\| \{[\s\S]*app_handle\.emit\("crash-reported", crash_payload_from_panic_report\(report\)\)/,
  ],
  [
    "Rust panic payloads are normalized for the crash dialog",
    source.tauriLib,
    /fn crash_payload_from_panic_report\([\s\S]*CrashDialogSource::RustPanic[\s\S]*summary: format!\("Rust panic: \{\}", report\.payload\)/,
  ],
  [
    "frontend listens for Rust panic crash reports",
    source.app,
    /listen<CrashDialogPayload>\("crash-reported"/,
  ],
  [
    "Rust panic reports open the crash dialog in a component test",
    source.appTest,
    /opens the crash dialog from Rust panic reports emitted by Tauri/,
  ],
  [
    "crash dialog invokes the restart action",
    source.crashDialog,
    /onClick=\{\(\) => \{[\s\S]*onRestart\?\.\(\)/,
  ],
  [
    "crash dialog restart action has visible copy",
    source.i18n,
    /restartApp: "Restart app"/,
  ],
];

for (const [label, fileSource, pattern] of evidence) {
  assertMatch(fileSource, pattern, label);
}

for (const [label, fileSource] of [
  ["src-tauri/src/lib.rs", source.tauriLib],
  ["src-tauri/src/updater_runtime.rs", source.updaterRuntime],
]) {
  assertTauriCommandsReturnAppResult(label, fileSource);
}

if (failures.length > 0) {
  console.error("Phase 9C crash isolation audit failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Phase 9C crash isolation audit passed.");
console.log(
  "renderer: injection path and macOS/iOS native terminate hook reload the affected window and surface the pending crash dialog",
);
console.log("react: per-root AppErrorBoundary isolation is covered");
console.log(
  "rust: Tauri commands return AppResult and panic reports reach the crash dialog",
);
console.log(
  "known gap: Tauri 2.11 exposes native WebView process termination callbacks only for macOS/iOS in this code path; Windows/Linux native crash detection still needs platform evidence",
);

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertMatch(fileSource, pattern, label) {
  if (!pattern.test(fileSource)) {
    failures.push(`${label}: missing ${pattern}`);
  }
}

function assertTauriCommandsReturnAppResult(label, fileSource) {
  const commands = [
    ...fileSource.matchAll(
      /#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\([\s\S]*?\)\s*->\s*([^{]+)\{/g,
    ),
  ];

  if (commands.length === 0) {
    failures.push(`${label}: no Tauri commands found`);
    return;
  }

  for (const [, name, returnType] of commands) {
    if (!/\b(?:artistic_git_contracts::)?AppResult\s*</.test(returnType)) {
      failures.push(
        `${label}:${name}: Tauri command must return AppResult, got ${returnType.trim()}`,
      );
    }
  }
}
