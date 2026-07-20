import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { I18nextProvider } from "react-i18next";
import { type i18n as I18nInstance } from "i18next";

import { ToastViewport } from "@/components/ui/toast-viewport";
import { appI18n } from "@/i18n/i18n";
import { SettingsRuntimeBridge } from "@/features/settings/SettingsRuntimeBridge";
import { UpdaterRuntimeBridge } from "@/features/updater/UpdaterRuntimeBridge";
import { LanguageProvider } from "@/i18n/LanguageProvider";
import type { LanguagePreference } from "@/i18n/resources";
import { createAppQueryClient } from "@/lib/query/client";
import {
  WindowStoreProvider,
  type WindowStoreApi,
  type WindowStoreState,
} from "@/store/window-store";
import { ThemeProvider, type ThemePreference } from "@/theme/ThemeProvider";

interface AppProvidersProps {
  children: React.ReactNode;
  i18n?: I18nInstance;
  initialLanguagePreference?: LanguagePreference;
  initialThemePreference?: ThemePreference;
  initialWindowState?: Partial<WindowStoreState>;
  queryClient?: QueryClient;
  windowStore?: WindowStoreApi;
}

export function AppProviders({
  children,
  i18n = appI18n,
  initialLanguagePreference,
  initialThemePreference,
  initialWindowState,
  queryClient,
  windowStore,
}: AppProvidersProps) {
  // Each mounted app root owns its client and UI store unless tests inject them.
  const [client] = React.useState(() => queryClient ?? createAppQueryClient());

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <LanguageProvider
          i18n={i18n}
          initialPreference={initialLanguagePreference}
        >
          <ThemeProvider initialPreference={initialThemePreference}>
            <WindowStoreProvider
              enableRealtimeEvents
              initialState={initialWindowState}
              store={windowStore}
            >
              <SettingsRuntimeBridge />
              <UpdaterRuntimeBridge />
              {children}
              <ToastViewport />
            </WindowStoreProvider>
          </ThemeProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
