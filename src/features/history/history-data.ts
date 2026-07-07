import type { CommitSummary } from "@/lib/ipc/generated";

import type {
  HistoryCommit,
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

export function attachGraphRows(commits: HistoryCommit[]): HistoryRow[] {
  const rows = layoutRows(commits);
  return commits.map((commit, index) => ({
    commit,
    graph: rows[index],
  }));
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

function parseCommitRefs(refs: string[]): HistoryCommitRef[] {
  return refs
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0 && ref !== "HEAD")
    .map((ref) => {
      if (ref.startsWith("HEAD -> ")) {
        return {
          current: true,
          name: normalizeBranchRef(ref.slice("HEAD -> ".length)),
          type: "branch",
        };
      }
      if (ref.startsWith("tag: ")) {
        return {
          name: ref.slice("tag: ".length),
          type: "tag",
        };
      }
      return {
        name: normalizeBranchRef(ref),
        type: "branch",
      };
    });
}

function normalizeBranchRef(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "");
}

function layoutRows(commits: HistoryCommit[]): HistoryGraphRow[] {
  const state: HistoryGraphLane[] = [];
  let nextColor = 0;

  return commits.map((commit) => {
    const commitKey = graphKey(commit.id);
    let nodeLane = state.findIndex((lane) => lane.target === commitKey);
    if (nodeLane < 0) {
      state.push({
        color: palette[nextColor % palette.length],
        target: commitKey,
      });
      nextColor += 1;
      nodeLane = state.length - 1;
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
      for (const [index, parent] of commit.parents.slice(1).entries()) {
        const lane = nodeLane + index + 1;
        const color = palette[nextColor % palette.length];
        nextColor += 1;
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
