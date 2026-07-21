import type { CommitChangedFile, CommitSummary } from "@/lib/ipc/generated";

import type {
  HistoryCommit,
  HistoryChangedFile,
  HistoryCommitRef,
  HistoryGraphLane,
  HistoryGraphRow,
  HistoryGraphSegment,
  HistoryRow,
  HistorySearchMatch,
} from "./types";

const palette = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#9333ea",
  "#ea580c",
  "#0891b2",
];
const maxVisibleGraphLanes = 6;

export function mapCommitSummaryToHistoryCommit(
  summary: CommitSummary,
  searchMatches: HistorySearchMatch[] = [],
): HistoryCommit {
  const authoredAtSeconds = Number.parseInt(summary.authoredAtUnixSeconds, 10);
  const authoredAt = Number.isFinite(authoredAtSeconds)
    ? new Date(authoredAtSeconds * 1000).toISOString()
    : new Date(0).toISOString();

  return {
    author: {
      email: summary.authorEmail || undefined,
      name: summary.authorName || "Unknown",
    },
    authoredAt,
    changedFiles: [],
    id: summary.oid,
    message: summary.subject || shortOid(summary.oid),
    parents: summary.parents,
    refs: parseCommitRefs(summary.refs),
    searchMatches: searchMatches.length > 0 ? searchMatches : undefined,
    shortId: shortOid(summary.oid),
  };
}

export function mapCommitChangedFile(
  file: CommitChangedFile,
): HistoryChangedFile {
  return {
    additions: file.additions,
    changeKind: file.changeKind,
    deletions: file.deletions,
    newMode: file.newMode ?? undefined,
    oldMode: file.oldMode ?? undefined,
    oldPath: file.oldPath ?? undefined,
    path: file.path,
  };
}

export function toCommitChangedFile(
  file: HistoryChangedFile,
): CommitChangedFile {
  return {
    additions: file.additions,
    changeKind: file.changeKind,
    deletions: file.deletions,
    newMode: file.newMode ?? null,
    oldMode: file.oldMode ?? null,
    oldPath: file.oldPath ?? null,
    path: file.path,
  };
}

export function attachGraphRows(commits: HistoryCommit[]): HistoryRow[] {
  return createHistoryGraphBuilder().append(commits);
}

export interface HistoryGraphBuilder {
  append: (commits: readonly HistoryCommit[]) => HistoryRow[];
}

export function createHistoryGraphBuilder(): HistoryGraphBuilder {
  const state: HistoryGraphLayoutState = {
    lanes: [],
    nextColor: 0,
  };

  return {
    append: (commits) => {
      const graphs = layoutRows(commits, state);
      return commits.map((commit, index) => ({
        commit,
        graph: graphs[index],
      }));
    },
  };
}

export function mergeHistoryCommits(commits: HistoryCommit[]): HistoryCommit[] {
  const byId = new Map<string, HistoryCommit>();

  for (const commit of commits) {
    const existing = byId.get(commit.id);
    if (!existing) {
      byId.set(commit.id, commit);
      continue;
    }

    const matches = new Set<HistorySearchMatch>(existing.searchMatches ?? []);
    for (const match of commit.searchMatches ?? []) {
      matches.add(match);
    }

    byId.set(commit.id, {
      ...existing,
      searchMatches: matches.size > 0 ? Array.from(matches) : undefined,
    });
  }

  return Array.from(byId.values());
}

export function parseCommitRefs(refs: string[]): HistoryCommitRef[] {
  return refs
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0 && ref !== "HEAD")
    .map((ref) => {
      if (ref.startsWith("HEAD -> ")) {
        return {
          current: true,
          name: normalizeLocalBranchRef(ref.slice("HEAD -> ".length)),
          type: "branch" as const,
        };
      }
      if (ref.startsWith("tag: ")) {
        return {
          name: ref.slice("tag: ".length),
          type: "tag" as const,
        };
      }
      const remoteName = parseRemoteBranchName(ref);
      if (remoteName !== null) {
        return {
          name: remoteName,
          remote: true,
          type: "branch" as const,
        };
      }
      return {
        name: normalizeLocalBranchRef(ref),
        type: "branch" as const,
      };
    });
}

function parseRemoteBranchName(ref: string): string | null {
  const candidates = [
    ref.startsWith("refs/remotes/origin/")
      ? ref.slice("refs/remotes/origin/".length)
      : null,
    ref.startsWith("origin/") ? ref.slice("origin/".length) : null,
  ];
  for (const name of candidates) {
    if (name && name !== "HEAD" && !name.startsWith("HEAD/")) {
      return name;
    }
  }
  return null;
}

function normalizeLocalBranchRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/**
 * Commits only reachable from the local tip or only from the remote tip of a
 * single branch. Shared history (already synced) is excluded.
 */
