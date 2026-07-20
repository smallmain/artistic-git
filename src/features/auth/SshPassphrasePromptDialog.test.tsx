import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { EventCallback } from "@tauri-apps/api/event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createI18n } from "@/i18n/i18n";
import type { SshPassphrasePromptEvent } from "@/lib/ipc/commands";

import { SshPassphrasePromptDialog } from "./SshPassphrasePromptDialog";

const commandMocks = vi.hoisted(() => ({
  submitSshPassphrasePrompt: vi.fn(),
}));

let promptHandler: EventCallback<SshPassphrasePromptEvent> | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, handler) => {
    promptHandler = handler as EventCallback<SshPassphrasePromptEvent>;
    return vi.fn();
  }),
}));

vi.mock("@/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc/commands")>();
  return {
    ...actual,
    submitSshPassphrasePrompt: commandMocks.submitSshPassphrasePrompt,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  promptHandler = null;
  commandMocks.submitSshPassphrasePrompt.mockResolvedValue(undefined);
});

describe("SshPassphrasePromptDialog", () => {
  it("submits the entered SSH passphrase for the active prompt", async () => {
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <SshPassphrasePromptDialog />
      </I18nextProvider>,
    );

    await waitFor(() => expect(promptHandler).not.toBeNull());
    act(() => {
      promptHandler?.({
        payload: {
          promptId: "prompt-1",
          request: {
            keyId: "/Users/me/.ssh/id_ed25519",
            prompt: "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
            rememberAvailable: true,
          },
        },
      } as Parameters<EventCallback<SshPassphrasePromptEvent>>[0]);
    });

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

    await waitFor(() => expect(promptHandler).not.toBeNull());
    act(() => {
      promptHandler?.({
        payload: {
          promptId: "prompt-2",
          request: {
            keyId: "/Users/me/.ssh/id_ed25519",
            prompt: "Enter passphrase:",
            rememberAvailable: false,
          },
        },
      } as Parameters<EventCallback<SshPassphrasePromptEvent>>[0]);
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
});
