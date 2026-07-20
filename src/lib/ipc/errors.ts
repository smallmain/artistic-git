import type { AppError } from "@/lib/ipc/generated";

export function isOperationCancelledError(error: unknown): error is AppError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Partial<AppError>;
  return (
    candidate.category === "expected" &&
    candidate.summary === "operation cancelled" &&
    candidate.git === null
  );
}
