import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("global text selection policy", () => {
  it("keeps application chrome non-selectable by default", () => {
    expect(styles).toMatch(
      /body\s*\{[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;/s,
    );
  });

  it("restores selection for editable and copy-worthy content", () => {
    const selectableRule = styles.match(
      /:where\(\s*input:not\(\[type\]\)[\s\S]*?\.cm-content\s*\)\s*\{([^}]*)\}/,
    );

    expect(selectableRule?.[0]).toContain("textarea");
    expect(selectableRule?.[0]).toContain("[contenteditable]");
    expect(selectableRule?.[0]).toContain("pre");
    expect(selectableRule?.[0]).toContain(".select-text");
    expect(selectableRule?.[1]).toContain("-webkit-user-select: text");
    expect(selectableRule?.[1]).toContain("user-select: text");
  });
});
