import {
  AlertTriangle,
  CloudOff,
  Download,
  Loader2,
  LogOut,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { DialogLayerContext, useModalLayer } from "@/lib/dialog-layer";
import type { ReviewModeState } from "@/lib/ipc/generated";

interface ReviewModeOverlayProps {
  busyAction: "exit" | "sync" | null;
  onExit: () => void;
  onSync: () => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  state: ReviewModeState;
}

export function ReviewModeOverlay({
  busyAction,
  onExit,
  onSync,
  returnFocusRef,
  state,
}: ReviewModeOverlayProps) {
  const { t } = useTranslation();
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const dialogId = useModalLayer(overlayRef, {
    restoreFocusRef: returnFocusRef,
  });
  const busy = busyAction !== null;
  const commit = state.latestCommit;
  const offline = state.pullStatus === "offline";
  const branch = state.branchName ?? t("review.detachedBranch");

  return (
    <DialogLayerContext.Provider value={dialogId}>
      <div
        ref={overlayRef}
        aria-label={t("review.overlayLabel")}
        aria-modal="true"
        className="fixed inset-0 z-50 flex items-center justify-center bg-background/82 px-4 backdrop-blur-sm"
        role="dialog"
        tabIndex={-1}
      >
        <section className="grid w-full max-w-lg gap-5 rounded-md border bg-card p-5 text-card-foreground shadow-floating">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{t("review.title")}</h2>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {t("review.branch", { branch })}
              </p>
            </div>
            {offline ? (
              <Tooltip
                content={
                  <span className="grid gap-1">
                    <span>{t("review.offlineTooltip")}</span>
                    {state.pullMessage ? (
                      <span className="text-muted-foreground">
                        {t("repository.fetchTechnicalDetails", {
                          message: state.pullMessage,
                        })}
                      </span>
                    ) : null}
                  </span>
                }
              >
                {({ describedBy }) => (
                  <span
                    aria-describedby={describedBy}
                    className="inline-flex size-9 items-center justify-center rounded-md border border-warning/40 bg-warning/10 text-warning"
                    tabIndex={0}
                  >
                    <CloudOff className="size-4" aria-hidden="true" />
                  </span>
                )}
              </Tooltip>
            ) : null}
          </div>

          <div className="grid gap-2 rounded-md border bg-background p-3 text-sm">
            <span className="text-xs uppercase text-muted-foreground">
              {t("review.latestCommit")}
            </span>
            <span className="truncate font-medium">
              {commit?.subject ?? t("review.noCommit")}
            </span>
            {commit ? (
              <span className="font-mono text-xs text-muted-foreground">
                {commit.oid.slice(0, 12)}
              </span>
            ) : null}
          </div>

          {state.pullError ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
              role="alert"
            >
              <span className="min-w-0 flex-1">
                {state.pullMessage ?? t("review.pullFailed")}
              </span>
              <Button
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("artistic-git:error", {
                      detail: state.pullError,
                    }),
                  );
                }}
                type="button"
                variant="ghost"
              >
                {t("dialogs.error.showDetails")}
              </Button>
            </div>
          ) : null}

          {state.hasRemoteUpdate ? (
            <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">{t("review.remoteUpdate")}</span>
              <Button
                disabled={busy}
                onClick={onSync}
                size="default"
                type="button"
                variant="secondary"
              >
                {busyAction === "sync" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                {busyAction === "sync" ? t("review.syncing") : t("review.sync")}
              </Button>
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={onExit} type="button">
              {busyAction === "exit" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <LogOut className="size-4" aria-hidden="true" />
              )}
              {busyAction === "exit" ? t("review.exiting") : t("review.exit")}
            </Button>
          </div>
        </section>
      </div>
    </DialogLayerContext.Provider>
  );
}
