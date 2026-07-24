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

describe("design token contract (redesign-spec)", () => {
  const darkBlock = styles.match(/:root\[data-theme="dark"\][\s\S]*?\n\}/);

  it("embeds Inter Variable locally with swap display", () => {
    expect(styles).toMatch(
      /@font-face\s*\{[^}]*font-family:\s*"Inter"[^}]*src:\s*url\("\.\/assets\/fonts\/InterVariable\.woff2"\)[^}]*font-display:\s*swap/s,
    );
  });

  it("defines font stacks with Inter first and system CJK fallback", () => {
    expect(styles).toContain('--font-sans:\n    "Inter"');
    expect(styles).toContain('"PingFang SC"');
    expect(styles).toContain("--font-mono:");
    expect(styles).toContain("ui-monospace");
  });

  it("provides three-level text colors in both themes", () => {
    expect(styles).toContain("--foreground-secondary:");
    expect(styles).toContain("--foreground-tertiary:");
    expect(darkBlock?.[0]).toContain("--foreground-secondary:");
    expect(darkBlock?.[0]).toContain("--foreground-tertiary:");
  });

  it("provides subtle border token in both themes", () => {
    expect(styles).toContain("--border-subtle:");
    expect(darkBlock?.[0]).toContain("--border-subtle:");
  });

  it("provides the raised/overlay/popover shadow ladder", () => {
    expect(styles).toContain("--shadow-raised-value:");
    expect(styles).toContain("--shadow-overlay-value:");
    expect(styles).toContain("--shadow-popover-value:");
    expect(styles).toContain(
      "--shadow-floating-value: var(--shadow-popover-value);",
    );
    expect(darkBlock?.[0]).toContain("--shadow-raised-value:");
    expect(darkBlock?.[0]).toContain("--shadow-overlay-value:");
    expect(darkBlock?.[0]).toContain("--shadow-popover-value:");
  });

  it("provides the motion duration ladder and easing curves", () => {
    expect(styles).toContain("--duration-micro-value: 120ms;");
    expect(styles).toContain("--duration-fast-value: 180ms;");
    expect(styles).toContain("--duration-panel-value: 240ms;");
    expect(styles).toContain("--duration-large-value: 320ms;");
    expect(styles).toContain(
      "--ease-standard-value: cubic-bezier(0.25, 0.1, 0.25, 1);",
    );
    expect(styles).toContain(
      "--ease-enter-value: cubic-bezier(0.16, 1, 0.3, 1);",
    );
    expect(styles).toContain("--ease-exit-value: cubic-bezier(0.4, 0, 1, 1);");
  });

  it("maps new tokens into the Tailwind theme", () => {
    expect(styles).toContain(
      "--color-foreground-secondary: hsl(var(--foreground-secondary));",
    );
    expect(styles).toContain(
      "--color-foreground-tertiary: hsl(var(--foreground-tertiary));",
    );
    expect(styles).toContain("--color-border-subtle: hsl(var(--border-subtle));");
    expect(styles).toContain("--shadow-popover: var(--shadow-popover-value);");
    expect(styles).toContain("--duration-micro: var(--duration-micro-value);");
    expect(styles).toContain("--ease-enter: var(--ease-enter-value);");
    expect(styles).toContain("--font-sans: var(--font-sans);");
    expect(styles).toContain("--font-mono: var(--font-mono);");
  });

  it("locks the semantic type scale parameters", () => {
    const cases = [
      /\.text-display\s*\{[^}]*font-size:\s*24px[^}]*line-height:\s*32px[^}]*font-weight:\s*560[^}]*letter-spacing:\s*-0\.022em/s,
      /\.text-title\s*\{[^}]*font-size:\s*16px[^}]*line-height:\s*24px[^}]*font-weight:\s*560[^}]*letter-spacing:\s*-0\.011em/s,
      /\.text-heading\s*\{[^}]*font-size:\s*14px[^}]*line-height:\s*20px[^}]*font-weight:\s*560[^}]*letter-spacing:\s*-0\.006em/s,
      /\.text-body\s*\{[^}]*font-size:\s*13px[^}]*line-height:\s*20px[^}]*font-weight:\s*450/s,
      /\.text-label\s*\{[^}]*font-size:\s*12px[^}]*line-height:\s*16px[^}]*font-weight:\s*500[^}]*letter-spacing:\s*0\.003em/s,
      /\.text-caption\s*\{[^}]*font-size:\s*12px[^}]*line-height:\s*16px[^}]*font-weight:\s*450/s,
    ];

    for (const pattern of cases) {
      expect(styles).toMatch(pattern);
    }
  });

  it("sets the base body typography to the 13px Linear density", () => {
    expect(styles).toMatch(
      /body\s*\{[^}]*font-family:\s*var\(--font-sans\)[^}]*font-size:\s*13px[^}]*line-height:\s*20px[^}]*font-weight:\s*450/s,
    );
  });
});
