import { describe, expect, it } from "vitest";

import { normalizeDisplayPath } from "@/lib/path-display";

describe("normalizeDisplayPath", () => {
  it("normalizes Windows and repeated separators to slash display", () => {
    expect(normalizeDisplayPath("C:\\repo\\\\assets\\hero.png")).toBe(
      "C:/repo/assets/hero.png",
    );
  });

  it("keeps root paths readable", () => {
    expect(normalizeDisplayPath("/")).toBe("/");
    expect(normalizeDisplayPath("/repo/assets/")).toBe("/repo/assets");
  });
});
