import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  cancelLabel?: string;
  confirmLabel?: string;
  description: string;
  onConfirm: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  variant?: "default" | "danger";
}

export function ConfirmDialog({
  cancelLabel,
  confirmLabel,
  description,
  onConfirm,
  onOpenChange,
  open,
  title,
  variant = "default",
}: ConfirmDialogProps) {
  const { t } = useTranslation();

  if (!open) {
    return null;
  }

  const resolvedCancelLabel = cancelLabel ?? t("actions.cancel");
  const resolvedConfirmLabel = confirmLabel ?? t("actions.confirm");

  return (
    <DialogFrame
      description={description}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
            type="button"
            variant="ghost"
          >
            {resolvedCancelLabel}
          </Button>
          <Button
            onClick={() => {
              void onConfirm();
            }}
            type="button"
            variant={variant === "danger" ? "destructive" : "default"}
          >
            {resolvedConfirmLabel}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={title}
    >
      <div className="flex gap-3 rounded-md border bg-background p-3 text-sm">
        <AlertTriangle
          className={
            variant === "danger"
              ? "mt-0.5 size-4 shrink-0 text-destructive"
              : "mt-0.5 size-4 shrink-0 text-warning"
          }
          aria-hidden="true"
        />
        <p>{description}</p>
      </div>
    </DialogFrame>
  );
}
