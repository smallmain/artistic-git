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

const startScreenStateScript = `
return (function () {
  var byTestId = function (testId) {
    return document.querySelector('[data-testid="' + testId + '"]');
  };
  var openProject = byTestId('start-open-project');
  var cloneProject = byTestId('start-clone-project');

  return {
    bodyText: document.body ? document.body.innerText.slice(0, 500) : '',
    cloneProjectEnabled: cloneProject ? !cloneProject.disabled : null,
    hasCloneProject: Boolean(cloneProject),
    hasOpenProject: Boolean(openProject),
    hasStartScreen: Boolean(byTestId('start-screen')),
    openProjectEnabled: openProject ? !openProject.disabled : null,
    readyState: document.readyState,
    title: document.title,
  };
})();
`;

describe("Artistic Git Tauri smoke", () => {
  it("opens the start screen", async () => {
    let lastState: StartScreenState | null = null;
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      lastState = await startScreenState();
      if (isStartScreenReady(lastState)) {
        break;
      }
      await browser.pause(500);
    }

    if (!lastState || !isStartScreenReady(lastState)) {
      throw new Error(
        "expected the Artistic Git start screen to be ready\n" +
          `Last start screen state: ${JSON.stringify(lastState, null, 2)}`,
      );
    }

    assert.ok(lastState.hasStartScreen);
    assert.equal(lastState.openProjectEnabled, true);
    assert.equal(lastState.cloneProjectEnabled, true);
  });
});

function isStartScreenReady(state: StartScreenState) {
  return (
    state.title === "Artistic Git" &&
    state.hasStartScreen &&
    state.hasOpenProject &&
    state.hasCloneProject &&
    state.openProjectEnabled === true &&
    state.cloneProjectEnabled === true
  );
}

function startScreenState() {
  return browser.execute(startScreenStateScript) as Promise<StartScreenState>;
}
