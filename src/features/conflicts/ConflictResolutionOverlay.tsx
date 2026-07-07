import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  FileQuestion,
  Image as ImageIcon,
  RotateCcw,
  Save,
  SquareCheck,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { DiffViewer } from "@/features/diff";
import {
  cancelConflictResolution,
  completeConflictResolution,
  conflictDetail,
  listConflicts,
  saveConflictResolution,
  selectConflictSide,
} from "@/lib/ipc/commands";
import type {
  ConflictDetailResponse,
  ConflictEnteredEvent,
  ConflictFile,
  ConflictFileDetail,
  ConflictListResponse,
  ConflictSaveResolutionResponse,
  ConflictSelectSideResponse,
  ConflictSide,
  DiffPayload,
} from "@/lib/ipc/generated";
import { cn } from "@/lib/utils";

export interface ConflictResolutionApi {
  cancelConflictResolution: typeof cancelConflictResolution;
  completeConflictResolution: typeof completeConflictResolution;
  conflictDetail: typeof conflictDetail;
  listConflicts: typeof listConflicts;
  saveConflictResolution: typeof saveConflictResolution;
  selectConflictSide: typeof selectConflictSide;
}

interface ConflictResolutionOverlayProps {
  api?: ConflictResolutionApi;
  event: ConflictEnteredEvent;
  onClose: (repositoryPath: string) => void;
}

const defaultApi: ConflictResolutionApi = {
  cancelConflictResolution,
  completeConflictResolution,
  conflictDetail,
  listConflicts,
  saveConflictResolution,
  selectConflictSide,
};

