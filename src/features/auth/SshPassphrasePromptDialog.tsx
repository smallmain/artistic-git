import { KeyRound, Loader2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import type {
  AuthPromptDismissedEvent,
  SshPassphrasePromptEvent,
  SubmitSshPassphrasePromptRequest,
} from "@/lib/ipc/commands";
import {
  setAuthPromptListenerReady,
  submitSshPassphrasePrompt,
} from "@/lib/ipc/commands";
import { listenRuntimeEvent } from "@/lib/ipc/events";

export function SshPassphrasePromptDialog() {
  const { t } = useTranslation();
  const [prompts, setPrompts] = React.useState<SshPassphrasePromptEvent[]>([]);
  const prompt = prompts[0] ?? null;
  const [passphrase, setPassphrase] = React.useState("");
  const [remember, setRemember] = React.useState(false);
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
        setPassphrase("");
        setRemember(prompt.request.rememberAvailable);
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
          await listenRuntimeEvent<SshPassphrasePromptEvent>(
            "ssh-passphrase-prompt",
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
            "ssh-passphrase-prompt-dismissed",
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
          kind: "sshPassphrase",
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
        kind: "sshPassphrase",
        ready: false,
      }).catch(() => undefined);
    };
  }, []);

  if (!prompt) {
    return null;
  }

  const request = prompt.request;
  const busy = busyAction !== null;
  const submitDisabled = !passphrase || busy;

  const completePrompt = async (
    submission: Omit<SubmitSshPassphrasePromptRequest, "promptId">,
  ) => {
    setBusyAction(submission.cancelled ? "cancel" : "submit");
    try {
      await submitSshPassphrasePrompt({
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
      description={t("auth.ssh.description")}
      dismissible={!busy}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            className="gap-2"
            disabled={busy}
            onClick={() =>
              void completePrompt({
                cancelled: true,
                remember: false,
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
                passphrase,
                remember: request.rememberAvailable && remember,
              })
            }
            type="button"
          >
            {busyAction === "submit" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <KeyRound className="size-4" aria-hidden="true" />
            )}
            {busyAction === "submit"
              ? t("auth.ssh.submitting")
              : t("auth.ssh.submit")}
          </Button>
        </div>
      }
      onOpenChange={(open) => {
        if (!open && !busy) {
          void completePrompt({ cancelled: true, remember: false });
        }
      }}
      title={t("auth.ssh.title")}
    >
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("auth.ssh.key")}</span>
          <input
            className="h-9 rounded-md border bg-muted px-3 text-sm"
            readOnly
            value={request.keyId}
          />
        </label>

        {request.prompt ? (
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">
              {t("dialogs.error.showDetails")}
            </summary>
            <p className="mt-2 select-text break-words rounded-md border bg-muted px-3 py-2 font-mono text-xs">
              {request.prompt}
            </p>
          </details>
        ) : null}

        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("auth.ssh.passphrase")}</span>
          <input
            autoFocus
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={busy}
            onChange={(event) => setPassphrase(event.target.value)}
            type="password"
            value={passphrase}
          />
        </label>

        {request.rememberAvailable ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              checked={remember}
              className="size-4 accent-primary"
              disabled={busy}
              onChange={(event) => setRemember(event.target.checked)}
              type="checkbox"
            />
            <span>{t("auth.ssh.remember")}</span>
          </label>
        ) : null}
      </div>
    </DialogFrame>
  );
}
