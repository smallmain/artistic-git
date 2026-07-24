import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n/LanguageProvider";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";
import type { WindowStoreApi, WindowStoreState } from "@/store/window-store";
import { createWindowStore, WindowStoreProvider } from "@/store/window-store";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { ToastViewport } from "@/components/ui/toast-viewport";

import { defaultAppSettings } from "./settings-model";
import { SettingsModal } from "./SettingsModal";

const commandMocks = vi.hoisted(() => ({
  deleteHttpsCredential: vi.fn(),
  generateSshKey: vi.fn(),
  listBranches: vi.fn(),
  listHttpsCredentials: vi.fn(),
  loadGitignore: vi.fn(),
  loadProjectSettings: vi.fn(),
  loadRepositoryAuthorSettings: vi.fn(),
  loadRemoteSettings: vi.fn(),
  openUpdateReleasePage: vi.fn(),
  saveAppSettings: vi.fn(),
  saveGitignore: vi.fn(),
  saveHttpsCredential: vi.fn(),
  saveProjectSettings: vi.fn(),
  saveRepositoryAuthorSettings: vi.fn(),
  saveRemoteSettings: vi.fn(),
  settingsSnapshot: vi.fn(),
}));

vi.mock("@/lib/ipc/commands", () => commandMocks);

