import * as React from "react";

import { useLanguage } from "@/i18n/LanguageProvider";
import { listenAppEvent } from "@/lib/ipc/events";
import type { AppSettings } from "@/lib/ipc/generated";
import { saveAppSettings, settingsSnapshot } from "@/lib/ipc/commands";
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
  const activeRepositoryPathRef = React.useRef(activeRepositoryPath);
  const appSettingsRef = React.useRef(appSettings);

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

  React.useEffect(() => {
    let active = true;

    void settingsSnapshot()
      .then((snapshot) => {
        if (!active) {
          return;
        }
        setAppVersion(snapshot.appVersion);
        applySettings(snapshot.settings);
      })
      .catch(() => {
        // Browser-only tests and static previews do not have a Tauri runtime.
      });

    return () => {
      active = false;
    };
  }, [applySettings, setAppVersion]);

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
      }
    })
      .then((resolvedUnlisten) => {
        if (active) {
          unlisten = resolvedUnlisten;
        } else {
          resolvedUnlisten();
        }
      })
      .catch(() => {
        // No-op outside Tauri.
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [applyIdentityToActiveRepository, applySettings, setProjectSettings]);

  return null;
}
