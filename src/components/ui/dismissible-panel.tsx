import * as React from "react";

import { cn } from "@/lib/utils";

interface DismissiblePanelProps {
  children: React.ReactNode;
  className?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title?: string;
}

export function DismissiblePanel({
  children,
  className,
  onOpenChange,
  open,
  title,
}: DismissiblePanelProps) {
  React.useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  if (!open) {
    return null;
  }

  return (
    <aside
      aria-label={title}
      className={cn(
        "rounded-lg border bg-card p-4 text-card-foreground shadow-floating",
        className,
      )}
      tabIndex={-1}
    >
      {children}
    </aside>
  );
}
