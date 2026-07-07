import * as React from "react";

import type {
  FetchStateEvent,
  OperationProgressEvent,
} from "@/lib/ipc/generated";

export interface WindowStoreState {
  activeRepositoryPath: string | null;
  fetchStatesByRepository: Record<string, FetchStateEvent>;
  operationsById: Record<string, OperationProgressEvent>;
  windowLabel: string | null;
}

export type WindowStoreAction =
  | {
      type: "set-active-repository";
      repositoryPath: string | null;
    }
  | {
      type: "set-fetch-state";
      event: FetchStateEvent;
    }
  | {
      type: "set-operation-progress";
      event: OperationProgressEvent;
    }
  | {
      type: "set-window-label";
      windowLabel: string | null;
    };

const initialWindowStoreState: WindowStoreState = {
  activeRepositoryPath: null,
  fetchStatesByRepository: {},
  operationsById: {},
  windowLabel: null,
};

interface WindowStoreContextValue {
  dispatch: React.Dispatch<WindowStoreAction>;
  state: WindowStoreState;
}

const WindowStoreContext = React.createContext<WindowStoreContextValue | null>(
  null,
);

interface WindowStoreProviderProps {
  children: React.ReactNode;
  initialState?: Partial<WindowStoreState>;
}

export function WindowStoreProvider({
  children,
  initialState,
}: WindowStoreProviderProps) {
  const [state, dispatch] = React.useReducer(
    windowStoreReducer,
    initialState,
    createInitialWindowStoreState,
  );

  const value = React.useMemo<WindowStoreContextValue>(
    () => ({ dispatch, state }),
    [state],
  );

  return (
    <WindowStoreContext.Provider value={value}>
      {children}
    </WindowStoreContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWindowStore() {
  const context = React.useContext(WindowStoreContext);

  if (!context) {
    throw new Error("useWindowStore must be used within WindowStoreProvider.");
  }

  return context;
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
    operationsById: {
      ...initialWindowStoreState.operationsById,
      ...initialState?.operationsById,
    },
  };
}

function windowStoreReducer(
  state: WindowStoreState,
  action: WindowStoreAction,
): WindowStoreState {
  switch (action.type) {
    case "set-active-repository":
      return {
        ...state,
        activeRepositoryPath: action.repositoryPath,
      };
    case "set-fetch-state":
      return {
        ...state,
        fetchStatesByRepository: {
          ...state.fetchStatesByRepository,
          [action.event.repositoryPath]: action.event,
        },
      };
    case "set-operation-progress":
      return {
        ...state,
        operationsById: {
          ...state.operationsById,
          [action.event.operationId]: action.event,
        },
      };
    case "set-window-label":
      return {
        ...state,
        windowLabel: action.windowLabel,
      };
  }
}
