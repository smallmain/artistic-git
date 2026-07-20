import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

export interface IconButtonProps extends Omit<
  ButtonProps,
  "aria-label" | "children" | "size"
> {
  children: React.ReactNode;
  label: string;
  tooltip?: string;
  tooltipPlacement?: "auto" | "vertical";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      children,
      className,
      label,
      tooltip = label,
      tooltipPlacement = "auto",
      ...props
    },
    ref,
  ) => {
    return (
      <Tooltip content={tooltip} placement={tooltipPlacement}>
        {({ describedBy }) => (
          <Button
            aria-describedby={describedBy}
            aria-label={label}
            className={className}
            ref={ref}
            size="icon"
            {...props}
          >
            {children}
          </Button>
        )}
      </Tooltip>
    );
  },
);
IconButton.displayName = "IconButton";
