import type { HistoryCommit, HistorySearchMatch } from "./types";

export interface HistorySearchResult {
  commits: HistoryCommit[];
  query: string;
}

export type HistorySearchSource = (
  query: string,
  signal: AbortSignal,
) => Promise<HistorySearchResult>;

export function createMockHistorySearchSource(
  commits: HistoryCommit[],
  delayMs = 160,
): HistorySearchSource {
  return (query, signal) =>
    new Promise((resolve, reject) => {
      const trimmedQuery = query.trim();
      const timeout = window.setTimeout(() => {
        if (signal.aborted) {
          reject(createAbortError());
          return;
        }

        resolve({
          commits: searchCommits(commits, trimmedQuery),
          query: trimmedQuery,
        });
      }, delayMs);

      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timeout);
          reject(createAbortError());
        },
        { once: true },
      );
    });
}

export function searchCommits(
  commits: HistoryCommit[],
  query: string,
): HistoryCommit[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commits;
  }

  const byId = new Map<string, HistoryCommit>();

  for (const commit of commits) {
    const matches: HistorySearchMatch[] = [];
    const messageHit = [commit.message, commit.body ?? ""].some((value) =>
      value.toLowerCase().includes(normalizedQuery),
    );
    const authorHit = [commit.author.name, commit.author.email ?? ""].some(
      (value) => value.toLowerCase().includes(normalizedQuery),
    );
    const contentHit = commit.changedFiles.some((file) =>
      [file.path, file.oldPath ?? "", file.preview ?? ""].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
    );

    if (messageHit) {
      matches.push("message");
    }
    if (authorHit) {
      matches.push("author");
    }
    if (contentHit) {
      matches.push("content");
    }
    if (matches.length > 0) {
      byId.set(commit.id, { ...commit, searchMatches: matches });
    }
  }

  return commits
    .map((commit) => byId.get(commit.id))
    .filter((commit): commit is HistoryCommit => Boolean(commit));
}

function createAbortError(): DOMException {
  return new DOMException("History search was cancelled.", "AbortError");
}
