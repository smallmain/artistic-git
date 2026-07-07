import { GraduationCap } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { AppErrorBoundary } from "@/components/layout/AppErrorBoundary";
import { Button } from "@/components/ui/button";
import { CrashDetailsDialog } from "@/components/dialogs/CrashDetailsDialog";
import { ErrorDetailsDialog } from "@/components/dialogs/ErrorDetailsDialog";
import { RepositoryShell } from "@/features/repository-shell/RepositoryShell";
import { StartScreen } from "@/features/start/StartScreen";
import { useWindowStore } from "@/store/window-store";

export function App() {
  return (
    <AppErrorBoundary>
      <AppRouter />
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
    return <OnboardingPlaceholder />;
  }

  if (activeRepositoryPath) {
    return <RepositoryShell repositoryPath={activeRepositoryPath} />;
  }

  return <StartScreen />;
}

function OnboardingPlaceholder() {
  const { t } = useTranslation();
  const setOnboarded = useWindowStore((state) => state.setOnboarded);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-8 text-foreground">
      <section className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-md border bg-card">
          <GraduationCap className="size-6" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">{t("onboarding.title")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("onboarding.placeholder")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              setOnboarded(true);
            }}
            type="button"
          >
            {t("onboarding.finish")}
          </Button>
          <Button
            onClick={() => {
              setOnboarded(true);
            }}
            type="button"
            variant="ghost"
          >
            {t("onboarding.skip")}
          </Button>
        </div>
      </section>
    </main>
  );
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
