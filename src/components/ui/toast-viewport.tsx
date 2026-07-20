import { AlertTriangle, CircleCheck, CircleX, Info, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/icon-button";
import {
  appToastEventName,
  defaultToastDurationMs,
  type ToastRequest,
} from "@/lib/toast";

interface ToastItem extends Required<Pick<ToastRequest, "message" | "tone">> {
  id: string;
}

type ToastPauseReason = "focus" | "hover";

interface ToastTimer {
  pauseReasons: Set<ToastPauseReason>;
  remainingMs: number;
  startedAt: number;
  timeoutId: number | null;
}

const maximumVisibleToasts = 3;
const maximumToastDurationMs = 12_000;
let toastSequence = 0;

function toastDuration(request: ToastRequest) {
  if (request.durationMs !== undefined) {
    return request.durationMs;
  }

  return Math.min(
    maximumToastDurationMs,
    defaultToastDurationMs + Math.max(0, request.message.length - 40) * 60,
  );
}

export function ToastViewport() {
  const { t } = useTranslation();
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const toastsRef = React.useRef<ToastItem[]>([]);
  const timersRef = React.useRef(new Map<string, ToastTimer>());
  const viewportRef = React.useRef<HTMLDivElement>(null);

  const dismissToast = React.useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer?.timeoutId !== null && timer?.timeoutId !== undefined) {
      window.clearTimeout(timer.timeoutId);
    }
    timersRef.current.delete(id);
    const next = toastsRef.current.filter((toast) => toast.id !== id);
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const startToastTimer = React.useCallback(
    (
      id: string,
      durationMs: number,
      pauseReasons: ReadonlySet<ToastPauseReason> = new Set(),
    ) => {
      const timer: ToastTimer = {
        pauseReasons: new Set(pauseReasons),
        remainingMs: durationMs,
        startedAt: Date.now(),
        timeoutId: null,
      };
      if (timer.pauseReasons.size === 0) {
        timer.timeoutId = window.setTimeout(() => dismissToast(id), durationMs);
      }
      timersRef.current.set(id, timer);
    },
    [dismissToast],
  );

  const pauseToast = React.useCallback(
    (id: string, reason: ToastPauseReason) => {
      const timer = timersRef.current.get(id);
      if (!timer || timer.pauseReasons.has(reason)) {
        return;
      }
      if (timer.pauseReasons.size === 0 && timer.timeoutId !== null) {
        window.clearTimeout(timer.timeoutId);
        timer.remainingMs = Math.max(
          0,
          timer.remainingMs - (Date.now() - timer.startedAt),
        );
        timer.timeoutId = null;
      }
      timer.pauseReasons.add(reason);
    },
    [],
  );

  const resumeToast = React.useCallback(
    (id: string, reason: ToastPauseReason) => {
      const timer = timersRef.current.get(id);
      if (!timer) {
        return;
      }
      timer.pauseReasons.delete(reason);
      if (timer.pauseReasons.size > 0 || timer.timeoutId !== null) {
        return;
      }
      if (timer.remainingMs <= 0) {
        dismissToast(id);
        return;
      }
      timer.startedAt = Date.now();
      timer.timeoutId = window.setTimeout(
        () => dismissToast(id),
        timer.remainingMs,
      );
    },
    [dismissToast],
  );

  React.useEffect(() => {
    const timers = timersRef.current;
    const handleToast = (event: Event) => {
      const request = (event as CustomEvent<ToastRequest>).detail;
      if (!request?.message) {
        return;
      }

      toastSequence += 1;
      const id = request.key ?? `toast-${toastSequence.toString(36)}`;
      const previousTimer = timers.get(id);
      const previousPauseReasons = previousTimer?.pauseReasons;
      if (
        previousTimer?.timeoutId !== null &&
        previousTimer?.timeoutId !== undefined
      ) {
        window.clearTimeout(previousTimer.timeoutId);
      }
      timers.delete(id);

      const item: ToastItem = {
        id,
        message: request.message,
        tone: request.tone ?? "info",
      };
      const next = [
        ...toastsRef.current.filter((toast) => toast.id !== id),
        item,
      ];
      const visible = next.slice(-maximumVisibleToasts);
      const visibleIds = new Set(visible.map((toast) => toast.id));
      for (const toast of next) {
        if (visibleIds.has(toast.id)) {
          continue;
        }
        const evictedTimer = timers.get(toast.id);
        if (evictedTimer !== undefined) {
          if (evictedTimer.timeoutId !== null) {
            window.clearTimeout(evictedTimer.timeoutId);
          }
          timers.delete(toast.id);
        }
      }
      toastsRef.current = visible;
      setToasts(visible);
      startToastTimer(id, toastDuration(request), previousPauseReasons);
    };

    window.addEventListener(appToastEventName, handleToast);
    return () => {
      window.removeEventListener(appToastEventName, handleToast);
      for (const timer of timers.values()) {
        if (timer.timeoutId !== null) {
          window.clearTimeout(timer.timeoutId);
        }
      }
      timers.clear();
    };
  }, [startToastTimer]);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [toasts]);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={t("toast.notifications")}
      className="fixed bottom-4 right-4 z-[80] flex max-h-[calc(100vh-2rem)] w-[min(28rem,calc(100vw-2rem))] flex-col items-stretch gap-2 overflow-y-auto overscroll-contain"
      data-testid="toast-viewport"
      ref={viewportRef}
      role="region"
    >
      {toasts.map((toast) => (
        <div
          className="flex max-h-[min(24rem,calc(100vh-2rem))] shrink-0 items-start gap-3 overflow-y-auto rounded-lg border bg-card p-3 text-sm text-card-foreground shadow-floating"
          data-testid="app-toast"
          key={toast.id}
          onBlurCapture={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              resumeToast(toast.id, "focus");
            }
          }}
          onFocusCapture={() => pauseToast(toast.id, "focus")}
          onMouseEnter={() => pauseToast(toast.id, "hover")}
          onMouseLeave={() => resumeToast(toast.id, "hover")}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          {toast.tone === "success" ? (
            <CircleCheck
              className="mt-0.5 size-4 shrink-0 text-success"
              aria-hidden="true"
            />
          ) : toast.tone === "warning" ? (
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-warning"
              aria-hidden="true"
            />
          ) : toast.tone === "error" ? (
            <CircleX
              className="mt-0.5 size-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {toast.message}
          </p>
          <IconButton
            className="-mr-1 -mt-1 shrink-0"
            label={t("actions.close")}
            onClick={() => dismissToast(toast.id)}
            type="button"
            variant="ghost"
          >
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
