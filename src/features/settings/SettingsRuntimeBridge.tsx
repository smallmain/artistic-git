import * as React from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";

import { useLanguage } from "@/i18n/LanguageProvider";
import { listenAppEvent } from "@/lib/ipc/events";
import type { AppSettings } from "@/lib/ipc/generated";
import {
  listRecentProjects,
  saveAppSettings,
  settingsSnapshot,
} from "@/lib/ipc/commands";
import {
  reportDesktopRuntimeError,
  reportDesktopRuntimeErrorGroup,
} from "@/lib/runtime-errors";
import { useWindowStore } from "@/store/window-store";
import { useTheme } from "@/theme/ThemeProvider";

import {
  appLanguageToUiLanguage,
  appThemeToUiTheme,
  identityRepositoryPaths,
  normalizeAppSettings,
  sameGitUser,
} from "./settings-model";

export function SettingsRuntimeBridge() {
  const { t } = useTranslation();
  const { setLanguagePreference } = useLanguage();
  const { setThemePreference } = useTheme();
  const activeRepositoryPath = useWindowStore(
    (state) => state.activeRepositoryPath,
  );
  const appSettings = useWindowStore((state) => state.appSettings);
  const setAppSettings = useWindowStore((state) => state.setAppSettings);
  const setAppVersion = useWindowStore((state) => state.setAppVersion);
  const setOnboarded = useWindowStore((state) => state.setOnboarded);
  const setProjectSettings = useWindowStore(
    (state) => state.setProjectSettings,
  );
  const runtimeBootstrapAttempt = useWindowStore(
    (state) => state.runtimeBootstrapAttempt,
  );
  const setRecentProjects = useWindowStore((state) => state.setRecentProjects);
  const recentProjectsRefreshAttempt = useWindowStore(
    (state) => state.recentProjectsRefreshAttempt,
  );
  const setRecentProjectsRuntime = useWindowStore(
    (state) => state.setRecentProjectsRuntime,
  );
  const setSettingsRuntime = useWindowStore(
    (state) => state.setSettingsRuntime,
  );
  const activeRepositoryPathRef = React.useRef(activeRepositoryPath);
  const appSettingsRef = React.useRef(appSettings);
  const recentProjectsRequestRef = React.useRef(0);
  const translateRef = React.useRef(t);

  React.useEffect(() => {
    translateRef.current = t;
  }, [t]);

  React.useEffect(() => {
    activeRepositoryPathRef.current = activeRepositoryPath;
  }, [activeRepositoryPath]);

  React.useEffect(() => {
    appSettingsRef.current = appSettings;
  }, [appSettings]);

  const applySettings = React.useCallback(
    (settings: AppSettings) => {
      const normalized = normalizeAppSettings(settings);
      appSettingsRef.current = normalized;
      setAppSettings(normalized);
      setOnboarded(normalized.onboarding?.onboarded ?? false);
      setLanguagePreference(appLanguageToUiLanguage(normalized.language));
      setThemePreference(appThemeToUiTheme(normalized.appearance?.theme));
    },
    [setAppSettings, setLanguagePreference, setOnboarded, setThemePreference],
  );

  const applyIdentityToActiveRepository = React.useCallback(
    (settings: AppSettings) => {
      const openRepositoryPaths = identityRepositoryPaths([
        activeRepositoryPathRef.current,
      ]);
      if (openRepositoryPaths.length === 0) {
        return;
      }

      void saveAppSettings({
        settings: normalizeAppSettings(settings),
        openRepositoryPaths,
        validateIdentity: true,
      }).catch((error) => {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      });
    },
    [],
  );

  const refreshRecentProjects = React.useCallback(
    (settings = appSettingsRef.current) => {
      const requestId = recentProjectsRequestRef.current + 1;
      recentProjectsRequestRef.current = requestId;
      setRecentProjectsRuntime({ status: "loading", error: null });
      const limit = Math.min(
        200,
        Math.max(0, settings?.recentProjectLimit ?? 20),
      );
      void listRecentProjects({ limit })
        .then((projects) => {
          if (recentProjectsRequestRef.current === requestId) {
            setRecentProjects(projects);
            setRecentProjectsRuntime({ status: "ready", error: null });
          }
        })
        .catch((error) => {
          if (recentProjectsRequestRef.current === requestId) {
            setRecentProjectsRuntime({ status: "failed", error });
            reportDesktopRuntimeError(error);
          }
        });
    },
    [setRecentProjects, setRecentProjectsRuntime],
  );

  React.useEffect(
    () => () => {
      recentProjectsRequestRef.current += 1;
    },
    [],
  );

  React.useEffect(() => {
    if (appSettings) {
      refreshRecentProjects(appSettings);
    }
  }, [appSettings, recentProjectsRefreshAttempt, refreshRecentProjects]);

  React.useEffect(() => {
    let active = true;

    void settingsSnapshot()
      .then((snapshot) => {
        if (!active) {
          return;
        }
        setAppVersion(snapshot.appVersion);
        applySettings(snapshot.settings);
        setSettingsRuntime({ status: "ready", error: null });
        reportDesktopRuntimeErrorGroup(
          [snapshot.identitySourcesError, snapshot.sshKeyError],
          translateRef.current("settings.supplementalLoadFailed"),
        );
      })
      .catch((error) => {
        if (active) {
          if (isTauri()) {
            setSettingsRuntime({ status: "failed", error });
            reportDesktopRuntimeError(error);
          } else {
            applySettings(normalizeAppSettings(appSettingsRef.current));
            setRecentProjects([]);
            setRecentProjectsRuntime({ status: "ready", error: null });
            setSettingsRuntime({ status: "ready", error: null });
          }
        }
      });

    return () => {
      active = false;
    };
  }, [
    applySettings,
    runtimeBootstrapAttempt,
    setAppVersion,
    setRecentProjects,
    setRecentProjectsRuntime,
    setSettingsRuntime,
  ]);

  React.useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    void listenAppEvent("config-change", (event) => {
      const payload = event.payload;
      if (payload.type === "settingsUpdated") {
        const identityChanged = !sameGitUser(
          appSettingsRef.current,
          payload.settings,
        );
        applySettings(payload.settings);
        if (identityChanged) {
          applyIdentityToActiveRepository(payload.settings);
        }
      } else if (payload.type === "projectUpdated") {
        setProjectSettings(payload.projectKey, payload.project);
      } else if (payload.type === "recentProjectsChanged") {
        refreshRecentProjects();
      }
    })
      .then((resolvedUnlisten) => {
        if (active) {
          unlisten = resolvedUnlisten;
        } else {
          resolvedUnlisten();
        }
      })
      .catch((error) => {
        reportDesktopRuntimeError(error);
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [
    applyIdentityToActiveRepository,
    applySettings,
    refreshRecentProjects,
    setProjectSettings,
  ]);

  return null;
}
