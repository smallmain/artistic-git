import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { AppProviders } from "./AppProviders";
import { ConfirmDialog } from "./components/dialogs/ConfirmDialog";
import { CrashDetailsDialog } from "./components/dialogs/CrashDetailsDialog";
import { ErrorDetailsDialog } from "./components/dialogs/ErrorDetailsDialog";
import { createI18n } from "./i18n/i18n";
import type { LanguagePreference } from "./i18n/resources";
import type { AppError } from "./lib/ipc/generated";
import { createAppQueryClient } from "./lib/query/client";
import type { WindowStoreState } from "./store/window-store";
import type { ThemePreference } from "./theme/ThemeProvider";

interface RenderOptions {
  initialLanguagePreference?: LanguagePreference;
  initialThemePreference?: ThemePreference;
  initialWindowState?: Partial<WindowStoreState>;
}

function renderWithProviders(
  ui: ReactElement,
  {
    initialLanguagePreference = "en",
    initialThemePreference = "light",
    initialWindowState,
  }: RenderOptions = {},
) {
  return render(
    <AppProviders
      i18n={createI18n("en")}
      initialLanguagePreference={initialLanguagePreference}
      initialThemePreference={initialThemePreference}
      initialWindowState={initialWindowState}
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
  it("renders the start screen with recent project actions", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        recentProjects: [
          {
            displayName: "Environment Art",
            path: "/Users/artist/Projects/Environment Art",
          },
          {
            displayName: "Moved Project",
            missing: true,
            path: "/Users/artist/Projects/Moved",
          },
        ],
      },
    });

    expect(
      screen.getByRole("heading", { name: "Artistic Git" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Project" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clone Project" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByText("Moved Project").closest("button")!);

    expect(screen.getByRole("alert")).toHaveTextContent("was deleted or moved");

    fireEvent.click(screen.getByRole("button", { name: "Remove from list" }));

    expect(screen.queryByText("Moved Project")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));

    expect(screen.getByText(/Project history will appear/)).toBeInTheDocument();
  });

  it("routes first-run windows to the onboarding placeholder", () => {
    renderWithProviders(<App />, {
      initialWindowState: { onboarded: false },
    });

    expect(
      screen.getByRole("heading", { name: "Setup Wizard" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(
      screen.getByRole("button", { name: "Open Project" }),
    ).toBeInTheDocument();
  });

  it("renders the repository shell, warning bar, tabs, and branch focus", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
      },
    });

    expect(
      screen.getByText("No remote repository configured"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Local Changes/ }),
    ).toHaveTextContent("4");
    expect(screen.getByText(/Focused on main/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /feature\/material-library/ }),
    );

    expect(
      screen.getByText(/Focused on feature\/material-library/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Local Changes/ }));

    expect(screen.getByText("Local changes placeholder")).toBeInTheDocument();
  });

  it("filters and collapses sidebar sections", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
      },
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Search branches" }), {
      target: { value: "nope" },
    });

    expect(screen.getByText("No matching items")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Branches" }));

    expect(
      screen.queryByRole("textbox", { name: "Search branches" }),
    ).not.toBeInTheDocument();
  });

  it("persists sidebar resize settings", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
      },
    });

    fireEvent.pointerDown(screen.getByLabelText("Resize sidebar"), {
      clientX: 320,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { clientX: 380 });
    fireEvent.pointerUp(window);

    expect(
      window.localStorage.getItem("artistic-git:sidebar-layout"),
    ).toContain('"widthPx":380');
  });

  it("shows operation progress and busy write tooltips", () => {
    renderWithProviders(<App />, {
      initialWindowState: {
        activeRepositoryPath: "/repo/art-project",
        operationsById: {
          "op-1": {
            cancellable: false,
            label: "Fetching branches",
            operationId: "op-1",
            progress: { kind: "indeterminate" },
          },
        },
      },
    });

    expect(screen.getByText("Fetching branches")).toBeInTheDocument();
    expect(
      screen.getAllByText("An operation is running").length,
    ).toBeGreaterThan(0);
  });

  it("opens global error and crash dialogs from window events", async () => {
    renderWithProviders(<App />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", {
          detail: new Error("Repository failed"),
        }),
      );
    });

    expect(screen.getByRole("dialog")).toHaveTextContent("Repository failed");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:crash", {
          detail: "Renderer crashed",
        }),
      );
    });

    expect(screen.getByRole("dialog")).toHaveTextContent("Renderer crashed");
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
