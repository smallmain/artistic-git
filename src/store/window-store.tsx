import * as React from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  AppSettings,
  ConflictEnteredEvent,
  FetchStateEvent,
  OperationProgressEvent,
  ProjectSettings,
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

export type SettingsSection = "general" | "project" | "about";

export interface WindowStoreState {
  activeRepositoryPath: string | null;
  appSettings: AppSettings | null;
  appVersion: string | null;
  conflictsByRepository: Record<string, ConflictEnteredEvent>;
  fetchStatesByRepository: Record<string, FetchStateEvent>;
  onboarded: boolean;
  operationsById: Record<string, OperationProgressEvent>;
  projectSettingsByRepository: Record<string, ProjectSettings>;
  recentProjects: RecentProject[];
  repoChangesByRepository: Record<string, RepoChangedEvent>;
  settingsModalOpen: boolean;
  settingsSection: SettingsSection;
  sidebarLayout: Required<SidebarLayoutSettings>;
  windowLabel: string | null;
}

export interface WindowStoreActions {
  clearRecentProjects: () => void;
  closeSettings: () => void;
  clearConflict: (repositoryPath: string) => void;
  openSettings: (section?: SettingsSection) => void;
  removeRecentProject: (path: string) => void;
  setActiveRepositoryPath: (repositoryPath: string | null) => void;
  setAppSettings: (appSettings: AppSettings | null) => void;
  setAppVersion: (appVersion: string | null) => void;
  setConflictEntered: (event: ConflictEnteredEvent) => void;
  setFetchState: (event: FetchStateEvent) => void;
  setOnboarded: (onboarded: boolean) => void;
  setOperationProgress: (event: OperationProgressEvent) => void;
  setProjectSettings: (
    repositoryPath: string,
    project: ProjectSettings,
  ) => void;
  setRecentProjects: (recentProjects: RecentProject[]) => void;
  setRepoChanged: (event: RepoChangedEvent) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setSidebarLayout: (sidebarLayout: Partial<SidebarLayoutSettings>) => void;
  setWindowLabel: (windowLabel: string | null) => void;
}

export type WindowStore = WindowStoreState & WindowStoreActions;
export type WindowStoreApi = StoreApi<WindowStore>;

const sidebarLayoutStorageKey = "artistic-git:sidebar-layout";

const initialWindowStoreState: WindowStoreState = {
  activeRepositoryPath: null,
  appSettings: null,
  appVersion: null,
  conflictsByRepository: {},
  fetchStatesByRepository: {},
  onboarded: true,
  operationsById: {},
  projectSettingsByRepository: {},
  recentProjects: [],
  repoChangesByRepository: {},
  settingsModalOpen: false,
  settingsSection: "general",
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
    closeSettings: () => {
      set({ settingsModalOpen: false });
    },
    clearConflict: (repositoryPath) => {
      set((state) => {
        const conflictsByRepository = { ...state.conflictsByRepository };
        delete conflictsByRepository[repositoryPath];

        return { conflictsByRepository };
      });
    },
    openSettings: (section = "general") => {
      set({ settingsModalOpen: true, settingsSection: section });
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
    setAppSettings: (appSettings) => {
      set({ appSettings });
    },
    setAppVersion: (appVersion) => {
      set({ appVersion });
    },
    setConflictEntered: (event) => {
      set((state) => ({
        conflictsByRepository: {
          ...state.conflictsByRepository,
          [event.repositoryPath]: event,
        },
      }));
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
    setProjectSettings: (repositoryPath, project) => {
      set((state) => ({
        projectSettingsByRepository: {
          ...state.projectSettingsByRepository,
          [repositoryPath]: project,
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
    setSettingsSection: (section) => {
      set({ settingsSection: section });
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
  const setConflictEntered = React.useCallback(
    (event: ConflictEnteredEvent) => {
      storeApi.getState().setConflictEntered(event);
    },
    [storeApi],
  );
  const setFetchState = React.useCallback(
    (event: FetchStateEvent) => {
      storeApi.getState().setFetchState(event);
    },
    [storeApi],
  );

  return (
    <WindowStoreContext.Provider value={storeApi}>
      {enableRealtimeEvents ? (
        <RealtimeEventBridge
          onConflictEntered={setConflictEntered}
          onFetchState={setFetchState}
          onRepoChanged={setRepoChanged}
        />
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
    conflictsByRepository: {
      ...initialWindowStoreState.conflictsByRepository,
      ...initialState?.conflictsByRepository,
    },
    operationsById: {
      ...initialWindowStoreState.operationsById,
      ...initialState?.operationsById,
    },
    projectSettingsByRepository: {
      ...initialWindowStoreState.projectSettingsByRepository,
      ...initialState?.projectSettingsByRepository,
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
