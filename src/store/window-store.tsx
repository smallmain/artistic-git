import * as React from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  FetchStateEvent,
  OperationProgressEvent,
  RepoChangedEvent,
  SidebarLayoutSettings,
} from "@/lib/ipc/generated";
import { RealtimeEventBridge } from "@/lib/realtime";

export interface RecentProject {
  displayName: string;
  lastOpenedAt?: string | null;
  missing?: boolean;
  path: string;
}

export interface WindowStoreState {
  activeRepositoryPath: string | null;
  fetchStatesByRepository: Record<string, FetchStateEvent>;
  onboarded: boolean;
  operationsById: Record<string, OperationProgressEvent>;
  recentProjects: RecentProject[];
  repoChangesByRepository: Record<string, RepoChangedEvent>;
  sidebarLayout: Required<SidebarLayoutSettings>;
  windowLabel: string | null;
}

export interface WindowStoreActions {
  clearRecentProjects: () => void;
  removeRecentProject: (path: string) => void;
  setActiveRepositoryPath: (repositoryPath: string | null) => void;
  setFetchState: (event: FetchStateEvent) => void;
  setOnboarded: (onboarded: boolean) => void;
  setOperationProgress: (event: OperationProgressEvent) => void;
  setRecentProjects: (recentProjects: RecentProject[]) => void;
  setRepoChanged: (event: RepoChangedEvent) => void;
  setSidebarLayout: (sidebarLayout: Partial<SidebarLayoutSettings>) => void;
  setWindowLabel: (windowLabel: string | null) => void;
}

export type WindowStore = WindowStoreState & WindowStoreActions;
export type WindowStoreApi = StoreApi<WindowStore>;

const sidebarLayoutStorageKey = "artistic-git:sidebar-layout";

const initialWindowStoreState: WindowStoreState = {
  activeRepositoryPath: null,
  fetchStatesByRepository: {},
  onboarded: true,
  operationsById: {},
  recentProjects: [],
  repoChangesByRepository: {},
  sidebarLayout: {
    branchSectionRatioPercent: 64,
    branchesCollapsed: false,
    stashesCollapsed: false,
    widthPx: 320,
  },
  windowLabel: null,
};

const WindowStoreContext = React.createContext<WindowStoreApi | null>(null);
const identityWindowStoreSelector = (state: WindowStore) => state;

interface WindowStoreProviderProps {
  children: React.ReactNode;
  enableRealtimeEvents?: boolean;
  initialState?: Partial<WindowStoreState>;
  store?: WindowStoreApi;
}

// eslint-disable-next-line react-refresh/only-export-components
export function createWindowStore(
  initialState?: Partial<WindowStoreState>,
): WindowStoreApi {
  const resolvedInitialState = createInitialWindowStoreState(initialState);

  return createStore<WindowStore>((set) => ({
    ...resolvedInitialState,
    clearRecentProjects: () => {
      set({ recentProjects: [] });
    },
    removeRecentProject: (path) => {
      set((state) => ({
        recentProjects: state.recentProjects.filter(
          (project) => project.path !== path,
        ),
      }));
    },
    setActiveRepositoryPath: (repositoryPath) => {
      set({ activeRepositoryPath: repositoryPath });
    },
    setFetchState: (event) => {
      set((state) => ({
        fetchStatesByRepository: {
          ...state.fetchStatesByRepository,
          [event.repositoryPath]: event,
        },
      }));
    },
    setOnboarded: (onboarded) => {
      set({ onboarded });
    },
    setOperationProgress: (event) => {
      set((state) => ({
        operationsById: {
          ...state.operationsById,
          [event.operationId]: event,
        },
      }));
    },
    setRecentProjects: (recentProjects) => {
      set({ recentProjects });
    },
    setRepoChanged: (event) => {
      set((state) => ({
        repoChangesByRepository: {
          ...state.repoChangesByRepository,
          [event.repositoryPath]: event,
        },
      }));
    },
    setSidebarLayout: (sidebarLayout) => {
      set((state) => {
        const nextSidebarLayout = {
          ...state.sidebarLayout,
          ...sidebarLayout,
        };

        persistSidebarLayout(nextSidebarLayout);

        return {
          sidebarLayout: nextSidebarLayout,
        };
      });
    },
    setWindowLabel: (windowLabel) => {
      set({ windowLabel });
    },
  }));
}

export function WindowStoreProvider({
  children,
  enableRealtimeEvents = false,
  initialState,
  store,
}: WindowStoreProviderProps) {
  const [storeApi] = React.useState(
    () => store ?? createWindowStore(initialState),
  );
  const setRepoChanged = React.useCallback(
    (event: RepoChangedEvent) => {
      storeApi.getState().setRepoChanged(event);
    },
    [storeApi],
  );

  return (
    <WindowStoreContext.Provider value={storeApi}>
      {enableRealtimeEvents ? (
        <RealtimeEventBridge onRepoChanged={setRepoChanged} />
      ) : null}
      {children}
    </WindowStoreContext.Provider>
  );
}

export function useWindowStore<T>(selector: (state: WindowStore) => T): T;
export function useWindowStore(): WindowStore;
// eslint-disable-next-line react-refresh/only-export-components
export function useWindowStore<T>(
  selector?: (state: WindowStore) => T,
): T | WindowStore {
  const store = useWindowStoreApi();
  const resolvedSelector = (selector ?? identityWindowStoreSelector) as (
    state: WindowStore,
  ) => T | WindowStore;

  return useStore(store, resolvedSelector);
}

function useWindowStoreApi(): WindowStoreApi {
  const store = React.useContext(WindowStoreContext);

  if (!store) {
    throw new Error("useWindowStore must be used within WindowStoreProvider.");
  }

  return store;
}

function createInitialWindowStoreState(
  initialState?: Partial<WindowStoreState>,
): WindowStoreState {
  const persistedSidebarLayout = readPersistedSidebarLayout();

  return {
    ...initialWindowStoreState,
    ...initialState,
    fetchStatesByRepository: {
      ...initialWindowStoreState.fetchStatesByRepository,
      ...initialState?.fetchStatesByRepository,
    },
    operationsById: {
      ...initialWindowStoreState.operationsById,
      ...initialState?.operationsById,
    },
    recentProjects: [
      ...(initialState?.recentProjects ??
        initialWindowStoreState.recentProjects),
    ],
    repoChangesByRepository: {
      ...initialWindowStoreState.repoChangesByRepository,
      ...initialState?.repoChangesByRepository,
    },
    sidebarLayout: {
      ...initialWindowStoreState.sidebarLayout,
      ...persistedSidebarLayout,
      ...initialState?.sidebarLayout,
    },
  };
}

function readPersistedSidebarLayout(): Partial<
  WindowStoreState["sidebarLayout"]
> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(sidebarLayoutStorageKey);

    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistSidebarLayout(
  sidebarLayout: WindowStoreState["sidebarLayout"],
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      sidebarLayoutStorageKey,
      JSON.stringify(sidebarLayout),
    );
  } catch {
    // Persistence is best-effort UI state.
  }
}
