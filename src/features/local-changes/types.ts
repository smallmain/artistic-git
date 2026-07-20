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

export interface LocalChangeDetailState {
  change: LocalChangeItem | null;
  error: unknown;
  loading: boolean;
  selectedId: string;
}

export interface LocalChangesPanelProps {
  busy?: boolean;
  changes: LocalChangeItem[];
  error?: unknown;
  initialCheckedIds?: string[];
  loadDeferredDetails?: boolean;
  loading?: boolean;
  onCheckedChange?: (checkedIds: string[]) => void;
  onCommit?: (checkedIds: string[]) => void;
  onOperationComplete?: () => void;
  onPreviewRenormalize?: () => void;
  onRetry?: () => void;
  onRetryDetail?: () => void;
  onRestore?: (checkedIds: string[]) => void;
  onSelectedChange?: (change: LocalChangeItem | null) => void;
  onStash?: (checkedIds: string[]) => void;
  onViewModeChange?: (viewMode: LocalChangesViewMode) => void;
  renormalizePreviewBusy?: boolean;
  renormalizePreviewStatus?: string | null;
  renormalizeSuggestion?: LocalChangesRenormalizeSuggestion | null;
  detailState?: LocalChangeDetailState;
  repositoryPath?: string;
  selectedId?: string | null;
  storageKey?: string;
  viewMode?: LocalChangesViewMode;
}
