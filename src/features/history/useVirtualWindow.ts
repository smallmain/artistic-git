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
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / estimateSize) - overscan,
  );
  const visibleCount = Math.ceil(viewportHeight / estimateSize) + overscan * 2;
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
