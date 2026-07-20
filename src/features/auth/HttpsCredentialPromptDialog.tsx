import { KeyRound, Loader2, Save } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import type {
  AuthPromptDismissedEvent,
  HttpsCredentialPromptEvent,
  SubmitHttpsCredentialPromptRequest,
} from "@/lib/ipc/commands";
import {
  setAuthPromptListenerReady,
  submitHttpsCredentialPrompt,
} from "@/lib/ipc/commands";
import type { HttpsCredentialScope } from "@/lib/ipc/generated";
import { listenRuntimeEvent } from "@/lib/ipc/events";
import { cn } from "@/lib/utils";

export function HttpsCredentialPromptDialog() {
  const { t } = useTranslation();
  const [prompts, setPrompts] = React.useState<HttpsCredentialPromptEvent[]>(
    [],
  );
  const prompt = prompts[0] ?? null;
  const [username, setUsername] = React.useState("");
  const [token, setToken] = React.useState("");
  const [scope, setScope] = React.useState<HttpsCredentialScope>("host");
  const [busyAction, setBusyAction] = React.useState<
    "cancel" | "submit" | null
  >(null);

  React.useEffect(() => {
    if (!prompt) {
      return;
    }
    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        setUsername(prompt.request.suggestedUsername ?? "");
        setToken("");
        setScope(prompt.request.defaultScope);
        setBusyAction(null);
      }
    });
    return () => {
      active = false;
    };
  }, [prompt]);

  React.useEffect(() => {
    let mounted = true;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        unlisteners.push(
          await listenRuntimeEvent<HttpsCredentialPromptEvent>(
            "https-credential-prompt",
            (event) => {
              const next = event.payload;
              setPrompts((current) =>
                current.some((prompt) => prompt.promptId === next.promptId)
                  ? current
                  : [...current, next],
              );
            },
          ),
        );
        unlisteners.push(
          await listenRuntimeEvent<AuthPromptDismissedEvent>(
            "https-credential-prompt-dismissed",
            (event) => {
              setPrompts((current) =>
                current.filter(
                  (prompt) => prompt.promptId !== event.payload.promptId,
                ),
              );
            },
          ),
        );
        if (!mounted) {
          for (const unlisten of unlisteners.toReversed()) {
            unlisten();
          }
          unlisteners.length = 0;
          return;
        }
        await setAuthPromptListenerReady({
          kind: "httpsCredential",
          ready: true,
        });
      } catch (error) {
        for (const unlisten of unlisteners.toReversed()) {
          unlisten();
        }
        unlisteners.length = 0;
        if (mounted) {
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      }
    })();

    return () => {
      mounted = false;
      for (const unlisten of unlisteners.toReversed()) {
        unlisten();
      }
      unlisteners.length = 0;
      void setAuthPromptListenerReady({
        kind: "httpsCredential",
        ready: false,
      }).catch(() => undefined);
    };
  }, []);

  if (!prompt) {
    return null;
  }

  const request = prompt.request;
  const canUsePathScope = Boolean(request.path);
  const busy = busyAction !== null;
  const submitDisabled = !username.trim() || !token || busy;
  const title =
    request.reason === "invalidOrExpired"
      ? t("auth.https.invalidTitle")
      : t("auth.https.title");

  const completePrompt = async (
    submission: Omit<SubmitHttpsCredentialPromptRequest, "promptId">,
  ) => {
    setBusyAction(submission.cancelled ? "cancel" : "submit");
    try {
      await submitHttpsCredentialPrompt({
        promptId: prompt.promptId,
        ...submission,
      });
      setPrompts((current) =>
        current.filter((item) => item.promptId !== prompt.promptId),
      );
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
      setBusyAction(null);
    }
  };

  return (
    <DialogFrame
      className="max-w-md"
      closeOnEscape={!busy}
      description={t("auth.https.description")}
      dismissible={!busy}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            className="gap-2"
            disabled={busy}
            onClick={() =>
              void completePrompt({
                cancelled: true,
              })
            }
            type="button"
            variant="secondary"
          >
            {busyAction === "cancel" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {busyAction === "cancel"
              ? t("actions.cancelling")
              : t("actions.cancel")}
          </Button>
          <Button
            className="gap-2"
            disabled={submitDisabled}
            onClick={() =>
              void completePrompt({
                cancelled: false,
                scope,
                token,
                username: username.trim(),
              })
            }
            type="button"
          >
            {busyAction === "submit" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            {busyAction === "submit"
              ? t("auth.https.submitting")
              : t("auth.https.submit")}
          </Button>
        </div>
      }
      onOpenChange={(open) => {
        if (!open && !busy) {
          void completePrompt({ cancelled: true });
        }
      }}
      title={title}
    >
      {request.reason === "invalidOrExpired" ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t("auth.https.invalidMessage")}
        </p>
      ) : null}

      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("auth.https.host")}</span>
          <input
            className="h-9 rounded-md border bg-muted px-3 text-sm"
            readOnly
            value={
              request.path ? `${request.host}/${request.path}` : request.host
            }
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("auth.https.username")}</span>
          <input
            autoFocus
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
            value={username}
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("auth.https.token")}</span>
          <input
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
            type="password"
            value={token}
          />
        </label>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <KeyRound className="size-3.5" aria-hidden="true" />
          {t("auth.https.tokenHelp")}
        </p>

        <div className="grid gap-2 text-sm">
          <span className="font-medium">{t("auth.https.saveScope")}</span>
          <div className="grid grid-cols-2 gap-2">
            <ScopeButton
              active={scope === "host"}
              disabled={busy}
              label={t("auth.https.hostScope")}
              onClick={() => setScope("host")}
            />
            <ScopeButton
              active={scope === "path"}
              disabled={!canUsePathScope || busy}
              label={t("auth.https.pathScope")}
              onClick={() => setScope("path")}
            />
          </div>
        </div>
      </div>
    </DialogFrame>
  );
}

function ScopeButton({
  active,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "h-9 rounded-md border px-3 text-sm font-medium",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-foreground hover:bg-accent",
        disabled && "cursor-not-allowed opacity-50 hover:bg-background",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
