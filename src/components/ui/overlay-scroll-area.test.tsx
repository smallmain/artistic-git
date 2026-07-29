import { act, fireEvent, render, screen, within } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { OverlayScrollArea } from "./overlay-scroll-area";

describe("OverlayScrollArea", () => {
  it("keeps the viewport full width and renders a draggable overlay thumb", () => {
    const onScroll = vi.fn();
    const viewportRef = React.createRef<HTMLDivElement>();
    render(
      <OverlayScrollArea
        className="h-48 w-48"
        data-testid="viewport"
        onScroll={onScroll}
        ref={viewportRef}
      >
        <div className="h-[1000px]" />
      </OverlayScrollArea>,
    );

    const viewport = screen.getByTestId("viewport");
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 192 },
      clientWidth: { configurable: true, value: 192 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollWidth: { configurable: true, value: 192 },
    });
    fireEvent.scroll(viewport, { target: { scrollTop: 400 } });

    expect(viewportRef.current).toBe(viewport);
    expect(viewport).toHaveClass("overlay-scrollbar-viewport", "w-full");
    expect(viewport.parentElement).toHaveClass("isolate", "overflow-hidden");
    expect(onScroll).toHaveBeenCalledTimes(1);
    const track = screen.getByTestId("overlay-scrollbar-vertical");
    expect(track.firstElementChild).toHaveStyle({ height: "35.328px" });

    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      bottom: 188,
      height: 184,
      left: 184,
      right: 192,
      toJSON: () => ({}),
      top: 4,
      width: 8,
      x: 184,
      y: 4,
    });
    fireEvent.pointerDown(track, { clientY: 140, pointerId: 1 });
    expect(viewport.scrollTop).toBeGreaterThan(400);
    fireEvent.pointerUp(window);
  });

  it("reveals the thumb while scrolling and fades it out once idle", () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(
        <OverlayScrollArea className="h-48 w-48" data-testid="idle-viewport">
          <div className="h-[1000px]" />
        </OverlayScrollArea>,
      );

      const viewport = getByTestId("idle-viewport");
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 192 },
        clientWidth: { configurable: true, value: 192 },
        scrollHeight: { configurable: true, value: 1_000 },
        scrollWidth: { configurable: true, value: 192 },
      });
      fireEvent.scroll(viewport, { target: { scrollTop: 400 } });

      const track = within(viewport.parentElement as HTMLElement).getByTestId(
        "overlay-scrollbar-vertical",
      );
      expect(track.firstElementChild).toHaveClass("opacity-100");
      expect(track).not.toHaveAttribute("data-scrollbar-idle");

      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(track.firstElementChild).toHaveClass("opacity-0");
      expect(track).toHaveAttribute("data-scrollbar-idle", "true");
    } finally {
      vi.useRealTimers();
    }
  });
});
