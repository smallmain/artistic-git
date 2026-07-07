import { Check, Copy, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";

interface DetailsDialogProps {
  description: string;
  details: string;
  onCopyDetails?: (details: string) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  summary: string;
  title: string;
}

export function DetailsDialog({
  description,
  details,
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
  const descriptionId = React.useId();
  const detailsId = React.useId();
  const titleId = React.useId();

  const handleCopyDetails = async () => {
    try {
      if (onCopyDetails) {
        await onCopyDetails(details);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(details);
      }

      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex max-h-full w-full max-w-2xl flex-col rounded-lg border bg-card text-card-foreground shadow-lg"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b p-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold" id={titleId}>
              {title}
            </h2>
            <p
              className="mt-1 text-sm text-muted-foreground"
              id={descriptionId}
            >
              {description}
            </p>
          </div>
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
        </div>

        <div className="flex flex-col gap-4 overflow-auto p-5">
          <p className="rounded-md border bg-background p-3 text-sm">
            {summary}
          </p>

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
              className="max-h-72 overflow-auto rounded-md border bg-muted p-3 text-xs text-muted-foreground"
              id={detailsId}
            >
              {details}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
