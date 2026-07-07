import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FolderOpen,
  GitBranch,
  RotateCw,
  Settings,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { TruncatedText } from "@/components/ui/truncated-text";
import { useLocalizedFormatters } from "@/i18n/format";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { LanguagePreference } from "@/i18n/resources";
import { useTheme, type ThemePreference } from "@/theme/ThemeProvider";

const demoDate = "2026-07-07T04:30:00Z";
const demoNow = "2026-07-07T06:30:00Z";

export function App() {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const { languagePreference, setLanguagePreference } = useLanguage();
  const { setThemePreference, themePreference } = useTheme();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

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

        <section className="grid flex-1 items-start gap-6 py-12 md:grid-cols-[320px_1fr]">
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

            <Button
              className="justify-start gap-2"
              onClick={() => {
                setConfirmOpen(true);
              }}
              size="lg"
              variant="ghost"
            >
              <AlertTriangle className="size-5" aria-hidden="true" />
              {t("demo.confirmTrigger")}
            </Button>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <section className="rounded-lg border bg-card p-6 text-card-foreground">
              <h2 className="text-base font-medium">
                {t("app.recentProjects")}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("app.recentProjectsEmpty")}
              </p>
              <div className="mt-4 min-w-0 rounded-md border bg-background p-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("demo.copiedPath")}
                </p>
                <TruncatedText
                  className="text-sm"
                  normalizePath
                  text="C:\\Projects\\Art Pack\\Characters\\Hero\\Textures\\very-long-texture-name-v012-final-final.png"
                />
              </div>
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border bg-card p-5 text-card-foreground">
                <h2 className="text-base font-medium">
                  {t("demo.typographyTitle")}
                </h2>
                <dl className="mt-4 grid gap-3 text-sm">
                  <DemoMetric
                    label={t("demo.dateLabel")}
                    value={formatters.formatDate(demoDate)}
                  />
                  <DemoMetric
                    label={t("demo.relativeTimeLabel")}
                    value={formatters.formatRelativeTime(demoDate, demoNow)}
                  />
                  <DemoMetric
                    label={t("demo.numberLabel")}
                    value={formatters.formatNumber(12345.6, {
                      maximumFractionDigits: 1,
                    })}
                  />
                  <DemoMetric
                    label={t("demo.fileSizeLabel")}
                    value={formatters.formatFileSize(1_572_864)}
                  />
                </dl>
              </div>

              <div className="rounded-lg border bg-card p-5 text-card-foreground">
                <h2 className="text-base font-medium">
                  {t("demo.statusTitle")}
                </h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  <StatusToken
                    icon={<CheckCircle2 className="size-4" />}
                    label={t("demo.success")}
                    tone="success"
                  />
                  <StatusToken
                    icon={<AlertTriangle className="size-4" />}
                    label={t("demo.warning")}
                    tone="warning"
                  />
                  <StatusToken
                    icon={<AlertTriangle className="size-4" />}
                    label={t("demo.danger")}
                    tone="danger"
                  />
                  <StatusToken
                    icon={<RotateCw className="size-4" />}
                    label={t("demo.sync")}
                    tone="sync"
                  />
                  <StatusToken
                    icon={<ShieldCheck className="size-4" />}
                    label={t("demo.review")}
                    tone="review"
                  />
                </div>
              </div>
            </section>
          </div>
        </section>
      </div>

      <ConfirmDialog
        description={t("demo.confirmDescription")}
        onConfirm={() => {
          setConfirmOpen(false);
        }}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        title={t("demo.confirmTitle")}
        variant="danger"
      />
    </main>
  );
}

interface DemoMetricProps {
  label: string;
  value: string;
}

function DemoMetric({ label, value }: DemoMetricProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="flex items-center gap-2 text-muted-foreground">
        <Clock3 className="size-4" aria-hidden="true" />
        {label}
      </dt>
      <dd className="text-numeric text-right font-medium">{value}</dd>
    </div>
  );
}

interface StatusTokenProps {
  icon: React.ReactElement<React.SVGProps<SVGSVGElement>>;
  label: string;
  tone: "success" | "warning" | "danger" | "sync" | "review";
}

function StatusToken({ icon, label, tone }: StatusTokenProps) {
  const toneClassName = {
    danger: "bg-danger text-danger-foreground",
    review: "bg-review-gradient text-white",
    success: "bg-success text-success-foreground",
    sync: "bg-sync text-sync-foreground",
    warning: "bg-warning text-warning-foreground",
  }[tone];

  return (
    <span
      className={`${toneClassName} inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium`}
    >
      {React.cloneElement(icon, { "aria-hidden": true })}
      {label}
    </span>
  );
}
