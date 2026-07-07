import assert from "node:assert/strict";

import { browser } from "@wdio/globals";

type StartScreenState = {
  bodyText: string;
  cloneProjectEnabled: boolean | null;
  hasCloneProject: boolean;
  hasOpenProject: boolean;
  hasStartScreen: boolean;
  openProjectEnabled: boolean | null;
  readyState: string;
  title: string;
};

describe("Artistic Git Tauri smoke", () => {
  it("opens the start screen", async () => {
    let lastState: StartScreenState | null = null;

    try {
      await browser.waitUntil(
        async () => {
          const state = await startScreenState();
          lastState = state;
          return (
            state.title === "Artistic Git" &&
            state.hasStartScreen &&
            state.hasOpenProject &&
            state.hasCloneProject &&
            state.openProjectEnabled === true &&
            state.cloneProjectEnabled === true
          );
        },
        {
          interval: 500,
          timeout: 60_000,
          timeoutMsg: "expected the Artistic Git start screen to be ready",
        },
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `Last start screen state: ${JSON.stringify(lastState, null, 2)}`,
        { cause: error },
      );
    }

    const readyState = await startScreenState();
    assert.ok(readyState.hasStartScreen);
    assert.equal(readyState.openProjectEnabled, true);
    assert.equal(readyState.cloneProjectEnabled, true);
  });
});

function startScreenState() {
  return browser.execute(() => {
    const byTestId = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const openProject = byTestId(
      "start-open-project",
    ) as HTMLButtonElement | null;
    const cloneProject = byTestId(
      "start-clone-project",
    ) as HTMLButtonElement | null;

    return {
      bodyText: document.body.innerText.slice(0, 500),
      cloneProjectEnabled: cloneProject ? !cloneProject.disabled : null,
      hasCloneProject: Boolean(cloneProject),
      hasOpenProject: Boolean(openProject),
      hasStartScreen: Boolean(byTestId("start-screen")),
      openProjectEnabled: openProject ? !openProject.disabled : null,
      readyState: document.readyState,
      title: document.title,
    };
  }) as Promise<StartScreenState>;
}
