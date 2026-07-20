import * as React from "react";
import { listen } from "@tauri-apps/api/event";

import { AppErrorBoundary } from "@/components/layout/AppErrorBoundary";
import { CrashDetailsDialog } from "@/components/dialogs/CrashDetailsDialog";
import { ErrorDetailsDialog } from "@/components/dialogs/ErrorDetailsDialog";
import { HttpsCredentialPromptDialog } from "@/features/auth/HttpsCredentialPromptDialog";
import { SshPassphrasePromptDialog } from "@/features/auth/SshPassphrasePromptDialog";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { RepositoryShell } from "@/features/repository-shell/RepositoryShell";
import { SettingsModal } from "@/features/settings/SettingsModal";
import { StartScreen } from "@/features/start/StartScreen";
import {
  acknowledgeRendererCrash,
  closeCurrentWindow,
  type CrashDialogPayload,
  newProjectWindow,
  openLogDir,
  registerWindowRepository,
  windowContext,
} from "@/lib/ipc/commands";
import type { AppError } from "@/lib/ipc/generated";
import { useWindowStore } from "@/store/window-store";
import { useTheme } from "@/theme/ThemeProvider";

export function App() {
  const [globalError, setGlobalError] = React.useState<
    AppError | Error | string | null
  >(null);
  const [globalCrash, setGlobalCrash] = React.useState<
    Error | string | CrashDialogPayload | null
  >(null);
  const handleGlobalError = React.useCallback((error: unknown) => {
    setGlobalError(normalizeThrowable(error));
  }, []);
  const handleGlobalCrash = React.useCallback((crash: unknown) => {
    setGlobalCrash(normalizeCrash(crash));
  }, []);

  return (
    <AppErrorBoundary>
      <AppRouter />
      <WindowRuntimeBridge
        onCrash={handleGlobalCrash}
        onError={handleGlobalError}
      />
      <AppMenuBridge />
      <GlobalSettingsModal />
      <HttpsCredentialPromptDialog />
      <SshPassphrasePromptDialog />
      <GlobalErrorDialogs
        crash={globalCrash}
        error={globalError}
        setCrash={setGlobalCrash}
        setError={setGlobalError}
      />
    </AppErrorBoundary>
  );
}

interface WindowRuntimeBridgeProps {
  onCrash: (crash: unknown) => void;
  onError: (error: unknown) => void;
}

