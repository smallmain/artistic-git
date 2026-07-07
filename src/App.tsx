import * as React from "react";

import { AppErrorBoundary } from "@/components/layout/AppErrorBoundary";
import { CrashDetailsDialog } from "@/components/dialogs/CrashDetailsDialog";
import { ErrorDetailsDialog } from "@/components/dialogs/ErrorDetailsDialog";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { RepositoryShell } from "@/features/repository-shell/RepositoryShell";
import { SettingsModal } from "@/features/settings/SettingsModal";
import { StartScreen } from "@/features/start/StartScreen";
import { useWindowStore } from "@/store/window-store";

export function App() {
  return (
    <AppErrorBoundary>
      <AppRouter />
      <GlobalSettingsModal />
      <GlobalErrorDialogs />
    </AppErrorBoundary>
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

function GlobalErrorDialogs() {
  const [error, setError] = React.useState<Error | string | null>(null);
  const [crash, setCrash] = React.useState<Error | string | null>(null);

  React.useEffect(() => {
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
      setCrash(normalizeThrowable((event as CustomEvent).detail));
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("artistic-git:error", handleAppError);
    window.addEventListener("artistic-git:crash", handleAppCrash);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
      window.removeEventListener("artistic-git:error", handleAppError);
      window.removeEventListener("artistic-git:crash", handleAppCrash);
    };
  }, []);

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

function normalizeThrowable(value: unknown): Error | string {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === "string") {
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
