import * as React from "react";

import { cn } from "@/lib/utils";

type ScrollbarAxis = "horizontal" | "vertical";

interface ScrollbarAxisState {
  offset: number;
  size: number;
  visible: boolean;
}

interface ScrollbarState {
  horizontal: ScrollbarAxisState;
  vertical: ScrollbarAxisState;
}

export interface OverlayScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string;
}

const scrollbarInset = 4;
const minimumThumbSize = 24;
const hiddenAxis: ScrollbarAxisState = {
  offset: 0,
  size: 0,
  visible: false,
};
const hiddenScrollbars: ScrollbarState = {
  horizontal: hiddenAxis,
  vertical: hiddenAxis,
};

export const OverlayScrollArea = React.forwardRef<
  HTMLDivElement,
  OverlayScrollAreaProps
>(function OverlayScrollArea(
  { children, className, onScroll, style, viewportClassName, ...viewportProps },
  forwardedRef,
) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const finishDragRef = React.useRef<(() => void) | null>(null);
  const [scrollbars, setScrollbars] =
    React.useState<ScrollbarState>(hiddenScrollbars);
  const setViewportRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );
  const measure = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const vertical = calculateAxisState(
      viewport.clientHeight,
      viewport.scrollHeight,
      viewport.scrollTop,
    );
    const horizontal = calculateAxisState(
      viewport.clientWidth,
      viewport.scrollWidth,
      viewport.scrollLeft,
    );
    const next = { horizontal, vertical };
    setScrollbars((current) =>
      scrollbarsEqual(current, next) ? current : next,
    );
  }, []);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const frame = window.requestAnimationFrame(measure);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(viewport);
    if (viewport.firstElementChild) {
      resizeObserver?.observe(viewport.firstElementChild);
    }
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    mutationObserver?.observe(viewport, { childList: true, subtree: true });
    window.addEventListener("resize", measure);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [children, measure]);

  React.useEffect(
    () => () => {
      finishDragRef.current?.();
    },
    [],
  );

  const startThumbDrag = (
    axis: ScrollbarAxis,
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const viewport = viewportRef.current;
    const axisState = scrollbars[axis];
    if (!viewport || !axisState.visible) {
      return;
    }

    finishDragRef.current?.();
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const trackRect = event.currentTarget.getBoundingClientRect();
    const pointerPosition =
      axis === "vertical"
        ? event.clientY - trackRect.top
        : event.clientX - trackRect.left;
    const pointerInsideThumb =
      pointerPosition >= axisState.offset &&
      pointerPosition <= axisState.offset + axisState.size;
    const grabOffset = pointerInsideThumb
      ? pointerPosition - axisState.offset
      : axisState.size / 2;

    const updateScrollPosition = (pointerEvent: PointerEvent) => {
      const trackSize =
        axis === "vertical" ? trackRect.height : trackRect.width;
      const maximumThumbOffset = Math.max(0, trackSize - axisState.size);
      const pointer =
        axis === "vertical"
          ? pointerEvent.clientY - trackRect.top
          : pointerEvent.clientX - trackRect.left;
      const ratio =
        maximumThumbOffset === 0
          ? 0
          : clamp((pointer - grabOffset) / maximumThumbOffset, 0, 1);

      if (axis === "vertical") {
        viewport.scrollTop =
          ratio * Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      } else {
        viewport.scrollLeft =
          ratio * Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      }
      measure();
    };
    updateScrollPosition(event.nativeEvent);

    let finished = false;
    const finishDrag = () => {
      if (finished) {
        return;
      }
      finished = true;
      window.removeEventListener("pointermove", updateScrollPosition);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      window.removeEventListener("blur", finishDrag);
      if (finishDragRef.current === finishDrag) {
        finishDragRef.current = null;
      }
    };

    window.addEventListener("pointermove", updateScrollPosition);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    window.addEventListener("blur", finishDrag);
    finishDragRef.current = finishDrag;
  };

  return (
    <div
      className={cn("relative isolate min-h-0 overflow-hidden", className)}
      style={style}
    >
      <div
        {...viewportProps}
        className={cn(
          "overlay-scrollbar-viewport h-full w-full overflow-auto",
          viewportClassName,
        )}
        onScroll={(event) => {
          onScroll?.(event);
          measure();
        }}
        ref={setViewportRef}
      >
        {children}
      </div>
      {scrollbars.vertical.visible ? (
        <div
          aria-hidden="true"
          className="absolute bottom-1 right-1 top-1 z-30 w-2 touch-none"
          data-testid="overlay-scrollbar-vertical"
          onPointerDown={(event) => startThumbDrag("vertical", event)}
        >
          <span
            className="absolute right-0 w-1.5 rounded-full bg-foreground/25 transition-colors hover:bg-foreground/40"
            style={{
              height: scrollbars.vertical.size,
              transform: `translateY(${scrollbars.vertical.offset}px)`,
            }}
          />
        </div>
      ) : null}
      {scrollbars.horizontal.visible ? (
        <div
          aria-hidden="true"
          className="absolute bottom-1 left-1 right-1 z-30 h-2 touch-none"
          data-testid="overlay-scrollbar-horizontal"
          onPointerDown={(event) => startThumbDrag("horizontal", event)}
        >
          <span
            className="absolute bottom-0 h-1.5 rounded-full bg-foreground/25 transition-colors hover:bg-foreground/40"
            style={{
              transform: `translateX(${scrollbars.horizontal.offset}px)`,
              width: scrollbars.horizontal.size,
            }}
          />
        </div>
      ) : null}
    </div>
  );
});

function calculateAxisState(
  viewportSize: number,
  contentSize: number,
  scrollOffset: number,
): ScrollbarAxisState {
  const trackSize = Math.max(0, viewportSize - scrollbarInset * 2);
  const maximumScrollOffset = Math.max(0, contentSize - viewportSize);
  if (trackSize === 0 || maximumScrollOffset <= 1) {
    return hiddenAxis;
  }

  const size = Math.min(
    trackSize,
    Math.max(minimumThumbSize, trackSize * (viewportSize / contentSize)),
  );
  const maximumThumbOffset = Math.max(0, trackSize - size);
  return {
    offset:
      maximumScrollOffset === 0
        ? 0
        : (clamp(scrollOffset, 0, maximumScrollOffset) / maximumScrollOffset) *
          maximumThumbOffset,
    size,
    visible: true,
  };
}

function scrollbarsEqual(current: ScrollbarState, next: ScrollbarState) {
  return (
    axisEqual(current.horizontal, next.horizontal) &&
    axisEqual(current.vertical, next.vertical)
  );
}

function axisEqual(current: ScrollbarAxisState, next: ScrollbarAxisState) {
  return (
    current.visible === next.visible &&
    current.offset === next.offset &&
    current.size === next.size
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
