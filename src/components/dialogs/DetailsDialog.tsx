import { Check, Copy } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";

interface DetailsDialogProps {
  description: string;
  details: string;
  extraActions?: React.ReactNode;
  onCopyDetails?: (details: string) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  summary: string;
  title: string;
}

export function DetailsDialog({
  description,
  details,
  extraActions,
  onCopyDetails,
  onOpenChange,
  open,
  summary,
  title,
}: DetailsDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <DetailsDialogContent
      description={description}
      details={details}
      extraActions={extraActions}
      onCopyDetails={onCopyDetails}
      onOpenChange={onOpenChange}
      summary={summary}
      title={title}
    />
  );
}

function DetailsDialogContent({
  description,
  details,
  extraActions,
  onCopyDetails,
  onOpenChange,
  summary,
  title,
}: Omit<DetailsDialogProps, "open">) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [copyStatus, setCopyStatus] = React.useState<
    "copied" | "failed" | null
  >(null);
  const detailsId = React.useId();

  const handleCopyDetails = async () => {
    try {
      if (onCopyDetails) {
        await onCopyDetails(details);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(details);
      } else {
        throw new Error("Clipboard API is unavailable.");
      }

      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <DialogFrame
      description={description}
      onOpenChange={onOpenChange}
      title={title}
    >
      <p className="rounded-md border bg-background p-3 text-sm">{summary}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-controls={detailsId}
          aria-expanded={detailsOpen}
          onClick={() => {
            setDetailsOpen((current) => !current);
          }}
          type="button"
          variant="secondary"
        >
          {detailsOpen
            ? t("dialogs.error.hideDetails")
            : t("dialogs.error.showDetails")}
        </Button>
        <Button
          className="gap-2"
          onClick={() => {
            void handleCopyDetails();
          }}
          type="button"
          variant="ghost"
        >
          {copyStatus === "copied" ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {t("actions.copyDetails")}
        </Button>
        {extraActions}
        {copyStatus ? (
          <span className="text-sm text-muted-foreground" role="status">
            {copyStatus === "copied"
              ? t("dialogs.error.copied")
              : t("dialogs.error.copyFailed")}
          </span>
        ) : null}
      </div>

      {detailsOpen ? (
        <pre
          className="max-h-72 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs text-muted-foreground"
          id={detailsId}
        >
          {details}
        </pre>
      ) : null}
    </DialogFrame>
  );
}
