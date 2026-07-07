import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n/LanguageProvider";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";
import type { WindowStoreState } from "@/store/window-store";
import { WindowStoreProvider } from "@/store/window-store";
import { ThemeProvider } from "@/theme/ThemeProvider";

import { defaultAppSettings } from "./settings-model";
import { SettingsModal } from "./SettingsModal";

const commandMocks = vi.hoisted(() => ({
  deleteHttpsCredential: vi.fn(),
  generateSshKey: vi.fn(),
  listHttpsCredentials: vi.fn(),
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
  commandMocks.listHttpsCredentials.mockResolvedValue({
    credentials: [
      {
        protocol: "https",
        host: "github.com",
        path: null,
        scope: "host",
        username: "alice",
      },
    ],
  });
  commandMocks.deleteHttpsCredential.mockResolvedValue(undefined);
  commandMocks.saveAppSettings.mockImplementation(({ settings }) =>
    Promise.resolve(settings),
  );
  commandMocks.loadProjectSettings.mockResolvedValue({
    largeFileCheck: { enabled: true, thresholdMb: 50 },
    path: "/repo/art",
  });
  commandMocks.loadGitignore.mockResolvedValue({
    content: "",
    exists: true,
    path: "/repo/art/.gitignore",
    repositoryPath: "/repo/art",
  });
  commandMocks.loadRemoteSettings.mockResolvedValue({
    originUrl: "https://example.test/repo.git",
    remoteMode: "origin",
    repositoryPath: "/repo/art",
  });
  commandMocks.saveRemoteSettings.mockResolvedValue({
    originUrl: null,
    remoteMode: "noRemote",
    repositoryPath: "/repo/art",
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

  it("invalidates repository queries after origin is removed", async () => {
    const queryClient = createAppQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <TestProviders
        initialWindowState={{
          activeRepositoryPath: "/repo/art",
          settingsSection: "project",
        }}
        queryClient={queryClient}
      >
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    const originInput = await screen.findByLabelText("Origin URL");
    fireEvent.change(originInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save remote" }));

    expect(
      await screen.findByText(
        "Save again to remove origin from this repository.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove origin" }));

    await waitFor(() =>
      expect(commandMocks.saveRemoteSettings).toHaveBeenCalledWith({
        originUrl: null,
        removeOrigin: true,
        repositoryPath: "/repo/art",
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["repository", "/repo/art", "summary"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["repository", "/repo/art", "branches"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["repository", "/repo/art", "history"],
    });
  });

  it("lists and forgets saved HTTPS credentials with confirmation", async () => {
    commandMocks.listHttpsCredentials
      .mockResolvedValueOnce({
        credentials: [
          {
            protocol: "https",
            host: "github.com",
            path: null,
            scope: "host",
            username: "alice",
          },
        ],
      })
      .mockResolvedValueOnce({ credentials: [] });

    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(await screen.findByText("github.com")).toBeInTheDocument();
    expect(screen.getByText("alice - Host credential")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Forget credential" }));
    expect(
      await screen.findByText("Select the credential again to forget it."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm forget" }));

    await waitFor(() =>
      expect(commandMocks.deleteHttpsCredential).toHaveBeenCalledWith({
        protocol: "https",
        host: "github.com",
        path: null,
        scope: "host",
      }),
    );
    expect(await screen.findByText("Credential forgotten")).toBeInTheDocument();
    expect(
      screen.getByText("No HTTPS credentials are saved."),
    ).toBeInTheDocument();
  });

  it("persists the SSH passphrase remember setting", async () => {
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    const rememberToggle = await screen.findByLabelText(
      "Remember SSH passphrases in secure storage",
    );
    fireEvent.click(rememberToggle);

    await waitFor(() =>
      expect(commandMocks.saveAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            git: expect.objectContaining({
              rememberSshPassphrase: true,
            }),
          }),
        }),
      ),
    );
  });
});

function TestProviders({
  children,
  initialWindowState,
  queryClient,
}: {
  children: ReactNode;
  initialWindowState?: Partial<WindowStoreState>;
  queryClient?: QueryClient;
}) {
  const i18n = createI18n("en");

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient ?? createAppQueryClient()}>
        <LanguageProvider i18n={i18n} initialPreference="en">
          <ThemeProvider initialPreference="light">
            <WindowStoreProvider initialState={initialWindowState}>
              {children}
            </WindowStoreProvider>
          </ThemeProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
