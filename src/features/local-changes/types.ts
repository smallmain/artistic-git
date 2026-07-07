import type {
  DiffPayload,
  LocalChangeSubmodule,
  LocalChangesRenormalizeSuggestion,
} from "@/lib/ipc/generated";

import type { DiffViewerContent } from "@/features/diff";

export type LocalChangesViewMode = "flat" | "tree";

export interface LocalChangeItem {
  diff?: DiffViewerContent;
  id: string;
  payload: DiffPayload;
  searchableText?: string;
  submodule?: LocalChangeSubmodule | null;
}

export interface LocalChangesPanelProps {
  busy?: boolean;
  changes: LocalChangeItem[];
  initialCheckedIds?: string[];
  onCheckedChange?: (checkedIds: string[]) => void;
  onCommit?: (checkedIds: string[]) => void;
  onOperationComplete?: () => void;
  onPreviewRenormalize?: () => void;
  onRestore?: (checkedIds: string[]) => void;
  onSelectedChange?: (change: LocalChangeItem | null) => void;
  onStash?: (checkedIds: string[]) => void;
  onViewModeChange?: (viewMode: LocalChangesViewMode) => void;
  renormalizePreviewBusy?: boolean;
  renormalizePreviewStatus?: string | null;
  renormalizeSuggestion?: LocalChangesRenormalizeSuggestion | null;
  repositoryPath?: string;
  selectedId?: string | null;
  storageKey?: string;
  viewMode?: LocalChangesViewMode;
}
