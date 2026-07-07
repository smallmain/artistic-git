import * as React from "react";

import { cn } from "@/lib/utils";

interface TooltipProps {
  children: (props: { describedBy: string }) => React.ReactNode;
  className?: string;
  content: React.ReactNode;
  tooltipClassName?: string;
}

export function Tooltip({
  children,
  className,
  content,
  tooltipClassName,
}: TooltipProps) {
  const tooltipId = React.useId();

  return (
    <span className={cn("group relative inline-flex min-w-0", className)}>
      {children({ describedBy: tooltipId })}
      <span
        className={cn(
          "pointer-events-none absolute right-0 top-[calc(100%+0.5rem)] z-20 max-w-80 whitespace-normal rounded-md border bg-card px-2 py-1 text-xs text-card-foreground opacity-0 shadow-floating transition-opacity duration-fast ease-out",
          "group-focus-within:opacity-100 group-hover:opacity-100",
          tooltipClassName,
        )}
        id={tooltipId}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
}
