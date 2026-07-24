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
import { ToastViewport } from "@/components/ui/toast-viewport";
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
        <ToastViewport />
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
      expect(screen.queryByRole("button", { name: "Set up later" })).toBeNull();
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

  it("keeps validated author details when SSH setup is skipped", async () => {
    renderWizard();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Artist" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "artist@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Skip SSH setup" }),
    );

    await waitFor(() =>
      expect(commandMocks.saveAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          author: {
            email: "artist@example.test",
            name: "Artist",
          },
          settings: expect.objectContaining({
            git: expect.objectContaining({
              defaultAuthorSource: "gitGlobal",
            }),
          }),
          validateIdentity: true,
        }),
      ),
    );
  });

  it("switches between Git global and tool-level author drafts", async () => {
    commandMocks.settingsSnapshot.mockResolvedValueOnce({
      ...settingsSnapshot,
      identitySources: {
        ...settingsSnapshot.identitySources,
        globalGitconfig: {
          email: "global@example.test",
          name: "Global Author",
        },
        settings: {
          email: "tool@example.test",
          name: "Tool Author",
        },
      },
    });
    renderWizard();

    expect(await screen.findByLabelText("Name")).toHaveValue("Global Author");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Separate tool-level configuration",
      }),
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Tool Author");
    expect(screen.getByLabelText("Email")).toHaveValue("tool@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Skip SSH setup" }),
    );

    await waitFor(() =>
      expect(commandMocks.saveAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          author: {
            email: "tool@example.test",
            name: "Tool Author",
          },
          settings: expect.objectContaining({
            git: expect.objectContaining({
              defaultAuthorSource: "tool",
            }),
          }),
          validateIdentity: true,
        }),
      ),
    );
  });

  it("shows copy failures as a toast and preserves the original error", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const copyError = new Error("clipboard unavailable");
    const handleAppError = vi.fn();
    commandMocks.settingsSnapshot.mockResolvedValueOnce({
      ...settingsSnapshot,
      identitySources: {
        ...settingsSnapshot.identitySources,
        settings: { email: "artist@example.test", name: "Artist" },
      },
      settings: {
        git: {
          defaultAuthorSource: "tool",
          user: { email: "artist@example.test", name: "Artist" },
        },
      },
      sshKey: {
        exists: true,
        privateKeyPath: "/home/artist/.ssh/id_ed25519",
        publicKey: "ssh-ed25519 AAAA artist@example.test",
        publicKeyPath: "/home/artist/.ssh/id_ed25519.pub",
      },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(copyError) },
    });
    window.addEventListener("artistic-git:error", handleAppError);

    try {
      renderWizard();
      fireEvent.click(await screen.findByRole("button", { name: "Next" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Copy public key" }),
      );

      expect(await screen.findByText("Copy failed")).toBeInTheDocument();
      expect(handleAppError).toHaveBeenCalledTimes(1);
      expect((handleAppError.mock.calls[0][0] as CustomEvent).detail).toEqual({
        cause: copyError,
        operationName: "copySshPublicKey",
        summary: "Copy failed",
      });
    } finally {
      window.removeEventListener("artistic-git:error", handleAppError);
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });
});
