import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import {
  cancelPendingWindowExit,
  closeCurrentWindow,
  setWindowCloseGuard,
} from "@/lib/ipc/commands";
import { listenRuntimeEvent } from "@/lib/ipc/events";

type WindowCloseBlockedReason = "closeWindow" | "quit";

interface WindowCloseBlockedEvent {
  reason?: WindowCloseBlockedReason;
}

interface WindowCloseGuardProps {
  active: boolean;
  canRecover: boolean;
  confirmLabel?: string;
  description?: string;
  recoveryBusyLabel?: string;
  onRecover: () => Promise<void>;
}

export function WindowCloseGuard({
  active,
  canRecover,
  confirmLabel,
  description,
  recoveryBusyLabel,
  onRecover,
}: WindowCloseGuardProps) {
  const { t } = useTranslation();
  const [closeRequest, setCloseRequest] = React.useState<{
    reason: WindowCloseBlockedReason;
  } | null>(null);
  const [recoveryBusy, setRecoveryBusy] = React.useState(false);
  const [listenerState, setListenerState] = React.useState<
    "failed" | "loading" | "ready"
  >("loading");
  const activeRef = React.useRef(active);

  React.useEffect(() => {
    activeRef.current = active;
  }, [active]);

  React.useEffect(() => {
    if (!active || listenerState !== "ready") {
      void setWindowCloseGuard({ active: false }).catch(() => undefined);
      return;
    }

    void setWindowCloseGuard({ active: true }).catch((error) => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    });

    const blockClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", blockClose);
    return () => {
      void setWindowCloseGuard({ active: false }).catch(() => undefined);
      window.removeEventListener("beforeunload", blockClose);
    };
  }, [active, listenerState]);

  const cancelPendingQuit = React.useCallback(() => {
    void cancelPendingWindowExit().catch((error) => {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    });
  }, []);

  const handleRecoverAndClose = React.useCallback(
    async (reason: WindowCloseBlockedReason) => {
      setRecoveryBusy(true);
      try {
        if (canRecover) {
          await onRecover();
        }
        setCloseRequest(null);
        await setWindowCloseGuard({ active: false });
        await closeCurrentWindow();
      } catch (error) {
        if (reason === "quit") {
          cancelPendingQuit();
        }
        setCloseRequest(null);
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      } finally {
        setRecoveryBusy(false);
      }
    },
    [canRecover, cancelPendingQuit, onRecover],
  );

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (open || recoveryBusy) {
        return;
      }
      if (closeRequest?.reason === "quit") {
        cancelPendingQuit();
      }
      setCloseRequest(null);
    },
    [cancelPendingQuit, closeRequest?.reason, recoveryBusy],
  );

  React.useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;

    void listenRuntimeEvent<WindowCloseBlockedEvent | WindowCloseBlockedReason>(
      "window-close-blocked",
      (event) => {
        if (!mounted) {
          return;
        }

        const reason = closeBlockedReasonFromPayload(event.payload);
        if (!activeRef.current) {
          void setWindowCloseGuard({ active: false })
            .then(() => closeCurrentWindow())
            .catch((error) => {
              window.dispatchEvent(
                new CustomEvent("artistic-git:error", { detail: error }),
              );
            });
          return;
        }

        setCloseRequest({ reason });
      },
    )
      .then((resolvedUnlisten) => {
        if (mounted) {
          unlisten = resolvedUnlisten;
          setListenerState("ready");
        } else {
          resolvedUnlisten();
        }
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }
        setListenerState("failed");
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
        void setWindowCloseGuard({ active: false }).catch((disableError) => {
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: disableError }),
          );
        });
      });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const recoveryAvailable = canRecover || recoveryBusy;

  if (closeRequest !== null && active && !recoveryAvailable) {
    return (
      <DialogFrame
        description={t("repository.closeGuardBusyBlocked")}
        footer={
          <div className="flex justify-end">
            <Button
              onClick={() => {
                handleOpenChange(false);
              }}
              type="button"
              variant="default"
            >
              {t("repository.closeGuardWait")}
            </Button>
          </div>
        }
        onOpenChange={handleOpenChange}
        title={t("repository.closeGuardTitle")}
      >
        <div className="flex gap-3 rounded-md border bg-background p-3 text-sm">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <p>{t("repository.closeGuardBusyBlocked")}</p>
        </div>
      </DialogFrame>
    );
  }

  return (
    <ConfirmDialog
      busy={recoveryBusy}
      busyLabel={recoveryBusyLabel ?? t("repository.closeGuardRecovering")}
      confirmLabel={
        recoveryAvailable && confirmLabel
          ? confirmLabel
          : recoveryAvailable
            ? t("repository.closeGuardConfirm")
            : t("actions.close")
      }
      description={
        recoveryAvailable && description
          ? description
          : recoveryAvailable
            ? t("repository.closeGuardDescription")
            : t("repository.closeGuardReadyDescription")
      }
      onConfirm={() => {
        if (closeRequest) {
          void handleRecoverAndClose(closeRequest.reason);
        }
      }}
      onOpenChange={handleOpenChange}
      open={closeRequest !== null}
      title={t("repository.closeGuardTitle")}
      variant="danger"
    />
  );
}

function closeBlockedReasonFromPayload(
  payload: WindowCloseBlockedEvent | WindowCloseBlockedReason | unknown,
): WindowCloseBlockedReason {
  if (payload === "quit") {
    return "quit";
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "reason" in payload &&
    (payload as WindowCloseBlockedEvent).reason === "quit"
  ) {
    return "quit";
  }

  return "closeWindow";
}