export function ConflictResolutionOverlay({
  api = defaultApi,
  event,
  onClose,
}: ConflictResolutionOverlayProps) {
  const { t } = useTranslation();
  const [files, setFiles] = React.useState<ConflictFile[]>(event.files);
  const [checkedPaths, setCheckedPaths] = React.useState<Set<string>>(
    () => new Set(event.files.map((file) => file.path)),
  );
  const [selectedPathPreference, setSelectedPathPreference] = React.useState<
    string | null
  >(null);
  const [detail, setDetail] = React.useState<ConflictDetailResponse | null>(
    null,
  );
  const [busyLabel, setBusyLabel] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void api
      .listConflicts({ repositoryPath: event.repositoryPath })
      .then((response: ConflictListResponse) => {
        if (!active) {
          return;
        }
        setFiles(response.files.length > 0 ? response.files : event.files);
      })
      .catch((source: unknown) => {
        if (active) {
          setError(errorSummary(source));
        }
      });

    return () => {
      active = false;
    };
  }, [api, event.files, event.repositoryPath]);

  const selectedPath = React.useMemo(() => {
    if (
      selectedPathPreference &&
      files.some((file) => file.path === selectedPathPreference)
    ) {
      return selectedPathPreference;
    }

    return (
      files.find((file) => file.status === "unresolved")?.path ??
      files[0]?.path ??
      null
    );
  }, [files, selectedPathPreference]);

  React.useEffect(() => {
    if (!selectedPath) {
      return;
    }

    let active = true;
    void api
      .conflictDetail({
        path: selectedPath,
        repositoryPath: event.repositoryPath,
      })
      .then((response) => {
        if (active) {
          setDetail(response);
        }
      })
      .catch((source: unknown) => {
        if (active) {
          setError(errorSummary(source));
        }
      });

    return () => {
      active = false;
    };
  }, [api, event.repositoryPath, selectedPath]);

  const unresolvedCount = files.filter(
    (file) => file.status === "unresolved",
  ).length;
  const allResolved = files.length > 0 && unresolvedCount === 0;
  const selectedFiles = files.filter((file) => checkedPaths.has(file.path));
  const selectedOrCurrentPaths =
    selectedFiles.length > 0
      ? selectedFiles.map((file) => file.path)
      : selectedPath
        ? [selectedPath]
        : [];

  const mergeUpdatedFiles = React.useCallback(
    (updatedFiles: ConflictFile[]) => {
      setFiles((currentFiles) => {
        const byPath = new Map(currentFiles.map((file) => [file.path, file]));
        for (const file of updatedFiles) {
          byPath.set(file.path, file);
        }
        return Array.from(byPath.values());
      });
    },
    [],
  );

  const runSelectSide = async (
    side: ConflictSide,
    paths = selectedOrCurrentPaths,
  ) => {
    if (paths.length === 0) {
      return;
    }
    setBusyLabel(t(`conflicts.side.${side}`));
    setError(null);
    try {
      const response: ConflictSelectSideResponse = await api.selectConflictSide(
        {
          paths,
          repositoryPath: event.repositoryPath,
          side,
        },
      );
      mergeUpdatedFiles(response.files);
      if (selectedPath) {
        const nextDetail = await api.conflictDetail({
          path: selectedPath,
          repositoryPath: event.repositoryPath,
        });
        setDetail(nextDetail);
      }
    } catch (source) {
      setError(errorSummary(source));
    } finally {
      setBusyLabel(null);
    }
  };

  const runSave = async (content: string, pendingHunks: number) => {
    if (!selectedPath) {
      return;
    }
    setBusyLabel(t("conflicts.save"));
    setError(null);
    try {
      const response: ConflictSaveResolutionResponse =
        await api.saveConflictResolution({
          content,
          path: selectedPath,
          pendingHunks,
          repositoryPath: event.repositoryPath,
        });
      mergeUpdatedFiles([response.file]);
      setDetail((current) =>
        current ? { ...current, file: response.file } : current,
      );
    } catch (source) {
      setError(errorSummary(source));
    } finally {
      setBusyLabel(null);
    }
  };

  const runComplete = async () => {
    if (!allResolved) {
      return;
    }
    setBusyLabel(t("conflicts.complete"));
    setError(null);
    try {
      await api.completeConflictResolution({
        operationId: event.operationId,
        paths: files.map((file) => file.path),
        repositoryPath: event.repositoryPath,
      });
      onClose(event.repositoryPath);
    } catch (source) {
      setError(errorSummary(source));
    } finally {
      setBusyLabel(null);
    }
  };

  const runCancel = async () => {
    setBusyLabel(t("actions.cancel"));
    setError(null);
    try {
      await api.cancelConflictResolution({
        operationId: event.operationId,
        repositoryPath: event.repositoryPath,
      });
      onClose(event.repositoryPath);
    } catch (source) {
      setError(errorSummary(source));
      setConfirmCancel(false);
    } finally {
      setBusyLabel(null);
    }
  };

  return (
    <section
      aria-label={t("conflicts.title")}
      aria-modal="true"
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-background text-foreground"
      role="dialog"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-card px-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">
            {event.operationName}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {t("conflicts.summary", {
              resolved: files.length - unresolvedCount,
              total: files.length,
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busyLabel ? (
            <span className="text-sm text-muted-foreground">{busyLabel}</span>
          ) : null}
          <Button
            disabled={!allResolved || busyLabel !== null}
            onClick={() => {
              void runComplete();
            }}
            type="button"
          >
            <CheckCircle2 className="mr-2 size-4" aria-hidden="true" />
            {t("conflicts.complete")}
          </Button>
          <Button
            disabled={busyLabel !== null}
            onClick={() => setConfirmCancel(true)}
            type="button"
            variant="ghost"
          >
            <X className="mr-2 size-4" aria-hidden="true" />
            {t("actions.cancel")}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{error}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r bg-card">
          <div className="grid grid-cols-2 gap-2 border-b p-3">
            <Button
              onClick={() =>
                setCheckedPaths(new Set(files.map((file) => file.path)))
              }
              type="button"
              variant="secondary"
            >
              <SquareCheck className="mr-2 size-4" aria-hidden="true" />
              {t("conflicts.selectAll")}
            </Button>
            <Button
              onClick={() => {
                setCheckedPaths(
                  new Set(
                    files
                      .filter((file) => !checkedPaths.has(file.path))
                      .map((file) => file.path),
                  ),
                );
              }}
              type="button"
              variant="secondary"
            >
              <RotateCcw className="mr-2 size-4" aria-hidden="true" />
              {t("conflicts.invert")}
            </Button>
            <Button
              disabled={
                selectedOrCurrentPaths.length === 0 || busyLabel !== null
              }
              onClick={() => {
                void runSelectSide("other");
              }}
              type="button"
              variant="ghost"
            >
              {t("conflicts.useOther")}
            </Button>
            <Button
              disabled={
                selectedOrCurrentPaths.length === 0 || busyLabel !== null
              }
              onClick={() => {
                void runSelectSide("own");
              }}
              type="button"
              variant="ghost"
            >
              {t("conflicts.useOwn")}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {files.map((file) => (
              <ConflictFileRow
                checked={checkedPaths.has(file.path)}
                file={file}
                key={file.path}
                onCheckedChange={(checked) => {
                  setCheckedPaths((current) => {
                    const next = new Set(current);
                    if (checked) {
                      next.add(file.path);
                    } else {
                      next.delete(file.path);
                    }
                    return next;
                  });
                }}
                onSelect={() => setSelectedPathPreference(file.path)}
                selected={file.path === selectedPath}
              />
            ))}
          </div>
        </aside>

        <div className="min-w-0 flex-1 bg-background">
          {detail ? (
            <ConflictDetailPanel
              detail={detail.detail}
              file={detail.file}
              onSave={(content, pendingHunks) => {
                void runSave(content, pendingHunks);
              }}
              onSelectSide={(side) => {
                void runSelectSide(side, [detail.file.path]);
              }}
              saving={busyLabel !== null}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("conflicts.loading")}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        confirmLabel={t("conflicts.abort")}
        description={t("conflicts.cancelDescription")}
        onConfirm={() => {
          void runCancel();
        }}
        onOpenChange={setConfirmCancel}
        open={confirmCancel}
        title={t("conflicts.cancelTitle")}
        variant="danger"
      />
    </section>
  );
}

function ConflictFileRow({
  checked,
  file,
  onCheckedChange,
  onSelect,
  selected,
}: {
  checked: boolean;
  file: ConflictFile;
  onCheckedChange: (checked: boolean) => void;
  onSelect: () => void;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const Icon =
    file.fileKind === "image"
      ? ImageIcon
      : file.fileKind === "text"
        ? FileCode2
        : FileQuestion;

  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-accent",
        selected ? "bg-secondary text-secondary-foreground" : "text-foreground",
      )}
      onClick={onSelect}
      type="button"
    >
      <input
        aria-label={t("conflicts.toggleFile", { path: file.path })}
        checked={checked}
        className="size-4 accent-primary"
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
        onClick={(event) => event.stopPropagation()}
        type="checkbox"
      />
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{file.path}</span>
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-xs",
          file.status === "resolved"
            ? "bg-success/15 text-success"
            : "bg-warning/15 text-warning",
        )}
      >
        {t(`conflicts.status.${file.status}`)}
      </span>
    </button>
  );
}

