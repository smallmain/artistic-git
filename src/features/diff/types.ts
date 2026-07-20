import type * as React from "react";

import type {
  DiffChangeKind,
  DiffFileKind,
  DiffPayload,
  LfsContentStatus,
  LfsLockStatus,
} from "@/lib/ipc/generated";

export type DiffViewerSource =
  "localChanges" | "commitDetails" | "conflictResolution";

export type TextDiffMode = "split" | "inline";

export interface DiffAsset {
  alt?: string | null;
  height?: number | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  src: string;
  width?: number | null;
}

export interface TextDiffContent {
  kind: "text";
  language?: string | null;
  newText?: string | null;
  oldText?: string | null;
}

export interface ImageDiffContent {
  kind: "image";
  newImage?: DiffAsset | null;
  oldImage?: DiffAsset | null;
}

export interface FileCardDiffContent {
  kind: "binary" | "deferred" | "oversizedText" | "lfsPointer" | "moved";
  message?: string | null;
  status?: LfsContentStatus;
}

export type DiffViewerContent =
  TextDiffContent | ImageDiffContent | FileCardDiffContent;

export interface TextDiffAdapterProps {
  content: TextDiffContent;
  mode: TextDiffMode;
  payload: DiffPayload;
}

export interface TextDiffRendererAdapter {
  render: (props: TextDiffAdapterProps) => React.ReactNode;
}

export interface DiffViewerProps {
  content: DiffViewerContent;
  initialTextMode?: TextDiffMode;
  onTextModeChange?: (mode: TextDiffMode) => void;
  payload: DiffPayload;
  source: DiffViewerSource;
  textRenderer?: TextDiffRendererAdapter;
}

export interface DiffFileListItem {
  changeKind: DiffChangeKind;
  fileKind: DiffFileKind;
  id: string;
  lfsLock?: LfsLockStatus | null;
  newPath: string;
  oldPath?: string | null;
  searchableText?: string;
}
