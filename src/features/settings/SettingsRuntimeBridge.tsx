import * as React from "react";

import { useLanguage } from "@/i18n/LanguageProvider";
import { listenAppEvent } from "@/lib/ipc/events";
import type { AppSettings } from "@/lib/ipc/generated";
import { settingsSnapshot } from "@/lib/ipc/commands";
import { useWindowStore } from "@/store/window-store";
import { useTheme } from "@/theme/ThemeProvider";

import {
  appLanguageToUiLanguage,
  appThemeToUiTheme,
  normalizeAppSettings,
} from "./settings-model";

export function SettingsRuntimeBridge() {
  const { setLanguagePreference } = useLanguage();
  const { setThemePreference } = useTheme();
  const setAppSettings = useWindowStore((state) => state.setAppSettings);
  const setAppVersion = useWindowStore((state) => state.setAppVersion);
  const setOnboarded = useWindowStore((state) => state.setOnboarded);
  const setProjectSettings = useWindowStore(
    (state) => state.setProjectSettings,
  );

  const applySettings = React.useCallback(
    (settings: AppSettings) => {
      const normalized = normalizeAppSettings(settings);
      setAppSettings(normalized);
      setOnboarded(normalized.onboarding?.onboarded ?? false);
      setLanguagePreference(appLanguageToUiLanguage(normalized.language));
      setThemePreference(appThemeToUiTheme(normalized.appearance?.theme));
    },
    [setAppSettings, setLanguagePreference, setOnboarded, setThemePreference],
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
        applySettings(payload.settings);
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
  }, [applySettings, setProjectSettings]);

  return null;
}
