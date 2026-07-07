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
import type { HttpsCredentialPromptEvent } from "@/lib/ipc/commands";

import { HttpsCredentialPromptDialog } from "./HttpsCredentialPromptDialog";

const commandMocks = vi.hoisted(() => ({
  submitHttpsCredentialPrompt: vi.fn(),
}));

let promptHandler: EventCallback<HttpsCredentialPromptEvent> | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, handler) => {
    promptHandler = handler as EventCallback<HttpsCredentialPromptEvent>;
    return vi.fn();
  }),
}));

vi.mock("@/lib/ipc/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc/commands")>();
  return {
    ...actual,
    submitHttpsCredentialPrompt: commandMocks.submitHttpsCredentialPrompt,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  promptHandler = null;
  commandMocks.submitHttpsCredentialPrompt.mockResolvedValue(undefined);
});

describe("HttpsCredentialPromptDialog", () => {
  it("submits entered HTTPS credentials for the active prompt", async () => {
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <HttpsCredentialPromptDialog />
      </I18nextProvider>,
    );

    await waitFor(() => expect(promptHandler).not.toBeNull());
    act(() => {
      promptHandler?.({
        payload: {
          promptId: "prompt-1",
          request: {
            defaultScope: "host",
            host: "github.com",
            path: "smallmain/artistic-git",
            protocol: "https",
            reason: "missing",
            suggestedUsername: "alice",
          },
        },
      } as Parameters<EventCallback<HttpsCredentialPromptEvent>>[0]);
    });

    expect(
      await screen.findByRole("heading", {
        name: "HTTPS credentials required",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveValue("alice");
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: "new-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(commandMocks.submitHttpsCredentialPrompt).toHaveBeenCalledWith({
        cancelled: false,
        promptId: "prompt-1",
        scope: "host",
        token: "new-token",
        username: "alice",
      }),
    );
  });
});
