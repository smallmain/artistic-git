import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DetailsDialog } from "@/components/dialogs/DetailsDialog";
import { Button } from "@/components/ui/button";
import { openLogDir } from "@/lib/ipc/commands";
import type { AppError } from "@/lib/ipc/generated";

interface ErrorDetailsDialogProps {
  error: AppError | Error | string;
  onCopyDetails?: (details: string) => Promise<void> | void;
  onOpenLogDir?: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function ErrorDetailsDialog({
  error,
  onCopyDetails,
  onOpenLogDir,
  onOpenChange,
  open,
}: ErrorDetailsDialogProps) {
  const { t } = useTranslation();
  const handleOpenLogDir = onOpenLogDir ?? openLogDir;

  return (
    <DetailsDialog
      description={t("dialogs.error.description")}
      details={formatErrorDetails(error)}
      extraActions={
        <Button
          className="gap-2"
          onClick={() => {
            void handleOpenLogDir();
          }}
          type="button"
          variant="ghost"
        >
          <FolderOpen className="size-4" aria-hidden="true" />
          {t("actions.openLogDir")}
        </Button>
      }
      onCopyDetails={onCopyDetails}
      onOpenChange={onOpenChange}
      open={open}
      summary={getErrorSummary(error)}
      title={t("dialogs.error.title")}
    />
  );
}

function getErrorSummary(error: AppError | Error | string): string {
  if (typeof error === "string") {
    return error;
  }

  if (isAppError(error)) {
    return error.summary;
  }

  return error.message;
}

function formatErrorDetails(error: AppError | Error | string): string {
  if (typeof error === "string") {
    return error;
  }

  if (isAppError(error)) {
    return JSON.stringify(error, null, 2);
  }

  return JSON.stringify(
    {
      message: error.message,
      name: error.name,
      stack: error.stack ?? null,
    },
    null,
    2,
  );
}

function isAppError(error: AppError | Error): error is AppError {
  return "category" in error && "summary" in error && "context" in error;
}