export function collectUnsyncedCommitIds(
  rows: readonly HistoryRow[],
  branchName: string,
): Set<string> {
  const rowsByCommitId = new Map<string, HistoryRow>();
  let localTip: HistoryRow | null = null;
  let remoteTip: HistoryRow | null = null;

  for (const row of rows) {
    rowsByCommitId.set(row.commit.id, row);
    rowsByCommitId.set(row.commit.shortId, row);
    for (const ref of row.commit.refs) {
      if (ref.type !== "branch" || ref.name !== branchName) {
        continue;
      }
      if (ref.remote) {
        remoteTip ??= row;
      } else {
        localTip ??= row;
      }
    }
  }

  if (localTip === null || remoteTip === null) {
    return new Set();
  }
  if (localTip.commit.id === remoteTip.commit.id) {
    return new Set();
  }

  const localReachable = collectReachableFromTip(rowsByCommitId, localTip);
  const remoteReachable = collectReachableFromTip(rowsByCommitId, remoteTip);
  const unsynced = new Set<string>();

  for (const commitId of localReachable) {
    if (!remoteReachable.has(commitId)) {
      unsynced.add(commitId);
    }
  }
  for (const commitId of remoteReachable) {
    if (!localReachable.has(commitId)) {
      unsynced.add(commitId);
    }
  }

  return unsynced;
}

function collectReachableFromTip(
  rowsByCommitId: ReadonlyMap<string, HistoryRow>,
  tip: HistoryRow,
): Set<string> {
  const reachable = new Set<string>();
  const pending: HistoryRow[] = [tip];

  while (pending.length > 0) {
    const row = pending.pop();
    if (!row || reachable.has(row.commit.id)) {
      continue;
    }
    reachable.add(row.commit.id);
    for (const parent of row.commit.parents) {
      const parentRow = rowsByCommitId.get(parent);
      if (parentRow) {
        pending.push(parentRow);
      }
    }
  }

  return reachable;
}

interface HistoryGraphLayoutState {
  lanes: HistoryGraphLane[];
  nextColor: number;
}

function layoutRows(
  commits: readonly HistoryCommit[],
  layoutState: HistoryGraphLayoutState,
): HistoryGraphRow[] {
  const state = layoutState.lanes;
  return commits.map((commit) => {
    const commitKey = graphKey(commit.id);
    let nodeLane = state.findIndex((lane) => lane.target === commitKey);
    if (nodeLane < 0) {
      const newLane = {
        color: palette[layoutState.nextColor % palette.length],
        target: commitKey,
      };
      layoutState.nextColor += 1;
      if (state.length < maxVisibleGraphLanes) {
        state.push(newLane);
        nodeLane = state.length - 1;
      } else {
        nodeLane = maxVisibleGraphLanes - 1;
        state[nodeLane] = newLane;
      }
    }

    const duplicateLanes = state
      .map((lane, index) => (lane.target === commitKey ? index : -1))
      .filter((index) => index >= 0 && index !== nodeLane);
    const lanesBefore = state.map((lane) => ({ ...lane }));
    const segments: HistoryGraphSegment[] = lanesBefore.map((lane, index) => ({
      color: lane.color,
      fromLane: index,
      fromY: "top",
      kind: "vertical",
      toLane: index,
      toY: "bottom",
    }));

    for (const duplicateLane of duplicateLanes) {
      segments.push({
        color: lanesBefore[duplicateLane].color,
        fromLane: duplicateLane,
        fromY: "top",
        kind: "merge",
        toLane: nodeLane,
        toY: "middle",
      });
    }

    for (const duplicateLane of [...duplicateLanes].reverse()) {
      state.splice(duplicateLane, 1);
    }
    nodeLane = state.findIndex((lane) => lane.target === commitKey);

    if (commit.parents.length === 0) {
      state.splice(nodeLane, 1);
    } else {
      state[nodeLane].target = graphKey(commit.parents[0]);
      const availableParentLanes = maxVisibleGraphLanes - state.length;
      for (const [index, parent] of commit.parents
        .slice(1, availableParentLanes + 1)
        .entries()) {
        const lane = nodeLane + index + 1;
        const color = palette[layoutState.nextColor % palette.length];
        layoutState.nextColor += 1;
        state.splice(lane, 0, { color, target: graphKey(parent) });
        segments.push({
          color,
          fromLane: nodeLane,
          fromY: "middle",
          kind: "parent",
          toLane: lane,
          toY: "bottom",
        });
      }
    }

    const lanesAfter = state.map((lane) => ({ ...lane }));
    return {
      commitId: commit.id,
      laneCount: Math.max(lanesBefore.length, lanesAfter.length, nodeLane + 1),
      lanesAfter,
      lanesBefore,
      node: {
        color: lanesBefore[nodeLane].color,
        lane: nodeLane,
      },
      segments,
    };
  });
}

function graphKey(oid: string): string {
  return shortOid(oid);
}

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}
