import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface IconButtonProps extends Omit<
  ButtonProps,
  "aria-label" | "children" | "size"
> {
  children: React.ReactNode;
  label: string;
  tooltip?: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ children, className, label, tooltip = label, ...props }, ref) => {
    return (
      <span className="group relative inline-flex">
        <Button
          aria-label={label}
          className={className}
          ref={ref}
          size="icon"
          {...props}
        >
          {children}
        </Button>
        <span
          className={cn(
            "pointer-events-none absolute right-0 top-[calc(100%+0.5rem)] z-20 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs text-card-foreground opacity-0 shadow-sm transition-opacity",
            "group-focus-within:opacity-100 group-hover:opacity-100",
          )}
          role="tooltip"
        >
          {tooltip}
        </span>
      </span>
    );
  },
);
IconButton.displayName = "IconButton";
