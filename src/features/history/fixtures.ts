import type { HistoryBranch, HistoryCommit } from "./types";
import { attachGraphRows } from "./history-data";

export const mockHistoryBranches: HistoryBranch[] = [
  { name: "main", current: true },
  { name: "feature/color-pipeline" },
  { name: "release/1.4" },
  { name: "asset-import" },
];

export const mockHistoryCommits: HistoryCommit[] = [
  {
    id: "8b43f0e6b3f0df17fba7f89fe9d846c2f8d92101",
    shortId: "8b43f0e",
    parents: ["71cfb9a", "49ec0cc"],
    message: "Merge color pipeline preview",
    body: "Connects the history preview to the asset color audit flow.",
    author: { name: "Mira Chen", email: "mira@example.test" },
    authoredAt: "2026-07-07T05:12:00Z",
    refs: [{ name: "main", type: "branch", current: true }],
    changedFiles: [
      {
        path: "src/features/history/HistoryWorkbench.tsx",
        changeKind: "modified",
        additions: 126,
        deletions: 18,
        preview: "history graph virtual rows",
      },
    ],
  },
  {
    id: "71cfb9ad5d7027f02174f1cc9f3056c650c2f625",
    shortId: "71cfb9a",
    parents: ["d4512aa"],
    message: "Add lightweight graph viewport",
    author: { name: "Jon Park", email: "jon@example.test" },
    authoredAt: "2026-07-07T03:48:00Z",
    refs: [{ name: "feature/color-pipeline", type: "branch" }],
    changedFiles: [
      {
        path: "src/features/history/useVirtualWindow.ts",
        changeKind: "added",
        additions: 79,
        deletions: 0,
        preview: "overscan range scrollTop rowHeight",
      },
    ],
  },
  {
    id: "49ec0cc8f1e59bf0d772efc1a530ddae13f347d4",
    shortId: "49ec0cc",
    parents: ["c5bca25"],
    message: "Tag release candidate assets",
    author: { name: "Avery Stone", email: "avery@example.test" },
    authoredAt: "2026-07-06T22:04:00Z",
    refs: [
      { name: "release/1.4", type: "branch" },
      { name: "v1.4.0-rc.1", type: "tag" },
    ],
    changedFiles: [
      {
        path: "assets/characters/hero.palette.json",
        changeKind: "modified",
        additions: 18,
        deletions: 4,
        preview: "primaryColor highlightColor",
      },
    ],
  },
  {
    id: "d4512aa7e8fb9ec3f93a545cb658f7de71f18291",
    shortId: "d4512aa",
    parents: ["c5bca25"],
    message: "Refine branch filter interactions",
    author: { name: "Mira Chen", email: "mira@example.test" },
    authoredAt: "2026-07-06T18:23:00Z",
    refs: [],
    changedFiles: [
      {
        path: "src/features/history/BranchFilter.tsx",
        changeKind: "added",
        additions: 142,
        deletions: 0,
        preview: "auto all selected branches",
      },
    ],
  },
  {
    id: "c5bca253536fcf2ff0f54136ebc72770644a1b69",
    shortId: "c5bca25",
    parents: ["6df1253"],
    message: "Import texture rename batch",
    author: { name: "Noah Kim", email: "noah@example.test" },
    authoredAt: "2026-07-05T16:42:00Z",
    refs: [{ name: "asset-import", type: "branch" }],
    changedFiles: [
      {
        path: "assets/environments/city/albedo.png",
        oldPath: "assets/env/city/albedo.png",
        changeKind: "renamed",
        additions: 0,
        deletions: 0,
        preview: "binary image rename",
      },
    ],
  },
  {
    id: "6df1253ce8c682a9c9c64c5fa3917c1d86f6d27a",
    shortId: "6df1253",
    parents: [],
    message: "Initialize project history fixtures",
    author: { name: "Lena Ortiz", email: "lena@example.test" },
    authoredAt: "2026-07-04T11:18:00Z",
    refs: [{ name: "v1.3.0", type: "tag" }],
    changedFiles: [
      {
        path: "TASKS.md",
        changeKind: "modified",
        additions: 34,
        deletions: 2,
        preview: "Phase 2C history graph",
      },
    ],
  },
];

export const mockHistoryRows = attachGraphRows(mockHistoryCommits);
