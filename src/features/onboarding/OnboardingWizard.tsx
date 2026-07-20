import {
  CircleAlert,
  Clipboard,
  GraduationCap,
  KeyRound,
  Loader2,
  RefreshCw,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type {
  AppSettings,
  GitUserSettings,
  SshKeyStatus,
} from "@/lib/ipc/generated";
import {
  generateSshKey,
  saveAppSettings,
  settingsSnapshot,
} from "@/lib/ipc/commands";
import { useWindowStore } from "@/store/window-store";
import {
  cleanGitUser,
  gitUserFromSettings,
  isValidEmail,
  normalizeAppSettings,
  settingsWithGitUser,
  settingsWithOnboarded,
  validateGitUser,
} from "@/features/settings/settings-model";
import { cn } from "@/lib/utils";

type OnboardingStep = "identity" | "ssh";
type OnboardingBusyState = "loading" | "saving" | "generatingSshKey";
type OnboardingSnapshotState =
  { kind: "loading" } | { kind: "ready" } | { error: unknown; kind: "failed" };

export function OnboardingWizard() {
  const { t } = useTranslation();
  const appSettings = useWindowStore((state) => state.appSettings);
  const setAppSettings = useWindowStore((state) => state.setAppSettings);
  const setOnboarded = useWindowStore((state) => state.setOnboarded);
  const [settings, setSettings] = React.useState<AppSettings>(() =>
    normalizeAppSettings(appSettings),
  );
  const [user, setUser] = React.useState<GitUserSettings>(() =>
    gitUserFromSettings(appSettings),
  );
  const [sshKey, setSshKey] = React.useState<SshKeyStatus | null>(null);
  const [passphrase, setPassphrase] = React.useState("");
  const [step, setStep] = React.useState<OnboardingStep>("identity");
  const [status, setStatus] = React.useState<string | null>(null);
  const [identityTouched, setIdentityTouched] = React.useState(false);
  const [identityAttempted, setIdentityAttempted] = React.useState(false);
  const [busyState, setBusyState] = React.useState<OnboardingBusyState | null>(
    "loading",
  );
  const [snapshotState, setSnapshotState] =
    React.useState<OnboardingSnapshotState>({ kind: "loading" });
  const busyRef = React.useRef(true);
  const mountedRef = React.useRef(true);
  const snapshotRequestRef = React.useRef(0);
  const email = user.email ?? "";
  const identityValidation = validateGitUser(user);
  const showIdentityValidation =
    identityTouched ||
    identityAttempted ||
    Boolean(email.trim() && !isValidEmail(email));

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applySnapshot = React.useCallback(
    (snapshot: Awaited<ReturnType<typeof settingsSnapshot>>) => {
      const normalized = normalizeAppSettings(snapshot.settings);
      const sourceUser =
        normalized.git?.user?.name || normalized.git?.user?.email
          ? gitUserFromSettings(normalized)
          : snapshot.identitySources.globalGitconfig;
      setSettings(normalized);
      setAppSettings(normalized);
      setUser(cleanGitUser(sourceUser));
      setSshKey(snapshot.sshKey);
      setIdentityTouched(false);
      setIdentityAttempted(false);
      setSnapshotState({ kind: "ready" });
    },
    [setAppSettings],
  );

  const requestSnapshot = React.useCallback(async () => {
    const requestId = snapshotRequestRef.current + 1;
    snapshotRequestRef.current = requestId;

    try {
      const snapshot = await settingsSnapshot();
      if (!mountedRef.current || snapshotRequestRef.current !== requestId) {
        return;
      }
      applySnapshot(snapshot);
    } catch (error) {
      if (mountedRef.current && snapshotRequestRef.current === requestId) {
        setSnapshotState({ error, kind: "failed" });
      }
    } finally {
      if (mountedRef.current && snapshotRequestRef.current === requestId) {
        busyRef.current = false;
        setBusyState(null);
      }
    }
  }, [applySnapshot]);

  React.useEffect(() => {
    const requestId = snapshotRequestRef.current + 1;
    snapshotRequestRef.current = requestId;
    void settingsSnapshot()
      .then((snapshot) => {
        if (mountedRef.current && snapshotRequestRef.current === requestId) {
          applySnapshot(snapshot);
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current && snapshotRequestRef.current === requestId) {
          setSnapshotState({ error, kind: "failed" });
        }
      })
      .finally(() => {
        if (mountedRef.current && snapshotRequestRef.current === requestId) {
          busyRef.current = false;
          setBusyState(null);
        }
      });
    return () => {
      snapshotRequestRef.current += 1;
    };
  }, [applySnapshot]);

  const retrySnapshot = () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusyState("loading");
    setSnapshotState({ kind: "loading" });
    setStatus(null);
    void requestSnapshot();
  };

  const complete = async (saveIdentity: boolean) => {
    if (busyRef.current || snapshotState.kind !== "ready") {
      return;
    }
    if (saveIdentity && !identityValidation.valid) {
      setIdentityAttempted(true);
      setStatus(
        t(identityValidation.messageKey ?? "settings.general.identityRequired"),
      );
      setStep("identity");
      return;
    }

    const withUser = saveIdentity
      ? settingsWithGitUser(settings, user)
      : settings;
    const next = settingsWithOnboarded(withUser, true);
    busyRef.current = true;
    setBusyState("saving");
    setStatus(null);
    try {
      const saved = await saveAppSettings({
        settings: next,
        validateIdentity: saveIdentity,
      });
      const normalized = normalizeAppSettings(saved);
      setAppSettings(normalized);
      busyRef.current = false;
      if (!mountedRef.current) {
        return;
      }
      setSettings(normalized);
      setBusyState(null);
      setOnboarded(true);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
      busyRef.current = false;
      if (mountedRef.current) {
        setBusyState(null);
      }
    }
  };

  const continueToSsh = () => {
    if (busyRef.current) {
      return;
    }
    if (!identityValidation.valid) {
      setIdentityAttempted(true);
      setStatus(
        t(identityValidation.messageKey ?? "settings.general.identityRequired"),
      );
      return;
    }
    setIdentityAttempted(false);
    setStatus(null);
    setStep("ssh");
  };

  const copyPublicKey = async () => {
    if (!sshKey?.publicKey) {
      return;
    }
    try {
      await navigator.clipboard.writeText(sshKey.publicKey);
      setStatus(t("settings.status.copied"));
    } catch {
      setStatus(t("settings.status.copyFailed"));
    }
  };

  const createSshKey = async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusyState("generatingSshKey");
    setStatus(null);
    try {
      const next = await generateSshKey({
        comment: user.email ?? "artistic-git",
        passphrase,
      });
      if (mountedRef.current) {
        setSshKey(next);
        setStatus(t("settings.status.sshGenerated"));
      }
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusyState(null);
      }
    }
  };

  const busyLabel = busyState ? t(`onboarding.${busyState}`) : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-8 text-foreground">
      <section
        aria-busy={busyState !== null}
        className="relative w-full max-w-xl space-y-6 overflow-hidden rounded-md border bg-card p-6 shadow-floating"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-md border bg-background">
            <GraduationCap className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{t("onboarding.title")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("onboarding.description")}
            </p>
          </div>
        </div>

        <div className="flex gap-2 text-sm">
          <StepPill
            active={step === "identity"}
            icon={<UserRound className="size-4" aria-hidden="true" />}
            label={t("onboarding.identity")}
          />
          <StepPill
            active={step === "ssh"}
            icon={<KeyRound className="size-4" aria-hidden="true" />}
            label={t("onboarding.ssh")}
          />
        </div>

        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t("onboarding.macosTranslocation")}
        </p>

        {snapshotState.kind === "failed" ? (
          <div className="space-y-4" role="alert">
            <div className="flex items-start gap-3">
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-destructive"
              />
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">
                  {t("onboarding.loadFailedTitle")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("onboarding.loadFailedDescription")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pl-8">
              <Button
                className="gap-2"
                onClick={retrySnapshot}
                type="button"
                variant="secondary"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {t("onboarding.retryLoading")}
              </Button>
              <Button
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("artistic-git:error", {
                      detail: snapshotState.error,
                    }),
                  );
                }}
                type="button"
                variant="ghost"
              >
                {t("onboarding.viewErrorDetails")}
              </Button>
            </div>
          </div>
        ) : snapshotState.kind === "ready" && step === "identity" ? (
          <div className="space-y-3">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("settings.general.name")}</span>
              <input
                aria-invalid={
                  showIdentityValidation && identityValidation.nameMissing
                }
                className={cn(
                  "h-9 rounded-md border bg-background px-3 text-sm",
                  showIdentityValidation &&
                    identityValidation.nameMissing &&
                    "border-destructive",
                )}
                disabled={busyState !== null}
                onChange={(event) => {
                  setIdentityTouched(true);
                  setUser((current) => ({
                    ...current,
                    name: event.target.value,
                  }));
                }}
                value={user.name ?? ""}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("settings.general.email")}</span>
              <input
                aria-invalid={
                  showIdentityValidation &&
                  (identityValidation.emailMissing ||
                    identityValidation.emailInvalid)
                }
                className={cn(
                  "h-9 rounded-md border bg-background px-3 text-sm",
                  showIdentityValidation &&
                    (identityValidation.emailMissing ||
                      identityValidation.emailInvalid) &&
                    "border-destructive",
                )}
                disabled={busyState !== null}
                onChange={(event) => {
                  setIdentityTouched(true);
                  setUser((current) => ({
                    ...current,
                    email: event.target.value,
                  }));
                }}
                value={user.email ?? ""}
              />
            </label>
            {showIdentityValidation && identityValidation.messageKey ? (
              <p className="text-sm text-destructive">
                {t(identityValidation.messageKey)}
              </p>
            ) : null}
          </div>
        ) : snapshotState.kind === "ready" ? (
          <div className="space-y-3">
            <div className="rounded-md border bg-background p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-medium">
                  {sshKey?.exists
                    ? t("settings.general.sshDetected")
                    : t("settings.general.sshMissing")}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {sshKey?.publicKeyPath ?? t("settings.general.noSshPath")}
                </span>
              </div>
              <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                {sshKey?.publicKey ?? t("settings.general.noPublicKey")}
              </pre>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="gap-2"
                disabled={busyState !== null || !sshKey?.publicKey}
                onClick={copyPublicKey}
                type="button"
                variant="secondary"
              >
                <Clipboard className="size-4" aria-hidden="true" />
                {t("settings.general.copyPublicKey")}
              </Button>
              {!sshKey?.exists ? (
                <label className="grid min-w-56 flex-1 gap-1 text-sm">
                  <span className="font-medium">
                    {t("onboarding.passphrase")}
                  </span>
                  <input
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    disabled={busyState !== null}
                    onChange={(event) => setPassphrase(event.target.value)}
                    type="password"
                    value={passphrase}
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("onboarding.passphraseHelp")}
                  </span>
                </label>
              ) : null}
              <Button
                className="gap-2"
                disabled={busyState !== null || sshKey?.exists}
                onClick={createSshKey}
                type="button"
                variant="secondary"
              >
                <KeyRound className="size-4" aria-hidden="true" />
                {t("settings.general.generateSshKey")}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("onboarding.addKeyHelp")}
            </p>
          </div>
        ) : null}

        {snapshotState.kind === "ready" ? (
          <footer className="flex items-center justify-between gap-3">
            <span className="min-w-0 text-sm text-muted-foreground">
              {status}
            </span>
            <div className="flex items-center gap-2">
              <Button
                disabled={busyState !== null}
                onClick={() => void complete(false)}
                type="button"
                variant="ghost"
              >
                {t("onboarding.skip")}
              </Button>
              {step === "identity" ? (
                <Button
                  disabled={busyState !== null}
                  onClick={continueToSsh}
                  type="button"
                >
                  {t("onboarding.next")}
                </Button>
              ) : (
                <Button
                  disabled={busyState !== null}
                  onClick={() => void complete(true)}
                  type="button"
                >
                  {t("onboarding.finish")}
                </Button>
              )}
            </div>
          </footer>
        ) : null}
        {busyLabel ? (
          <div
            aria-live="polite"
            className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-card/80 text-sm font-medium"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span>{busyLabel}</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function StepPill({
  active,
  icon,
  label,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <span
      className={
        active
          ? "flex items-center gap-2 rounded-md bg-secondary px-3 py-1 text-secondary-foreground"
          : "flex items-center gap-2 rounded-md px-3 py-1 text-muted-foreground"
      }
    >
      {icon}
      {label}
    </span>
  );
}
