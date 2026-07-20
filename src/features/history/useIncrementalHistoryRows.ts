import * as React from "react";

import type { LogPageResponse } from "@/lib/ipc/generated";

import {
  createHistoryGraphBuilder,
  mapCommitSummaryToHistoryCommit,
} from "./history-data";
import type {
  BranchFilterMode,
  HistoryCommit,
  HistoryRow,
  HistorySearchMatch,
} from "./types";

export interface IncrementalHistoryRows {
  changedFrom: number;
  rows: HistoryRow[];
}

interface HistoryPageLike {
  commits: readonly HistoryCommit[];
}

interface HistoryRowsProjector<Page> {
  project: (pages: readonly Page[]) => IncrementalHistoryRows;
}

export function useIncrementalLogRows(
  pages: readonly LogPageResponse[] | undefined,
): IncrementalHistoryRows {
  const [projector] = React.useState(() =>
    createHistoryRowsProjector<LogPageResponse>((page) =>
      page.commits.map((commit) => mapCommitSummaryToHistoryCommit(commit)),
    ),
  );

  return React.useMemo(
    () => projector.project(pages ?? []),
    [pages, projector],
  );
}

export function useIncrementalSearchRows(
  pages: readonly HistoryPageLike[] | undefined,
): IncrementalHistoryRows {
  const [projector] = React.useState(() =>
    createHistoryRowsProjector<HistoryPageLike>((page) => page.commits),
  );

  return React.useMemo(
    () => projector.project(pages ?? []),
    [pages, projector],
  );
}

export function useIncrementalFilteredRows(
  source: IncrementalHistoryRows,
  branchMode: BranchFilterMode,
  selectedBranches: ReadonlySet<string>,
): HistoryRow[] {
  const [projector] = React.useState(createFilteredRowsProjector);
  const filterKey = React.useMemo(
    () =>
      `${branchMode}:${Array.from(selectedBranches).toSorted().join("\u0000")}`,
    [branchMode, selectedBranches],
  );

  return React.useMemo(
    () =>
      projector.project(source, filterKey, (row) => {
        if (branchMode === "all") {
          return true;
        }
        const branchNames = row.commit.refs
          .filter((ref) => ref.type === "branch")
          .map((ref) => ref.name);
        return branchMode === "auto"
          ? branchNames.length === 0 || branchNames.includes("main")
          : branchNames.some((branch) => selectedBranches.has(branch));
      }),
    [branchMode, filterKey, projector, selectedBranches, source],
  );
}

function createHistoryRowsProjector<Page>(
  commitsForPage: (page: Page) => readonly HistoryCommit[],
): HistoryRowsProjector<Page> {
  let cachedPages: readonly Page[] = [];
  let rows: HistoryRow[] = [];
  let rowIndexById = new Map<string, number>();
  let graphBuilder = createHistoryGraphBuilder();
  let snapshot: IncrementalHistoryRows = { changedFrom: 0, rows };

  return {
    project: (pages) => {
      const canAppend =
        cachedPages.length <= pages.length &&
        cachedPages.every((page, index) => pages[index] === page);

      if (!canAppend) {
        cachedPages = [];
        rows = [];
        rowIndexById = new Map();
        graphBuilder = createHistoryGraphBuilder();
        snapshot = { changedFrom: 0, rows };
      }

      if (cachedPages.length === pages.length) {
        return snapshot;
      }

      const changedFromInitial = rows.length;
      let changedFrom = changedFromInitial;
      const nextRows = rows;
      const nextRowIndexById = rowIndexById;

      for (const page of pages.slice(cachedPages.length)) {
        const additions: HistoryCommit[] = [];
        for (const commit of commitsForPage(page)) {
          const existingIndex = nextRowIndexById.get(commit.id);
          if (existingIndex === undefined) {
            nextRowIndexById.set(commit.id, nextRows.length + additions.length);
            additions.push(commit);
            continue;
          }

          const pendingIndex = existingIndex - nextRows.length;
          if (pendingIndex >= 0) {
            additions[pendingIndex] = mergeSearchMatches(
              additions[pendingIndex],
              commit,
            );
            continue;
          }

          const existingRow = nextRows[existingIndex];
          const mergedCommit = mergeSearchMatches(existingRow.commit, commit);
          if (mergedCommit !== existingRow.commit) {
            nextRows[existingIndex] = { ...existingRow, commit: mergedCommit };
            changedFrom = Math.min(changedFrom, existingIndex);
          }
        }

        nextRows.push(...graphBuilder.append(additions));
      }

      cachedPages = pages.slice();
      rows = nextRows;
      rowIndexById = nextRowIndexById;
      snapshot = { changedFrom, rows };
      return snapshot;
    },
  };
}

function createFilteredRowsProjector() {
  let filterKey = "";
  let sourceLength = 0;
  let visibleRows: HistoryRow[] = [];

  return {
    project: (
      source: IncrementalHistoryRows,
      nextFilterKey: string,
      matches: (row: HistoryRow) => boolean,
    ) => {
      const canAppend =
        filterKey === nextFilterKey && source.changedFrom === sourceLength;
      if (canAppend) {
        visibleRows.push(...source.rows.slice(sourceLength).filter(matches));
      } else {
        visibleRows = source.rows.filter(matches);
      }
      filterKey = nextFilterKey;
      sourceLength = source.rows.length;
      return visibleRows;
    },
  };
}

function mergeSearchMatches(
  existing: HistoryCommit,
  incoming: HistoryCommit,
): HistoryCommit {
  const matches = new Set<HistorySearchMatch>(existing.searchMatches ?? []);
  for (const match of incoming.searchMatches ?? []) {
    matches.add(match);
  }
  const mergedMatches = Array.from(matches);
  const currentMatches = existing.searchMatches ?? [];
  if (
    mergedMatches.length === currentMatches.length &&
    mergedMatches.every((match, index) => currentMatches[index] === match)
  ) {
    return existing;
  }

  return {
    ...existing,
    searchMatches: mergedMatches.length > 0 ? mergedMatches : undefined,
  };
}
