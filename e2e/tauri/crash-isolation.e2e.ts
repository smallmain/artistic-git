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
  injectionCompleted: boolean | null;
  injectionError: string | null;
  injectionState: string | null;
  navigationType: string | null;
  readyState: string;
  title: string;
};

type CrashInjectionResult = {
  accepted: boolean;
  completed: boolean;
  error: string | null;
};

type TauriInvokeInternals = {
  invoke?: (
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
};

type WindowWithTauriInternals = Window & {
  __artisticGitCrashInjectionCompleted?: boolean | null;
  __artisticGitCrashInjectionError?: string | null;
  __artisticGitCrashInjectionState?: string | null;
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
          state.diagnostics.hasCrashDialogTestId &&
          state.diagnostics.hasStartScreen &&
          state.text.includes(crashSummary) &&
          state.text.includes("Restart app")
        );
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "renderer crash injection did not reload into CrashDetailsDialog over the StartScreen",
      },
    );

    await showCrashTechnicalDetails();
    await browser.waitUntil(
      async () => {
        const nextState = await crashDialogState();
        lastCrashState = nextState;
        return (
          nextState.detailsVisible &&
          nextState.text.includes("Renderer process for window")
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: "crash dialog technical details did not expand",
      },
    );

    const state = await crashDialogState();
    assert.equal(state.open, true);
    assert.equal(state.detailsVisible, true);
    assert.equal(state.diagnostics.hasStartScreen, true);
    assert.match(state.text, /Renderer process for window/);

    await dismissCrashDialogIfOpen();
    await browser.waitUntil(startScreenControlsReady, {
      timeout: 10_000,
      timeoutMsg: "start screen controls did not recover after crash dialog",
    });
    const startScreenStillInteractive = await startScreenControlsReady();
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

async function injectRendererCrash(summary: string) {
  try {
    return (await browser.executeAsync((nextSummary, done) => {
      const targetWindow = window as WindowWithTauriInternals;
      const internals = targetWindow.__TAURI_INTERNALS__;
      if (typeof internals?.invoke !== "function") {
        done({
          accepted: false,
          completed: true,
          error: "Tauri invoke internals are not available in WebDriver",
        });
        return;
      }

      let finished = false;
      const finish = (result: CrashInjectionResult) => {
        if (finished) {
          return;
        }
        finished = true;
        done(result);
      };

      targetWindow.__artisticGitCrashInjectionCompleted = false;
      targetWindow.__artisticGitCrashInjectionError = null;
      targetWindow.__artisticGitCrashInjectionState = "pending";
      void internals
        .invoke("inject_renderer_crash", {
          request: { summary: nextSummary },
        })
        .then(() => {
          targetWindow.__artisticGitCrashInjectionCompleted = true;
          targetWindow.__artisticGitCrashInjectionState = "fulfilled";
          finish({ accepted: true, completed: true, error: null });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          targetWindow.__artisticGitCrashInjectionCompleted = true;
          targetWindow.__artisticGitCrashInjectionError = message;
          targetWindow.__artisticGitCrashInjectionState = "rejected";
          finish({ accepted: false, completed: true, error: message });
        });

      setTimeout(() => {
        targetWindow.__artisticGitCrashInjectionState = "timeout";
        finish({ accepted: true, completed: false, error: null });
      }, 1_000);
    }, summary)) as CrashInjectionResult;
  } catch (error) {
    return {
      accepted: true,
      completed: false,
      error: `executeAsync interrupted after crash injection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
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
        injectionCompleted:
          (window as WindowWithTauriInternals)
            .__artisticGitCrashInjectionCompleted ?? null,
        injectionError:
          (window as WindowWithTauriInternals)
            .__artisticGitCrashInjectionError ?? null,
        injectionState:
          (window as WindowWithTauriInternals)
            .__artisticGitCrashInjectionState ?? null,
        navigationType:
          performance.getEntriesByType("navigation")[0]?.toJSON().type ?? null,
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

async function showCrashTechnicalDetails() {
  const expanded = await browser.execute(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const crashDialog =
      document.querySelector('[data-testid="crash-details-dialog"]') ??
      dialogs.find((dialog) => dialog.textContent?.includes("Restart app"));
    if (!crashDialog) {
      return false;
    }
    if (crashDialog.textContent?.includes("Renderer process for window")) {
      return true;
    }
    const buttons = Array.from(crashDialog.querySelectorAll("button"));
    const detailsButton = buttons.find(
      (button) =>
        button.getAttribute("aria-expanded") === "false" ||
        button.textContent?.trim() === "Show technical details",
    );
    if (!(detailsButton instanceof HTMLButtonElement)) {
      return false;
    }
    detailsButton.click();
    return true;
  });

  assert.equal(
    expanded,
    true,
    "crash dialog technical details control was not available",
  );
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
