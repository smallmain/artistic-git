import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { browser } from "@wdio/globals";

import { waitForStartScreenReady } from "./start-screen";

type CrashDialogState = {
  detailsVisible: boolean;
  diagnostics: CrashDiagnostics;
  open: boolean;
  text: string;
};

type CrashDiagnostics = {
  bodyTextSnippet: string;
  dialogCount: number;
  dialogTexts: string[];
  hasCrashDialogTestId: boolean;
  hasStartScreen: boolean;
  injectionError: string | null;
  readyState: string;
  title: string;
};

type CrashInjectionResult = {
  accepted: boolean;
  error: string | null;
};

type TauriInvokeInternals = {
  invoke?: (
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
};

type WindowWithTauriInternals = Window & {
  __artisticGitCrashInjectionError?: string | null;
  __TAURI_INTERNALS__?: TauriInvokeInternals;
};

type CrashInjectionRuntimeReport = {
  checkedAt: string;
  command: "inject_renderer_crash";
  driver: "tauri-driver";
  kind: "phase9-crash-isolation-runtime";
  observations: {
    crashDetailsVisible: boolean;
    diagnostics: CrashDiagnostics | null;
    dialogTextSnippet: string;
    startScreenStillInteractive: boolean;
  };
  platform: NodeJS.Platform;
  result: "passed" | "failed";
  schemaVersion: 1;
  summary: string;
  taskCheckable: boolean;
};

const crashSummary =
  "Phase 9C tauri-driver renderer crash injection reloaded this window.";

let runtimeReport: CrashInjectionRuntimeReport | null = null;
let lastCrashState: CrashDialogState | null = null;

describe("Artistic Git Tauri crash isolation", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "passed" && runtimeReport === null) {
      writeCrashInjectionRuntimeReport({
        checkedAt: new Date().toISOString(),
        command: "inject_renderer_crash",
        driver: "tauri-driver",
        kind: "phase9-crash-isolation-runtime",
        observations: {
          crashDetailsVisible: false,
          diagnostics: lastCrashState?.diagnostics ?? null,
          dialogTextSnippet: "",
          startScreenStillInteractive: false,
        },
        platform: process.platform,
        result: "failed",
        schemaVersion: 1,
        summary: crashSummary,
        taskCheckable: false,
      });
    }

    await dismissCrashDialogIfOpen();
  });

  it("injects a renderer crash through Tauri IPC and observes reload plus crash dialog", async () => {
    await waitForStartScreen();
    const injection = await injectRendererCrash(crashSummary);
    assert.equal(injection.accepted, true, injection.error ?? "IPC failed");

    await browser.waitUntil(
      async () => {
        const state = await crashDialogState();
        lastCrashState = state;
        return (
          state.open &&
          state.detailsVisible &&
          state.text.includes(crashSummary) &&
          state.text.includes("Renderer process for window")
        );
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "renderer crash injection did not reload into CrashDetailsDialog",
      },
    );

    const state = await crashDialogState();
    const startScreenStillInteractive = await startScreenControlsReady();
    assert.equal(state.open, true);
    assert.equal(state.detailsVisible, true);
    assert.match(state.text, /Renderer process for window/);
    assert.equal(startScreenStillInteractive, true);

    writeCrashInjectionRuntimeReport({
      checkedAt: new Date().toISOString(),
      command: "inject_renderer_crash",
      driver: "tauri-driver",
      kind: "phase9-crash-isolation-runtime",
      observations: {
        crashDetailsVisible: state.detailsVisible,
        diagnostics: state.diagnostics,
        dialogTextSnippet: state.text.slice(0, 500),
        startScreenStillInteractive,
      },
      platform: process.platform,
      result: "passed",
      schemaVersion: 1,
      summary: crashSummary,
      taskCheckable: true,
    });
  });
});

async function waitForStartScreen() {
  await waitForStartScreenReady();
}

function startScreenControlsReady() {
  return browser.execute(() => {
    const openProject = document.querySelector<HTMLButtonElement>(
      '[data-testid="start-open-project"]',
    );
    const cloneProject = document.querySelector<HTMLButtonElement>(
      '[data-testid="start-clone-project"]',
    );
    return Boolean(
      openProject &&
      cloneProject &&
      !openProject.disabled &&
      !cloneProject.disabled,
    );
  }) as Promise<boolean>;
}

function injectRendererCrash(summary: string) {
  return browser.execute((nextSummary) => {
    const internals = (window as WindowWithTauriInternals).__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== "function") {
      throw new Error("Tauri invoke internals are not available in WebDriver");
    }

    const targetWindow = window as WindowWithTauriInternals;
    targetWindow.__artisticGitCrashInjectionError = null;
    void internals
      .invoke("inject_renderer_crash", {
        request: { summary: nextSummary },
      })
      .catch((error) => {
        targetWindow.__artisticGitCrashInjectionError =
          error instanceof Error ? error.message : String(error);
      });

    return { accepted: true, error: null };
  }, summary) as Promise<CrashInjectionResult>;
}

function crashDialogState() {
  return browser.execute(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const crashDialogByTestId = document.querySelector(
      '[data-testid="crash-details-dialog"]',
    );
    const crashDialog =
      crashDialogByTestId ??
      dialogs.find((dialog) => dialog.textContent?.includes("Restart app"));
    const dialogTexts = dialogs.map((dialog) => dialog.textContent ?? "");

    return {
      diagnostics: {
        bodyTextSnippet: document.body?.innerText.slice(0, 1000) ?? "",
        dialogCount: dialogs.length,
        dialogTexts: dialogTexts.map((text) => text.slice(0, 500)),
        hasCrashDialogTestId: Boolean(crashDialogByTestId),
        hasStartScreen: Boolean(
          document.querySelector('[data-testid="start-screen"]'),
        ),
        injectionError:
          (window as WindowWithTauriInternals)
            .__artisticGitCrashInjectionError ?? null,
        readyState: document.readyState,
        title: document.title,
      },
      detailsVisible: Boolean(
        crashDialog?.textContent?.includes("Renderer process for window"),
      ),
      open: Boolean(crashDialog),
      text: crashDialog?.textContent ?? "",
    };
  }) as Promise<CrashDialogState>;
}

async function dismissCrashDialogIfOpen() {
  const dismissed = await browser.execute(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const crashDialog =
      document.querySelector('[data-testid="crash-details-dialog"]') ??
      dialogs.find((dialog) => dialog.textContent?.includes("Restart app"));
    const buttons = Array.from(crashDialog?.querySelectorAll("button") ?? []);
    const closeButton = buttons.find(
      (button) => button.textContent?.trim() === "Close",
    );
    if (!(closeButton instanceof HTMLButtonElement)) {
      return false;
    }
    closeButton.click();
    return true;
  });

  if (!dismissed) {
    return;
  }

  await browser.waitUntil(async () => !(await crashDialogState()).open, {
    timeout: 10_000,
    timeoutMsg: "crash dialog did not dismiss",
  });
}

function writeCrashInjectionRuntimeReport(report: CrashInjectionRuntimeReport) {
  runtimeReport = report;
  const reportPath = process.env.ARTISTIC_GIT_PHASE9_CRASH_ISOLATION_E2E_REPORT;
  if (!reportPath) {
    return;
  }

  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}${os.EOL}`);
}
