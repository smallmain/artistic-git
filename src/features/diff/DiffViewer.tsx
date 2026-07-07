import { javascript } from "@codemirror/lang-javascript";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import {
  ArrowRight,
  Binary,
  Columns2,
  FileQuestion,
  FileText,
  Image as ImageIcon,
  LockKeyhole,
  Rows3,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/icon-button";
import { useLocalizedFormatters } from "@/i18n/format";

import type {
  DiffAsset,
  DiffViewerContent,
  DiffViewerProps,
  TextDiffContent,
  TextDiffMode,
} from "./types";

export function DiffViewer({
  content,
  initialTextMode = "split",
  onTextModeChange,
  payload,
  source,
  textRenderer,
}: DiffViewerProps) {
  const { t } = useTranslation();
  const [textMode, setTextMode] = React.useState<TextDiffMode>(initialTextMode);
  const effectiveContent = getEffectiveContent(content, payload);

  const updateTextMode = (mode: TextDiffMode) => {
    setTextMode(mode);
    onTextModeChange?.(mode);
  };

  return (
    <section
      aria-label={t("diff.viewerLabel")}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border bg-background"
      data-diff-source={source}
    >
      <header className="flex min-h-12 items-center justify-between gap-3 border-b bg-card px-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon kind={effectiveContent.kind} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {formatDiffPath(payload)}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t(`diff.changeKind.${payload.changeKind}`)} ·{" "}
              {t(`diff.fileKind.${payload.fileKind}`)}
              {payload.lfsLock?.locked ? ` · ${t("diff.lfsLocked")}` : ""}
            </p>
          </div>
        </div>

        {effectiveContent.kind === "text" ? (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              aria-pressed={textMode === "split"}
              label={t("diff.splitMode")}
              onClick={() => updateTextMode("split")}
              tooltip={t("diff.splitMode")}
              variant={textMode === "split" ? "secondary" : "ghost"}
            >
              <Columns2 className="size-4" aria-hidden="true" />
            </IconButton>
            <IconButton
              aria-pressed={textMode === "inline"}
              label={t("diff.inlineMode")}
              onClick={() => updateTextMode("inline")}
              tooltip={t("diff.inlineMode")}
              variant={textMode === "inline" ? "secondary" : "ghost"}
            >
              <Rows3 className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {renderContent(effectiveContent, payload, textMode, textRenderer)}
      </div>
    </section>
  );
}

function getEffectiveContent(
  content: DiffViewerContent,
  payload: DiffViewerProps["payload"],
): DiffViewerContent {
  if (
    payload.changeKind === "renamed" &&
    payload.metadata.contentChanged === "false"
  ) {
    return { kind: "moved" };
  }

  return content;
}

function renderContent(
  content: DiffViewerContent,
  payload: DiffViewerProps["payload"],
  textMode: TextDiffMode,
  textRenderer: DiffViewerProps["textRenderer"],
) {
  if (content.kind === "text") {
    return textRenderer ? (
      textRenderer.render({ content, mode: textMode, payload })
    ) : (
      <TextDiff content={content} mode={textMode} />
    );
  }

  if (content.kind === "image") {
    return <ImageDiff content={content} />;
  }

  return <FileDiffCard content={content} payload={payload} />;
}

function TextDiff({
  content,
  mode,
}: {
  content: TextDiffContent;
  mode: TextDiffMode;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveMode = useEffectiveTextMode(mode);

  React.useEffect(() => {
    const parent = containerRef.current;
    if (!parent) {
      return;
    }

    parent.replaceChildren();
    const oldText = content.oldText ?? "";
    const newText = content.newText ?? "";
    const extensions = createCodeMirrorExtensions(
      content.language ?? undefined,
    );

    if (effectiveMode === "split") {
      const mergeView = new MergeView({
        a: { doc: oldText, extensions },
        b: { doc: newText, extensions },
        collapseUnchanged: { margin: 3, minSize: 8 },
        diffConfig: { scanLimit: 10_000, timeout: 250 },
        gutter: true,
        highlightChanges: true,
        parent,
      });

      return () => {
        mergeView.destroy();
      };
    }

    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: newText,
        extensions: [
          ...extensions,
          unifiedMergeView({
            allowInlineDiffs: true,
            collapseUnchanged: { margin: 3, minSize: 8 },
            diffConfig: { scanLimit: 10_000, timeout: 250 },
            gutter: true,
            highlightChanges: true,
            mergeControls: false,
            original: oldText,
          }),
        ],
      }),
    });

    return () => {
      editor.destroy();
    };
  }, [content.language, content.newText, content.oldText, effectiveMode]);

  return (
    <div
      className="diff-codemirror h-full min-h-80 overflow-auto text-sm"
      data-text-diff-mode={effectiveMode}
      ref={containerRef}
    />
  );
}

