import * as React from "react";
import { isTauri } from "@tauri-apps/api/core";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";

import { AppErrorBoundary } from "@/components/layout/AppErrorBoundary";
import { CrashDetailsDialog } from "@/components/dialogs/CrashDetailsDialog";
import { ErrorDetailsDialog } from "@/components/dialogs/ErrorDetailsDialog";
import { HttpsCredentialPromptDialog } from "@/features/auth/HttpsCredentialPromptDialog";
import { SshPassphrasePromptDialog } from "@/features/auth/SshPassphrasePromptDialog";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { RepositoryShell } from "@/features/repository-shell/RepositoryShell";
import { SettingsModal } from "@/features/settings/SettingsModal";
import {
  appThemeToUiTheme,
  normalizeAppSettings,
  settingsWithTheme,
} from "@/features/settings/settings-model";
import { StartScreen } from "@/features/start/StartScreen";
import { hasOpenModalLayer } from "@/lib/dialog-layer";
import {
  acknowledgeRendererCrash,
  closeCurrentWindow,
  type CrashDialogPayload,
  newProjectWindow,
  openLogDir,
  registerWindowRepository,
  saveAppSettings,
  windowContext,
} from "@/lib/ipc/commands";
import type { AppError } from "@/lib/ipc/generated";
import { listenRuntimeEvent } from "@/lib/ipc/events";
import { reportDesktopRuntimeError } from "@/lib/runtime-errors";
import { useWindowStore } from "@/store/window-store";
import { useTheme } from "@/theme/ThemeProvider";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { showToast } from "@/lib/toast";
import { dispatchErrorGroup } from "@/lib/runtime-errors";

type DisplayError = AppError | Error | object | string;

export function App() {
  const [globalErrors, setGlobalErrors] = React.useState<DisplayError[]>([]);
  const [globalCrash, setGlobalCrash] = React.useState<unknown>(null);
  const handleGlobalError = React.useCallback((error: unknown) => {
    setGlobalErrors((current) => [...current, normalizeThrowable(error)]);
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
        errors={globalErrors}
        setCrash={setGlobalCrash}
        setErrors={setGlobalErrors}
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
  const runtimeBootstrapAttempt = useWindowStore(
    (state) => state.runtimeBootstrapAttempt,
  );
  const setWindowRuntime = useWindowStore((state) => state.setWindowRuntime);

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
        setWindowRuntime({ status: "ready", error: null });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (initialRepositoryPath) {
          setActiveRepositoryPath(initialRepositoryPath);
        }
        if (isTauri()) {
          setWindowRuntime({ status: "failed", error });
          reportDesktopRuntimeError(error);
        } else {
          setWindowRuntime({ status: "ready", error: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    onCrash,
    onError,
    runtimeBootstrapAttempt,
    setActiveRepositoryPath,
    setWindowLabel,
    setWindowRuntime,
  ]);

  return null;
}

function AppMenuBridge() {
  const { t } = useTranslation();
  const activeRepositoryPath = useWindowStore(
    (state) => state.activeRepositoryPath,
  );
  const openSettings = useWindowStore((state) => state.openSettings);
  const navigationLocked = useWindowStore((state) => state.navigationLocked);
  const settingsRuntime = useWindowStore((state) => state.settingsRuntime);
  const windowRuntime = useWindowStore((state) => state.windowRuntime);
  const appSettings = useWindowStore((state) => state.appSettings);
  const setAppSettings = useWindowStore((state) => state.setAppSettings);
  const { resolvedTheme, setThemePreference } = useTheme();
  const themeSaveSequence = React.useRef(0);

  const persistMenuTheme = React.useCallback(() => {
    const previous = normalizeAppSettings(appSettings);
    const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
    const next = settingsWithTheme(previous, nextTheme);
    const sequence = themeSaveSequence.current + 1;
    themeSaveSequence.current = sequence;
    setAppSettings(next);
    setThemePreference(nextTheme);
    void saveAppSettings({
      settings: next,
    })
      .then((saved) => {
        if (themeSaveSequence.current !== sequence) {
          return;
        }
        const normalized = normalizeAppSettings(saved);
        setAppSettings(normalized);
        setThemePreference(appThemeToUiTheme(normalized.appearance?.theme));
      })
      .catch((error) => {
        if (themeSaveSequence.current === sequence) {
          setAppSettings(previous);
          setThemePreference(appThemeToUiTheme(previous.appearance?.theme));
        }
        dispatchAppError(error);
      });
  }, [appSettings, resolvedTheme, setAppSettings, setThemePreference]);

  React.useEffect(() => {
    const handleMenuAction = (id: string) => {
      if (
        settingsRuntime.status !== "ready" ||
        windowRuntime.status !== "ready"
      ) {
        showToast({
          key: "runtime-starting",
          message: t("app.waitForStartup"),
          tone: "info",
        });
        return;
      }
      if (
        (navigationLocked || hasOpenModalLayer()) &&
        [
          "open-settings",
          "check-updates",
          "open-project",
          "clone-project",
          "view-history",
          "view-local-changes",
        ].includes(id)
      ) {
        showToast({
          key: "navigation-locked",
          message: t("app.finishCurrentOperation"),
          tone: "info",
        });
        return;
      }
      if (
        activeRepositoryPath &&
        (id === "open-project" || id === "clone-project")
      ) {
        void newProjectWindow({
          initialAction: id === "clone-project" ? "clone" : "open",
        }).catch(dispatchAppError);
        return;
      }
      if (
        !activeRepositoryPath &&
        (id === "view-history" || id === "view-local-changes")
      ) {
        showToast({
          key: "menu-requires-project",
          message: t("app.openProjectForView"),
          tone: "info",
        });
        return;
      }
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
          persistMenuTheme();
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
        if (navigationLocked || hasOpenModalLayer()) {
          showToast({
            key: "navigation-locked",
            message: t("app.finishCurrentOperation"),
            tone: "info",
          });
        } else {
          focusCurrentSearchInput();
        }
      }
    };

    let active = true;
    let unlisten: (() => void) | undefined;
    void listenRuntimeEvent<{ id: string }>("app-menu", (event) => {
      handleMenuAction(event.payload.id);
    })
      .then((resolvedUnlisten) => {
        if (active) {
          unlisten = resolvedUnlisten;
        } else {
          resolvedUnlisten();
        }
      })
      .catch((error) => {
        if (active) {
          dispatchAppError(error);
        }
      });

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      active = false;
      unlisten?.();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeRepositoryPath,
    navigationLocked,
    openSettings,
    persistMenuTheme,
    resolvedTheme,
    setThemePreference,
    settingsRuntime.status,
    t,
    windowRuntime.status,
  ]);

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
  const { t } = useTranslation();
  const onboarded = useWindowStore((state) => state.onboarded);
  const activeRepositoryPath = useWindowStore(
    (state) => state.activeRepositoryPath,
  );
  const settingsRuntime = useWindowStore((state) => state.settingsRuntime);
  const windowRuntime = useWindowStore((state) => state.windowRuntime);
  const retryRuntimeBootstrap = useWindowStore(
    (state) => state.retryRuntimeBootstrap,
  );

  if (
    settingsRuntime.status === "loading" ||
    windowRuntime.status === "loading"
  ) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {t("app.starting")}
        </div>
      </main>
    );
  }

  if (
    settingsRuntime.status === "failed" ||
    windowRuntime.status === "failed"
  ) {
    const errors = [settingsRuntime, windowRuntime]
      .filter((state) => state.status === "failed")
      .map((state) => state.error);
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
        <section
          className="w-full max-w-lg space-y-4 rounded-md border border-destructive/40 bg-card p-6"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <h1 className="font-semibold">{t("app.startFailedTitle")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("app.startFailedDescription")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pl-8">
            <Button
              onClick={() => {
                dispatchErrorGroup(errors, t("app.startFailedTitle"));
              }}
              type="button"
              variant="ghost"
            >
              {t("dialogs.error.showDetails")}
            </Button>
            <Button
              className="gap-2"
              onClick={retryRuntimeBootstrap}
              type="button"
              variant="secondary"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("actions.retry")}
            </Button>
          </div>
        </section>
      </main>
    );
  }

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

  if (!open) {
    return null;
  }

  return <SettingsModal onOpenChange={closeSettingsFromOpenChange} open />;

  function closeSettingsFromOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      closeSettings();
    }
  }
}

