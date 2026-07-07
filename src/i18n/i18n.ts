import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import {
  defaultLanguage,
  languageFromLocale,
  resources,
  type SupportedLanguage,
  supportedLanguages,
} from "./resources";

export function resolveSystemLanguage(): SupportedLanguage {
  if (typeof navigator === "undefined") {
    return defaultLanguage;
  }

  return languageFromLocale(navigator.language);
}

export function createI18n(
  initialLanguage: SupportedLanguage = resolveSystemLanguage(),
): I18nInstance {
  const instance = i18next.createInstance();

  void instance.use(initReactI18next).init({
    fallbackLng: defaultLanguage,
    initAsync: false,
    interpolation: {
      escapeValue: false,
    },
    lng: initialLanguage,
    resources,
    supportedLngs: [...supportedLanguages],
  });

  return instance;
}

export const appI18n = createI18n();
