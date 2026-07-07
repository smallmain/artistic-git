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
  listBranches: vi.fn(),
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
  commandMocks.listBranches.mockResolvedValue({
    branches: [
      branchSummary("main", "localAndRemote"),
      branchSummary("release", "localAndRemote"),
      branchSummary("design", "remoteOnly"),
    ],
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

  it("validates automatic tracking rules before saving project settings", async () => {
    commandMocks.loadProjectSettings.mockResolvedValue({
      autoTrackingRules: [
        { sourceBranch: "main", targetBranch: "release" },
        { sourceBranch: "release", targetBranch: "main" },
      ],
      largeFileCheck: { enabled: true, thresholdMb: 50 },
      path: "/repo/art",
    });

    render(
      <TestProviders
        initialWindowState={{
          activeRepositoryPath: "/repo/art",
          settingsSection: "project",
        }}
      >
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(
      await screen.findAllByText(
        "Automatic tracking rules cannot form a cycle.",
      ),
    ).toHaveLength(2);

    const saveButtons = screen.getAllByRole("button", {
      name: "Save project settings",
    });
    expect(saveButtons.at(-1)).toBeDisabled();
  });

  it("warns when an automatic tracking target branch was deleted", async () => {
    commandMocks.loadProjectSettings.mockResolvedValue({
      autoTrackingRules: [{ sourceBranch: "main", targetBranch: "deleted" }],
      largeFileCheck: { enabled: true, thresholdMb: 50 },
      path: "/repo/art",
    });

    render(
      <TestProviders
        initialWindowState={{
          activeRepositoryPath: "/repo/art",
          settingsSection: "project",
        }}
      >
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(
      await screen.findByText("Target branch was deleted."),
    ).toBeInTheDocument();
    const saveButtons = screen.getAllByRole("button", {
      name: "Save project settings",
    });
    expect(saveButtons.at(-1)).toBeEnabled();
  });

  it("saves a valid automatic tracking rule with remote-only branch hints", async () => {
    commandMocks.saveProjectSettings.mockImplementation((request) =>
      Promise.resolve({
        autoTrackingRules: request.autoTrackingRules,
        largeFileCheck: request.largeFileCheck,
        path: request.repositoryPath,
      }),
    );

    render(
      <TestProviders
        initialWindowState={{
          activeRepositoryPath: "/repo/art",
          settingsSection: "project",
        }}
      >
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add automatic tracking rule",
      }),
    );
    fireEvent.change(screen.getByLabelText("Source origin branch"), {
      target: { value: "design" },
    });
    fireEvent.change(screen.getByLabelText("Target origin branch"), {
      target: { value: "release" },
    });

    expect(screen.getAllByText("design (remote only)")).toHaveLength(2);

    const saveButtons = screen.getAllByRole("button", {
      name: "Save project settings",
    });
    fireEvent.click(saveButtons.at(-1)!);

    await waitFor(() =>
      expect(commandMocks.saveProjectSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          autoTrackingRules: [
            { sourceBranch: "design", targetBranch: "release" },
          ],
          repositoryPath: "/repo/art",
        }),
      ),
    );
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

  it("persists the automatic update check setting", async () => {
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    const autoUpdateToggle = await screen.findByLabelText(
      "Check for updates automatically",
    );
    fireEvent.click(autoUpdateToggle);

    await waitFor(() =>
      expect(commandMocks.saveAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            updates: expect.objectContaining({
              autoCheck: false,
            }),
          }),
        }),
      ),
    );
  });

  it("shows about update status and dispatches a manual check request", async () => {
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");

    render(
      <TestProviders
        initialWindowState={{
          settingsSection: "about",
          updateStatus: {
            requestId: "manual-1",
            source: "manual",
            targetWindowLabel: "main",
            status: {
              message: "network unavailable",
              state: "failed",
              visible: true,
            },
          },
        }}
      >
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(
      await screen.findByText("Check failed: network unavailable"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "artistic-git:check-updates" }),
    );
  });

  it("shows ready update details in about and respects install gate state", async () => {
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");

    render(
      <TestProviders
        initialWindowState={{
          settingsSection: "about",
          updateInstallGate: {
            blocked: true,
            message: "finish conflict resolution before installing an update",
            reason: "conflict",
          },
          updateStatus: {
            requestId: "manual-ready-1",
            source: "manual",
            targetWindowLabel: "main",
            status: {
              notes: "Ready release notes",
              state: "ready",
              version: "0.2.0",
            },
          },
        }}
      >
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(
      await screen.findByText("Version 0.2.0 is ready to install."),
    ).toBeInTheDocument();
    expect(screen.getByText("Ready release notes")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Resolve active conflicts before restarting to install the update.",
      ),
    ).toBeInTheDocument();

    const installButton = screen.getByRole("button", {
      name: "Restart and install",
    });
    expect(installButton).toBeDisabled();

    fireEvent.click(installButton);
    expect(dispatchEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "artistic-git:install-update" }),
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

function branchSummary(
  shortName: string,
  existence: "localOnly" | "remoteOnly" | "localAndRemote",
) {
  return {
    ahead: 0,
    behind: 0,
    current: shortName === "main",
    existence,
    headOid: `${shortName}abcdef`,
    latestCommitUnixSeconds: "1760000000",
    name:
      existence === "remoteOnly"
        ? `refs/remotes/origin/${shortName}`
        : `refs/heads/${shortName}`,
    shortName,
    upstream: existence === "localAndRemote" ? `origin/${shortName}` : null,
  };
}
