import * as React from "react";
import { type i18n as I18nInstance } from "i18next";

import { appI18n, resolveSystemLanguage } from "./i18n";
import {
  isLanguagePreference,
  type LanguagePreference,
  type SupportedLanguage,
} from "./resources";

const languagePreferenceStorageKey = "artistic-git:language-preference";

interface LanguageContextValue {
  languagePreference: LanguagePreference;
  resolvedLanguage: SupportedLanguage;
  setLanguagePreference: (preference: LanguagePreference) => void;
}

const LanguageContext = React.createContext<LanguageContextValue | null>(null);

interface LanguageProviderProps {
  children: React.ReactNode;
  i18n?: I18nInstance;
  initialPreference?: LanguagePreference;
}

export function LanguageProvider({
  children,
  i18n = appI18n,
  initialPreference,
}: LanguageProviderProps) {
  const [systemLanguage, setSystemLanguage] = React.useState<SupportedLanguage>(
    resolveSystemLanguage,
  );
  const [languagePreference, setLanguagePreferenceState] =
    React.useState<LanguagePreference>(
      () => initialPreference ?? readStoredLanguagePreference(),
    );

  const resolvedLanguage =
    languagePreference === "system" ? systemLanguage : languagePreference;

  React.useEffect(() => {
    void i18n.changeLanguage(resolvedLanguage);
  }, [i18n, resolvedLanguage]);

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleLanguageChange = () => {
      setSystemLanguage(resolveSystemLanguage());
    };

    window.addEventListener("languagechange", handleLanguageChange);
    return () => {
      window.removeEventListener("languagechange", handleLanguageChange);
    };
  }, []);

  const setLanguagePreference = React.useCallback(
    (preference: LanguagePreference) => {
      setLanguagePreferenceState(preference);
      writeStoredLanguagePreference(preference);
    },
    [],
  );

  const value = React.useMemo<LanguageContextValue>(
    () => ({
      languagePreference,
      resolvedLanguage,
      setLanguagePreference,
    }),
    [languagePreference, resolvedLanguage, setLanguagePreference],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLanguage() {
  const context = React.useContext(LanguageContext);

  if (!context) {
    throw new Error("useLanguage must be used within LanguageProvider.");
  }

  return context;
}

function readStoredLanguagePreference(): LanguagePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  const storedPreference = window.localStorage.getItem(
    languagePreferenceStorageKey,
  );

  return storedPreference && isLanguagePreference(storedPreference)
    ? storedPreference
    : "system";
}

function writeStoredLanguagePreference(preference: LanguagePreference) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(languagePreferenceStorageKey, preference);
}
