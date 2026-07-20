import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DetailsDialog } from "@/components/dialogs/DetailsDialog";
import { formatErrorDetails, getErrorSummary } from "@/lib/error-details";
import { Button } from "@/components/ui/button";
import type { CrashDialogPayload } from "@/lib/ipc/commands";

interface CrashDetailsDialogProps {
  crash: unknown;
  onCopyDetails?: (details: string) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  onRestart?: () => Promise<void> | void;
  open: boolean;
}

export function CrashDetailsDialog({
  crash,
  onCopyDetails,
  onOpenChange,
  onRestart,
  open,
}: CrashDetailsDialogProps) {
  const { t } = useTranslation();
  const details = formatCrashDetails(crash);

  return (
    <DetailsDialog
      data-testid="crash-details-dialog"
      description={t("dialogs.crash.description")}
      details={details}
      extraActions={
        onRestart ? (
          <Button
            className="gap-2"
            onClick={() => {
              void onRestart();
            }}
            type="button"
            variant="secondary"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {t("actions.reloadWindow")}
          </Button>
        ) : null
      }
      onCopyDetails={onCopyDetails}
      onOpenChange={onOpenChange}
      open={open}
      summary={crashSummary(crash)}
      title={t("dialogs.crash.title")}
    />
  );
}

function crashSummary(crash: unknown): string {
  return getErrorSummary(crash);
}

function formatCrashDetails(crash: unknown): string {
  if (isCrashDialogPayload(crash)) {
    return crash.details;
  }
  return formatErrorDetails(crash);
}

function isCrashDialogPayload(value: unknown): value is CrashDialogPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "summary" in value &&
    typeof value.summary === "string" &&
    "details" in value &&
    typeof value.details === "string"
  );
}
