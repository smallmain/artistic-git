import { describe, expect, it } from "vitest";

import { resources } from "./resources";

function stringEntries(
  value: unknown,
  prefix = "",
): Array<[key: string, value: string]> {
  if (typeof value === "string") {
    return [[prefix, value]];
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    stringEntries(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("localized status copy", () => {
  it("ends Chinese in-progress labels with an ellipsis", () => {
    const violations = stringEntries(resources["zh-CN"].translation).filter(
      ([, value]) => value.startsWith("正在") && !value.endsWith("..."),
    );

    expect(violations).toEqual([]);
    expect(
      resources["zh-CN"].translation.updaterPrompt.availableDescription,
    ).toMatch(/\.\.\.$/);
  });
});
