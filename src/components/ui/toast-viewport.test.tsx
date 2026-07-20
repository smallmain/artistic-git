import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createI18n } from "@/i18n/i18n";
import { showToast } from "@/lib/toast";

import { ToastViewport } from "./toast-viewport";

function renderViewport() {
  return render(
    <I18nextProvider i18n={createI18n("en")}>
      <ToastViewport />
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToastViewport", () => {
  it("replaces a keyed toast and supports manual dismissal", () => {
    renderViewport();

    act(() => {
      showToast({ key: "result", message: "First result" });
      showToast({ key: "result", message: "Latest result", tone: "success" });
    });

    expect(screen.queryByText("First result")).not.toBeInTheDocument();
    const toast = screen.getByTestId("app-toast");
    expect(toast).toHaveTextContent("Latest result");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("app-toast")).not.toBeInTheDocument();
  });

  it("dismisses a toast after its requested duration", () => {
    vi.useFakeTimers();
    renderViewport();

    act(() => {
      showToast({ durationMs: 1_000, message: "Temporary result" });
    });
    expect(screen.getByText("Temporary result")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText("Temporary result")).not.toBeInTheDocument();
  });

  it("pauses dismissal while the toast is hovered", () => {
    vi.useFakeTimers();
    renderViewport();

    act(() => {
      showToast({ durationMs: 1_000, message: "Readable result" });
    });
    const toast = screen.getByTestId("app-toast");
    fireEvent.mouseEnter(toast);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(toast).toBeInTheDocument();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText("Readable result")).not.toBeInTheDocument();
  });

  it("pauses dismissal while keyboard focus remains in the toast", () => {
    vi.useFakeTimers();
    renderViewport();

    act(() => {
      showToast({ durationMs: 1_000, message: "Keyboard result" });
    });
    const closeButton = screen.getByRole("button", { name: "Close" });
    fireEvent.focus(closeButton);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("Keyboard result")).toBeInTheDocument();

    fireEvent.blur(closeButton);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText("Keyboard result")).not.toBeInTheDocument();
  });

  it("does not carry a paused timer into a later toast with the same key", () => {
    vi.useFakeTimers();
    renderViewport();

    act(() => {
      showToast({
        durationMs: 1_000,
        key: "reusable-result",
        message: "Paused result",
      });
    });
    const firstToast = screen.getByTestId("app-toast");
    fireEvent.mouseEnter(firstToast);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    act(() => {
      showToast({
        durationMs: 1_000,
        key: "reusable-result",
        message: "Later result",
      });
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.queryByText("Later result")).not.toBeInTheDocument();
  });

  it("keeps only the latest three notifications", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    renderViewport();

    act(() => {
      showToast({ message: "First" });
      showToast({ message: "Second" });
      showToast({ message: "Third" });
      showToast({ message: "Fourth" });
    });

    expect(screen.getAllByTestId("app-toast")).toHaveLength(3);
    expect(screen.queryByText("First")).not.toBeInTheDocument();
    expect(screen.getByText("Fourth")).toBeInTheDocument();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
