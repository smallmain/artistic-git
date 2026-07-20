import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import * as React from "react";

import { DetailsDialog } from "@/components/dialogs/DetailsDialog";
import { Button } from "@/components/ui/button";
import { formatErrorDetails, getErrorSummary } from "@/lib/error-details";
import { openLogDir } from "@/lib/ipc/commands";

interface ErrorDetailsDialogProps {
  error: unknown;
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
  if (!open) {
    return null;
  }

  const details = formatErrorDetails(error);
  return (
    <ErrorDetailsDialogContent
      error={error}
      key={details}
      onCopyDetails={onCopyDetails}
      onOpenChange={onOpenChange}
      onOpenLogDir={onOpenLogDir}
    />
  );
}

function ErrorDetailsDialogContent({
  error,
  onCopyDetails,
  onOpenLogDir,
  onOpenChange,
}: Omit<ErrorDetailsDialogProps, "open">) {
  const { t } = useTranslation();
  const handleOpenLogDir: () => unknown = onOpenLogDir ?? openLogDir;
  const [openingLogDir, setOpeningLogDir] = React.useState(false);
  const [logDirError, setLogDirError] = React.useState<unknown>(null);

  const detailsError = logDirError
    ? { logDirectoryError: logDirError, originalError: error }
    : error;

  return (
    <DetailsDialog
      description={t("dialogs.error.description")}
      details={formatErrorDetails(detailsError)}
      extraActions={
        <div className="flex items-center gap-2">
          {logDirError ? (
            <span className="text-xs text-destructive" role="alert">
              {t("dialogs.error.openLogDirFailed")}
            </span>
          ) : null}
          <Button
            className="gap-2"
            disabled={openingLogDir}
            onClick={() => {
              setOpeningLogDir(true);
              setLogDirError(null);
              void Promise.resolve()
                .then(() => handleOpenLogDir())
                .catch(setLogDirError)
                .finally(() => setOpeningLogDir(false));
            }}
            type="button"
            variant="ghost"
          >
            <FolderOpen className="size-4" aria-hidden="true" />
            {openingLogDir
              ? t("actions.openingLogDir")
              : t("actions.openLogDir")}
          </Button>
        </div>
      }
      onCopyDetails={onCopyDetails}
      onOpenChange={onOpenChange}
      open
      summary={getErrorSummary(error)}
      title={t("dialogs.error.title")}
    />
  );
}
