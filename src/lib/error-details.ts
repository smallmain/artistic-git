import type { AppError } from "@/lib/ipc/generated";

export function getErrorSummary(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (isAppError(error)) {
    return error.summary;
  }

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

  return "Unknown error";
}

export function formatErrorDetails(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  const details = JSON.stringify(toSerializableErrorDetails(error), null, 2);
  return details ?? String(error);
}

function toSerializableErrorDetails(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    const properties = Object.fromEntries(
      Object.entries(value).map(([key, property]) => [
        key,
        toSerializableErrorDetails(property, seen),
      ]),
    );
    return {
      ...properties,
      cause:
        value.cause === undefined
          ? undefined
          : toSerializableErrorDetails(value.cause, seen),
      message: value.message,
      name: value.name,
      stack: value.stack ?? null,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => toSerializableErrorDetails(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, property]) => [
      key,
      toSerializableErrorDetails(property, seen),
    ]),
  );
}

function isAppError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    "summary" in error &&
    "context" in error
  );
}
