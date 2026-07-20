import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createI18n } from "@/i18n/i18n";
import { createWindowStore, WindowStoreProvider } from "@/store/window-store";

import { OnboardingWizard } from "./OnboardingWizard";

const commandMocks = vi.hoisted(() => ({
  generateSshKey: vi.fn(),
  saveAppSettings: vi.fn(),
  settingsSnapshot: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => commandMocks);

const settingsSnapshot = {
  appVersion: "0.2.5",
  identitySources: {
    globalGitconfig: { email: null, name: null },
    globalGitconfigPath: null,
    settings: { email: null, name: null },
  },
  settings: {},
  sshKey: {
    exists: false,
    privateKeyPath: null,
    publicKey: null,
    publicKeyPath: null,
  },
};

function renderWizard() {
  const store = createWindowStore({ onboarded: false });
  render(
    <I18nextProvider i18n={createI18n("en")}>
      <WindowStoreProvider enableRealtimeEvents={false} store={store}>
        <OnboardingWizard />
      </WindowStoreProvider>
    </I18nextProvider>,
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  commandMocks.settingsSnapshot.mockResolvedValue(settingsSnapshot);
  commandMocks.saveAppSettings.mockImplementation(async ({ settings }) =>
    Promise.resolve(settings),
  );
});

afterEach(() => {
  cleanup();
});

describe("OnboardingWizard", () => {
  it("blocks setup after a snapshot failure and preserves details for retry", async () => {
    const snapshotError = {
      operation: "load settings snapshot",
      stderr: "fatal: failed to read the global Git configuration",
      summary: "Git settings could not be loaded",
    };
    const handleAppError = vi.fn();
    commandMocks.settingsSnapshot
      .mockRejectedValueOnce(snapshotError)
      .mockResolvedValueOnce(settingsSnapshot);
    window.addEventListener("artistic-git:error", handleAppError);

    try {
      renderWizard();

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't load current Git settings");
      expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
      expect(commandMocks.saveAppSettings).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole("button", { name: "View error details" }),
      );
      expect(handleAppError).toHaveBeenCalledTimes(1);
      expect((handleAppError.mock.calls[0][0] as CustomEvent).detail).toBe(
        snapshotError,
      );

      fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
      );
      expect(commandMocks.settingsSnapshot).toHaveBeenCalledTimes(2);
      expect(commandMocks.saveAppSettings).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("artistic-git:error", handleAppError);
    }
  });
});
