import { listen } from "@tauri-apps/api/event";
import { KeyRound } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import type {
  SshPassphrasePromptEvent,
  SubmitSshPassphrasePromptRequest,
} from "@/lib/ipc/commands";
import { submitSshPassphrasePrompt } from "@/lib/ipc/commands";

export function SshPassphrasePromptDialog() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = React.useState<SshPassphrasePromptEvent | null>(
    null,
  );
  const [passphrase, setPassphrase] = React.useState("");
  const [remember, setRemember] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<SshPassphrasePromptEvent>(
      "ssh-passphrase-prompt",
      (event) => {
        const next = event.payload;
        setPrompt(next);
        setPassphrase("");
        setRemember(next.request.rememberAvailable);
        setSubmitting(false);
      },
    ).then((resolvedUnlisten) => {
      unlisten = resolvedUnlisten;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  if (!prompt) {
    return null;
  }

  const request = prompt.request;
  const submitDisabled = !passphrase || submitting;

  const completePrompt = async (
    submission: Omit<SubmitSshPassphrasePromptRequest, "promptId">,
  ) => {
    setSubmitting(true);
    try {
      await submitSshPassphrasePrompt({
        promptId: prompt.promptId,
        ...submission,
      });
      setPrompt(null);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
      setSubmitting(false);
    }
  };

  return (
    <DialogFrame
      className="max-w-md"
      closeOnEscape={!submitting}
      description={t("auth.ssh.description")}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            disabled={submitting}
            onClick={() =>
              void completePrompt({
                cancelled: true,
                remember: false,
              })
            }
            type="button"
            variant="secondary"
          >
            {t("actions.cancel")}
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
            <KeyRound className="size-4" aria-hidden="true" />
            {t("auth.ssh.submit")}
          </Button>
        </div>
      }
      onOpenChange={(open) => {
        if (!open && !submitting) {
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

        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("auth.ssh.prompt")}</span>
          <input
            className="h-9 rounded-md border bg-muted px-3 text-sm"
            readOnly
            value={request.prompt}
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("auth.ssh.passphrase")}</span>
          <input
            autoFocus
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
