export type HistoryRefType = "branch" | "tag";
export type HistorySearchMatch = "message" | "author" | "content";

export interface HistoryCommitRef {
  name: string;
  type: HistoryRefType;
  current?: boolean;
}

export interface HistoryAuthor {
  name: string;
  email?: string;
}

export interface HistoryChangedFile {
  path: string;
  changeKind: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  oldPath?: string;
  preview?: string;
}

export interface HistoryCommit {
  id: string;
  shortId: string;
  parents: string[];
  message: string;
  body?: string;
  author: HistoryAuthor;
  authoredAt: string;
  refs: HistoryCommitRef[];
  changedFiles: HistoryChangedFile[];
  searchMatches?: HistorySearchMatch[];
}

export type GraphAnchor = "top" | "middle" | "bottom";
export type HistoryGraphSegmentKind = "vertical" | "parent" | "merge";

export interface HistoryGraphLane {
  target: string;
  color: string;
}

export interface HistoryGraphSegment {
  fromLane: number;
  toLane: number;
  fromY: GraphAnchor;
  toY: GraphAnchor;
  color: string;
  kind: HistoryGraphSegmentKind;
}

export interface HistoryGraphRow {
  commitId: string;
  node: {
    lane: number;
    color: string;
  };
  laneCount: number;
  lanesBefore: HistoryGraphLane[];
  lanesAfter: HistoryGraphLane[];
  segments: HistoryGraphSegment[];
}

export interface HistoryRow {
  commit: HistoryCommit;
  graph: HistoryGraphRow;
}

export interface HistoryBranch {
  name: string;
  current?: boolean;
}

export type BranchFilterMode = "auto" | "all" | "custom";
