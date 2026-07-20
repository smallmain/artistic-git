import { Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import { openUpdateReleasePage } from "@/lib/ipc/commands";
import type {
  UpdateInstallGateResponse,
  UpdateStatusEvent,
} from "@/lib/ipc/update-types";
import { useWindowStore } from "@/store/window-store";

export function UpdaterPromptDialog() {
  const { t } = useTranslation();
  const installGate = useWindowStore((state) => state.updateInstallGate);
  const installing = useWindowStore((state) => state.updateInstallInProgress);
  const open = useWindowStore((state) => state.updatePromptOpen);
  const setDismissedRequestId = useWindowStore(
    (state) => state.setUpdatePromptDismissedRequestId,
  );
  const setOpen = useWindowStore((state) => state.setUpdatePromptOpen);
  const updateStatus = useWindowStore((state) => state.updateStatus);

  const status = updateStatus?.status ?? null;
  if (!open || !updateStatus || !status || !isPromptStatus(status)) {
    return null;
  }

  const version =
    "version" in status ? status.version : t("updaterPrompt.unknownVersion");
  const notes = "notes" in status ? status.notes : null;
  const ready = status.state === "ready";
  const failed = status.state === "failed";
  const releaseAvailable = status.state === "releaseAvailable";
  const installBlockedMessage =
    ready && installGate.blocked
      ? updateInstallGateMessage(installGate, t)
      : null;

  const closePrompt = () => {
    if (installing) {
      return;
    }
    setDismissedRequestId(updateStatus.requestId);
    setOpen(false);
  };

  const title =
    status.state === "failed"
      ? t("updaterPrompt.failedTitle")
      : releaseAvailable
        ? t("updaterPrompt.releasePageTitle")
        : ready
          ? t("updaterPrompt.readyTitle")
          : t("updaterPrompt.availableTitle");
  const description =
    status.state === "failed"
      ? t("updaterPrompt.failedDescription")
      : releaseAvailable
        ? t("updaterPrompt.releasePageDescription", { version })
        : ready
          ? t("updaterPrompt.readyDescription", { version })
          : t("updaterPrompt.availableDescription", { version });

  return (
    <DialogFrame
      className="max-w-xl"
      closeOnEscape={!installing}
      description={description}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={installing}
            onClick={closePrompt}
            type="button"
            variant="ghost"
          >
            {failed ? t("actions.close") : t("updaterPrompt.later")}
          </Button>
          {failed ? null : (
            <>
              {releaseAvailable ? (
                <Button
                  className="gap-2"
                  onClick={() => {
                    void openUpdateReleasePage().catch((error) => {
                      window.dispatchEvent(
                        new CustomEvent("artistic-git:error", {
                          detail: error,
                        }),
                      );
                    });
                  }}
                  type="button"
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  {t("updaterPrompt.openReleases")}
                </Button>
              ) : (
                <Button
                  className="gap-2"
                  disabled={!ready || installGate.blocked || installing}
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent("artistic-git:install-update"),
                    );
                  }}
                  type="button"
                >
                  {installing ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Download className="size-4" aria-hidden="true" />
                  )}
                  {installing
                    ? t("updaterPrompt.installing")
                    : t("updaterPrompt.restartNow")}
                </Button>
              )}
            </>
          )}
        </div>
      }
      hideCloseButton={installing}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !installing) {
          closePrompt();
        }
      }}
      title={title}
    >
      {installing ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("updaterPrompt.installing")}
        </p>
      ) : null}
      {failed ? (
        <p className="text-sm text-destructive">
          {t("updaterPrompt.failedMessage", { message: status.message })}
        </p>
      ) : (
        <>
          <div className="flex items-start gap-3 rounded-md border bg-background p-3">
            <RefreshCw
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-2">
              <p className="text-sm font-medium">
                {t("updaterPrompt.versionAvailable", { version })}
              </p>
              <UpdateDownloadStatus status={status} />
              {installBlockedMessage ? (
                <p className="text-sm text-muted-foreground">
                  {installBlockedMessage}
                </p>
              ) : null}
            </div>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              {t("updaterPrompt.releaseNotes")}
            </h3>
            <div className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-sm">
              {notes?.trim() ? notes : t("updaterPrompt.noReleaseNotes")}
            </div>
          </section>
        </>
      )}
    </DialogFrame>
  );
}

function UpdateDownloadStatus({
  status,
}: {
  status: Extract<
    UpdateStatusEvent["status"],
    { state: "available" | "releaseAvailable" | "downloading" | "ready" }
  >;
}) {
  const { t } = useTranslation();

  if (status.state === "releaseAvailable") {
    return (
      <p className="text-sm text-muted-foreground">
        {t("updaterPrompt.releasePageStatus")}
      </p>
    );
  }

  if (status.state === "ready") {
    return (
      <p className="text-sm text-muted-foreground">
        {t("updaterPrompt.readyStatus")}
      </p>
    );
  }

  const progress =
    status.state === "downloading" && status.progress !== null
      ? Math.round(status.progress * 100)
      : null;

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {progress === null
          ? t("updaterPrompt.downloadingUnknown")
          : t("updaterPrompt.downloadingProgress", { percent: progress })}
      </p>
      <div
        aria-label={t("updaterPrompt.downloadProgress")}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress ?? undefined}
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div
          className="h-full bg-primary"
          style={{
            width: `${progress ?? 8}%`,
          }}
        />
      </div>
    </div>
  );
}

function isPromptStatus(status: UpdateStatusEvent["status"]): status is Extract<
  UpdateStatusEvent["status"],
  {
    state:
      "available" | "releaseAvailable" | "downloading" | "ready" | "failed";
  }
> {
  return (
    status.state === "available" ||
    status.state === "releaseAvailable" ||
    status.state === "downloading" ||
    status.state === "ready" ||
    status.state === "failed"
  );
}

function updateInstallGateMessage(
  gate: UpdateInstallGateResponse,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (gate.reason) {
    case "gitOperation":
    case "backgroundOperation":
      return t("settings.about.installBlockedGitOperation");
    case "closeGuard":
      return t("settings.about.installBlockedCloseGuard");
    case "conflict":
      return t("settings.about.installBlockedConflict");
    case "reviewMode":
      return t("settings.about.installBlockedReviewMode");
    case "unsupportedInstallFormat":
      return t("settings.about.installBlockedUnsupportedFormat");
    default:
      return gate.message ?? t("settings.about.installBlocked");
  }
}
