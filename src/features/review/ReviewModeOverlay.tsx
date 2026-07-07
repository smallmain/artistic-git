import { AlertTriangle, CloudOff, Download, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { ReviewModeState } from "@/lib/ipc/generated";

interface ReviewModeOverlayProps {
  busy: boolean;
  onExit: () => void;
  onSync: () => void;
  state: ReviewModeState;
}

export function ReviewModeOverlay({
  busy,
  onExit,
  onSync,
  state,
}: ReviewModeOverlayProps) {
  const { t } = useTranslation();
  const commit = state.latestCommit;
  const offline =
    state.pullStatus === "offline" || state.pullStatus === "failed";
  const branch = state.branchName ?? t("review.detachedBranch");

  return (
    <div
      aria-label={t("review.overlayLabel")}
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-background/82 px-4 backdrop-blur-sm"
      role="dialog"
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
            <Tooltip content={state.pullMessage ?? t("review.offlineTooltip")}>
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
              <Download className="size-4" aria-hidden="true" />
              {t("review.sync")}
            </Button>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={onExit} type="button">
            <LogOut className="size-4" aria-hidden="true" />
            {busy ? t("review.exiting") : t("review.exit")}
          </Button>
        </div>
      </section>
    </div>
  );
}
