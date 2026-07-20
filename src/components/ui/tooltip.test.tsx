import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { calculateTooltipPosition } from "@/components/ui/tooltip-position";
import { Tooltip } from "@/components/ui/tooltip";

describe("tooltip positioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["bottom", rect(340, 16, 40, 24)],
    ["top", rect(340, 560, 40, 24)],
    ["right", rect(16, 280, 40, 24)],
    ["left", rect(744, 280, 40, 24)],
  ] as const)("chooses the %s side with the most room", (side, trigger) => {
    const tooltip = rect(0, 0, 100, 40);
    const position = calculateTooltipPosition(trigger, tooltip, {
      height: 600,
      width: 800,
    });

    expect(position.side).toBe(side);
    expect(position.left).toBeGreaterThanOrEqual(8);
    expect(position.left + tooltip.width).toBeLessThanOrEqual(792);
    expect(position.top).toBeGreaterThanOrEqual(8);
    expect(position.top + tooltip.height).toBeLessThanOrEqual(592);
  });

  it("shifts a tooltip away from the viewport edge", () => {
    const tooltip = rect(0, 0, 120, 40);
    const position = calculateTooltipPosition(rect(270, 20, 24, 24), tooltip, {
      height: 240,
      width: 320,
    });

    expect(position).toEqual({ left: 192, side: "bottom", top: 52 });
  });

  it("renders in a body portal and updates its fixed position when opened", async () => {
    render(
      <div data-testid="clipping-parent" style={{ overflow: "hidden" }}>
        <Tooltip content="A tooltip that can size itself">
          {({ describedBy }) => (
            <button aria-describedby={describedBy}>Trigger</button>
          )}
        </Tooltip>
      </div>,
    );

    const button = screen.getByRole("button", { name: "Trigger" });
    const trigger = button.parentElement;
    const tooltip = screen.getByRole("tooltip", {
      name: "A tooltip that can size itself",
    });

    expect(trigger).not.toBeNull();
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveClass("fixed", "w-max");

    vi.spyOn(trigger!, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 0, 0),
    );
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      rect(270, 20, 24, 24),
    );
    vi.spyOn(tooltip, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 120, 40),
    );
    vi.stubGlobal("innerHeight", 240);
    vi.stubGlobal("innerWidth", 320);

    fireEvent.mouseEnter(trigger!);

    await waitFor(() => {
      expect(tooltip).toHaveAttribute("data-side", "bottom");
      expect(tooltip).toHaveStyle({ left: "192px", top: "52px" });
      expect(tooltip).toHaveAttribute("data-state", "open");
    });

    fireEvent.mouseLeave(trigger!);
    fireEvent.mouseEnter(tooltip);
    expect(tooltip).toHaveAttribute("data-state", "open");

    fireEvent.mouseLeave(tooltip);
    await waitFor(() => {
      expect(tooltip).toHaveAttribute("data-state", "closed");
    });
  });

  it("opens from keyboard focus and dismisses with Escape", async () => {
    render(
      <Tooltip content="Keyboard tooltip">
        {({ describedBy }) => (
          <button aria-describedby={describedBy}>Keyboard trigger</button>
        )}
      </Tooltip>,
    );

    const button = screen.getByRole("button", { name: "Keyboard trigger" });
    const tooltip = screen.getByRole("tooltip", { name: "Keyboard tooltip" });

    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      rect(100, 100, 24, 24),
    );
    vi.spyOn(tooltip, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 100, 40),
    );

    fireEvent.focus(button);
    await waitFor(() => {
      expect(tooltip).toHaveAttribute("data-state", "open");
    });

    fireEvent.keyDown(button, { key: "Escape" });
    expect(tooltip).toHaveAttribute("data-state", "closed");

    fireEvent.blur(button);
    fireEvent.focus(button);
    await waitFor(() => {
      expect(tooltip).toHaveAttribute("data-state", "open");
    });

    fireEvent.blur(button);
    expect(tooltip).toHaveAttribute("data-state", "closed");
  });
});

function rect(left: number, top: number, width: number, height: number) {
  return new DOMRect(left, top, width, height);
}
