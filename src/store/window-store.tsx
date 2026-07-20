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
import type {
  UpdateInstallGateResponse,
  UpdateStatusEvent,
} from "@/lib/ipc/update-types";
import type { ConflictClearedEvent } from "@/lib/ipc/events";
import { RealtimeEventBridge } from "@/lib/realtime";

export interface RecentProject {
  displayName: string;
  lastOpenedAt?: string | null;
  missing?: boolean;
  path: string;
}

export type SettingsSection = "general" | "project" | "about";
export type RuntimeBootstrapState =
  | { status: "loading"; error: null }
  | { status: "ready"; error: null }
  | { status: "failed"; error: unknown };

export interface WindowStoreState {
  activeRepositoryPath: string | null;
  appSettings: AppSettings | null;
  appVersion: string | null;
  conflictsByRepository: Record<string, ConflictEnteredEvent>;
  fetchStatesByRepository: Record<string, FetchStateEvent>;
  onboarded: boolean;
  navigationLocked: boolean;
  operationsById: Record<string, OperationProgressEvent>;
  projectSettingsByRepository: Record<string, ProjectSettings>;
  recentProjects: RecentProject[];
  recentProjectsRefreshAttempt: number;
  recentProjectsRuntime: RuntimeBootstrapState;
  runtimeBootstrapAttempt: number;
  settingsRuntime: RuntimeBootstrapState;
  repoChangesByRepository: Record<string, RepoChangedEvent>;
  settingsModalOpen: boolean;
  settingsSection: SettingsSection;
  sidebarLayout: Required<SidebarLayoutSettings>;
  updateInstallGate: UpdateInstallGateResponse;
  updateInstallInProgress: boolean;
  updatePromptDismissedRequestId: string | null;
  updatePromptOpen: boolean;
  updateStatus: UpdateStatusEvent | null;
  windowLabel: string | null;
  windowRuntime: RuntimeBootstrapState;
}

export interface WindowStoreActions {
  clearRecentProjects: () => void;
  closeSettings: () => void;
  clearConflict: (repositoryPath: string) => void;
  openSettings: (section?: SettingsSection) => void;
  removeRecentProject: (path: string) => void;
  retryRuntimeBootstrap: () => void;
  retryRecentProjects: () => void;
  setActiveRepositoryPath: (repositoryPath: string | null) => void;
  setAppSettings: (appSettings: AppSettings | null) => void;
  setAppVersion: (appVersion: string | null) => void;
  setConflictEntered: (event: ConflictEnteredEvent) => void;
  setFetchState: (event: FetchStateEvent) => void;
  setOnboarded: (onboarded: boolean) => void;
  setNavigationLocked: (locked: boolean) => void;
  setOperationProgress: (event: OperationProgressEvent) => void;
  setProjectSettings: (
    repositoryPath: string,
    project: ProjectSettings,
  ) => void;
  setRecentProjects: (recentProjects: RecentProject[]) => void;
  setRecentProjectsRuntime: (state: RuntimeBootstrapState) => void;
  setRepoChanged: (event: RepoChangedEvent) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setSettingsRuntime: (state: RuntimeBootstrapState) => void;
  setSidebarLayout: (sidebarLayout: Partial<SidebarLayoutSettings>) => void;
  setUpdateInstallGate: (gate: UpdateInstallGateResponse) => void;
  setUpdateInstallInProgress: (inProgress: boolean) => void;
  setUpdatePromptDismissedRequestId: (requestId: string | null) => void;
  setUpdatePromptOpen: (open: boolean) => void;
  setUpdateStatus: (event: UpdateStatusEvent | null) => void;
  setWindowLabel: (windowLabel: string | null) => void;
  setWindowRuntime: (state: RuntimeBootstrapState) => void;
}

export type WindowStore = WindowStoreState & WindowStoreActions;
export type WindowStoreApi = StoreApi<WindowStore>;

const sidebarLayoutStorageKey = "artistic-git:sidebar-layout";
const defaultRecentProjectLimit = 20;
const maximumRecentProjectLimit = 200;

