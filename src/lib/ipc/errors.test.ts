import { describe, expect, it } from "vitest";

import { isOperationCancelledError } from "./errors";

describe("isOperationCancelledError", () => {
  it("accepts only the structured cancellation response", () => {
    const cancelled = {
      category: "expected",
      context: {
        operationId: "operation-1",
        operationName: "cloneRepository",
        repositoryPath: null,
        windowLabel: "main",
      },
      git: null,
      summary: "operation cancelled",
    };

    expect(isOperationCancelledError(cancelled)).toBe(true);
    expect(
      isOperationCancelledError({
        ...cancelled,
        git: {
          command: ["git", "clone"],
          exitCode: 1,
          stderr: "cleanup failed",
          stdout: "",
        },
      }),
    ).toBe(false);
    expect(isOperationCancelledError(new Error("operation cancelled"))).toBe(
      false,
    );
  });
});
