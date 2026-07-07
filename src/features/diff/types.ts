import type * as React from "react";

import type {
  DiffChangeKind,
  DiffFileKind,
  DiffPayload,
  LfsLockStatus,
} from "@/lib/ipc/generated";

export type DiffViewerSource =
  "localChanges" | "commitDetails" | "conflictResolution";

export type TextDiffMode = "split" | "inline";

export interface DiffAsset {
  alt?: string;
  height?: number;
  mimeType?: string;
  sizeBytes?: number;
  src: string;
  width?: number;
}

export interface TextDiffContent {
  kind: "text";
  language?: string;
  newText?: string;
  oldText?: string;
}

export interface ImageDiffContent {
  kind: "image";
  newImage?: DiffAsset;
  oldImage?: DiffAsset;
}

export interface FileCardDiffContent {
  kind: "binary" | "oversizedText" | "lfsPointer" | "moved";
  message?: string;
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
