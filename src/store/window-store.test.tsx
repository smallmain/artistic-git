import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createWindowStore,
  useWindowStore,
  WindowStoreProvider,
} from "@/store/window-store";

describe("window store", () => {
  it("keeps each provider instance independent", () => {
    render(
      <div>
        <WindowStoreProvider>
          <WindowStoreProbe label="first" />
        </WindowStoreProvider>
        <WindowStoreProvider>
          <WindowStoreProbe label="second" />
        </WindowStoreProvider>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "set first" }));

    expect(screen.getByLabelText("first path")).toHaveTextContent(
      "/repo/first",
    );
    expect(screen.getByLabelText("second path")).toHaveTextContent("none");
  });

  it("stores operation and fetch events by stable keys", () => {
    const store = createWindowStore();

    store.getState().setFetchState({
      lastSuccessAt: null,
      message: "offline",
      repositoryPath: "/repo/art",
      state: "offline",
    });
    store.getState().setOperationProgress({
      cancellable: true,
      label: "Fetching",
      operationId: "op-1",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    });
    store.getState().setRepoChanged({
      changedQueries: ["summary", "localChanges"],
      repositoryPath: "/repo/art",
    });
    store.getState().setConflictEntered({
      files: [
        {
          fileKind: "text",
          path: "src/file.ts",
          status: "unresolved",
        },
      ],
      operationId: "op-conflict",
      operationName: "Rebase",
      repositoryPath: "/repo/art",
    });

    expect(store.getState().fetchStatesByRepository["/repo/art"].state).toBe(
      "offline",
    );
    expect(store.getState().operationsById["op-1"].label).toBe("Fetching");
    expect(
      store.getState().repoChangesByRepository["/repo/art"].changedQueries,
    ).toEqual(["summary", "localChanges"]);
    expect(
      store.getState().conflictsByRepository["/repo/art"].files[0].path,
    ).toBe("src/file.ts");

    store.getState().clearConflict("/repo/art");

    expect(store.getState().conflictsByRepository["/repo/art"]).toBeUndefined();
  });

  it("filters operation progress to the active repository and window", () => {
    const store = createWindowStore({
      activeRepositoryPath: "/repo/art",
      windowLabel: "repo-1",
    });

    store.getState().setOperationProgress({
      cancellable: false,
      label: "Other repository",
      operationId: "op-other-repo",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/other",
      windowLabel: "repo-1",
    });
    store.getState().setOperationProgress({
      cancellable: false,
      label: "Other window",
      operationId: "op-other-window",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-2",
    });
    store.getState().setOperationProgress({
      cancellable: false,
      label: "Own operation",
      operationId: "op-own",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    });

    expect(Object.keys(store.getState().operationsById)).toEqual(["op-own"]);
  });

  it("uses the current phase cancellability for substep progress", () => {
    const store = createWindowStore({
      activeRepositoryPath: "/repo/art",
      windowLabel: "repo-1",
    });

    store.getState().setOperationProgress({
      cancellable: true,
      label: "Syncing",
      operationId: "sync-1",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    });
    store.getState().setOperationProgress({
      cancellable: false,
      label: "Updating submodules",
      operationId: "sync-1",
      progress: { kind: "indeterminate" },
      repositoryPath: "/repo/art",
      windowLabel: "repo-1",
    });

    expect(store.getState().operationsById["sync-1"]).toMatchObject({
      cancellable: false,
      label: "Updating submodules",
    });
  });

  it("keeps recent projects within the configured display limit", () => {
    const projects = Array.from({ length: 8 }, (_, index) => ({
      displayName: `Project ${index}`,
      path: `/repo/project-${index}`,
    }));
    const store = createWindowStore({
      appSettings: { recentProjectLimit: 3 },
      recentProjects: projects,
    });

    expect(
      store.getState().recentProjects.map((project) => project.path),
    ).toEqual(["/repo/project-0", "/repo/project-1", "/repo/project-2"]);

    store.getState().setRecentProjects(projects.slice().reverse());
    expect(store.getState().recentProjects).toHaveLength(3);
    expect(store.getState().recentProjects[0].path).toBe("/repo/project-7");

    store.getState().setAppSettings({ recentProjectLimit: 2 });
    expect(store.getState().recentProjects).toHaveLength(2);
  });
});

function WindowStoreProbe({ label }: { label: string }) {
  const path = useWindowStore((state) => state.activeRepositoryPath);
  const setActiveRepositoryPath = useWindowStore(
    (state) => state.setActiveRepositoryPath,
  );

  return (
    <section>
      <output aria-label={`${label} path`}>{path ?? "none"}</output>
      <button
        onClick={() => {
          setActiveRepositoryPath(`/repo/${label}`);
        }}
        type="button"
      >
        set {label}
      </button>
    </section>
  );
}
