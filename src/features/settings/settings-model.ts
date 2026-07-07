import type {
  AppSettings,
  GitUserSettings,
  LanguagePreference as BackendLanguagePreference,
  LargeFileCheckSettings,
  ProjectSettings,
  ToolGitIdentity,
} from "@/lib/ipc/generated";
import type {
  LanguagePreference as UiLanguagePreference,
  SupportedLanguage,
} from "@/i18n/resources";
import type { ThemePreference } from "@/theme/ThemeProvider";

export const defaultAppSettings: AppSettings = {
  schemaVersion: 1,
  language: "system",
  appearance: { theme: "system" },
  git: {
    autoFetch: true,
    fetchIntervalSeconds: 60,
    user: { name: null, email: null },
    rememberSshPassphrase: false,
  },
  updates: { autoCheck: true },
  privacy: { gravatarEnabled: false },
  onboarding: { onboarded: false },
  window: {
    defaultGeometry: {
      width: 1280,
      height: 720,
      x: null,
      y: null,
      maximized: false,
    },
  },
  paths: { lastCloneParentDir: null },
  logging: { level: "info", retainDays: 30 },
  recentProjectLimit: 20,
};

export const defaultLargeFileCheck: Required<LargeFileCheckSettings> = {
  enabled: true,
  thresholdMb: 50,
};

export function normalizeAppSettings(
  settings?: AppSettings | null,
): AppSettings {
  return {
    ...defaultAppSettings,
    ...settings,
    appearance: {
      ...defaultAppSettings.appearance,
      ...settings?.appearance,
    },
    git: {
      ...defaultAppSettings.git,
      ...settings?.git,
      user: {
        ...defaultAppSettings.git?.user,
        ...settings?.git?.user,
      },
    },
    updates: {
      ...defaultAppSettings.updates,
      ...settings?.updates,
    },
    privacy: {
      ...defaultAppSettings.privacy,
      ...settings?.privacy,
    },
    onboarding: {
      ...defaultAppSettings.onboarding,
      ...settings?.onboarding,
    },
    window: {
      ...defaultAppSettings.window,
      ...settings?.window,
      defaultGeometry: {
        ...defaultAppSettings.window?.defaultGeometry,
        ...settings?.window?.defaultGeometry,
      },
    },
    paths: {
      ...defaultAppSettings.paths,
      ...settings?.paths,
    },
    logging: {
      ...defaultAppSettings.logging,
      ...settings?.logging,
    },
  };
}

export function normalizeProjectSettings(project?: ProjectSettings | null) {
  return {
    ...project,
    largeFileCheck: {
      ...defaultLargeFileCheck,
      ...project?.largeFileCheck,
    },
  };
}

export function appLanguageToUiLanguage(
  language?: BackendLanguagePreference,
): UiLanguagePreference {
  if (language === "zhCn") {
    return "zh-CN";
  }
  if (language === "enUs") {
    return "en";
  }
  return "system";
}

export function uiLanguageToAppLanguage(
  language: UiLanguagePreference,
): BackendLanguagePreference {
  if (language === "zh-CN") {
    return "zhCn";
  }
  if (language === "en") {
    return "enUs";
  }
  return "system";
}

export function appThemeToUiTheme(theme?: ThemePreference): ThemePreference {
  return theme === "light" || theme === "dark" ? theme : "system";
}

export function settingsWithLanguage(
  settings: AppSettings | null | undefined,
  language: UiLanguagePreference,
): AppSettings {
  const normalized = normalizeAppSettings(settings);
  return {
    ...normalized,
    language: uiLanguageToAppLanguage(language),
  };
}

export function settingsWithTheme(
  settings: AppSettings | null | undefined,
  theme: ThemePreference,
): AppSettings {
  const normalized = normalizeAppSettings(settings);
  return {
    ...normalized,
    appearance: {
      ...normalized.appearance,
      theme,
    },
  };
}

export function settingsWithGitUser(
  settings: AppSettings | null | undefined,
  user: GitUserSettings,
): AppSettings {
  const normalized = normalizeAppSettings(settings);
  return {
    ...normalized,
    git: {
      ...normalized.git,
      user: cleanGitUser(user),
    },
  };
}

export function settingsWithOnboarded(
  settings: AppSettings | null | undefined,
  onboarded: boolean,
): AppSettings {
  const normalized = normalizeAppSettings(settings);
  return {
    ...normalized,
    onboarding: {
      ...normalized.onboarding,
      onboarded,
    },
  };
}

export function gitUserFromSettings(
  settings: AppSettings | null | undefined,
): GitUserSettings {
  const user = normalizeAppSettings(settings).git?.user;
  return {
    name: user?.name ?? null,
    email: user?.email ?? null,
  };
}

export function cleanGitUser(user: GitUserSettings): GitUserSettings {
  return {
    name: cleanOptionalText(user.name),
    email: cleanOptionalText(user.email),
  };
}

export interface GitUserValidation {
  emailInvalid: boolean;
  emailMissing: boolean;
  messageKey: string | null;
  nameMissing: boolean;
  valid: boolean;
}

export function validateGitUser(user: GitUserSettings): GitUserValidation {
  const cleaned = cleanGitUser(user);
  const nameMissing = !cleaned.name;
  const emailMissing = !cleaned.email;
  const emailInvalid = Boolean(cleaned.email && !isValidEmail(cleaned.email));
  const messageKey =
    nameMissing && emailMissing
      ? "settings.general.identityRequired"
      : nameMissing
        ? "settings.general.nameRequired"
        : emailMissing
          ? "settings.general.emailRequired"
          : emailInvalid
            ? "settings.general.emailInvalid"
            : null;

  return {
    emailInvalid,
    emailMissing,
    messageKey,
    nameMissing,
    valid: !nameMissing && !emailMissing && !emailInvalid,
  };
}

export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  const parts = trimmed.split("@");
  return (
    parts.length === 2 &&
    parts[0].length > 0 &&
    parts[1].includes(".") &&
    !parts[1].endsWith(".")
  );
}

export function toolIdentityFromSettings(
  settings: AppSettings | null | undefined,
): ToolGitIdentity | null {
  const user = gitUserFromSettings(settings);
  const identity: ToolGitIdentity = {
    name: user.name ?? null,
    email: user.email ?? null,
  };

  return identity.name || identity.email ? identity : null;
}

export function languageLabelKey(language: UiLanguagePreference): string {
  return language === "zh-CN" ? "zhCN" : language;
}

export function supportedLanguageFromUi(
  language: UiLanguagePreference,
  fallback: SupportedLanguage,
): SupportedLanguage {
  return language === "system" ? fallback : language;
}

function cleanOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}