function ConflictDetailPanel({
  detail,
  file,
  onSave,
  onSelectSide,
  saving,
}: {
  detail: ConflictFileDetail;
  file: ConflictFile;
  onSave: (content: string, pendingHunks: number) => void;
  onSelectSide: (side: ConflictSide) => void;
  saving: boolean;
}) {
  if (detail.kind === "binary") {
    return (
      <BinaryConflictDetail
        detail={detail}
        file={file}
        onSelectSide={onSelectSide}
        saving={saving}
      />
    );
  }

  return (
    <TextConflictDetail
      detail={detail}
      file={file}
      key={`${file.path}:${detail.currentText}`}
      onSave={onSave}
      saving={saving}
    />
  );
}

function TextConflictDetail({
  detail,
  file,
  onSave,
  saving,
}: {
  detail: Extract<ConflictFileDetail, { kind: "text" }>;
  file: ConflictFile;
  onSave: (content: string, pendingHunks: number) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [manualMode, setManualMode] = React.useState(false);
  const [manualResolved, setManualResolved] = React.useState(false);
  const [selections, setSelections] = React.useState<
    Record<number, ConflictSide>
  >({});
  const [manualContent, setManualContent] = React.useState(detail.currentText);

  const automaticContent = React.useMemo(
    () => applyHunkSelections(detail, selections),
    [detail, selections],
  );
  const content = manualMode ? manualContent : automaticContent;

  const pendingHunks = manualMode
    ? manualResolved
      ? 0
      : detail.hunks.length
    : detail.hunks.filter((hunk) => !selections[hunk.id]).length;
  const markersRemain = containsConflictMarkers(content);
  const saveDisabled = saving || pendingHunks > 0 || markersRemain;

  const payload: DiffPayload = {
    changeKind: "modified",
    fileKind: "text",
    lfsLock: null,
    metadata: {},
    newPath: file.path,
    oldPath: null,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b bg-card px-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{file.path}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t("conflicts.pendingHunks", { count: pendingHunks })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              checked={manualMode}
              className="size-4 accent-primary"
              onChange={(event) => {
                const nextManualMode = event.currentTarget.checked;
                if (nextManualMode) {
                  setManualContent(automaticContent);
                }
                setManualMode(nextManualMode);
              }}
              type="checkbox"
            />
            {t("conflicts.manualMode")}
          </label>
          {manualMode ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={manualResolved}
                className="size-4 accent-primary"
                onChange={(event) =>
                  setManualResolved(event.currentTarget.checked)
                }
                type="checkbox"
              />
              {t("conflicts.markResolved")}
            </label>
          ) : null}
          <Button
            disabled={saveDisabled}
            onClick={() => onSave(content, pendingHunks)}
            type="button"
          >
            <Save className="mr-2 size-4" aria-hidden="true" />
            {t("conflicts.save")}
          </Button>
        </div>
      </div>

      {markersRemain ? (
        <div className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-2 text-sm">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {t("conflicts.markersRemain")}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem]">
        <DiffViewer
          content={{
            kind: "text",
            language: detail.language ?? undefined,
            newText: detail.otherText,
            oldText: detail.ownText,
          }}
          payload={payload}
          source="conflictResolution"
        />
        <div className="flex min-h-0 flex-col border-l">
          <div className="grid shrink-0 gap-2 border-b p-3">
            {detail.hunks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("conflicts.noHunks")}
              </p>
            ) : (
              detail.hunks.map((hunk) => (
                <div className="rounded-md border p-2" key={hunk.id}>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {t("conflicts.hunkLabel", { line: hunk.startLine })}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      onClick={() =>
                        setSelections((current) => ({
                          ...current,
                          [hunk.id]: "own",
                        }))
                      }
                      type="button"
                      variant={
                        selections[hunk.id] === "own" ? "secondary" : "ghost"
                      }
                    >
                      {t("conflicts.useOwn")}
                    </Button>
                    <Button
                      onClick={() =>
                        setSelections((current) => ({
                          ...current,
                          [hunk.id]: "other",
                        }))
                      }
                      type="button"
                      variant={
                        selections[hunk.id] === "other" ? "secondary" : "ghost"
                      }
                    >
                      {t("conflicts.useOther")}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          <textarea
            aria-label={t("conflicts.resolutionContent")}
            className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-xs outline-none"
            onChange={(event) => {
              setManualContent(event.currentTarget.value);
              setManualMode(true);
            }}
            value={content}
          />
        </div>
      </div>
    </div>
  );
}

function BinaryConflictDetail({
  detail,
  file,
  onSelectSide,
  saving,
}: {
  detail: Extract<ConflictFileDetail, { kind: "binary" }>;
  file: ConflictFile;
  onSelectSide: (side: ConflictSide) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center justify-between border-b bg-card px-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{file.path}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t("conflicts.binaryOnly")}
          </p>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto p-3">
        <BinarySideCard
          disabled={saving}
          label={t("conflicts.ownVersion")}
          onSelect={() => onSelectSide("own")}
          side={detail.own}
        />
        <BinarySideCard
          disabled={saving}
          label={t("conflicts.otherVersion")}
          onSelect={() => onSelectSide("other")}
          side={detail.other}
        />
      </div>
    </div>
  );
}

function BinarySideCard({
  disabled,
  label,
  onSelect,
  side,
}: {
  disabled: boolean;
  label: string;
  onSelect: () => void;
  side: Extract<ConflictFileDetail, { kind: "binary" }>["own"];
}) {
  const { t } = useTranslation();

  return (
    <section className="flex min-h-0 flex-col rounded-md border bg-card">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-medium">{label}</h2>
        <Button
          disabled={disabled || !side}
          onClick={onSelect}
          type="button"
          variant="secondary"
        >
          {t("conflicts.chooseSide")}
        </Button>
      </header>
      <div className="grid gap-2 p-3 text-sm">
        <p className="text-muted-foreground">
          {side?.mimeType ?? t("conflicts.unknownType")}
        </p>
        <p className="text-numeric text-muted-foreground">
          {side?.sizeBytes != null
            ? t("conflicts.bytes", { count: side.sizeBytes })
            : "-"}
        </p>
      </div>
      <div className="min-h-0 flex-1 p-3">
        {side?.preview ? (
          <div className="diff-checkerboard flex h-full min-h-64 items-center justify-center overflow-auto rounded-md border">
            <img
              alt={label}
              className="max-h-full max-w-full object-contain"
              src={side.preview.dataUrl}
            />
          </div>
        ) : (
          <div className="flex h-full min-h-64 items-center justify-center rounded-md border text-sm text-muted-foreground">
            {t("conflicts.noPreview")}
          </div>
        )}
      </div>
    </section>
  );
}

function applyHunkSelections(
  detail: Extract<ConflictFileDetail, { kind: "text" }>,
  selections: Record<number, ConflictSide>,
): string {
  let cursor = 0;
  let output = "";
  const hunks = [...detail.hunks].sort(
    (left, right) => left.startOffset - right.startOffset,
  );

  for (const hunk of hunks) {
    output += detail.currentText.slice(cursor, hunk.startOffset);
    const side = selections[hunk.id];
    output +=
      side === "own"
        ? hunk.ownText
        : side === "other"
          ? hunk.otherText
          : detail.currentText.slice(hunk.startOffset, hunk.endOffset);
    cursor = hunk.endOffset;
  }

  return output + detail.currentText.slice(cursor);
}

function containsConflictMarkers(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    return (
      line.startsWith("<<<<<<< ") ||
      line.startsWith("||||||| ") ||
      line === "=======" ||
      line.startsWith(">>>>>>> ")
    );
  });
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "summary" in error &&
    typeof error.summary === "string"
  ) {
    return error.summary;
  }
  return typeof error === "string" ? error : "Unknown error";
}
