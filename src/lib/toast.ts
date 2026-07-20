export const appToastEventName = "artistic-git:toast";

export const defaultToastDurationMs = 5_000;

export type ToastTone = "error" | "info" | "success" | "warning";

export interface ToastRequest {
  durationMs?: number;
  key?: string;
  message: string;
  tone?: ToastTone;
}

export function showToast(request: ToastRequest): void {
  window.dispatchEvent(
    new CustomEvent<ToastRequest>(appToastEventName, { detail: request }),
  );
}
