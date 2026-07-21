import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listenRuntimeEvent } from "@/lib/ipc/events";

const listenMock = vi.mocked(listen);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    configurable: true,
    value: {
      unregisterListener: vi.fn(),
    },
  });
});

describe("runtime event listeners", () => {
  it("unregisters each listener at most once", async () => {
    const rawUnlisten = vi.fn();
    listenMock.mockResolvedValue(rawUnlisten);

    const unlisten = await listenRuntimeEvent("repo-changed", vi.fn());
    unlisten();
    unlisten();

    expect(rawUnlisten).toHaveBeenCalledTimes(1);
  });

  it("consumes Tauri's stale-listener rejection from its async unlisten", async () => {
    const rawUnlisten = vi.fn(() =>
      Promise.reject(
        new TypeError(
          "undefined is not an object (evaluating 'listeners[eventId].handlerId')",
        ),
      ),
    );
    listenMock.mockResolvedValue(rawUnlisten);

    const unlisten = await listenRuntimeEvent("repo-changed", vi.fn());
    unlisten();
    await Promise.resolve();

    expect(rawUnlisten).toHaveBeenCalledTimes(1);
  });

  it("allows Tauri to finish unlistening when its local listener entry is gone", async () => {
    const unregisterListener = vi.fn(() => {
      throw new TypeError(
        "undefined is not an object (evaluating 'listeners[eventId].handlerId')",
      );
    });
    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener =
      unregisterListener;
    const backendUnlisten = vi.fn();
    listenMock.mockResolvedValue(() => {
      window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(
        "repo-changed",
        7,
      );
      backendUnlisten();
    });

    const unlisten = await listenRuntimeEvent("repo-changed", vi.fn());

    expect(() => unlisten()).not.toThrow();
    expect(unregisterListener).toHaveBeenCalledWith("repo-changed", 7);
    expect(backendUnlisten).toHaveBeenCalledTimes(1);
  });

  it("does not hide unrelated unregister errors", async () => {
    const unregisterError = new TypeError("event internals are unavailable");
    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = vi.fn(() => {
      throw unregisterError;
    });
    listenMock.mockResolvedValue(() => {
      window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(
        "repo-changed",
        9,
      );
    });

    const unlisten = await listenRuntimeEvent("repo-changed", vi.fn());

    expect(() => unlisten()).toThrow(unregisterError);
  });
});