interface GlobalErrorDialogsProps {
  crash: unknown;
  errors: DisplayError[];
  setCrash: React.Dispatch<React.SetStateAction<unknown>>;
  setErrors: React.Dispatch<React.SetStateAction<DisplayError[]>>;
}

function GlobalErrorDialogs({
  crash,
  errors,
  setCrash,
  setErrors,
}: GlobalErrorDialogsProps) {
  const enqueueError = React.useCallback(
    (error: unknown) => {
      setErrors((current) => [...current, normalizeThrowable(error)]);
    },
    [setErrors],
  );
  React.useEffect(() => {
    let active = true;
    let unlistenCrashReported: (() => void) | undefined;
    let unlistenAppError: (() => void) | undefined;
    const handleError = (event: ErrorEvent) => {
      enqueueError(event.error instanceof Error ? event.error : event.message);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      enqueueError(event.reason);
    };
    const handleAppError = (event: Event) => {
      enqueueError((event as CustomEvent).detail);
    };
    const handleAppCrash = (event: Event) => {
      setCrash(normalizeCrash((event as CustomEvent).detail));
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("artistic-git:error", handleAppError);
    window.addEventListener("artistic-git:crash", handleAppCrash);
    void listenRuntimeEvent<CrashDialogPayload>("crash-reported", (event) => {
      setCrash(event.payload);
    })
      .then((resolvedUnlisten) => {
        if (active) {
          unlistenCrashReported = resolvedUnlisten;
        } else {
          resolvedUnlisten();
        }
      })
      .catch((error) => {
        if (active) {
          enqueueError(error);
        }
      });
    void listenRuntimeEvent<AppError>("app-error", (event) => {
      enqueueError(event.payload);
    })
      .then((resolvedUnlisten) => {
        if (active) {
          unlistenAppError = resolvedUnlisten;
        } else {
          resolvedUnlisten();
        }
      })
      .catch((error) => {
        if (active) {
          enqueueError(error);
        }
      });

    return () => {
      active = false;
      unlistenCrashReported?.();
      unlistenAppError?.();
      window.removeEventListener("error", handleError);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
      window.removeEventListener("artistic-git:error", handleAppError);
      window.removeEventListener("artistic-git:crash", handleAppCrash);
    };
  }, [enqueueError, setCrash]);

  const error = errors[0] ?? null;

  return (
    <>
      <ErrorDetailsDialog
        error={error ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            setErrors((current) => current.slice(1));
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
        onRestart={() => window.location.reload()}
        open={crash !== null}
      />
    </>
  );
}

function normalizeThrowable(value: unknown): DisplayError {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === "string") {
    return value;
  }

  if (isAppError(value)) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    return value;
  }

  return value == null ? "Unknown error" : String(value);
}

function normalizeCrash(value: unknown): unknown {
  if (isCrashDialogPayload(value)) {
    return value;
  }

  const normalized = normalizeThrowable(value);
  return normalized;
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
