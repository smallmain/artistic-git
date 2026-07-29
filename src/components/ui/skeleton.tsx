import * as React from "react";

import { cn } from "@/lib/utils";

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * Skeleton primitive: restrained pulse (1800ms); shapes should mirror the real layout.
 * Usage: compose Skeleton blocks at the real element's dimensions; no shimmer sweep.
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
