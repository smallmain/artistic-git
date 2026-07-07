import assert from "node:assert/strict";

import { $, browser } from "@wdio/globals";

describe("Artistic Git Tauri smoke", () => {
  it("opens the start screen", async () => {
    await browser.waitUntil(
      async () => (await browser.getTitle()) === "Artistic Git",
      {
        timeout: 15_000,
        timeoutMsg: "expected the Tauri window title to be Artistic Git",
      },
    );

    const startScreen = await $('[data-testid="start-screen"]');
    const openProject = await $('[data-testid="start-open-project"]');
    const cloneProject = await $('[data-testid="start-clone-project"]');

    await startScreen.waitForDisplayed({ timeout: 15_000 });
    await openProject.waitForDisplayed({ timeout: 15_000 });
    await cloneProject.waitForDisplayed({ timeout: 15_000 });

    assert.equal(await openProject.isEnabled(), true);
    assert.equal(await cloneProject.isEnabled(), true);
  });
});
