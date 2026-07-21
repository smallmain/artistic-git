import { javascript } from "@codemirror/lang-javascript";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FileQuestion,
  FileWarning,
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
import { OverlayScrollArea } from "@/components/ui/overlay-scroll-area";
import { DiffViewer } from "@/features/diff";
import { useLocalizedFormatters } from "@/i18n/format";
import { DialogLayerContext, useModalLayer } from "@/lib/dialog-layer";
import {
  cancelConflictResolution,
  cancelOperation,
  completeConflictResolution,
  conflictDetail,
  listConflicts,
  saveConflictResolution,
  selectConflictSide,
} from "@/lib/ipc/commands";
import { isOperationCancelledError } from "@/lib/ipc/errors";
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
  cancelOperation: typeof cancelOperation;
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
  cancelOperation,
  completeConflictResolution,
  conflictDetail,
  listConflicts,
  saveConflictResolution,
  selectConflictSide,
};

const CONFLICT_FILE_PAGE_SIZE = 200;
const CONFLICT_HUNK_PAGE_SIZE = 50;
let conflictOperationSequence = 0;

interface ConflictDetailRequestState {
  path: string;
  status: "error" | "loading" | "ready";
}

function createConflictOperationId(): string {
  conflictOperationSequence += 1;
  const seed =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}`;
  return `conflict-select-${seed}-${conflictOperationSequence.toString(36)}`;
}

export function ConflictResolutionOverlay({
  api = defaultApi,
  event,
  onClose,
}: ConflictResolutionOverlayProps) {
  const { t } = useTranslation();
  const overlayRef = React.useRef<HTMLElement>(null);
  const dialogId = useModalLayer(overlayRef);
  const [files, setFiles] = React.useState<ConflictFile[]>(event.files);
  const [checkedPaths, setCheckedPaths] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [selectedPathPreference, setSelectedPathPreference] = React.useState<
    string | null
  >(null);
  const [detail, setDetail] = React.useState<ConflictDetailResponse | null>(
    null,
  );
  const [detailRequest, setDetailRequest] =
    React.useState<ConflictDetailRequestState | null>(null);
  const [busyLabel, setBusyLabel] = React.useState<string | null>(null);
  const busyRef = React.useRef(false);
  const [activeOperationId, setActiveOperationId] = React.useState<
    string | null
  >(null);
  const activeOperationIdRef = React.useRef<string | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const operationFailedMessage = t("conflicts.operationFailed");
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const conflictListKey = `${event.repositoryPath}\0${event.operationId}`;
  const [conflictListPage, setConflictListPage] = React.useState({
    key: conflictListKey,
    pageIndex: 0,
  });
  const requestedPageIndex =
    conflictListPage.key === conflictListKey ? conflictListPage.pageIndex : 0;
  const reportError = React.useCallback(
    (source: unknown) => {
      setError(operationFailedMessage);
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: source }),
      );
    },
    [operationFailedMessage],
  );

  React.useEffect(() => {
    let active = true;
    void api
      .listConflicts({ repositoryPath: event.repositoryPath })
      .then((response: ConflictListResponse) => {
        if (!active) {
          return;
        }
        setFiles(response.files);
      })
      .catch((source: unknown) => {
        if (active) {
          reportError(source);
        }
      });

    return () => {
      active = false;
    };
  }, [api, event.files, event.repositoryPath, reportError]);

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
  const selectedPathRef = React.useRef(selectedPath);
  React.useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  React.useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) {
        return;
      }
      setDetail(null);
      setDetailRequest(
        selectedPath ? { path: selectedPath, status: "loading" } : null,
      );
      if (selectedPath) {
        setError(null);
      }
    });

    if (!selectedPath) {
      return () => {
        active = false;
      };
    }

    void api
      .conflictDetail({
        path: selectedPath,
        repositoryPath: event.repositoryPath,
      })
      .then((response) => {
        if (!active || selectedPathRef.current !== selectedPath) {
          return;
        }
        if (response.file.path !== selectedPath) {
          throw new Error(
            `Conflict detail path mismatch: requested ${selectedPath}, received ${response.file.path}.`,
          );
        }
        setDetail(response);
        setDetailRequest({ path: selectedPath, status: "ready" });
      })
      .catch((source: unknown) => {
        if (!active || selectedPathRef.current !== selectedPath) {
          return;
        }
        setDetail(null);
        setDetailRequest({ path: selectedPath, status: "error" });
        reportError(source);
      });

    return () => {
      active = false;
    };
  }, [api, event.repositoryPath, reportError, selectedPath]);

  const unresolvedCount = files.filter(
    (file) => file.status === "unresolved",
  ).length;
  const allResolved = unresolvedCount === 0;
  const selectedFiles = files.filter((file) => checkedPaths.has(file.path));
  const conflictPageCount = Math.max(
    1,
    Math.ceil(files.length / CONFLICT_FILE_PAGE_SIZE),
  );
  const conflictPageIndex = Math.min(requestedPageIndex, conflictPageCount - 1);
  const visibleFiles = files.slice(
    conflictPageIndex * CONFLICT_FILE_PAGE_SIZE,
    (conflictPageIndex + 1) * CONFLICT_FILE_PAGE_SIZE,
  );
  const visibleDetail =
    detail?.file.path === selectedPath &&
    detailRequest?.path === selectedPath &&
    detailRequest.status === "ready"
      ? detail
      : null;
  const selectedDetailFailed =
    detailRequest?.path === selectedPath && detailRequest.status === "error";
  const selectedOrCurrentPaths =
    selectedFiles.length > 0
      ? selectedFiles.map((file) => file.path)
      : selectedPath
        ? [selectedPath]
        : [];
  const sideLabels = React.useMemo(
    () => conflictSideLabels(t, event.operationName),
    [event.operationName, t],
  );

  const beginBusy = (label: string, operationId: string | null = null) => {
    if (busyRef.current) {
      return false;
    }
    busyRef.current = true;
    activeOperationIdRef.current = operationId;
    setBusyLabel(label);
    setActiveOperationId(operationId);
    setCancelling(false);
    return true;
  };

  const finishBusy = () => {
    busyRef.current = false;
    activeOperationIdRef.current = null;
    setBusyLabel(null);
    setActiveOperationId(null);
    setCancelling(false);
  };

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
    const operationId = createConflictOperationId();
    if (
      paths.length === 0 ||
      !beginBusy(t("conflicts.applyingSelection"), operationId)
    ) {
      return;
    }
    const detailPath = selectedPath;
    let refreshingDetail = false;
    setError(null);
    try {
      const response: ConflictSelectSideResponse = await api.selectConflictSide(
        {
          operationId,
          paths,
          repositoryPath: event.repositoryPath,
          side,
        },
      );
      mergeUpdatedFiles(response.files);
      if (detailPath && selectedPathRef.current === detailPath) {
        refreshingDetail = true;
        setDetail(null);
        setDetailRequest({ path: detailPath, status: "loading" });
        const nextDetail = await api.conflictDetail({
          path: detailPath,
          repositoryPath: event.repositoryPath,
        });
        if (nextDetail.file.path !== detailPath) {
          throw new Error(
            `Conflict detail path mismatch: requested ${detailPath}, received ${nextDetail.file.path}.`,
          );
        }
        if (selectedPathRef.current === detailPath) {
          setDetail(nextDetail);
          setDetailRequest({ path: detailPath, status: "ready" });
        }
      }
    } catch (source) {
      if (
        refreshingDetail &&
        detailPath &&
        selectedPathRef.current === detailPath
      ) {
        setDetail(null);
        setDetailRequest({ path: detailPath, status: "error" });
      }
      if (!isOperationCancelledError(source)) {
        reportError(source);
      }
    } finally {
      finishBusy();
    }
  };

  const cancelActiveOperation = async () => {
    const operationId = activeOperationIdRef.current;
    if (!operationId || cancelling) {
      return;
    }
    const previousBusyLabel = busyLabel;
    setCancelling(true);
    setBusyLabel(t("conflicts.cancelling"));
    try {
      const response = await api.cancelOperation({ operationId });
      if (!response.cancelled && activeOperationIdRef.current === operationId) {
        throw new Error("The conflict operation could not be cancelled.");
      }
    } catch (source) {
      if (activeOperationIdRef.current === operationId) {
        setCancelling(false);
        setBusyLabel(previousBusyLabel);
        reportError(source);
      }
    }
  };

  const runSave = async (content: string, pendingHunks: number) => {
    if (!selectedPath || !beginBusy(t("conflicts.saving"))) {
      return;
    }
    const detailPath = selectedPath;
    setError(null);
    try {
      const response: ConflictSaveResolutionResponse =
        await api.saveConflictResolution({
          content,
          path: detailPath,
          pendingHunks,
          repositoryPath: event.repositoryPath,
        });
      mergeUpdatedFiles([response.file]);
      if (selectedPathRef.current === detailPath) {
        setDetail((current) =>
          current?.file.path === detailPath
            ? { ...current, file: response.file }
            : current,
        );
      }
    } catch (source) {
      reportError(source);
    } finally {
      finishBusy();
    }
  };

  const runComplete = async () => {
    if (!allResolved || !beginBusy(t("conflicts.completing"))) {
      return;
    }
    setError(null);
    try {
      await api.completeConflictResolution({
        operationId: event.operationId,
        paths: files.map((file) => file.path),
        repositoryPath: event.repositoryPath,
      });
      onClose(event.repositoryPath);
    } catch (source) {
      reportError(source);
    } finally {
      finishBusy();
    }
  };

  const runCancel = async () => {
    if (!beginBusy(t("conflicts.cancelling"))) {
      return;
    }
    setError(null);
    try {
      await api.cancelConflictResolution({
        operationId: event.operationId,
        repositoryPath: event.repositoryPath,
      });
      onClose(event.repositoryPath);
    } catch (source) {
      reportError(source);
      setConfirmCancel(false);
    } finally {
      finishBusy();
    }
  };

  return (
    <DialogLayerContext.Provider value={dialogId}>
      <section
        ref={overlayRef}
        aria-label={t("conflicts.title")}
        aria-modal="true"
        className="fixed inset-0 z-50 flex min-h-0 flex-col bg-background text-foreground"
        data-testid="conflict-resolution-overlay"
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-card px-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">
              {t("conflicts.title")}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {files.length === 0
                ? t("conflicts.noFilesRemaining")
                : t("conflicts.summary", {
                    resolved: files.length - unresolvedCount,
                    total: files.length,
                  })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {busyLabel ? (
              <span className="text-sm text-muted-foreground" role="status">
                {busyLabel}
              </span>
            ) : null}
            {activeOperationId ? (
              <Button
                data-testid="conflict-cancel-active-operation"
                disabled={cancelling}
                onClick={() => {
                  void cancelActiveOperation();
                }}
                type="button"
                variant="secondary"
              >
                <X className="mr-2 size-4" aria-hidden="true" />
                {t("actions.cancel")}
              </Button>
            ) : null}
            <Button
              data-testid="conflict-complete"
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
          <aside
            aria-busy={busyLabel !== null}
            className="flex w-80 shrink-0 flex-col border-r bg-card"
            inert={busyLabel !== null}
          >
            <div className="grid grid-cols-2 gap-2 border-b p-3">
              <Button
                disabled={busyLabel !== null}
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
                disabled={busyLabel !== null}
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
                data-testid="conflict-use-other"
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
                data-testid="conflict-use-own"
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

            <OverlayScrollArea
              className="min-h-0 flex-1"
              data-testid="conflict-file-list"
            >
              {visibleFiles.map((file) => (
                <ConflictFileRow
                  checked={checkedPaths.has(file.path)}
                  disabled={busyLabel !== null}
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
              {conflictPageCount > 1 ? (
                <div className="flex items-center justify-between gap-2 border-b p-2">
                  <Button
                    aria-label={t("conflicts.previousPage")}
                    data-testid="conflict-previous-page"
                    disabled={busyLabel !== null || conflictPageIndex === 0}
                    onClick={() => {
                      setConflictListPage({
                        key: conflictListKey,
                        pageIndex: Math.max(0, conflictPageIndex - 1),
                      });
                    }}
                    size="icon"
                    title={t("conflicts.previousPage")}
                    type="button"
                    variant="ghost"
                  >
                    <ChevronLeft aria-hidden="true" className="size-4" />
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t("conflicts.page", {
                      page: conflictPageIndex + 1,
                      total: conflictPageCount,
                    })}
                  </span>
                  <Button
                    aria-label={t("conflicts.nextPage")}
                    data-testid="conflict-next-page"
                    disabled={
                      busyLabel !== null ||
                      conflictPageIndex >= conflictPageCount - 1
                    }
                    onClick={() => {
                      setConflictListPage({
                        key: conflictListKey,
                        pageIndex: Math.min(
                          conflictPageCount - 1,
                          conflictPageIndex + 1,
                        ),
                      });
                    }}
                    size="icon"
                    title={t("conflicts.nextPage")}
                    type="button"
                    variant="ghost"
                  >
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              ) : null}
            </OverlayScrollArea>
          </aside>

          <div className="min-w-0 flex-1 bg-background">
            {visibleDetail ? (
              <ConflictDetailPanel
                detail={visibleDetail.detail}
                file={visibleDetail.file}
                onSave={(content, pendingHunks) => {
                  void runSave(content, pendingHunks);
                }}
                onSelectSide={(side) => {
                  void runSelectSide(side, [visibleDetail.file.path]);
                }}
                saving={busyLabel !== null}
                sideLabels={sideLabels}
              />
            ) : (
              <div
                className="flex h-full items-center justify-center text-sm text-muted-foreground"
                role={selectedDetailFailed ? "alert" : "status"}
              >
                {t(
                  files.length === 0
                    ? "conflicts.noFilesRemaining"
                    : selectedDetailFailed
                      ? "conflicts.detailUnavailable"
                      : "conflicts.loading",
                )}
              </div>
            )}
          </div>
        </div>

        <ConfirmDialog
          busy={busyLabel !== null}
          busyLabel={t("conflicts.cancelling")}
          confirmLabel={t("conflicts.abort")}
          description={t("conflicts.cancelDescription")}
          onConfirm={() => {
            void runCancel();
          }}
          onOpenChange={(open) => {
            if (!open && busyLabel !== null) {
              return;
            }
            setConfirmCancel(open);
          }}
          open={confirmCancel}
          title={t("conflicts.cancelTitle")}
          variant="danger"
        />
      </section>
    </DialogLayerContext.Provider>
  );
}

function ConflictFileRow({
  checked,
  disabled,
  file,
  onCheckedChange,
  onSelect,
  selected,
}: {
  checked: boolean;
  disabled: boolean;
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
      data-conflict-path={file.path}
      data-testid="conflict-file-row"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <input
        aria-label={t("conflicts.toggleFile", { path: file.path })}
        checked={checked}
        disabled={disabled}
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
  sideLabels,
}: {
  detail: ConflictFileDetail;
  file: ConflictFile;
  onSave: (content: string, pendingHunks: number) => void;
  onSelectSide: (side: ConflictSide) => void;
  saving: boolean;
  sideLabels: ConflictSideLabels;
}) {
  if (detail.kind === "oversizedText") {
    return (
      <OversizedTextConflictDetail
        detail={detail}
        file={file}
        onSelectSide={onSelectSide}
        saving={saving}
        sideLabels={sideLabels}
      />
    );
  }

  if (detail.kind === "binary") {
    return (
      <BinaryConflictDetail
        detail={detail}
        file={file}
        onSelectSide={onSelectSide}
        saving={saving}
        sideLabels={sideLabels}
      />
    );
  }

  return (
    <TextConflictDetail
      detail={detail}
      file={file}
      key={`${file.path}:${detail.currentText}`}
      onSave={onSave}
      onSelectSide={onSelectSide}
      saving={saving}
      sideLabels={sideLabels}
    />
  );
}

function OversizedTextConflictDetail({
  detail,
  file,
  onSelectSide,
  saving,
  sideLabels,
}: {
  detail: Extract<ConflictFileDetail, { kind: "oversizedText" }>;
  file: ConflictFile;
  onSelectSide: (side: ConflictSide) => void;
  saving: boolean;
  sideLabels: ConflictSideLabels;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const sizeBytes = Number(detail.sizeBytes);
  const formattedSize = Number.isFinite(sizeBytes)
    ? formatters.formatFileSize(sizeBytes)
    : detail.sizeBytes;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center border-b bg-card px-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{file.path}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t("conflicts.oversizedTitle")}
          </p>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <section className="flex max-w-xl flex-col items-center gap-4 text-center">
          <FileWarning aria-hidden="true" className="size-10 text-warning" />
          <div className="space-y-2">
            <h2 className="text-base font-semibold">
              {t("conflicts.oversizedTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("conflicts.oversizedDescription", {
                limit: formatters.formatFileSize(detail.maxPreviewBytes),
                size: formattedSize,
              })}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              data-testid="conflict-oversized-use-own"
              disabled={saving}
              onClick={() => onSelectSide("own")}
              type="button"
              variant="secondary"
            >
              {sideLabels.useOwn}
            </Button>
            <Button
              data-testid="conflict-oversized-use-other"
              disabled={saving}
              onClick={() => onSelectSide("other")}
              type="button"
              variant="secondary"
            >
              {sideLabels.useOther}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function TextConflictDetail({
  detail,
  file,
  onSave,
  onSelectSide,
  saving,
  sideLabels,
}: {
  detail: Extract<ConflictFileDetail, { kind: "text" }>;
  file: ConflictFile;
  onSave: (content: string, pendingHunks: number) => void;
  onSelectSide: (side: ConflictSide) => void;
  saving: boolean;
  sideLabels: ConflictSideLabels;
}) {
  const { t } = useTranslation();
  const [manualMode, setManualMode] = React.useState(false);
  const [manualResolved, setManualResolved] = React.useState(false);
  const [selections, setSelections] = React.useState<
    Record<number, ConflictSide>
  >({});
  const [manualContent, setManualContent] = React.useState(detail.currentText);
  const [hunkPageIndex, setHunkPageIndex] = React.useState(0);

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
  const hunkPageCount = Math.max(
    1,
    Math.ceil(detail.hunks.length / CONFLICT_HUNK_PAGE_SIZE),
  );
  const currentHunkPageIndex = Math.min(hunkPageIndex, hunkPageCount - 1);
  const visibleHunks = detail.hunks.slice(
    currentHunkPageIndex * CONFLICT_HUNK_PAGE_SIZE,
    (currentHunkPageIndex + 1) * CONFLICT_HUNK_PAGE_SIZE,
  );

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
          <Button
            data-testid="conflict-detail-use-own"
            disabled={saving}
            onClick={() => onSelectSide("own")}
            type="button"
            variant="ghost"
          >
            {sideLabels.useOwn}
          </Button>
          <Button
            data-testid="conflict-detail-use-other"
            disabled={saving}
            onClick={() => onSelectSide("other")}
            type="button"
            variant="ghost"
          >
            {sideLabels.useOther}
          </Button>
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
            data-testid="conflict-save"
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
        <div className="flex min-h-0 flex-col">
          <div className="grid shrink-0 grid-cols-2 border-b bg-card px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>{sideLabels.ownVersion}</span>
            <span>{sideLabels.otherVersion}</span>
          </div>
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
        </div>
        <div className="flex min-h-0 flex-col border-l">
          <div className="flex max-h-80 shrink-0 flex-col border-b">
            <OverlayScrollArea
              className="min-h-0 flex-1"
              data-testid="conflict-hunk-list"
              viewportClassName="grid gap-2 p-3"
            >
              {detail.hunks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("conflicts.noHunks")}
                </p>
              ) : (
                visibleHunks.map((hunk) => (
                  <ConflictHunkCard
                    hunk={hunk}
                    key={hunk.id}
                    onSelect={(side) =>
                      setSelections((current) => ({
                        ...current,
                        [hunk.id]: side,
                      }))
                    }
                    selectedSide={selections[hunk.id]}
                    sideLabels={sideLabels}
                  />
                ))
              )}
            </OverlayScrollArea>
            {hunkPageCount > 1 ? (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t p-2">
                <Button
                  aria-label={t("conflicts.previousHunkPage")}
                  data-testid="conflict-previous-hunk-page"
                  disabled={currentHunkPageIndex === 0}
                  onClick={() =>
                    setHunkPageIndex(Math.max(0, currentHunkPageIndex - 1))
                  }
                  size="icon"
                  title={t("conflicts.previousHunkPage")}
                  type="button"
                  variant="ghost"
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("conflicts.hunkPage", {
                    page: currentHunkPageIndex + 1,
                    total: hunkPageCount,
                  })}
                </span>
                <Button
                  aria-label={t("conflicts.nextHunkPage")}
                  data-testid="conflict-next-hunk-page"
                  disabled={currentHunkPageIndex >= hunkPageCount - 1}
                  onClick={() =>
                    setHunkPageIndex(
                      Math.min(hunkPageCount - 1, currentHunkPageIndex + 1),
                    )
                  }
                  size="icon"
                  title={t("conflicts.nextHunkPage")}
                  type="button"
                  variant="ghost"
                >
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>
          <ManualResolutionEditor
            label={t("conflicts.resolutionContent")}
            language={detail.language ?? undefined}
            onChange={(nextContent) => {
              setManualContent(nextContent);
              setManualMode(true);
            }}
            value={content}
          />
        </div>
      </div>
    </div>
  );
}

function ManualResolutionEditor({
  label,
  language,
  onChange,
  value,
}: {
  label: string;
  language?: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<EditorView | null>(null);
  const applyingExternalChangeRef = React.useRef(false);
  const initialValueRef = React.useRef(value);
  const labelRef = React.useRef(label);
  const onChangeRef = React.useRef(onChange);

  React.useEffect(() => {
    labelRef.current = label;
  }, [label]);

  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    const parent = containerRef.current;
    if (!parent) {
      return;
    }

    parent.replaceChildren();
    const initialValue = initialValueRef.current;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialValue,
        extensions: createResolutionEditorExtensions(language, (nextValue) => {
          if (!applyingExternalChangeRef.current) {
            onChangeRef.current(nextValue);
          }
        }),
      }),
    });

    editorRef.current = editor;
    updateResolutionEditorDom(editor, labelRef.current, initialValue);

    return () => {
      editorRef.current = null;
      editor.destroy();
    };
  }, [language]);

  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    updateResolutionEditorDom(editor, label, value);

    const currentValue = editor.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    applyingExternalChangeRef.current = true;
    try {
      editor.dispatch({
        changes: {
          from: 0,
          insert: value,
          to: editor.state.doc.length,
        },
      });
    } finally {
      applyingExternalChangeRef.current = false;
    }
    updateResolutionEditorDom(editor, label, value);
  }, [label, value]);

  return (
    <div
      className="conflict-resolution-codemirror min-h-0 flex-1 overflow-auto bg-background text-xs"
      ref={containerRef}
    />
  );
}

function ConflictHunkCard({
  hunk,
  onSelect,
  selectedSide,
  sideLabels,
}: {
  hunk: Extract<ConflictFileDetail, { kind: "text" }>["hunks"][number];
  onSelect: (side: ConflictSide) => void;
  selectedSide?: ConflictSide;
  sideLabels: ConflictSideLabels;
}) {
  const { t } = useTranslation();

  return (
    <section
      aria-label={t("conflicts.hunkLabel", { line: hunk.startLine })}
      className="overflow-hidden rounded-md border bg-card"
      data-testid="conflict-hunk-card"
    >
      <header className="border-b bg-muted/35 px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t("conflicts.hunkLabel", { line: hunk.startLine })}
        </p>
      </header>
      <div className="grid grid-cols-2 divide-x">
        <ConflictHunkSide
          content={hunk.ownText}
          label={sideLabels.ownSection}
          onSelect={() => onSelect("own")}
          selected={selectedSide === "own"}
          selectLabel={sideLabels.useOwnHunk}
        />
        <ConflictHunkSide
          content={hunk.otherText}
          label={sideLabels.otherSection}
          onSelect={() => onSelect("other")}
          selected={selectedSide === "other"}
          selectLabel={sideLabels.useOtherHunk}
        />
      </div>
    </section>
  );
}

function ConflictHunkSide({
  content,
  label,
  onSelect,
  selected,
  selectLabel,
}: {
  content: string;
  label: string;
  onSelect: () => void;
  selected: boolean;
  selectLabel: string;
}) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 p-2",
        selected
          ? "bg-primary/10 ring-1 ring-inset ring-primary"
          : "bg-muted/15",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <Button
          aria-pressed={selected}
          className="h-7 shrink-0 px-2 text-xs"
          onClick={onSelect}
          type="button"
          variant={selected ? "secondary" : "ghost"}
        >
          {selectLabel}
        </Button>
      </div>
      <pre className="max-h-40 min-h-20 overflow-auto whitespace-pre-wrap break-words rounded bg-background/80 p-2 font-mono text-xs text-foreground">
        {content.length > 0 ? content : t("conflicts.emptySection")}
      </pre>
    </div>
  );
}

function BinaryConflictDetail({
  detail,
  file,
  onSelectSide,
  saving,
  sideLabels,
}: {
  detail: Extract<ConflictFileDetail, { kind: "binary" }>;
  file: ConflictFile;
  onSelectSide: (side: ConflictSide) => void;
  saving: boolean;
  sideLabels: ConflictSideLabels;
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
          label={sideLabels.ownVersion}
          onSelect={() => onSelectSide("own")}
          side={detail.own}
        />
        <BinarySideCard
          disabled={saving}
          label={sideLabels.otherVersion}
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
  const formatters = useLocalizedFormatters();
  const modifiedLabel = formatModifiedTime(
    side?.modifiedUnixSeconds,
    formatters.formatDate,
    t("conflicts.unavailable"),
  );

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
      <dl className="grid gap-2 p-3 text-sm">
        <BinaryInfoRow
          label={t("conflicts.typeLabel")}
          value={side?.mimeType ?? t("conflicts.unknownType")}
        />
        <BinaryInfoRow
          label={t("conflicts.sizeLabel")}
          value={
            side?.sizeBytes != null
              ? formatters.formatFileSize(side.sizeBytes)
              : t("conflicts.unavailable")
          }
        />
        <BinaryInfoRow
          label={t("conflicts.modifiedLabel")}
          value={modifiedLabel}
        />
      </dl>
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

function BinaryInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{value}</dd>
    </div>
  );
}

function formatModifiedTime(
  unixSeconds: string | null | undefined,
  formatDate: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
  fallback: string,
): string {
  if (!unixSeconds) {
    return fallback;
  }

  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds)) {
    return fallback;
  }

  return formatDate(seconds * 1000, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const isTestEnvironment = import.meta.env.MODE === "test";

function createResolutionEditorExtensions(
  language: string | undefined,
  onDocumentChange: (value: string) => void,
): Extension[] {
  const extensions: Extension[] = [
    lineNumbers(),
    EditorView.lineWrapping,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocumentChange(update.state.doc.toString());
      }
    }),
    EditorView.theme({
      "&": {
        backgroundColor: "hsl(var(--background))",
        color: "hsl(var(--foreground))",
        height: "100%",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-activeLine, .cm-activeLineGutter": {
        backgroundColor: "hsl(var(--muted) / 0.35)",
      },
      ".cm-content": {
        minHeight: "100%",
        padding: "0.75rem",
      },
      ".cm-gutters": {
        backgroundColor: "hsl(var(--muted) / 0.35)",
        borderRight: "1px solid hsl(var(--border))",
        color: "hsl(var(--muted-foreground))",
      },
      ".cm-line": {
        padding: "0",
      },
      ".cm-scroller": {
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: "12px",
      },
    }),
  ];

  if (isTestEnvironment) {
    extensions.push(
      EditorView.domEventHandlers({
        input: (_event, view) => {
          const nextValue = view.contentDOM.textContent;
          if (nextValue == null || nextValue === view.state.doc.toString()) {
            return false;
          }

          view.dispatch({
            changes: {
              from: 0,
              insert: nextValue,
              to: view.state.doc.length,
            },
          });
          return true;
        },
      }),
    );
  }

  if (
    language === "js" ||
    language === "jsx" ||
    language === "ts" ||
    language === "tsx"
  ) {
    extensions.push(
      javascript({
        jsx: language === "jsx" || language === "tsx",
        typescript: language === "ts" || language === "tsx",
      }),
    );
  }

  return extensions;
}

function updateResolutionEditorDom(
  editor: EditorView,
  label: string,
  value: string,
) {
  editor.contentDOM.setAttribute("aria-label", label);
  editor.contentDOM.setAttribute("aria-multiline", "true");
  editor.contentDOM.setAttribute("role", "textbox");
  if (isTestEnvironment) {
    editor.contentDOM.setAttribute("data-editor-value", value);
  }
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

interface ConflictSideLabels {
  otherSection: string;
  otherVersion: string;
  ownSection: string;
  ownVersion: string;
  useOther: string;
  useOtherHunk: string;
  useOwn: string;
  useOwnHunk: string;
}

function conflictSideLabels(
  t: (key: string) => string,
  operationName: string,
): ConflictSideLabels {
  const normalizedOperationName = operationName.toLowerCase();
  if (normalizedOperationName.includes("stash")) {
    return {
      otherSection: t("conflicts.stashOtherSection"),
      otherVersion: t("conflicts.stashOtherVersion"),
      ownSection: t("conflicts.stashOwnSection"),
      ownVersion: t("conflicts.stashOwnVersion"),
      useOther: t("conflicts.useStashOther"),
      useOtherHunk: t("conflicts.useStashOtherHunk"),
      useOwn: t("conflicts.useStashOwn"),
      useOwnHunk: t("conflicts.useStashOwnHunk"),
    };
  }

  if (normalizedOperationName.includes("sync")) {
    return {
      otherSection: t("conflicts.syncOtherSection"),
      otherVersion: t("conflicts.syncOtherVersion"),
      ownSection: t("conflicts.syncOwnSection"),
      ownVersion: t("conflicts.syncOwnVersion"),
      useOther: t("conflicts.useSyncOther"),
      useOtherHunk: t("conflicts.useSyncOtherHunk"),
      useOwn: t("conflicts.useSyncOwn"),
      useOwnHunk: t("conflicts.useSyncOwnHunk"),
    };
  }

  return {
    otherSection: t("conflicts.otherSection"),
    otherVersion: t("conflicts.otherVersion"),
    ownSection: t("conflicts.ownSection"),
    ownVersion: t("conflicts.ownVersion"),
    useOther: t("conflicts.useOther"),
    useOtherHunk: t("conflicts.useOtherHunk"),
    useOwn: t("conflicts.useOwn"),
    useOwnHunk: t("conflicts.useOwnHunk"),
  };
}
