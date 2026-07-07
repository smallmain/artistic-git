import * as React from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

const themePreferenceStorageKey = "artistic-git:theme-preference";

interface ThemeContextValue {
  resolvedTheme: ResolvedTheme;
  setThemePreference: (preference: ThemePreference) => void;
  themePreference: ThemePreference;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: React.ReactNode;
  initialPreference?: ThemePreference;
}

export function ThemeProvider({
  children,
  initialPreference,
}: ThemeProviderProps) {
  const [systemTheme, setSystemTheme] =
    React.useState<ResolvedTheme>(resolveSystemTheme);
  const [themePreference, setThemePreferenceState] =
    React.useState<ThemePreference>(
      () => initialPreference ?? readStoredThemePreference(),
    );

  const resolvedTheme =
    themePreference === "system" ? systemTheme : themePreference;

  React.useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      setSystemTheme(mediaQuery.matches ? "dark" : "light");
    };

    handleChange();
    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  React.useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const root = document.documentElement;
    root.classList.toggle("dark", resolvedTheme === "dark");
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setThemePreference = React.useCallback(
    (preference: ThemePreference) => {
      setThemePreferenceState(preference);
      writeStoredThemePreference(preference);
    },
    [],
  );

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      resolvedTheme,
      setThemePreference,
      themePreference,
    }),
    [resolvedTheme, setThemePreference, themePreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const context = React.useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }

  return context;
}

function resolveSystemTheme(): ResolvedTheme {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function isThemePreference(value: string): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  const storedPreference = window.localStorage.getItem(
    themePreferenceStorageKey,
  );

  return storedPreference && isThemePreference(storedPreference)
    ? storedPreference
    : "system";
}

function writeStoredThemePreference(preference: ThemePreference) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(themePreferenceStorageKey, preference);
}
