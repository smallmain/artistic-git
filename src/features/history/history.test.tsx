import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/AppProviders";
import { createI18n } from "@/i18n/i18n";
import { createAppQueryClient } from "@/lib/query/client";

import { resolveAvatarPresentation } from "./avatar";
import { HistoryWorkbench } from "./HistoryWorkbench";
import { createMockHistorySearchSource, searchCommits } from "./history-search";
import { mockHistoryCommits, mockHistoryRows } from "./fixtures";

function renderWithProviders(ui: ReactElement) {
  return render(
    <AppProviders
      i18n={createI18n("en")}
      initialLanguagePreference="en"
      initialThemePreference="light"
      queryClient={createAppQueryClient()}
    >
      {ui}
    </AppProviders>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("history search", () => {
  it("merges message, author, and content matches without duplicates", () => {
    const results = searchCommits(mockHistoryCommits, "history");

    expect(results.map((commit) => commit.shortId)).toEqual([
      "8b43f0e",
      "71cfb9a",
      "d4512aa",
      "6df1253",
    ]);
    expect(results[0].searchMatches).toEqual(["message", "content"]);
  });

  it("cancels an in-flight search request", async () => {
    const source = createMockHistorySearchSource(mockHistoryCommits, 500);
    const controller = new AbortController();
    const promise = source("history", controller.signal);

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("history avatars", () => {
  it("does not create a remote Gravatar URL by default", () => {
    const avatar = resolveAvatarPresentation({
      email: "mira@example.test",
      name: "Mira Chen",
    });

    expect(avatar.initials).toBe("MC");
    expect(avatar.remoteUrl).toBeNull();
  });
});

describe("HistoryWorkbench", () => {
  it("filters branches and opens the commit detail panel", () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

    expect(
      screen.getByText("Merge color pipeline preview"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Auto/ }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(
      screen.getByText("Tag release candidate assets"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Tag release candidate assets"));
    expect(screen.getByText("Copy hash")).toBeInTheDocument();
    expect(
      screen.getByText("2D diff preview placeholder for the selected file."),
    ).toBeInTheDocument();
  });

  it("debounces search, shows loading, and renders de-duplicated results", async () => {
    renderWithProviders(<HistoryWorkbench rows={mockHistoryRows} />);

    fireEvent.click(screen.getByRole("button", { name: /Auto/ }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Search history" }), {
      target: { value: "viewport" },
    });

    await act(async () => {
      vi.advanceTimersByTime(230);
    });
    expect(
      screen.getByText("Merge color pipeline preview"),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    expect(screen.queryByText("Merge color pipeline preview")).toBeNull();
    expect(
      screen.getByText("Add lightweight graph viewport"),
    ).toBeInTheDocument();
  });
});
