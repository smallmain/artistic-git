import type { DiffPayload } from "@/lib/ipc/generated";

import type { DiffViewerContent } from "@/features/diff";

export type LocalChangesViewMode = "flat" | "tree";

export interface LocalChangeItem {
  diff?: DiffViewerContent;
  id: string;
  payload: DiffPayload;
  searchableText?: string;
}

export interface LocalChangesPanelProps {
  busy?: boolean;
  changes: LocalChangeItem[];
  initialCheckedIds?: string[];
  onCheckedChange?: (checkedIds: string[]) => void;
  onCommit?: (checkedIds: string[]) => void;
  onOperationComplete?: () => void;
  onRestore?: (checkedIds: string[]) => void;
  onSelectedChange?: (change: LocalChangeItem | null) => void;
  onStash?: (checkedIds: string[]) => void;
  repositoryPath?: string;
  selectedId?: string | null;
  storageKey?: string;
}
