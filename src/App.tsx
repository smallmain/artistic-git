import { FolderOpen, GitBranch, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { LanguagePreference } from "@/i18n/resources";
import { useTheme, type ThemePreference } from "@/theme/ThemeProvider";

export function App() {
  const { t } = useTranslation();
  const { languagePreference, setLanguagePreference } = useLanguage();
  const { setThemePreference, themePreference } = useTheme();

  return (
    <main className="min-h-screen overflow-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-8 py-10">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card">
              <GitBranch className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-normal">
                {t("app.name")}
              </h1>
              <p className="truncate text-sm text-muted-foreground">
                {t("app.tagline")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              aria-label={t("language.label")}
              className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                setLanguagePreference(event.target.value as LanguagePreference);
              }}
              value={languagePreference}
            >
              <option value="system">{t("language.system")}</option>
              <option value="en">{t("language.en")}</option>
              <option value="zh-CN">{t("language.zhCN")}</option>
            </select>
            <select
              aria-label={t("theme.label")}
              className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                setThemePreference(event.target.value as ThemePreference);
              }}
              value={themePreference}
            >
              <option value="system">{t("theme.system")}</option>
              <option value="light">{t("theme.light")}</option>
              <option value="dark">{t("theme.dark")}</option>
            </select>
            <IconButton
              label={t("actions.openSettings")}
              tooltip={t("actions.openSettings")}
              variant="ghost"
            >
              <Settings className="size-5" aria-hidden="true" />
            </IconButton>
          </div>
        </header>

        <section className="grid flex-1 items-center gap-6 py-12 md:grid-cols-[320px_1fr]">
          <div className="flex flex-col gap-3">
            <Button className="justify-start gap-2" size="lg">
              <FolderOpen className="size-5" aria-hidden="true" />
              {t("actions.openProject")}
            </Button>
            <Button
              className="justify-start gap-2"
              variant="secondary"
              size="lg"
            >
              <GitBranch className="size-5" aria-hidden="true" />
              {t("actions.cloneProject")}
            </Button>
          </div>

          <div className="rounded-lg border bg-card p-6 text-card-foreground">
            <h2 className="text-base font-medium">{t("app.recentProjects")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("app.recentProjectsEmpty")}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
