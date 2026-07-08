import { browser } from "@wdio/globals";

export type StartScreenState = {
  bodyText: string;
  cloneProjectEnabled: boolean | null;
  hasCloneProject: boolean;
  hasOpenProject: boolean;
  hasStartScreen: boolean;
  openProjectEnabled: boolean | null;
  readyState: string;
  title: string;
};

export const startScreenStateScript = `
return (function () {
  var startScreen = document.querySelector('[data-testid="start-screen"]');
  var openProject = document.querySelector('[data-testid="start-open-project"]');
  var cloneProject = document.querySelector('[data-testid="start-clone-project"]');

  return {
    bodyText: document.body ? document.body.innerText.slice(0, 500) : '',
    cloneProjectEnabled: cloneProject ? !cloneProject.disabled : null,
    hasCloneProject: Boolean(cloneProject),
    hasOpenProject: Boolean(openProject),
    hasStartScreen: Boolean(startScreen),
    openProjectEnabled: openProject ? !openProject.disabled : null,
    readyState: document.readyState,
    title: document.title,
  };
})();
`;

export function isStartScreenReady(state: StartScreenState) {
  return (
    state.title === "Artistic Git" &&
    state.hasStartScreen &&
    state.hasOpenProject &&
    state.hasCloneProject &&
    state.openProjectEnabled === true &&
    state.cloneProjectEnabled === true
  );
}

export function getStartScreenState() {
  return browser.execute(startScreenStateScript) as Promise<StartScreenState>;
}

export async function waitForStartScreenReady(timeout = 120_000) {
  let lastState: StartScreenState | null = null;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    lastState = await getStartScreenState();
    if (isStartScreenReady(lastState)) {
      return lastState;
    }
    await browser.pause(500);
  }

  throw new Error(
    "expected the Artistic Git start screen to be ready\n" +
      `Last start screen state: ${JSON.stringify(lastState, null, 2)}`,
  );
}
