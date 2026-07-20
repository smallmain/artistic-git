import * as React from "react";
import { createPortal } from "react-dom";

import { calculateTooltipPosition } from "@/components/ui/tooltip-position";
import { dialogOpenedEventName } from "@/lib/dialog-layer";
import { cn } from "@/lib/utils";

interface TooltipProps {
  children: (props: { describedBy: string }) => React.ReactNode;
  className?: string;
  content: React.ReactNode;
  placement?: "auto" | "vertical";
  tooltipClassName?: string;
}

export function Tooltip({
  children,
  className,
  content,
  placement = "auto",
  tooltipClassName,
}: TooltipProps) {
  const tooltipId = React.useId();
  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const tooltipRef = React.useRef<HTMLSpanElement>(null);
  const hoverCloseTimeoutRef = React.useRef<number | null>(null);
  const [hasFocus, setHasFocus] = React.useState(false);
  const [isDismissed, setIsDismissed] = React.useState(false);
  const [isTooltipHovered, setIsTooltipHovered] = React.useState(false);
  const [isTriggerHovered, setIsTriggerHovered] = React.useState(false);
  const [position, setPosition] = React.useState<ReturnType<
    typeof calculateTooltipPosition
  > | null>(null);
  const isOpen =
    (hasFocus || isTooltipHovered || isTriggerHovered) && !isDismissed;

  const cancelPendingHoverClose = React.useCallback(() => {
    if (hoverCloseTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(hoverCloseTimeoutRef.current);
    hoverCloseTimeoutRef.current = null;
  }, []);

  const scheduleHoverClose = React.useCallback(
    (close: () => void) => {
      cancelPendingHoverClose();
      hoverCloseTimeoutRef.current = window.setTimeout(() => {
        hoverCloseTimeoutRef.current = null;
        close();
      }, 100);
    },
    [cancelPendingHoverClose],
  );

  const updatePosition = React.useCallback(() => {
    const trigger = getPositionAnchor(triggerRef.current);
    const tooltip = tooltipRef.current;

    if (!trigger || !tooltip) {
      return;
    }

    const nextPosition = calculateTooltipPosition(
      trigger.getBoundingClientRect(),
      tooltip.getBoundingClientRect(),
      { height: window.innerHeight, width: window.innerWidth },
      { placement },
    );

    setPosition((currentPosition) =>
      currentPosition?.left === nextPosition.left &&
      currentPosition.side === nextPosition.side &&
      currentPosition.top === nextPosition.top
        ? currentPosition
        : nextPosition,
    );
  }, [placement]);

  React.useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    updatePosition();

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updatePosition);

    if (resizeObserver) {
      const trigger = triggerRef.current;
      const positionAnchor = getPositionAnchor(trigger);

      if (trigger) {
        resizeObserver.observe(trigger);
      }
      if (positionAnchor && positionAnchor !== trigger) {
        resizeObserver.observe(positionAnchor);
      }
      if (tooltipRef.current) {
        resizeObserver.observe(tooltipRef.current);
      }
    }

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [content, isOpen, updatePosition]);

  React.useEffect(() => cancelPendingHoverClose, [cancelPendingHoverClose]);

  React.useEffect(() => {
    const handleDialogOpened = () => {
      cancelPendingHoverClose();
      setHasFocus(false);
      setIsDismissed(true);
      setIsTooltipHovered(false);
      setIsTriggerHovered(false);
    };
    window.addEventListener(dialogOpenedEventName, handleDialogOpened);
    return () =>
      window.removeEventListener(dialogOpenedEventName, handleDialogOpened);
  }, [cancelPendingHoverClose]);

  React.useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsDismissed(true);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen]);

  const tooltip =
    typeof document === "undefined"
      ? null
      : createPortal(
          <span
            className={cn(
              "pointer-events-none fixed z-[60] max-h-[calc(100vh-1rem)] w-max max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto whitespace-normal rounded-md border bg-card px-2 py-1 text-xs text-card-foreground opacity-0 shadow-floating transition-opacity duration-fast ease-out",
              isOpen && position && "pointer-events-auto opacity-100",
              tooltipClassName,
            )}
            data-side={position?.side}
            data-state={isOpen ? "open" : "closed"}
            id={tooltipId}
            onMouseEnter={() => {
              cancelPendingHoverClose();
              setIsTriggerHovered(false);
              setIsTooltipHovered(true);
            }}
            onMouseLeave={() => {
              scheduleHoverClose(() => setIsTooltipHovered(false));
            }}
            ref={tooltipRef}
            role="tooltip"
            style={{
              left: position?.left ?? 0,
              overflowWrap: "anywhere",
              top: position?.top ?? 0,
            }}
          >
            {content}
          </span>,
          document.body,
        );

  return (
    <>
      <span
        className={cn("group relative inline-flex min-w-0", className)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setHasFocus(false);
          }
        }}
        onFocusCapture={() => {
          setIsDismissed(false);
          setHasFocus(true);
        }}
        onMouseEnter={() => {
          cancelPendingHoverClose();
          setIsDismissed(false);
          setIsTooltipHovered(false);
          setIsTriggerHovered(true);
        }}
        onMouseLeave={() => {
          scheduleHoverClose(() => setIsTriggerHovered(false));
        }}
        ref={triggerRef}
      >
        {children({ describedBy: tooltipId })}
      </span>
      {tooltip}
    </>
  );
}

function getPositionAnchor(trigger: HTMLSpanElement | null) {
  return trigger?.firstElementChild ?? trigger;
}