function useEffectiveTextMode(mode: TextDiffMode): TextDiffMode {
  const [narrow, setNarrow] = React.useState(false);

  React.useEffect(() => {
    const update = () => setNarrow(window.innerWidth < 900);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return mode === "split" && narrow ? "inline" : mode;
}

function createCodeMirrorExtensions(language?: string): Extension[] {
  const extensions: Extension[] = [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.theme({
      "&": {
        backgroundColor: "hsl(var(--background))",
        color: "hsl(var(--foreground))",
        height: "100%",
      },
      ".cm-activeLine, .cm-activeLineGutter": {
        backgroundColor: "transparent",
      },
      ".cm-content": {
        minHeight: "100%",
      },
      ".cm-gutters": {
        backgroundColor: "hsl(var(--muted) / 0.35)",
        borderRight: "1px solid hsl(var(--border))",
        color: "hsl(var(--muted-foreground))",
      },
      ".cm-scroller": {
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: "12px",
      },
    }),
  ];

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

function ImageDiff({
  content,
}: {
  content: Extract<DiffViewerContent, { kind: "image" }>;
}) {
  const { t } = useTranslation();
  const [zoom, setZoom] = React.useState(100);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-end gap-2 border-b bg-card px-3 py-2 text-xs">
        <label htmlFor="diff-image-zoom">{t("diff.zoom")}</label>
        <input
          className="w-32 accent-primary"
          id="diff-image-zoom"
          max={200}
          min={25}
          onChange={(event) => setZoom(Number(event.target.value))}
          type="range"
          value={zoom}
        />
        <span className="w-10 text-right text-numeric">{zoom}%</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <ImagePane
          asset={content.oldImage}
          label={t("diff.oldImage")}
          zoom={zoom}
        />
        <ImagePane
          asset={content.newImage}
          label={t("diff.newImage")}
          zoom={zoom}
        />
      </div>
    </div>
  );
}

function ImagePane({
  asset,
  label,
  zoom,
}: {
  asset?: DiffAsset | null;
  label: string;
  zoom: number;
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();

  return (
    <section className="flex min-h-72 flex-col border-b md:border-b-0 md:border-r">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium">{label}</span>
        {asset ? (
          <span className="text-muted-foreground">
            {formatImageMeta(asset, formatters.formatFileSize)}
          </span>
        ) : null}
      </header>
      <div className="diff-checkerboard flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {asset ? (
          <img
            alt={asset.alt ?? label}
            className="max-w-none"
            src={asset.src}
            style={{ width: `${zoom}%` }}
          />
        ) : (
          <div className="text-sm text-muted-foreground">
            {t("diff.imageMissing")}
          </div>
        )}
      </div>
    </section>
  );
}

function FileDiffCard({
  content,
  payload,
}: {
  content: Extract<
    DiffViewerContent,
    { kind: "binary" | "oversizedText" | "lfsPointer" | "moved" }
  >;
  payload: DiffViewerProps["payload"];
}) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const oldBytes = parseOptionalNumber(payload.metadata.oldBytes);
  const newBytes = parseOptionalNumber(payload.metadata.newBytes);
  const lfsStatus = content.kind === "lfsPointer" ? content.status : undefined;
  const isSubmodule = payload.metadata.submodule === "true";
  const title =
    content.kind === "lfsPointer" && content.status === "loading"
      ? t("diff.card.lfsLoading")
      : content.kind === "lfsPointer" && content.status === "error"
        ? (content.message ?? t("diff.card.lfsError"))
        : (content.message ??
          (isSubmodule
            ? t("diff.card.submoduleUpdated", { path: payload.newPath })
            : t(`diff.card.${content.kind}`)));
  const role =
    lfsStatus === "loading"
      ? "status"
      : lfsStatus === "error"
        ? "alert"
        : undefined;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div
        className="w-full max-w-lg rounded-lg border bg-card p-5 text-card-foreground shadow-sm"
        role={role}
      >
        <div className="flex items-start gap-3">
          <FileIcon kind={content.kind} />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium">{title}</h2>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              {formatDiffPath(payload)}
            </p>
            <dl className="mt-4 grid gap-2 text-sm">
              {lfsStatus ? (
                <MetadataRow
                  label={t("diff.lfsContent")}
                  value={t(`diff.lfsStatus.${lfsStatus}`)}
                />
              ) : null}
              <MetadataRow
                label={t("diff.changeType")}
                value={t(`diff.changeKind.${payload.changeKind}`)}
              />
              <MetadataRow
                label={t("diff.fileType")}
                value={t(`diff.fileKind.${payload.fileKind}`)}
              />
              {oldBytes !== undefined || newBytes !== undefined ? (
                <MetadataRow
                  label={t("diff.sizeChange")}
                  value={`${formatSize(oldBytes, formatters.formatFileSize)} -> ${formatSize(
                    newBytes,
                    formatters.formatFileSize,
                  )}`}
                />
              ) : null}
              {payload.lfsLock?.locked ? (
                <MetadataRow
                  label={t("diff.lfsLock")}
                  value={payload.lfsLock.owner ?? t("diff.locked")}
                />
              ) : null}
              {isSubmodule && payload.metadata.oldOid ? (
                <MetadataRow
                  label={t("diff.oldVersion")}
                  value={shortOid(payload.metadata.oldOid)}
                />
              ) : null}
              {isSubmodule && payload.metadata.newOid ? (
                <MetadataRow
                  label={t("diff.newVersion")}
                  value={shortOid(payload.metadata.newOid)}
                />
              ) : null}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

function FileIcon({ kind }: { kind: DiffViewerContent["kind"] | "text" }) {
  const className = "mt-0.5 size-5 shrink-0 text-muted-foreground";

  if (kind === "image") {
    return <ImageIcon className={className} aria-hidden="true" />;
  }

  if (kind === "binary") {
    return <Binary className={className} aria-hidden="true" />;
  }

  if (kind === "lfsPointer") {
    return <LockKeyhole className={className} aria-hidden="true" />;
  }

  if (kind === "moved") {
    return <ArrowRight className={className} aria-hidden="true" />;
  }

  if (kind === "oversizedText") {
    return <FileQuestion className={className} aria-hidden="true" />;
  }

  return <FileText className={className} aria-hidden="true" />;
}

function formatDiffPath(payload: DiffViewerProps["payload"]): string {
  if (payload.oldPath && payload.oldPath !== payload.newPath) {
    return `${payload.oldPath} -> ${payload.newPath}`;
  }

  return payload.newPath;
}

function formatImageMeta(
  asset: DiffAsset,
  formatFileSize: (bytes: number) => string,
): string {
  const dimensions =
    asset.width && asset.height
      ? `${asset.width} x ${asset.height}`
      : undefined;
  const size =
    asset.sizeBytes === undefined || asset.sizeBytes === null
      ? undefined
      : formatFileSize(asset.sizeBytes);

  return [dimensions, size].filter(Boolean).join(" · ");
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatSize(
  value: number | undefined,
  formatFileSize: (bytes: number) => string,
): string {
  return value === undefined ? "-" : formatFileSize(value);
}

function shortOid(value: string): string {
  return value.slice(0, 12);
}