beforeEach(() => {
  vi.resetAllMocks();
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
  commandMocks.saveHttpsCredential.mockResolvedValue({
    protocol: "https",
    host: "github.com",
    path: null,
    scope: "host",
    username: "alice",
  });
  commandMocks.saveAppSettings.mockImplementation(({ settings }) =>
    Promise.resolve(settings),
  );
  commandMocks.loadProjectSettings.mockResolvedValue({
    largeFileCheck: { enabled: true, thresholdMb: 50 },
    path: "/repo/art",
  });
  commandMocks.loadRepositoryAuthorSettings.mockResolvedValue({
    defaultAuthor: { email: null, name: null },
    repositoryAuthor: { email: null, name: null },
    repositoryPath: "/repo/art",
    settings: defaultAppSettings,
    source: "toolDefault",
  });
  commandMocks.saveRepositoryAuthorSettings.mockImplementation(
    ({ author, repositoryPath, source }) =>
      Promise.resolve({
        defaultAuthor: source === "toolDefault" ? author : {},
        repositoryAuthor: source === "repository" ? author : {},
        repositoryPath,
        settings: defaultAppSettings,
        source,
      }),
  );
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
  it("keeps every settings form locked until the current settings load succeeds", async () => {
    const loadError = {
      operation: "settingsSnapshot",
      stderr: "settings file is unreadable",
      summary: "Unable to load settings",
    };
    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    commandMocks.settingsSnapshot
      .mockRejectedValueOnce(loadError)
      .mockResolvedValueOnce({
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
    window.addEventListener("artistic-git:error", handleError);

    try {
      render(
        <TestProviders initialWindowState={{ appSettings: null }}>
          <SettingsModal onOpenChange={vi.fn()} open />
        </TestProviders>,
      );

      expect(
        await screen.findByRole("heading", { name: "Couldn't load settings" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Save author information" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save project settings" }),
      ).not.toBeInTheDocument();
      expect(commandMocks.saveAppSettings).not.toHaveBeenCalled();
      expect(receivedDetails).toEqual([loadError]);

      fireEvent.click(
        screen.getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails).toEqual([loadError, loadError]);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      expect(
        await screen.findByRole("button", {
          name: "Save update check settings",
        }),
      ).toBeVisible();
      expect(commandMocks.settingsSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("shows identity validation once beside the identity fields", async () => {
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Save author information" }),
    );

    expect(
      screen.getAllByText("Enter both author name and email before saving."),
    ).toHaveLength(1);
  });

  it("keeps default author drafts separate and saves the selected destination", async () => {
    commandMocks.settingsSnapshot.mockResolvedValueOnce({
      appVersion: "0.2.5",
      identitySources: {
        globalGitconfig: {
          email: "global@example.test",
          name: "Global Author",
        },
        globalGitconfigPath: "/home/artist/.gitconfig",
        settings: {
          email: "tool@example.test",
          name: "Tool Author",
        },
      },
      settings: defaultAppSettings,
      sshKey: {
        exists: false,
        privateKeyPath: null,
        publicKey: null,
        publicKeyPath: null,
      },
    });
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(await screen.findByLabelText("Name")).toHaveValue("Global Author");
    expect(screen.getByLabelText("Email")).toHaveValue("global@example.test");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Separate tool-level configuration",
      }),
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Tool Author");
    expect(screen.getByLabelText("Email")).toHaveValue("tool@example.test");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Edited Tool Author" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Follow global Git configuration" }),
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Global Author");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Separate tool-level configuration",
      }),
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Edited Tool Author");

    fireEvent.click(
      screen.getByRole("button", { name: "Save author information" }),
    );
    await waitFor(() =>
      expect(commandMocks.saveAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          author: {
            email: "tool@example.test",
            name: "Edited Tool Author",
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

  it("loads repository branches only when project settings are opened", async () => {
    render(
      <TestProviders initialWindowState={{ activeRepositoryPath: "/repo/art" }}>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    await screen.findByRole("button", {
      name: "Save update check settings",
    });
    expect(commandMocks.listBranches).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Project" }));

    await screen.findByLabelText("Remote repository URL");
    expect(commandMocks.listBranches).toHaveBeenCalledTimes(1);
    expect(commandMocks.listBranches).toHaveBeenCalledWith({
      repositoryPath: "/repo/art",
    });
  });

  it("saves a separate repository-level author", async () => {
    commandMocks.loadRepositoryAuthorSettings.mockResolvedValueOnce({
      defaultAuthor: {
        email: "default@example.test",
        name: "Default Author",
      },
      repositoryAuthor: { email: null, name: null },
      repositoryPath: "/repo/art",
      settings: defaultAppSettings,
      source: "toolDefault",
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

    expect(await screen.findByLabelText("Name")).toHaveValue("Default Author");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Separate repository-level configuration",
      }),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Repository Author" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "repository@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save repository author information",
      }),
    );

    await waitFor(() =>
      expect(commandMocks.saveRepositoryAuthorSettings).toHaveBeenCalledWith({
        author: {
          email: "repository@example.test",
          name: "Repository Author",
        },
        repositoryPath: "/repo/art",
        source: "repository",
      }),
    );
  });

  it("preserves unsaved project drafts when switching settings sections", async () => {
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

    const remoteInput = await screen.findByLabelText("Remote repository URL");
    const gitignoreEditor = screen.getByRole("textbox", { name: ".gitignore" });
    fireEvent.change(remoteInput, {
      target: { value: "https://example.test/draft.git" },
    });
    fireEvent.change(gitignoreEditor, { target: { value: "*.draft\n" } });
    await waitFor(() => {
      expect(commandMocks.loadProjectSettings).toHaveBeenCalledTimes(1);
      expect(commandMocks.loadGitignore).toHaveBeenCalledTimes(1);
      expect(commandMocks.loadRemoteSettings).toHaveBeenCalledTimes(1);
      expect(commandMocks.listBranches).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.click(screen.getByRole("button", { name: "Project" }));

    expect(screen.getByLabelText("Remote repository URL")).toHaveValue(
      "https://example.test/draft.git",
    );
    expect(screen.getByRole("textbox", { name: ".gitignore" })).toHaveValue(
      "*.draft\n",
    );
    expect(commandMocks.loadProjectSettings).toHaveBeenCalledTimes(1);
    expect(commandMocks.loadGitignore).toHaveBeenCalledTimes(1);
    expect(commandMocks.loadRemoteSettings).toHaveBeenCalledTimes(1);
    expect(commandMocks.listBranches).toHaveBeenCalledTimes(1);
  });

  it("isolates a failed project source and retries it without blocking other settings", async () => {
    const loadError = {
      operation: "loadGitignore",
      stderr: "permission denied",
      summary: "Could not read .gitignore",
    };
    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    commandMocks.loadGitignore.mockRejectedValueOnce(loadError);
    window.addEventListener("artistic-git:error", handleError);

    try {
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
        await screen.findByText(
          "This section could not be loaded. Other project settings remain available.",
        ),
      ).toBeVisible();
      expect(screen.getByLabelText("Remote repository URL")).toHaveValue(
        "https://example.test/repo.git",
      );
      expect(
        screen.getAllByRole("button", { name: "Save project settings" }),
      ).toEqual(expect.arrayContaining([expect.any(HTMLButtonElement)]));
      for (const button of screen.getAllByRole("button", {
        name: "Save project settings",
      })) {
        expect(button).toBeEnabled();
      }
      expect(
        screen.queryByRole("button", { name: "Save .gitignore" }),
      ).not.toBeInTheDocument();
      expect(commandMocks.saveProjectSettings).not.toHaveBeenCalled();
      expect(commandMocks.saveGitignore).not.toHaveBeenCalled();
      expect(commandMocks.saveRemoteSettings).not.toHaveBeenCalled();
      expect(receivedDetails).toEqual([loadError]);

      fireEvent.click(
        screen.getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails).toEqual([loadError, loadError]);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      expect(
        await screen.findByRole("button", { name: "Save .gitignore" }),
      ).toBeEnabled();
      expect(commandMocks.loadGitignore).toHaveBeenCalledTimes(2);
      expect(commandMocks.loadProjectSettings).toHaveBeenCalledTimes(1);
      expect(commandMocks.loadRemoteSettings).toHaveBeenCalledTimes(1);
      expect(commandMocks.listBranches).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Remote repository URL")).toHaveValue(
        "https://example.test/repo.git",
      );
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("shows interval validation and disables saving when fetch interval is out of range", async () => {
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    const intervalInput = await screen.findByLabelText(
      "Check interval (seconds)",
    );
    fireEvent.change(intervalInput, { target: { value: "9" } });

    await waitFor(() =>
      expect(
        screen.getByText(
          "The check interval must be between 10 and 3600 seconds.",
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Save update check settings" }),
    ).toBeDisabled();
  });

  it("blocks closing and repeated saves while settings are being written", async () => {
    let finishSave: (() => void) | undefined;
    commandMocks.saveAppSettings.mockImplementation(
      ({ settings }) =>
        new Promise((resolve) => {
          finishSave = () => resolve(settings);
        }),
    );
    const onOpenChange = vi.fn();
    render(
      <TestProviders>
        <SettingsModal onOpenChange={onOpenChange} open />
      </TestProviders>,
    );

    const saveButton = await screen.findByRole("button", {
      name: "Save update check settings",
    });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(commandMocks.saveAppSettings).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Saving settings...")).toBeInTheDocument();
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons).toHaveLength(1);
    expect(closeButtons[0]).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => {
      finishSave?.();
    });
    await waitFor(() => expect(closeButtons[0]).toBeEnabled());
  });

  it("blocks stale settings immediately when the modal reopens", async () => {
    const onOpenChange = vi.fn();
    const view = render(
      <TestProviders>
        <SettingsModal onOpenChange={onOpenChange} open />
      </TestProviders>,
    );
    await screen.findByRole("button", {
      name: "Save update check settings",
    });

    view.rerender(<TestProviders>{null}</TestProviders>);
    commandMocks.settingsSnapshot.mockReturnValueOnce(
      new Promise(() => undefined),
    );
    commandMocks.listHttpsCredentials.mockReturnValueOnce(
      new Promise(() => undefined),
    );
    view.rerender(
      <TestProviders>
        <SettingsModal onOpenChange={onOpenChange} open />
      </TestProviders>,
    );

    expect(screen.getByTestId("settings-content")).toHaveAttribute("inert");
    expect(screen.getByRole("status")).toHaveTextContent("Loading settings...");
    expect(screen.getAllByText("Loading settings...")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("relies on the repository change event after origin is removed", async () => {
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

    const originInput = await screen.findByLabelText("Remote repository URL");
    fireEvent.change(originInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save remote" }));

    expect(
      await screen.findByText(
        "Select Disconnect remote repository to confirm.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Select Disconnect remote repository to confirm."),
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect remote repository" }),
    );

    await waitFor(() =>
      expect(commandMocks.saveRemoteSettings).toHaveBeenCalledWith({
        originUrl: null,
        removeOrigin: true,
        repositoryPath: "/repo/art",
      }),
    );
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("clears form-specific guidance when switching settings sections", async () => {
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

    const remoteInput = await screen.findByLabelText("Remote repository URL");
    fireEvent.change(remoteInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save remote" }));
    expect(
      await screen.findByText(
        "Select Disconnect remote repository to confirm.",
      ),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(
      screen.queryByText("Select Disconnect remote repository to confirm."),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText("Updates haven't been checked yet."),
    ).toBeVisible();
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
        "These rules create an update loop. Change one of the selected branches.",
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
      await screen.findByText("The selected update source no longer exists."),
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
        name: "Add automatic branch update",
      }),
    );
    chooseBranch("Branch to update", "design", "design (remote only)");
    chooseBranch("Get updates from", "release");

    expect(screen.getByText("design (remote only)")).toBeInTheDocument();

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
    expect(
      screen.getByText("alice - All repositories on this host"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove saved credential" }),
    );
    expect(
      await screen.findByText(
        "Select Remove saved credential again to confirm.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));

    await waitFor(() =>
      expect(commandMocks.deleteHttpsCredential).toHaveBeenCalledWith({
        protocol: "https",
        host: "github.com",
        path: null,
        scope: "host",
      }),
    );
    expect(await screen.findByText("Credential removed")).toBeInTheDocument();
    expect(
      screen.getByText("No HTTPS credentials are saved."),
    ).toBeInTheDocument();
  });

  it("does not present a credential load failure as an empty credential list", async () => {
    const loadError = {
      operation: "listHttpsCredentials",
      stderr: "secure storage is locked",
      summary: "Unable to list credentials",
    };
    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    commandMocks.listHttpsCredentials
      .mockRejectedValueOnce(loadError)
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
      });
    window.addEventListener("artistic-git:error", handleError);

    try {
      render(
        <TestProviders>
          <SettingsModal onOpenChange={vi.fn()} open />
        </TestProviders>,
      );

      expect(
        await screen.findByText("Couldn't load saved credentials"),
      ).toBeVisible();
      expect(
        screen.queryByText("No HTTPS credentials are saved."),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Add credential" }),
      ).not.toBeInTheDocument();
      expect(receivedDetails).toEqual([loadError]);

      fireEvent.click(
        screen.getByRole("button", { name: "View error details" }),
      );
      expect(receivedDetails).toEqual([loadError, loadError]);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      expect(await screen.findByText("github.com")).toBeVisible();
      expect(commandMocks.listHttpsCredentials).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("clears credential guidance when editing is cancelled", async () => {
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Add credential" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(
      screen.getByText("Enter host and username before saving."),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByText("Enter host and username before saving."),
    ).not.toBeInTheDocument();
  });

  it("labels credential deletion accurately while it is pending", async () => {
    let finishDelete: (() => void) | undefined;
    commandMocks.deleteHttpsCredential.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    );
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove saved credential" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));

    expect(
      await screen.findByText("Deleting saved credential..."),
    ).toBeVisible();
    expect(screen.queryByText("Saving settings...")).not.toBeInTheDocument();

    await act(async () => finishDelete?.());
  });

  it("paginates large saved credential lists", async () => {
    commandMocks.listHttpsCredentials.mockResolvedValue({
      credentials: Array.from({ length: 120 }, (_, index) => ({
        host: `git-${index}.example.test`,
        path: null,
        protocol: "https",
        scope: "host" as const,
        username: `user-${index}`,
      })),
    });

    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    await screen.findByText("git-0.example.test");
    expect(screen.getAllByTestId("https-credential-item")).toHaveLength(50);
    expect(screen.getByText("Credential page 1 of 3")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Next credential page" }),
    );

    expect(screen.getByText("git-50.example.test")).toBeInTheDocument();
    expect(screen.getAllByTestId("https-credential-item")).toHaveLength(50);
  });

  it("edits saved HTTPS credentials without exposing the existing token", async () => {
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
      .mockResolvedValueOnce({
        credentials: [
          {
            protocol: "https",
            host: "github.com",
            path: null,
            scope: "host",
            username: "bob",
          },
        ],
      });

    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(await screen.findByText("github.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(commandMocks.saveHttpsCredential).toHaveBeenCalledWith({
        protocol: "https",
        host: "github.com",
        path: null,
        scope: "host",
        username: "bob",
        token: null,
      }),
    );
    expect(await screen.findByText("Credential saved")).toBeInTheDocument();
    expect(
      screen.getByText("bob - All repositories on this host"),
    ).toBeInTheDocument();
  });

  it("preserves an HTTPS credential draft while switching sections", async () => {
    render(
      <TestProviders initialWindowState={{ activeRepositoryPath: "/repo/art" }}>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(await screen.findByText("github.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "path" },
    });
    fireEvent.change(screen.getByLabelText("Repository path"), {
      target: { value: "team/art" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "draft-user" },
    });
    fireEvent.change(screen.getByLabelText("Access token"), {
      target: { value: "draft-token" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    await screen.findByLabelText("Remote repository URL");
    fireEvent.click(screen.getByRole("button", { name: "General" }));

    expect(await screen.findByLabelText("Repository path")).toHaveValue(
      "team/art",
    );
    expect(screen.getByLabelText("Username")).toHaveValue("draft-user");
    expect(screen.getByLabelText("Access token")).toHaveValue("draft-token");
    expect(commandMocks.listHttpsCredentials).toHaveBeenCalledTimes(1);
  });

  it("shows copy failures as a toast and preserves the original error", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const copyError = new Error("clipboard permission denied");
    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(copyError) },
    });
    window.addEventListener("artistic-git:error", handleError);

    try {
      render(
        <TestProviders
          initialWindowState={{ activeRepositoryPath: "/repo/art" }}
        >
          <SettingsModal onOpenChange={vi.fn()} open />
        </TestProviders>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Project" }));
      await screen.findByDisplayValue("https://example.test/repo.git");
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));

      expect(await screen.findByText("Copy failed")).toBeInTheDocument();
      expect(
        within(screen.getByRole("dialog", { name: "Settings" })).queryByText(
          "Copy failed",
        ),
      ).not.toBeInTheDocument();
      expect(receivedDetails).toEqual([
        {
          cause: copyError,
          operationName: "copyRemoteUrl",
          summary: "Copy failed",
        },
      ]);
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
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

  it("persists the Gravatar privacy setting immediately", async () => {
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    fireEvent.click(await screen.findByLabelText("Enable Gravatar avatars"));

    await waitFor(() =>
      expect(commandMocks.saveAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            privacy: expect.objectContaining({ gravatarEnabled: true }),
          }),
        }),
      ),
    );
  });

  it("uses the newly selected language for the save result toast", async () => {
    render(
      <TestProviders>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    fireEvent.change(await screen.findByLabelText("Language"), {
      target: { value: "zh-CN" },
    });

    expect(await screen.findByText("设置已保存")).toBeInTheDocument();
    expect(screen.queryByText("Settings saved")).not.toBeInTheDocument();
  });

  it("reports a completed manual update check in a toast", async () => {
    const windowStore = createWindowStore({ settingsSection: "about" });
    render(
      <TestProviders windowStore={windowStore}>
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    act(() => {
      windowStore.getState().setUpdateStatus({
        requestId: "manual-current-1",
        source: "manual",
        status: { state: "checking" },
        targetWindowLabel: "main",
      });
    });
    act(() => {
      windowStore.getState().setUpdateStatus({
        requestId: "manual-current-1",
        source: "manual",
        status: { state: "notAvailable" },
        targetWindowLabel: "main",
      });
    });

    expect(await screen.findByTestId("app-toast")).toHaveTextContent(
      "Artistic Git is up to date.",
    );
    expect(
      screen.queryByText("Updates haven't been checked yet."),
    ).not.toBeInTheDocument();
  });

  it("shows silent automatic failures in about and dispatches a manual check request", async () => {
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");

    render(
      <TestProviders
        initialWindowState={{
          settingsSection: "about",
          updateStatus: {
            requestId: "automatic-1",
            source: "automatic",
            targetWindowLabel: "main",
            status: {
              message: "network unavailable",
              state: "failed",
              visible: false,
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

  it("shows automatic download progress and release notes in about", async () => {
    render(
      <TestProviders
        initialWindowState={{
          settingsSection: "about",
          updateStatus: {
            requestId: "automatic-download-1",
            source: "automatic",
            targetWindowLabel: "main",
            status: {
              downloadedBytes: 50,
              notes: "Automatic release notes",
              progress: 0.5,
              state: "downloading",
              totalBytes: 100,
              version: "0.2.0",
            },
          },
        }}
      >
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(
      await screen.findByText("Downloading version 0.2.0 (50%)..."),
    ).toBeInTheDocument();
    expect(screen.getByText("Automatic release notes")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeDisabled();
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

  it("localizes the temporary update preparation gate", async () => {
    render(
      <TestProviders
        initialWindowState={{
          settingsSection: "about",
          updateInstallGate: {
            blocked: true,
            message: "no downloaded update is ready to install",
            reason: "noReadyUpdate",
          },
          updateStatus: {
            requestId: "manual-ready-preparing",
            source: "manual",
            targetWindowLabel: "main",
            status: {
              notes: null,
              state: "ready",
              version: "0.2.0",
            },
          },
        }}
      >
        <SettingsModal onOpenChange={vi.fn()} open />
      </TestProviders>,
    );

    expect(await screen.findByText("Preparing the update...")).toBeVisible();
    expect(
      screen.queryByText("no downloaded update is ready to install"),
    ).not.toBeInTheDocument();
  });
});

function TestProviders({
  children,
  initialWindowState,
  queryClient,
  windowStore,
}: {
  children: ReactNode;
  initialWindowState?: Partial<WindowStoreState>;
  queryClient?: QueryClient;
  windowStore?: WindowStoreApi;
}) {
  const i18n = createI18n("en");

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient ?? createAppQueryClient()}>
        <LanguageProvider i18n={i18n} initialPreference="en">
          <ThemeProvider initialPreference="light">
            <WindowStoreProvider
              initialState={initialWindowState}
              store={windowStore}
            >
              {children}
              <ToastViewport />
            </WindowStoreProvider>
          </ThemeProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

function chooseBranch(label: string, branch: string, optionLabel = branch) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search branches" }), {
    target: { value: branch },
  });
  fireEvent.click(screen.getByRole("option", { name: optionLabel }));
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
