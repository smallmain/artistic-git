import { isTauri } from "@tauri-apps/api/core";

export function reportDesktopRuntimeError(error: unknown): void {
  if (!isTauri()) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("artistic-git:error", { detail: error }),
  );
}

export function dispatchErrorGroup(
  errors: Array<unknown | null | undefined>,
  summary: string,
): void {
  const presentErrors = errors.filter((error) => error != null);
  if (presentErrors.length === 0) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("artistic-git:error", {
      detail: { errors: presentErrors, summary },
    }),
  );
}

export function reportDesktopRuntimeErrorGroup(
  errors: Array<unknown | null | undefined>,
  summary: string,
): void {
  if (!isTauri()) {
    return;
  }
  dispatchErrorGroup(errors, summary);
}
