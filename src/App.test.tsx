import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { AppProviders } from "./AppProviders";
import { ConfirmDialog } from "./components/dialogs/ConfirmDialog";
import { CrashDetailsDialog } from "./components/dialogs/CrashDetailsDialog";
import { ErrorDetailsDialog } from "./components/dialogs/ErrorDetailsDialog";
import { createI18n } from "./i18n/i18n";
import type { LanguagePreference } from "./i18n/resources";
import { createAppQueryClient } from "./lib/query/client";
import type { AppError } from "./lib/ipc/generated";
import type { ThemePreference } from "./theme/ThemeProvider";

interface RenderOptions {
  initialLanguagePreference?: LanguagePreference;
  initialThemePreference?: ThemePreference;
}

function renderWithProviders(
  ui: ReactElement,
  {
    initialLanguagePreference = "en",
    initialThemePreference = "light",
  }: RenderOptions = {},
) {
  return render(
    <AppProviders
      i18n={createI18n("en")}
      initialLanguagePreference={initialLanguagePreference}
      initialThemePreference={initialThemePreference}
      queryClient={createAppQueryClient()}
    >
      {ui}
    </AppProviders>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
});

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("renders the start screen", () => {
    renderWithProviders(<App />);

    expect(
      screen.getByRole("heading", { name: "Artistic Git" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Project" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clone Project" }),
    ).toBeInTheDocument();
  });

  it("switches visible copy between English and Chinese", async () => {
    renderWithProviders(<App />);

    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
      target: { value: "zh-CN" },
    });

    expect(
      await screen.findByRole("button", { name: "打开项目" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "克隆项目" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "语言" })).toHaveValue("zh-CN");
  });

  it("switches the document theme tokens", () => {
    renderWithProviders(<App />);

    fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), {
      target: { value: "dark" },
    });

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), {
      target: { value: "light" },
    });

    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});

describe("ErrorDetailsDialog", () => {
  it("expands and collapses technical details", () => {
    const onOpenChange = vi.fn();

    renderWithProviders(
      <ErrorDetailsDialog
        error={createAppError()}
        onOpenChange={onOpenChange}
        open
      />,
    );

    expect(
      screen.queryByText(/"summary": "Merge failed"/),
    ).not.toBeInTheDocument();

    const showDetails = screen.getByRole("button", {
      name: "Show technical details",
    });
    expect(showDetails).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(showDetails);

    expect(screen.getByText(/"summary": "Merge failed"/)).toBeInTheDocument();
    expect(showDetails).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Hide technical details" }),
    );

    expect(
      screen.queryByText(/"summary": "Merge failed"/),
    ).not.toBeInTheDocument();
  });

  it("closes with Escape and opens the log directory", () => {
    const onOpenChange = vi.fn();
    const onOpenLogDir = vi.fn();

    renderWithProviders(
      <ErrorDetailsDialog
        error={createAppError()}
        onOpenChange={onOpenChange}
        onOpenLogDir={onOpenLogDir}
        open
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open log folder" }));
    expect(onOpenLogDir).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CrashDetailsDialog", () => {
  it("renders a restart action placeholder", () => {
    const onRestart = vi.fn();

    renderWithProviders(
      <CrashDetailsDialog
        crash="Renderer crashed"
        onOpenChange={vi.fn()}
        onRestart={onRestart}
        open
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restart app" }));

    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmDialog", () => {
  it("confirms, cancels, and closes with Escape", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();

    renderWithProviders(
      <ConfirmDialog
        description="Delete this branch?"
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
        open
        title="Confirm delete"
        variant="danger"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

function createAppError(): AppError {
  return {
    category: "unexpected",
    context: {
      operationId: null,
      operationName: "merge",
      repositoryPath: "/tmp/art-project",
      windowLabel: "main",
    },
    git: {
      command: ["git", "merge", "feature"],
      exitCode: 1,
      stderr: "conflict",
      stdout: "",
    },
    summary: "Merge failed",
  };
}
