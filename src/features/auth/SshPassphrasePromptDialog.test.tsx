import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { EventCallback } from "@tauri-apps/api/event";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createI18n } from "@/i18n/i18n";
import type {
  AuthPromptDismissedEvent,
  SshPassphrasePromptEvent,
} from "@/lib/ipc/commands";

import { SshPassphrasePromptDialog } from "./SshPassphrasePromptDialog";

const commandMocks = vi.hoisted(() => ({
  setAuthPromptListenerReady: vi.fn(),
  submitSshPassphrasePrompt: vi.fn(),
}));

const eventHandlers = new Map<string, EventCallback<unknown>>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, handler) => {
    eventHandlers.set(name, handler as EventCallback<unknown>);
    return vi.fn();
  }),
}));

vi.mock("@/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc/commands")>();
  return {
    ...actual,
    setAuthPromptListenerReady: commandMocks.setAuthPromptListenerReady,
    submitSshPassphrasePrompt: commandMocks.submitSshPassphrasePrompt,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  commandMocks.setAuthPromptListenerReady.mockResolvedValue(undefined);
  commandMocks.submitSshPassphrasePrompt.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

async function emitPrompt(payload: SshPassphrasePromptEvent) {
  await emitEvent("ssh-passphrase-prompt", payload);
}

async function emitDismissed(payload: AuthPromptDismissedEvent) {
  await emitEvent("ssh-passphrase-prompt-dismissed", payload);
}

async function emitEvent<T>(name: string, payload: T) {
  await waitFor(() => expect(eventHandlers.has(name)).toBe(true));
  act(() => {
    eventHandlers.get(name)?.({ payload } as Parameters<EventCallback<T>>[0]);
  });
}

describe("SshPassphrasePromptDialog", () => {
  it("submits the entered SSH passphrase for the active prompt", async () => {
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <SshPassphrasePromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-1",
      request: {
        keyId: "/Users/me/.ssh/id_ed25519",
        prompt: "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
        rememberAvailable: true,
      },
    });

    await waitFor(() =>
      expect(commandMocks.setAuthPromptListenerReady).toHaveBeenCalledWith({
        kind: "sshPassphrase",
        ready: true,
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "SSH passphrase required",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("SSH key")).toHaveValue(
      "/Users/me/.ssh/id_ed25519",
    );
    expect(
      screen.getByLabelText("Remember securely on this device"),
    ).toBeChecked();

    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "secret-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() =>
      expect(commandMocks.submitSshPassphrasePrompt).toHaveBeenCalledWith({
        cancelled: false,
        passphrase: "secret-passphrase",
        promptId: "prompt-1",
        remember: true,
      }),
    );
  });

  it("cancels without a passphrase when dismissed", async () => {
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <SshPassphrasePromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-2",
      request: {
        keyId: "/Users/me/.ssh/id_ed25519",
        prompt: "Enter passphrase:",
        rememberAvailable: false,
      },
    });

    expect(
      await screen.findByRole("heading", {
        name: "SSH passphrase required",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Remember securely on this device"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(commandMocks.submitSshPassphrasePrompt).toHaveBeenCalledWith({
        cancelled: true,
        promptId: "prompt-2",
        remember: false,
      }),
    );
  });

  it("shows cancellation on the cancel button while dismissal is pending", async () => {
    let resolveCancel: (() => void) | undefined;
    commandMocks.submitSshPassphrasePrompt.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    );
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <SshPassphrasePromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-cancel-pending",
      request: {
        keyId: "/Users/me/.ssh/id_ed25519",
        prompt: "Enter passphrase:",
        rememberAvailable: false,
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(
      screen.getByRole("button", { name: "Cancelling..." }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeDisabled();
    expect(screen.queryByText("Unlocking key...")).not.toBeInTheDocument();

    await act(async () => resolveCancel?.());
  });

  it("shows an explicit state while the key is being unlocked", async () => {
    let resolveSubmit: (() => void) | undefined;
    commandMocks.submitSshPassphrasePrompt.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      }),
    );
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <SshPassphrasePromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-pending",
      request: {
        keyId: "/Users/me/.ssh/id_ed25519",
        prompt: "Enter passphrase for an internal askpass request",
        rememberAvailable: true,
      },
    });

    expect(
      await screen.findByText("Enter the SSH key passphrase to continue."),
    ).toBeVisible();
    expect(
      screen.getByText("Enter passphrase for an internal askpass request"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(
      screen.getByRole("button", { name: "Unlocking key..." }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Passphrase")).toBeDisabled();
    expect(
      within(
        screen.getByRole("dialog", { name: "SSH passphrase required" }),
      ).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();

    await act(async () => resolveSubmit?.());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "SSH passphrase required" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("queues concurrent prompts and removes cancelled queued prompts", async () => {
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <SshPassphrasePromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-first",
      request: {
        keyId: "/keys/first",
        prompt: "",
        rememberAvailable: false,
      },
    });
    await emitPrompt({
      promptId: "prompt-second",
      request: {
        keyId: "/keys/second",
        prompt: "",
        rememberAvailable: false,
      },
    });
    expect(await screen.findByLabelText("SSH key")).toHaveValue("/keys/first");

    await emitDismissed({ promptId: "prompt-second" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "SSH passphrase required" }),
      ).not.toBeInTheDocument(),
    );
  });
});
