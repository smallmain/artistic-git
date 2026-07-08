import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DetailsDialog } from "@/components/dialogs/DetailsDialog";
import { Button } from "@/components/ui/button";
import type { CrashDialogPayload } from "@/lib/ipc/commands";

interface CrashDetailsDialogProps {
  crash: CrashDialogPayload | Error | string;
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
        <Button
          className="gap-2"
          onClick={() => {
            void onRestart?.();
          }}
          type="button"
          variant="secondary"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          {t("actions.restartApp")}
        </Button>
      }
      onCopyDetails={onCopyDetails}
      onOpenChange={onOpenChange}
      open={open}
      summary={crashSummary(crash)}
      title={t("dialogs.crash.title")}
    />
  );
}

function crashSummary(crash: CrashDialogPayload | Error | string): string {
  if (typeof crash === "string") {
    return crash;
  }

  if (crash instanceof Error) {
    return crash.message;
  }

  return crash.summary;
}

function formatCrashDetails(
  crash: CrashDialogPayload | Error | string,
): string {
  if (typeof crash === "string") {
    return crash;
  }

  if (!(crash instanceof Error)) {
    return crash.details;
  }

  return JSON.stringify(
    {
      message: crash.message,
      name: crash.name,
      stack: crash.stack ?? null,
    },
    null,
    2,
  );
}
