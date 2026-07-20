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
  HttpsCredentialPromptEvent,
} from "@/lib/ipc/commands";

import { HttpsCredentialPromptDialog } from "./HttpsCredentialPromptDialog";

const commandMocks = vi.hoisted(() => ({
  setAuthPromptListenerReady: vi.fn(),
  submitHttpsCredentialPrompt: vi.fn(),
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
    submitHttpsCredentialPrompt: commandMocks.submitHttpsCredentialPrompt,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  commandMocks.setAuthPromptListenerReady.mockResolvedValue(undefined);
  commandMocks.submitHttpsCredentialPrompt.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

async function emitPrompt(payload: HttpsCredentialPromptEvent) {
  await emitEvent("https-credential-prompt", payload);
}

async function emitDismissed(payload: AuthPromptDismissedEvent) {
  await emitEvent("https-credential-prompt-dismissed", payload);
}

async function emitEvent<T>(name: string, payload: T) {
  await waitFor(() => expect(eventHandlers.has(name)).toBe(true));
  act(() => {
    eventHandlers.get(name)?.({ payload } as Parameters<EventCallback<T>>[0]);
  });
}

describe("HttpsCredentialPromptDialog", () => {
  it("submits entered HTTPS credentials for the active prompt", async () => {
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <HttpsCredentialPromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-1",
      request: {
        defaultScope: "host",
        host: "github.com",
        path: "smallmain/artistic-git",
        protocol: "https",
        reason: "missing",
        suggestedUsername: "alice",
      },
    });

    await waitFor(() =>
      expect(commandMocks.setAuthPromptListenerReady).toHaveBeenCalledWith({
        kind: "httpsCredential",
        ready: true,
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "HTTPS credentials required",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveValue("alice");
    fireEvent.change(screen.getByLabelText("Access token"), {
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

  it("shows an explicit state while credentials are being verified", async () => {
    let resolveSubmit: (() => void) | undefined;
    commandMocks.submitHttpsCredentialPrompt.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      }),
    );
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <HttpsCredentialPromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-pending",
      request: {
        defaultScope: "host",
        host: "github.com",
        path: "smallmain/artistic-git",
        protocol: "https",
        reason: "missing",
        suggestedUsername: "alice",
      },
    });

    await screen.findByRole("heading", { name: "HTTPS credentials required" });
    fireEvent.change(screen.getByLabelText("Access token"), {
      target: { value: "new-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByRole("button", { name: "Verifying credentials..." }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Username")).toBeDisabled();
    expect(screen.getByLabelText("Access token")).toBeDisabled();
    expect(
      within(
        screen.getByRole("dialog", { name: "HTTPS credentials required" }),
      ).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();

    await act(async () => resolveSubmit?.());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "HTTPS credentials required" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows cancellation on the cancel button while dismissal is pending", async () => {
    let resolveCancel: (() => void) | undefined;
    commandMocks.submitHttpsCredentialPrompt.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    );
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <HttpsCredentialPromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-cancel-pending",
      request: {
        defaultScope: "host",
        host: "github.com",
        path: "smallmain/artistic-git",
        protocol: "https",
        reason: "missing",
        suggestedUsername: "alice",
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(
      screen.getByRole("button", { name: "Cancelling..." }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(
      screen.queryByText("Verifying credentials..."),
    ).not.toBeInTheDocument();

    await act(async () => resolveCancel?.());
  });

  it("queues concurrent prompts and advances after the active prompt finishes", async () => {
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <HttpsCredentialPromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-first",
      request: {
        defaultScope: "host",
        host: "first.example.test",
        path: null,
        protocol: "https",
        reason: "missing",
        suggestedUsername: "first-user",
      },
    });
    await emitPrompt({
      promptId: "prompt-second",
      request: {
        defaultScope: "host",
        host: "second.example.test",
        path: null,
        protocol: "https",
        reason: "missing",
        suggestedUsername: "second-user",
      },
    });

    expect(await screen.findByLabelText("Host")).toHaveValue(
      "first.example.test",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Host")).toHaveValue("second.example.test"),
    );
    expect(commandMocks.submitHttpsCredentialPrompt).toHaveBeenCalledWith({
      cancelled: true,
      promptId: "prompt-first",
    });
  });

  it("dismisses a queued prompt when its operation is cancelled", async () => {
    render(
      <I18nextProvider i18n={createI18n("en")}>
        <HttpsCredentialPromptDialog />
      </I18nextProvider>,
    );

    await emitPrompt({
      promptId: "prompt-active",
      request: {
        defaultScope: "host",
        host: "active.example.test",
        path: null,
        protocol: "https",
        reason: "missing",
        suggestedUsername: null,
      },
    });
    await emitPrompt({
      promptId: "prompt-cancelled",
      request: {
        defaultScope: "host",
        host: "cancelled.example.test",
        path: null,
        protocol: "https",
        reason: "missing",
        suggestedUsername: null,
      },
    });
    await emitDismissed({ promptId: "prompt-cancelled" });
    const dialog = await screen.findByRole("dialog", {
      name: "HTTPS credentials required",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "HTTPS credentials required" }),
      ).not.toBeInTheDocument(),
    );
  });
});
