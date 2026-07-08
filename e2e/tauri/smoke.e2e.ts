import assert from "node:assert/strict";

import {
  getStartScreenState,
  isStartScreenReady,
  type StartScreenState,
} from "./start-screen";

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

function startScreenState() {
  return getStartScreenState() as Promise<StartScreenState>;
}
