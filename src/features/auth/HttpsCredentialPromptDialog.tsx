import { listen } from "@tauri-apps/api/event";
import { KeyRound, Save } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import type {
  HttpsCredentialPromptEvent,
  SubmitHttpsCredentialPromptRequest,
} from "@/lib/ipc/commands";
import { submitHttpsCredentialPrompt } from "@/lib/ipc/commands";
import type { HttpsCredentialScope } from "@/lib/ipc/generated";
import { cn } from "@/lib/utils";

export function HttpsCredentialPromptDialog() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = React.useState<HttpsCredentialPromptEvent | null>(
    null,
  );
  const [username, setUsername] = React.useState("");
  const [token, setToken] = React.useState("");
  const [scope, setScope] = React.useState<HttpsCredentialScope>("host");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<HttpsCredentialPromptEvent>(
      "https-credential-prompt",
      (event) => {
        const next = event.payload;
        setPrompt(next);
        setUsername(next.request.suggestedUsername ?? "");
        setToken("");
        setScope(next.request.defaultScope);
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
  const canUsePathScope = Boolean(request.path);
  const submitDisabled = !username.trim() || !token || submitting;
  const title =
    request.reason === "invalidOrExpired"
      ? t("auth.https.invalidTitle")
      : t("auth.https.title");

  const completePrompt = async (
    submission: Omit<SubmitHttpsCredentialPromptRequest, "promptId">,
  ) => {
    setSubmitting(true);
    try {
      await submitHttpsCredentialPrompt({
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
      description={t("auth.https.description")}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            disabled={submitting}
            onClick={() =>
              void completePrompt({
                cancelled: true,
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
                scope,
                token,
                username: username.trim(),
              })
            }
            type="button"
          >
            <Save className="size-4" aria-hidden="true" />
            {t("auth.https.submit")}
          </Button>
        </div>
      }
      onOpenChange={(open) => {
        if (!open && !submitting) {
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
            onChange={(event) => setUsername(event.target.value)}
            value={username}
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("auth.https.token")}</span>
          <input
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              label={t("auth.https.hostScope")}
              onClick={() => setScope("host")}
            />
            <ScopeButton
              active={scope === "path"}
              disabled={!canUsePathScope}
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
