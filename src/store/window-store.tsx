import * as React from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  FetchStateEvent,
  OperationProgressEvent,
  RepoChangedEvent,
} from "@/lib/ipc/generated";
import { RealtimeEventBridge } from "@/lib/realtime";

export interface WindowStoreState {
  activeRepositoryPath: string | null;
  fetchStatesByRepository: Record<string, FetchStateEvent>;
  repoChangesByRepository: Record<string, RepoChangedEvent>;
  operationsById: Record<string, OperationProgressEvent>;
  windowLabel: string | null;
}

export interface WindowStoreActions {
  setActiveRepositoryPath: (repositoryPath: string | null) => void;
  setFetchState: (event: FetchStateEvent) => void;
  setOperationProgress: (event: OperationProgressEvent) => void;
  setRepoChanged: (event: RepoChangedEvent) => void;
  setWindowLabel: (windowLabel: string | null) => void;
}

export type WindowStore = WindowStoreState & WindowStoreActions;
export type WindowStoreApi = StoreApi<WindowStore>;

const initialWindowStoreState: WindowStoreState = {
  activeRepositoryPath: null,
  fetchStatesByRepository: {},
  repoChangesByRepository: {},
  operationsById: {},
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
    setOperationProgress: (event) => {
      set((state) => ({
        operationsById: {
          ...state.operationsById,
          [event.operationId]: event,
        },
      }));
    },
    setRepoChanged: (event) => {
      set((state) => ({
        repoChangesByRepository: {
          ...state.repoChangesByRepository,
          [event.repositoryPath]: event,
        },
      }));
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
  return {
    ...initialWindowStoreState,
    ...initialState,
    fetchStatesByRepository: {
      ...initialWindowStoreState.fetchStatesByRepository,
      ...initialState?.fetchStatesByRepository,
    },
    repoChangesByRepository: {
      ...initialWindowStoreState.repoChangesByRepository,
      ...initialState?.repoChangesByRepository,
    },
    operationsById: {
      ...initialWindowStoreState.operationsById,
      ...initialState?.operationsById,
    },
  };
}
