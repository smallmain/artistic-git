import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { browser } from "@wdio/globals";

import { waitForStartScreenReady } from "./start-screen";

type CrashDialogState = {
  detailsVisible: boolean;
  open: boolean;
  text: string;
};

type TauriInvokeInternals = {
  invoke?: (
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
};

type WindowWithTauriInternals = Window & {
  __TAURI_INTERNALS__?: TauriInvokeInternals;
};

type CrashInjectionRuntimeReport = {
  checkedAt: string;
  command: "inject_renderer_crash";
  driver: "tauri-driver";
  kind: "phase9-crash-isolation-runtime";
  observations: {
    crashDetailsVisible: boolean;
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
    await injectRendererCrash(crashSummary);

    await browser.waitUntil(
      async () => {
        const state = await crashDialogState();
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

    void internals.invoke("inject_renderer_crash", {
      request: { summary: nextSummary },
    });
  }, summary);
}

function crashDialogState() {
  return browser.execute(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const crashDialog = dialogs.find((dialog) =>
      dialog.textContent?.includes("Restart app"),
    );

    return {
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
    const crashDialog = dialogs.find((dialog) =>
      dialog.textContent?.includes("Restart app"),
    );
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
