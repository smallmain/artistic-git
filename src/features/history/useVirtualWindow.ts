import * as React from "react";

export interface VirtualItem {
  index: number;
  key: number;
  size: number;
  start: number;
}

export interface VirtualWindow {
  items: VirtualItem[];
  onScroll: React.UIEventHandler<HTMLElement>;
  totalSize: number;
}

export function useVirtualWindow({
  count,
  estimateSize,
  overscan = 6,
  viewportHeight,
}: {
  count: number;
  estimateSize: number;
  overscan?: number;
  viewportHeight: number;
}): VirtualWindow {
  const [scrollTop, setScrollTop] = React.useState(0);
  const totalSize = count * estimateSize;
  const visibleCount = Math.ceil(viewportHeight / estimateSize) + overscan * 2;
  const requestedStart = Math.floor(scrollTop / estimateSize) - overscan;
  const startIndex = Math.min(
    Math.max(0, requestedStart),
    Math.max(0, count - visibleCount),
  );
  const endIndex = Math.min(count, startIndex + visibleCount);

  const items = React.useMemo(
    () =>
      Array.from({ length: endIndex - startIndex }, (_, offset) => {
        const index = startIndex + offset;
        return {
          index,
          key: index,
          size: estimateSize,
          start: index * estimateSize,
        };
      }),
    [endIndex, estimateSize, startIndex],
  );

  return {
    items,
    onScroll: (event) => {
      setScrollTop(event.currentTarget.scrollTop);
    },
    totalSize,
  };
}
