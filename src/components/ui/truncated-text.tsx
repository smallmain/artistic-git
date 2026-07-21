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
    // Tooltip defaults to inline-flex for icon triggers. For truncated labels the
    // wrapper must fill the constrained parent width, or text-overflow never kicks in.
    <Tooltip className="block w-full min-w-0 max-w-full" content={tooltipText}>
      {({ describedBy }) => (
        <Component
          aria-describedby={describedBy}
          className={cn("block min-w-0 max-w-full truncate", className)}
        >
          {displayText}
        </Component>
      )}
    </Tooltip>
  );
}
