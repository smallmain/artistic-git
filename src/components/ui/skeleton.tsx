import * as React from "react";

import { cn } from "@/lib/utils";

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * 骨架屏基元：克制 pulse（1800ms），形状应与真实布局一致。
 * 用法：以真实元素的尺寸拼接 Skeleton 块，禁止 shimmer 扫光。
 */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-skeleton-pulse rounded bg-secondary", className)}
      {...props}
    />
  );
}
