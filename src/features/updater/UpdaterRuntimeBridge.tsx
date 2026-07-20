import * as React from "react";

import {
  checkForUpdates,
  installReadyUpdate,
  updateInstallGate,
} from "@/lib/ipc/commands";
import { emitAppEvent, listenAppEvent } from "@/lib/ipc/events";
import type {
  UpdateCheckSource,
  UpdateInstallGateResponse,
  UpdateStatusEvent,
} from "@/lib/ipc/update-types";
import { useWindowStore } from "@/store/window-store";

import { isDevelopmentRuntime } from "./development-runtime";
import { UpdaterPromptDialog } from "./UpdaterPromptDialog";

export const AUTO_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const AUTO_UPDATE_INITIAL_DELAY_MS = 1000;
const INSTALL_GATE_REFRESH_INTERVAL_MS = 5000;
export const INSTALL_GATE_WINDOW_RESPONSE_WAIT_MS = 100;

const noReadyUpdateGate: UpdateInstallGateResponse = {
  blocked: true,
  message: "no downloaded update is ready to install",
  reason: "noReadyUpdate",
};

let nextInstallGateRequestId = 0;

export function UpdaterRuntimeBridge() {
  const appSettings = useWindowStore((state) => state.appSettings);
  const conflictsByRepository = useWindowStore(
    (state) => state.conflictsByRepository,
  );
  const projectSettingsByRepository = useWindowStore(
    (state) => state.projectSettingsByRepository,
  );
  const updateStatus = useWindowStore((state) => state.updateStatus);
  const updatePromptDismissedRequestId = useWindowStore(
    (state) => state.updatePromptDismissedRequestId,
  );
  const windowLabel = useWindowStore((state) => state.windowLabel);
  const setUpdateInstallGate = useWindowStore(
    (state) => state.setUpdateInstallGate,
  );
  const setUpdateInstallInProgress = useWindowStore(
    (state) => state.setUpdateInstallInProgress,
  );
  const setUpdatePromptDismissedRequestId = useWindowStore(
    (state) => state.setUpdatePromptDismissedRequestId,
  );
  const setUpdatePromptOpen = useWindowStore(
    (state) => state.setUpdatePromptOpen,
  );
  const setUpdateStatus = useWindowStore((state) => state.setUpdateStatus);
  const blockersRef = React.useRef({
    conflictsByRepository,
    projectSettingsByRepository,
  });
  const dismissedPromptRequestIdRef = React.useRef(
    updatePromptDismissedRequestId,
  );
  const installInFlightRef = React.useRef(false);
  const updateStatusRef = React.useRef(updateStatus);
  const windowLabelRef = React.useRef(windowLabel);

  React.useEffect(() => {
    blockersRef.current = {
      conflictsByRepository,
      projectSettingsByRepository,
    };
  }, [conflictsByRepository, projectSettingsByRepository]);

  React.useEffect(() => {
    windowLabelRef.current = windowLabel;
  }, [windowLabel]);

  React.useEffect(() => {
    dismissedPromptRequestIdRef.current = updatePromptDismissedRequestId;
  }, [updatePromptDismissedRequestId]);

  React.useEffect(() => {
    updateStatusRef.current = updateStatus;
  }, [updateStatus]);

  const frontendInstallGate =
    React.useCallback((): UpdateInstallGateResponse | null => {
      const blockers = blockersRef.current;
      if (Object.keys(blockers.conflictsByRepository).length > 0) {
        return {
          blocked: true,
          message: "finish conflict resolution before installing an update",
          reason: "conflict",
        };
      }

      const reviewModeActive = Object.values(
        blockers.projectSettingsByRepository,
      ).some((project) => Boolean(project.reviewModeCrash));
      if (reviewModeActive) {
        return {
          blocked: true,
          message: "finish review mode before installing an update",
          reason: "reviewMode",
        };
      }

      return null;
    }, []);

  const refreshInstallGate = React.useCallback(async () => {
    const frontendGate = frontendInstallGate();
    if (frontendGate) {
      setUpdateInstallGate(frontendGate);
      return frontendGate;
    }

    const windowGate = await queryWindowInstallGate(windowLabelRef.current);
    if (windowGate) {
      setUpdateInstallGate(windowGate);
      return windowGate;
    }

    try {
      const gate = await updateInstallGate();
      setUpdateInstallGate(gate);
      return gate;
    } catch {
      setUpdateInstallGate(noReadyUpdateGate);
      return noReadyUpdateGate;
    }
  }, [frontendInstallGate, setUpdateInstallGate]);

  React.useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    void listenAppEvent("update-install-gate-request", (event) => {
      if (!active) {
        return;
      }

      const gate = frontendInstallGate();
      if (!gate) {
        return;
      }

      void emitAppEvent("update-install-gate-response", {
        gate,
        requestId: event.payload.requestId,
        responderWindowLabel: windowLabelRef.current,
      }).catch(() => undefined);
    })
      .then((resolvedUnlisten) => {
        if (active) {
          unlisten = resolvedUnlisten;
        } else {
          resolvedUnlisten();
        }
      })
      .catch(() => {
        // Browser-only tests and previews do not have a Tauri event runtime.
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [frontendInstallGate]);

  React.useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    void listenAppEvent("update-status", (event) => {
      const payload = event.payload;
      if (!isStatusForCurrentWindow(payload, windowLabelRef.current)) {
        return;
      }

      setUpdateStatus(payload);
      if (
        shouldOpenUpdatePrompt(payload, dismissedPromptRequestIdRef.current)
      ) {
        setUpdatePromptOpen(true);
      }
      if (payload.status.state === "ready") {
        void refreshInstallGate();
      } else if (
        payload.status.state === "notAvailable" ||
        payload.status.state === "releaseAvailable"
      ) {
        setUpdateInstallGate(noReadyUpdateGate);
      }
    })
      .then((resolvedUnlisten) => {
        if (active) {
          unlisten = resolvedUnlisten;
        } else {
          resolvedUnlisten();
        }
      })
      .catch(() => {
        // Browser-only tests and previews do not have a Tauri event runtime.
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [
    refreshInstallGate,
    setUpdateInstallGate,
    setUpdatePromptOpen,
    setUpdateStatus,
  ]);

  React.useEffect(() => {
    const handleManualCheck = () => {
      void checkForUpdates({ source: "manual" }).catch((error) => {
        const status = failedUpdateStatus(
          error,
          "manual",
          windowLabelRef.current,
        );
        setUpdateStatus(status);
        setUpdatePromptDismissedRequestId(null);
        setUpdatePromptOpen(true);
      });
    };
    const handleInstall = () => {
      if (
        updateStatusRef.current?.status.state !== "ready" ||
        installInFlightRef.current
      ) {
        return;
      }

      installInFlightRef.current = true;
      setUpdateInstallInProgress(true);
      void Promise.resolve()
        .then(refreshInstallGate)
        .then((gate) => {
          if (gate.blocked) {
            return;
          }
          return installReadyUpdate();
        })
        .catch((error) => {
          const status = failedUpdateStatus(
            error,
            "manual",
            windowLabelRef.current,
          );
          setUpdateStatus(status);
          setUpdatePromptDismissedRequestId(null);
          setUpdatePromptOpen(true);
        })
        .finally(() => {
          installInFlightRef.current = false;
          setUpdateInstallInProgress(false);
        });
    };

    window.addEventListener("artistic-git:check-updates", handleManualCheck);
    window.addEventListener("artistic-git:install-update", handleInstall);
    return () => {
      window.removeEventListener(
        "artistic-git:check-updates",
        handleManualCheck,
      );
      window.removeEventListener("artistic-git:install-update", handleInstall);
    };
  }, [
    refreshInstallGate,
    setUpdateInstallInProgress,
    setUpdatePromptDismissedRequestId,
    setUpdatePromptOpen,
    setUpdateStatus,
  ]);

  React.useEffect(() => {
    // Development builds use a placeholder updater public key and are not
    // installable release packages, so automatic update checks stay disabled.
    if (
      isDevelopmentRuntime() ||
      appSettings === null ||
      appSettings.updates?.autoCheck === false
    ) {
      return;
    }

    const runAutomaticCheck = () => {
      void checkForUpdates({ source: "automatic" }).catch((error) => {
        setUpdateStatus(
          failedUpdateStatus(error, "automatic", windowLabelRef.current),
        );
      });
    };
    const initialTimer = window.setTimeout(
      runAutomaticCheck,
      AUTO_UPDATE_INITIAL_DELAY_MS,
    );
    const interval = window.setInterval(
      runAutomaticCheck,
      AUTO_UPDATE_CHECK_INTERVAL_MS,
    );

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [appSettings, setUpdateStatus]);

  React.useEffect(() => {
    if (updateStatus?.status.state !== "ready") {
      return;
    }

    void refreshInstallGate();
    const interval = window.setInterval(
      () => void refreshInstallGate(),
      INSTALL_GATE_REFRESH_INTERVAL_MS,
    );
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshInstallGate, updateStatus]);

  return <UpdaterPromptDialog />;
}

function isStatusForCurrentWindow(
  event: UpdateStatusEvent,
  windowLabel: string | null,
): boolean {
  return (
    !event.targetWindowLabel ||
    !windowLabel ||
    event.targetWindowLabel === windowLabel
  );
}

function shouldOpenUpdatePrompt(
  event: UpdateStatusEvent,
  dismissedRequestId: string | null,
): boolean {
  if (event.requestId === dismissedRequestId) {
    return false;
  }

  if (event.source === "automatic") {
    return (
      event.status.state === "ready" ||
      event.status.state === "releaseAvailable"
    );
  }

  return (
    event.status.state === "available" ||
    event.status.state === "releaseAvailable" ||
    event.status.state === "downloading" ||
    event.status.state === "ready" ||
    (event.status.state === "failed" && event.status.visible)
  );
}

function failedUpdateStatus(
  error: unknown,
  source: UpdateCheckSource,
  windowLabel: string | null,
): UpdateStatusEvent {
  return {
    requestId: `${source}-update-check-failed`,
    source,
    targetWindowLabel: windowLabel,
    status: {
      message: errorMessage(error),
      state: "failed",
      visible: source === "manual",
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "summary" in error &&
    typeof error.summary === "string"
  ) {
    return error.summary;
  }
  return typeof error === "string" ? error : "Update check failed";
}

function queryWindowInstallGate(
  requesterWindowLabel: string | null,
): Promise<UpdateInstallGateResponse | null> {
  const requestId = `update-install-gate-${Date.now()}-${++nextInstallGateRequestId}`;

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;
    let unlisten: (() => void) | null = null;

    const settle = (gate: UpdateInstallGateResponse | null) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      unlisten?.();
      resolve(gate);
    };

    void listenAppEvent("update-install-gate-response", (event) => {
      const payload = event.payload;
      if (payload.requestId !== requestId || !payload.gate.blocked) {
        return;
      }

      settle(payload.gate);
    })
      .then((resolvedUnlisten) => {
        if (settled) {
          resolvedUnlisten();
          return;
        }

        unlisten = resolvedUnlisten;
        timeoutId = window.setTimeout(() => {
          settle(null);
        }, INSTALL_GATE_WINDOW_RESPONSE_WAIT_MS);
        void emitAppEvent("update-install-gate-request", {
          requestId,
          requesterWindowLabel,
        }).catch(() => {
          settle(null);
        });
      })
      .catch(() => {
        settle(null);
      });
  });
}
