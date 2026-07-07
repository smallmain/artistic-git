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
    });
    store.getState().setRepoChanged({
      changedQueries: ["summary", "localChanges"],
      repositoryPath: "/repo/art",
    });

    expect(store.getState().fetchStatesByRepository["/repo/art"].state).toBe(
      "offline",
    );
    expect(store.getState().operationsById["op-1"].label).toBe("Fetching");
    expect(
      store.getState().repoChangesByRepository["/repo/art"].changedQueries,
    ).toEqual(["summary", "localChanges"]);
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
