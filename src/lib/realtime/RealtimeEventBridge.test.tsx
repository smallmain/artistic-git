import { QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "@/lib/query/client";

import { RealtimeEventBridge } from "./RealtimeEventBridge";

const bridgeMocks = vi.hoisted(() => ({
  installRealtimeEventBridge: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, isTauri: bridgeMocks.isTauri };
});

vi.mock("@/lib/realtime/events", () => ({
  installRealtimeEventBridge: bridgeMocks.installRealtimeEventBridge,
}));

beforeEach(() => {
  vi.clearAllMocks();
  bridgeMocks.isTauri.mockReturnValue(true);
});

describe("RealtimeEventBridge", () => {
  it("reports bridge installation errors in the desktop runtime", async () => {
    const bridgeError = {
      operation: "installRealtimeEventBridge",
      stderr: "event channel closed",
      summary: "Realtime updates are unavailable",
    };
    const receivedDetails: unknown[] = [];
    const handleError = (event: Event) => {
      receivedDetails.push((event as CustomEvent).detail);
    };
    bridgeMocks.installRealtimeEventBridge.mockRejectedValue(bridgeError);
    window.addEventListener("artistic-git:error", handleError);

    try {
      render(
        <QueryClientProvider client={createAppQueryClient()}>
          <RealtimeEventBridge />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(receivedDetails).toEqual([bridgeError]));
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("stays silent outside the desktop runtime", async () => {
    bridgeMocks.isTauri.mockReturnValue(false);
    bridgeMocks.installRealtimeEventBridge.mockRejectedValue(
      new Error("No Tauri"),
    );
    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);

    try {
      render(
        <QueryClientProvider client={createAppQueryClient()}>
          <RealtimeEventBridge />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(bridgeMocks.installRealtimeEventBridge).toHaveBeenCalled(),
      );
      expect(handleError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });

  it("does not report an installation failure after unmount", async () => {
    const bridgeError = new Error("stale bridge installation failed");
    let rejectInstallation: (error: unknown) => void = () => undefined;
    bridgeMocks.installRealtimeEventBridge.mockReturnValue(
      new Promise((_, reject) => {
        rejectInstallation = reject;
      }),
    );
    const handleError = vi.fn();
    window.addEventListener("artistic-git:error", handleError);

    try {
      const view = render(
        <QueryClientProvider client={createAppQueryClient()}>
          <RealtimeEventBridge />
        </QueryClientProvider>,
      );
      expect(bridgeMocks.installRealtimeEventBridge).toHaveBeenCalled();
      view.unmount();
      rejectInstallation(bridgeError);

      await Promise.resolve();
      expect(handleError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("artistic-git:error", handleError);
    }
  });
});
