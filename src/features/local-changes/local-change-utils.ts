import type { LocalChangeItem } from "./types";

export interface TreeNode {
  children: Map<string, TreeNode>;
  id: string;
  item?: LocalChangeItem;
  name: string;
  path: string;
}

export type CheckState = "checked" | "unchecked" | "mixed";

export function isDeferredLocalChange(
  change: LocalChangeItem | null,
): change is LocalChangeItem {
  return Boolean(
    change &&
    (change.payload.fileKind === "deferred" ||
      change.payload.metadata.previewDeferred === "true" ||
      change.diff?.kind === "deferred"),
  );
}

export function filterChanges(
  changes: LocalChangeItem[],
  searchTerm: string,
): LocalChangeItem[] {
  const normalizedSearch = normalizeSearch(searchTerm);

  if (!normalizedSearch) {
    return changes;
  }

  return changes.filter((change) =>
    [
      change.payload.newPath,
      change.payload.oldPath ?? "",
      change.submodule?.name ?? "",
      change.submodule?.path ?? "",
      change.searchableText ?? "",
    ]
      .join("\n")
      .toLowerCase()
      .includes(normalizedSearch),
  );
}

export function buildChangeTree(changes: LocalChangeItem[]): TreeNode {
  const root: TreeNode = {
    children: new Map(),
    id: "",
    name: "",
    path: "",
  };

  for (const change of changes) {
    const parts = change.payload.newPath.split("/").filter(Boolean);
    let node = root;

    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const existing = node.children.get(part);
      const next = existing ?? {
        children: new Map(),
        id: path,
        name: part,
        path,
      };

      node.children.set(part, next);
      node = next;
    });

    node.item = change;
    node.id = change.id;
  }

  return root;
}

export function collectTreeItemIds(node: TreeNode): string[] {
  if (node.item) {
    return [node.item.id];
  }

  return Array.from(node.children.values()).flatMap(collectTreeItemIds);
}

export function getCheckState(
  ids: string[],
  checkedIds: Set<string>,
): CheckState {
  if (ids.length === 0) {
    return "unchecked";
  }

  const checkedCount = ids.filter((id) => checkedIds.has(id)).length;

  if (checkedCount === 0) {
    return "unchecked";
  }

  return checkedCount === ids.length ? "checked" : "mixed";
}

export function formatChangePath(change: LocalChangeItem): string {
  const { oldPath, newPath } = change.payload;

  if (oldPath && oldPath !== newPath) {
    return `${oldPath} -> ${newPath}`;
  }

  return newPath;
}

export function formatChangeName(change: LocalChangeItem): string {
  const { oldPath, newPath } = change.payload;
  const newName = fileName(newPath);

  if (oldPath && oldPath !== newPath) {
    const oldName = fileName(oldPath);
    return oldName === newName ? newName : `${oldName} -> ${newName}`;
  }

  return newName;
}

export function parentPath(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/");
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function normalizeSearch(searchTerm: string): string {
  return searchTerm.trim().toLowerCase();
}
