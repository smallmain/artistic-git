export type TooltipSide = "top" | "right" | "bottom" | "left";

interface Bounds {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

interface ViewportSize {
  height: number;
  width: number;
}

export interface TooltipPosition {
  left: number;
  side: TooltipSide;
  top: number;
}

interface PositionOptions {
  gap?: number;
  placement?: "auto" | "vertical";
  viewportPadding?: number;
}

interface Candidate extends TooltipPosition {
  clearance: number;
}

const sidePriority: TooltipSide[] = ["bottom", "top", "right", "left"];

export function calculateTooltipPosition(
  trigger: Bounds,
  tooltip: Bounds,
  viewport: ViewportSize,
  { gap = 8, placement = "auto", viewportPadding = 8 }: PositionOptions = {},
): TooltipPosition {
  const triggerCenterX = trigger.left + trigger.width / 2;
  const triggerCenterY = trigger.top + trigger.height / 2;

  const candidates: Record<TooltipSide, Candidate> = {
    bottom: {
      clearance:
        viewport.height -
        trigger.bottom -
        viewportPadding -
        gap -
        tooltip.height,
      left: triggerCenterX - tooltip.width / 2,
      side: "bottom",
      top: trigger.bottom + gap,
    },
    top: {
      clearance: trigger.top - viewportPadding - gap - tooltip.height,
      left: triggerCenterX - tooltip.width / 2,
      side: "top",
      top: trigger.top - gap - tooltip.height,
    },
    right: {
      clearance:
        viewport.width - trigger.right - viewportPadding - gap - tooltip.width,
      left: trigger.right + gap,
      side: "right",
      top: triggerCenterY - tooltip.height / 2,
    },
    left: {
      clearance: trigger.left - viewportPadding - gap - tooltip.width,
      left: trigger.left - gap - tooltip.width,
      side: "left",
      top: triggerCenterY - tooltip.height / 2,
    },
  };

  const candidateSides =
    placement === "vertical" ? sidePriority.slice(0, 2) : sidePriority;
  const bestCandidate = candidateSides.reduce((best, side) => {
    const candidate = candidates[side];
    return candidate.clearance > best.clearance ? candidate : best;
  }, candidates[candidateSides[0]]);

  const maxLeft = Math.max(
    viewportPadding,
    viewport.width - viewportPadding - tooltip.width,
  );
  const maxTop = Math.max(
    viewportPadding,
    viewport.height - viewportPadding - tooltip.height,
  );

  return {
    left: clamp(bestCandidate.left, viewportPadding, maxLeft),
    side: bestCandidate.side,
    top: clamp(bestCandidate.top, viewportPadding, maxTop),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
