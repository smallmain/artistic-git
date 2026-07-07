import * as React from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { normalizeDisplayPath } from "@/lib/path-display";
import { cn } from "@/lib/utils";

interface TruncatedTextProps {
  as?: "span" | "p" | "div";
  className?: string;
  normalizePath?: boolean;
  text: string;
  tooltip?: string;
}

export function TruncatedText({
  as: Component = "span",
  className,
  normalizePath = false,
  text,
  tooltip,
}: TruncatedTextProps) {
  const displayText = normalizePath ? normalizeDisplayPath(text) : text;
  const tooltipText = tooltip ?? displayText;

  return (
    <Tooltip content={tooltipText}>
      {({ describedBy }) => (
        <Component
          aria-describedby={describedBy}
          className={cn("block min-w-0 truncate", className)}
        >
          {displayText}
        </Component>
      )}
    </Tooltip>
  );
}
