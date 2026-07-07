import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DetailsDialog } from "@/components/dialogs/DetailsDialog";
import { Button } from "@/components/ui/button";

interface CrashDetailsDialogProps {
  crash: Error | string;
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
      summary={typeof crash === "string" ? crash : crash.message}
      title={t("dialogs.crash.title")}
    />
  );
}

function formatCrashDetails(crash: Error | string): string {
  if (typeof crash === "string") {
    return crash;
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
