import { Copy } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import { showToast } from "@/lib/toast";

interface DetailsDialogProps {
  "data-testid"?: string;
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
  "data-testid": testId,
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
      data-testid={testId}
      extraActions={extraActions}
      onCopyDetails={onCopyDetails}
      onOpenChange={onOpenChange}
      summary={summary}
      title={title}
    />
  );
}

function DetailsDialogContent({
  "data-testid": testId,
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
  const [copyFailed, setCopyFailed] = React.useState(false);
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

      setCopyFailed(false);
      showToast({
        key: "details-copy-result",
        message: t("dialogs.error.copied"),
        tone: "success",
      });
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <DialogFrame
      data-testid={testId}
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
          <Copy className="size-4" aria-hidden="true" />
          {t("actions.copyDetails")}
        </Button>
        {extraActions}
        {copyFailed ? (
          <span className="text-sm text-muted-foreground" role="status">
            {t("dialogs.error.copyFailed")}
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
