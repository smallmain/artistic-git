import type { RepoChangedEvent, RepoQueryKind } from "@/lib/ipc/generated";

export type RepoQueryKey = readonly ["repository", string, RepoQueryKind];

export const repoQueryKeys = {
  branches: (repositoryPath: string) =>
    repoQueryKeys.kind(repositoryPath, "branches"),
  history: (repositoryPath: string) =>
    repoQueryKeys.kind(repositoryPath, "history"),
  kind: (repositoryPath: string, queryKind: RepoQueryKind): RepoQueryKey => [
    "repository",
    repositoryPath,
    queryKind,
  ],
  localChanges: (repositoryPath: string) =>
    repoQueryKeys.kind(repositoryPath, "localChanges"),
  stashes: (repositoryPath: string) =>
    repoQueryKeys.kind(repositoryPath, "stashes"),
  summary: (repositoryPath: string) =>
    repoQueryKeys.kind(repositoryPath, "summary"),
};

export function repoChangedQueryKeys(
  event: RepoChangedEvent,
): readonly RepoQueryKey[] {
  return event.changedQueries.map((queryKind) =>
    repoQueryKeys.kind(event.repositoryPath, queryKind),
  );
}
