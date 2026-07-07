import type { DiffPayload } from "@/lib/ipc/generated";

import type { LocalChangeItem } from "./types";

export const demoLocalChanges: LocalChangeItem[] = [
  {
    diff: {
      kind: "text",
      language: "ts",
      newText:
        "export function renderPreview() {\n  console.log('lighting pass ready');\n}\n",
      oldText:
        "export function renderPreview() {\n  console.log('draft pass');\n}\n",
    },
    id: "change-src-preview",
    payload: createPayload({
      changeKind: "modified",
      fileKind: "text",
      newPath: "src/preview/render-preview.ts",
    }),
    searchableText: "console lighting preview render",
  },
  {
    id: "change-material-bin",
    payload: createPayload({
      changeKind: "added",
      fileKind: "binary",
      metadata: { newBytes: "2048" },
      newPath: "assets/textures/material-roughness.bin",
    }),
    searchableText: "roughness metallic material texture",
  },
  {
    diff: { kind: "moved" },
    id: "change-rename-image",
    payload: createPayload({
      changeKind: "renamed",
      fileKind: "image",
      metadata: { contentChanged: "false" },
      newPath: "assets/environments/city/albedo.png",
      oldPath: "assets/env/city/albedo.png",
    }),
    searchableText: "city albedo image rename",
  },
  {
    id: "change-lfs-pointer",
    payload: createPayload({
      changeKind: "modified",
      fileKind: "lfsPointer",
      lfsLock: {
        locked: true,
        owner: "maya",
      },
      metadata: { oldBytes: "128", newBytes: "13107200" },
      newPath: "assets/characters/hero/sculpt.fbx",
    }),
    searchableText: "hero sculpt lfs locked",
  },
];

function createPayload(overrides: Partial<DiffPayload>): DiffPayload {
  return {
    changeKind: "modified",
    fileKind: "text",
    lfsLock: null,
    metadata: {},
    newPath: "file.txt",
    oldPath: null,
    ...overrides,
  };
}