const initialWindowStoreState: WindowStoreState = {
  activeRepositoryPath: null,
  appSettings: null,
  appVersion: null,
  conflictsByRepository: {},
  fetchStatesByRepository: {},
  onboarded: true,
  navigationLocked: false,
  operationsById: {},
  projectSettingsByRepository: {},
  recentProjects: [],
  recentProjectsRefreshAttempt: 0,
  recentProjectsRuntime: { status: "loading", error: null },
  runtimeBootstrapAttempt: 0,
  settingsRuntime: { status: "loading", error: null },
  repoChangesByRepository: {},
  settingsModalOpen: false,
  settingsSection: "general",
  sidebarLayout: {
    branchSectionRatioPercent: 64,
    branchesCollapsed: false,
    stashesCollapsed: false,
    widthPx: 320,
  },
  updateInstallGate: {
    blocked: true,
    message: "no downloaded update is ready to install",
    reason: "noReadyUpdate",
  },
  updateInstallInProgress: false,
  updatePromptDismissedRequestId: null,
  updatePromptOpen: false,
  updateStatus: null,
  windowLabel: null,
  windowRuntime: { status: "loading", error: null },
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
    retryRuntimeBootstrap: () => {
      set((state) => ({
        runtimeBootstrapAttempt: state.runtimeBootstrapAttempt + 1,
        settingsRuntime: { status: "loading", error: null },
        windowRuntime: { status: "loading", error: null },
      }));
    },
    retryRecentProjects: () => {
      set((state) => ({
        recentProjectsRefreshAttempt: state.recentProjectsRefreshAttempt + 1,
        recentProjectsRuntime: { status: "loading", error: null },
      }));
    },
    setActiveRepositoryPath: (repositoryPath) => {
      set({ activeRepositoryPath: repositoryPath });
    },
    setAppSettings: (appSettings) => {
      set((state) => ({
        appSettings,
        recentProjects: limitRecentProjects(state.recentProjects, appSettings),
      }));
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
    setNavigationLocked: (navigationLocked) => {
      set({ navigationLocked });
    },
    setOperationProgress: (event) => {
      set((state) => {
        if (!isOperationProgressOwnedByWindow(event, state)) {
          return {};
        }

        const operationsById = { ...state.operationsById };
        if (
          event.progress.kind === "percent" &&
          event.progress.value !== null &&
          event.progress.value >= 100
        ) {
          delete operationsById[event.operationId];
        } else {
          operationsById[event.operationId] = event;
        }
        return { operationsById };
      });
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
      set((state) => ({
        recentProjects: limitRecentProjects(recentProjects, state.appSettings),
      }));
    },
    setRecentProjectsRuntime: (recentProjectsRuntime) => {
      set({ recentProjectsRuntime });
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
    setSettingsRuntime: (settingsRuntime) => {
      set({ settingsRuntime });
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
    setUpdateInstallGate: (gate) => {
      set({ updateInstallGate: gate });
    },
    setUpdateInstallInProgress: (inProgress) => {
      set({ updateInstallInProgress: inProgress });
    },
    setUpdatePromptDismissedRequestId: (requestId) => {
      set({ updatePromptDismissedRequestId: requestId });
    },
    setUpdatePromptOpen: (open) => {
      set({ updatePromptOpen: open });
    },
    setUpdateStatus: (event) => {
      set({ updateStatus: event });
    },
    setWindowLabel: (windowLabel) => {
      set({ windowLabel });
    },
    setWindowRuntime: (windowRuntime) => {
      set({ windowRuntime });
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
  const clearConflict = React.useCallback(
    (event: ConflictClearedEvent) => {
      storeApi.getState().clearConflict(event.repositoryPath);
    },
    [storeApi],
  );
  const setFetchState = React.useCallback(
    (event: FetchStateEvent) => {
      storeApi.getState().setFetchState(event);
    },
    [storeApi],
  );
  const setOperationProgress = React.useCallback(
    (event: OperationProgressEvent) => {
      storeApi.getState().setOperationProgress(event);
    },
    [storeApi],
  );
  const operationProgressFilter = React.useCallback(
    (event: OperationProgressEvent) =>
      isOperationProgressOwnedByWindow(event, storeApi.getState()),
    [storeApi],
  );

  return (
    <WindowStoreContext.Provider value={storeApi}>
      {enableRealtimeEvents ? (
        <RealtimeEventBridge
          onConflictCleared={clearConflict}
          onConflictEntered={setConflictEntered}
          onFetchState={setFetchState}
          onOperationProgress={setOperationProgress}
          operationProgressFilter={operationProgressFilter}
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

function isOperationProgressOwnedByWindow(
  event: OperationProgressEvent,
  state: Pick<WindowStoreState, "activeRepositoryPath" | "windowLabel">,
): boolean {
  if (
    state.activeRepositoryPath !== null &&
    event.repositoryPath !== state.activeRepositoryPath
  ) {
    return false;
  }

  if (
    state.windowLabel !== null &&
    event.windowLabel !== null &&
    event.windowLabel !== state.windowLabel
  ) {
    return false;
  }

  return true;
}

function createInitialWindowStoreState(
  initialState?: Partial<WindowStoreState>,
): WindowStoreState {
  const persistedSidebarLayout = readPersistedSidebarLayout();
  const appSettings =
    initialState?.appSettings ?? initialWindowStoreState.appSettings;

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
    recentProjects: limitRecentProjects(
      initialState?.recentProjects ?? initialWindowStoreState.recentProjects,
      appSettings,
    ),
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

// eslint-disable-next-line react-refresh/only-export-components
export function recentProjectLimit(appSettings: AppSettings | null): number {
  const configured = appSettings?.recentProjectLimit;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return defaultRecentProjectLimit;
  }

  return Math.min(
    maximumRecentProjectLimit,
    Math.max(1, Math.floor(configured)),
  );
}

function limitRecentProjects(
  recentProjects: RecentProject[],
  appSettings: AppSettings | null,
): RecentProject[] {
  return recentProjects.slice(0, recentProjectLimit(appSettings));
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
