import { X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/icon-button";
import { OverlayScrollArea } from "@/components/ui/overlay-scroll-area";
import { DialogLayerContext, useModalLayer } from "@/lib/dialog-layer";
import { cn } from "@/lib/utils";

interface DialogFrameProps {
  children: React.ReactNode;
  className?: string;
  closeOnEscape?: boolean;
  contentClassName?: string;
  contentViewportClassName?: string;
  "data-testid"?: string;
  description: string;
  dismissible?: boolean;
  footer?: React.ReactNode;
  hideCloseButton?: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
}

export function DialogFrame({
  children,
  className,
  closeOnEscape = true,
  contentClassName,
  contentViewportClassName,
  "data-testid": testId,
  description,
  dismissible = true,
  footer,
  hideCloseButton = false,
  onOpenChange,
  title,
}: DialogFrameProps) {
  const { t } = useTranslation();
  const descriptionId = React.useId();
  const titleId = React.useId();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const dialogId = useModalLayer(dialogRef, {
    onEscape:
      dismissible && closeOnEscape ? () => onOpenChange(false) : undefined,
  });

  return (
    <DialogLayerContext.Provider value={dialogId}>
      <div className="animate-overlay-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6">
        <div
          aria-describedby={descriptionId}
          aria-labelledby={titleId}
          aria-modal="true"
          className={cn(
            "animate-overlay-enter flex max-h-full w-full max-w-2xl flex-col rounded-xl border bg-card text-card-foreground shadow-floating focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          data-testid={testId}
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
            <div className="min-w-0">
              <h2 className="text-title" id={titleId}>
                {title}
              </h2>
              <p
                className="text-body mt-1 text-foreground-secondary"
                id={descriptionId}
              >
                {description}
              </p>
            </div>
            {hideCloseButton || !dismissible ? null : (
              <IconButton
                label={t("actions.close")}
                onClick={() => {
                  onOpenChange(false);
                }}
                tooltip={t("actions.close")}
                variant="ghost"
              >
                <X className="size-4" aria-hidden="true" />
              </IconButton>
            )}
          </div>

          <OverlayScrollArea
            className={contentClassName}
            viewportClassName={cn(
              "flex flex-col gap-4 p-6",
              contentViewportClassName,
            )}
          >
            {children}
          </OverlayScrollArea>
          {footer ? (
            <div className="border-t border-border-subtle px-6 py-4">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </DialogLayerContext.Provider>
  );
}
