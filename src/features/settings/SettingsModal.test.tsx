import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n/LanguageProvider";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";
import { WindowStoreProvider } from "@/store/window-store";
import { ThemeProvider } from "@/theme/ThemeProvider";

import { defaultAppSettings } from "./settings-model";
import { SettingsModal } from "./SettingsModal";

const commandMocks = vi.hoisted(() => ({
  generateSshKey: vi.fn(),
  loadGitignore: vi.fn(),
  loadProjectSettings: vi.fn(),
  loadRemoteSettings: vi.fn(),
  saveAppSettings: vi.fn(),
  saveGitignore: vi.fn(),
  saveProjectSettings: vi.fn(),
  saveRemoteSettings: vi.fn(),
  settingsSnapshot: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => commandMocks);

beforeEach(() => {
  vi.clearAllMocks();
  commandMocks.settingsSnapshot.mockResolvedValue({
    appVersion: "0.1.0",
    identitySources: {
      globalGitconfig: { email: null, name: null },
      globalGitconfigPath: null,
      settings: { email: null, name: null },
    },
    settings: defaultAppSettings,
    sshKey: {
      exists: false,
      privateKeyPath: null,
      publicKey: null,
      publicKeyPath: null,
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("SettingsModal", () => {
  it("shows interval validation and disables saving when fetch interval is out of range", async () => {
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    const intervalInput = await screen.findByLabelText(
      "Fetch interval (seconds)",
    );
    fireEvent.change(intervalInput, { target: { value: "9" } });

    await waitFor(() =>
      expect(
        screen.getByText("Fetch interval must be between 10 and 3600 seconds."),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Save fetch settings" }),
    ).toBeDisabled();
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  const i18n = createI18n("en");

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={createAppQueryClient()}>
        <LanguageProvider i18n={i18n} initialPreference="en">
          <ThemeProvider initialPreference="light">
            <WindowStoreProvider>{children}</WindowStoreProvider>
          </ThemeProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