function WindowRuntimeBridge({ onCrash, onError }: WindowRuntimeBridgeProps) {
  const setActiveRepositoryPath = useWindowStore(
    (state) => state.setActiveRepositoryPath,
  );
  const setWindowLabel = useWindowStore((state) => state.setWindowLabel);

  React.useEffect(() => {
    let cancelled = false;
    const initialRepositoryPath = repositoryPathFromLocation();

    void windowContext()
      .then((context) => {
        if (cancelled) {
          return;
        }
        setWindowLabel(context.label);
        const repositoryPath = context.repositoryPath ?? initialRepositoryPath;
        if (repositoryPath) {
          setActiveRepositoryPath(repositoryPath);
          void registerWindowRepository({ repositoryPath }).catch(onError);
        }
        if (context.pendingCrash) {
          onCrash(context.pendingCrash);
          void acknowledgeRendererCrash().catch(onError);
        }
      })
      .catch(() => {
        if (initialRepositoryPath) {
          setActiveRepositoryPath(initialRepositoryPath);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onCrash, onError, setActiveRepositoryPath, setWindowLabel]);

  return null;
}

function AppMenuBridge() {
  const openSettings = useWindowStore((state) => state.openSettings);
  const { resolvedTheme, setThemePreference } = useTheme();

  React.useEffect(() => {
    const handleMenuAction = (id: string) => {
      switch (id) {
        case "open-settings":
          openSettings("general");
          break;
        case "open-project":
          window.dispatchEvent(new CustomEvent("artistic-git:open-project"));
          break;
        case "clone-project":
          window.dispatchEvent(new CustomEvent("artistic-git:clone-project"));
          break;
        case "view-history":
          window.dispatchEvent(
            new CustomEvent("artistic-git:view-tab", { detail: "history" }),
          );
          break;
        case "view-local-changes":
          window.dispatchEvent(
            new CustomEvent("artistic-git:view-tab", {
              detail: "localChanges",
            }),
          );
          break;
        case "toggle-theme":
          setThemePreference(resolvedTheme === "dark" ? "light" : "dark");
          break;
        case "toggle-devtools":
          window.dispatchEvent(new CustomEvent("artistic-git:toggle-devtools"));
          break;
        case "open-log-dir":
          void openLogDir().catch(dispatchAppError);
          break;
        case "check-updates":
          openSettings("about");
          window.dispatchEvent(new CustomEvent("artistic-git:check-updates"));
          break;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        void newProjectWindow().catch(dispatchAppError);
      } else if (key === "o") {
        event.preventDefault();
        handleMenuAction("open-project");
      } else if (key === "w") {
        event.preventDefault();
        void closeCurrentWindow().catch(dispatchAppError);
      } else if (key === ",") {
        event.preventDefault();
        handleMenuAction("open-settings");
      } else if (key === "f") {
        event.preventDefault();
        focusCurrentSearchInput();
      }
    };

    let unlisten: (() => void) | undefined;
    void listen<{ id: string }>("app-menu", (event) => {
      handleMenuAction(event.payload.id);
    }).then((resolvedUnlisten) => {
      unlisten = resolvedUnlisten;
    });

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      unlisten?.();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openSettings, resolvedTheme, setThemePreference]);

  return null;
}

function repositoryPathFromLocation(): string | null {
  const repositoryPath = new URLSearchParams(window.location.search).get(
    "repository",
  );
  return repositoryPath && repositoryPath.trim() ? repositoryPath : null;
}

function focusCurrentSearchInput() {
  const searchInput = document.querySelector<HTMLElement>(
    '[data-app-search="current"]',
  );
  searchInput?.focus();
}

function dispatchAppError(error: unknown) {
  window.dispatchEvent(
    new CustomEvent("artistic-git:error", { detail: error }),
  );
}

function AppRouter() {
  const onboarded = useWindowStore((state) => state.onboarded);
  const activeRepositoryPath = useWindowStore(
    (state) => state.activeRepositoryPath,
  );

  if (!onboarded) {
    return <OnboardingWizard />;
  }

  if (activeRepositoryPath) {
    return <RepositoryShell repositoryPath={activeRepositoryPath} />;
  }

  return <StartScreen />;
}

function GlobalSettingsModal() {
  const open = useWindowStore((state) => state.settingsModalOpen);
  const closeSettings = useWindowStore((state) => state.closeSettings);

  return (
    <SettingsModal onOpenChange={closeSettingsFromOpenChange} open={open} />
  );

  function closeSettingsFromOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      closeSettings();
    }
  }
}

interface GlobalErrorDialogsProps {
  crash: Error | string | CrashDialogPayload | null;
  error: AppError | Error | string | null;
  setCrash: React.Dispatch<
    React.SetStateAction<Error | string | CrashDialogPayload | null>
  >;
  setError: React.Dispatch<
    React.SetStateAction<AppError | Error | string | null>
  >;
}

function GlobalErrorDialogs({
  crash,
  error,
  setCrash,
  setError,
}: GlobalErrorDialogsProps) {
  React.useEffect(() => {
    let unlistenCrashReported: (() => void) | undefined;
    const handleError = (event: ErrorEvent) => {
      setError(event.error instanceof Error ? event.error : event.message);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      setError(normalizeThrowable(event.reason));
    };
    const handleAppError = (event: Event) => {
      setError(normalizeThrowable((event as CustomEvent).detail));
    };
    const handleAppCrash = (event: Event) => {
      setCrash(normalizeCrash((event as CustomEvent).detail));
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("artistic-git:error", handleAppError);
    window.addEventListener("artistic-git:crash", handleAppCrash);
    void listen<CrashDialogPayload>("crash-reported", (event) => {
      setCrash(event.payload);
    }).then((resolvedUnlisten) => {
      unlistenCrashReported = resolvedUnlisten;
    });

    return () => {
      unlistenCrashReported?.();
      window.removeEventListener("error", handleError);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
      window.removeEventListener("artistic-git:error", handleAppError);
      window.removeEventListener("artistic-git:crash", handleAppCrash);
    };
  }, [setCrash, setError]);

  return (
    <>
      <ErrorDetailsDialog
        error={error ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            setError(null);
          }
        }}
        open={error !== null}
      />
      <CrashDetailsDialog
        crash={crash ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            setCrash(null);
          }
        }}
        open={crash !== null}
      />
    </>
  );
}

function normalizeThrowable(value: unknown): AppError | Error | string {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === "string") {
    return value;
  }

  if (isAppError(value)) {
    return value;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "summary" in value &&
    typeof value.summary === "string"
  ) {
    return value.summary;
  }

  return "Unknown error";
}

function normalizeCrash(value: unknown): CrashDialogPayload | Error | string {
  if (isCrashDialogPayload(value)) {
    return value;
  }

  const normalized = normalizeThrowable(value);
  return isAppError(normalized) ? normalized.summary : normalized;
}

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "category" in value &&
    "summary" in value &&
    typeof value.summary === "string" &&
    "context" in value
  );
}

function isCrashDialogPayload(value: unknown): value is CrashDialogPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "summary" in value &&
    typeof value.summary === "string" &&
    "details" in value &&
    typeof value.details === "string"
  );
}
