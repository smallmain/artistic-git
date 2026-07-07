import { useTranslation } from "react-i18next";

import { DetailsDialog } from "@/components/dialogs/DetailsDialog";

interface CrashDetailsDialogProps {
  crash: Error | string;
  onCopyDetails?: (details: string) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function CrashDetailsDialog({
  crash,
  onCopyDetails,
  onOpenChange,
  open,
}: CrashDetailsDialogProps) {
  const { t } = useTranslation();
  const details = formatCrashDetails(crash);

  return (
    <DetailsDialog
      description={t("dialogs.crash.description")}
      details={details}
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
