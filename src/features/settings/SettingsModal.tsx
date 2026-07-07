import {
  Check,
  Clipboard,
  FolderCog,
  Info,
  KeyRound,
  Palette,
  Save,
  Settings2,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import type {
  AppSettings,
  GitUserSettings,
  GitignoreFileResponse,
  IdentitySourcesResponse,
  ProjectSettings,
  SshKeyStatus,
} from "@/lib/ipc/generated";
import {
  generateSshKey,
  loadGitignore,
  loadProjectSettings,
  saveAppSettings,
  saveGitignore,
  saveProjectSettings,
  settingsSnapshot,
} from "@/lib/ipc/commands";
import { cn } from "@/lib/utils";
import { useWindowStore, type SettingsSection } from "@/store/window-store";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useTheme } from "@/theme/ThemeProvider";

import {
  appLanguageToUiLanguage,
  appThemeToUiTheme,
  defaultLargeFileCheck,
  gitUserFromSettings,
  isValidEmail,
  normalizeAppSettings,
  normalizeProjectSettings,
  settingsWithLanguage,
  settingsWithTheme,
  validateGitUser,
  type GitUserValidation,
} from "./settings-model";

interface SettingsModalProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const sections: Array<{
  icon: React.ReactNode;
  key: SettingsSection;
  labelKey: string;
}> = [
  {
    icon: <Settings2 className="size-4" aria-hidden="true" />,
    key: "general",
    labelKey: "settings.sections.general",
  },
  {
    icon: <FolderCog className="size-4" aria-hidden="true" />,
    key: "project",
    labelKey: "settings.sections.project",
  },
  {
    icon: <Info className="size-4" aria-hidden="true" />,
    key: "about",
    labelKey: "settings.sections.about",
  },
];

export function SettingsModal({ onOpenChange, open }: SettingsModalProps) {
  const { t } = useTranslation();
  const { setLanguagePreference } = useLanguage();
  const { setThemePreference } = useTheme();
  const activeRepositoryPath = useWindowStore(
    (state) => state.activeRepositoryPath,
  );
  const appSettings = useWindowStore((state) => state.appSettings);
  const appVersion = useWindowStore((state) => state.appVersion);
  const section = useWindowStore((state) => state.settingsSection);
  const setSection = useWindowStore((state) => state.setSettingsSection);
  const setAppSettings = useWindowStore((state) => state.setAppSettings);
  const setAppVersion = useWindowStore((state) => state.setAppVersion);
  const setProjectSettings = useWindowStore(
    (state) => state.setProjectSettings,
  );
  const [draft, setDraft] = React.useState<AppSettings>(() =>
    normalizeAppSettings(appSettings),
  );
  const [identitySources, setIdentitySources] =
    React.useState<IdentitySourcesResponse | null>(null);
  const [sshKey, setSshKey] = React.useState<SshKeyStatus | null>(null);
  const [project, setProject] = React.useState<ProjectSettings | null>(null);
  const [gitignore, setGitignore] =
    React.useState<GitignoreFileResponse | null>(null);
  const [gitignoreDraft, setGitignoreDraft] = React.useState("");
  const [loading, setLoading] = React.useState(open);
  const [savingSettings, setSavingSettings] = React.useState(false);
  const [savingProject, setSavingProject] = React.useState(false);
  const [savingGitignore, setSavingGitignore] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [identityTouched, setIdentityTouched] = React.useState(false);
  const [identitySaveAttempted, setIdentitySaveAttempted] =
    React.useState(false);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        setLoading(true);
        setStatus(null);
      }
    });

    void settingsSnapshot()
      .then((snapshot) => {
        if (!active) {
          return;
        }
        const normalized = normalizeAppSettings(snapshot.settings);
        setDraft(normalized);
        setAppSettings(normalized);
        setAppVersion(snapshot.appVersion);
        setIdentitySources(snapshot.identitySources);
        setSshKey(snapshot.sshKey);
        setIdentityTouched(false);
        setIdentitySaveAttempted(false);
      })
      .catch((error) => {
        setDraft(normalizeAppSettings(appSettings));
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [appSettings, open, setAppSettings, setAppVersion]);

  React.useEffect(() => {
    if (!open || !activeRepositoryPath) {
      return;
    }

    let active = true;
    void Promise.all([
      loadProjectSettings({ repositoryPath: activeRepositoryPath }),
      loadGitignore({ repositoryPath: activeRepositoryPath }),
    ])
      .then(([loadedProject, loadedGitignore]) => {
        if (!active) {
          return;
        }
        setProject(loadedProject);
        setProjectSettings(activeRepositoryPath, loadedProject);
        setGitignore(loadedGitignore);
        setGitignoreDraft(loadedGitignore.content);
      })
      .catch((error) => {
        window.dispatchEvent(
          new CustomEvent("artistic-git:error", { detail: error }),
        );
      });

    return () => {
      active = false;
    };
  }, [activeRepositoryPath, open, setProjectSettings]);

  if (!open) {
    return null;
  }

  const visibleProject = open && activeRepositoryPath ? project : null;
  const visibleGitignore = open && activeRepositoryPath ? gitignore : null;
  const visibleGitignoreDraft =
    open && activeRepositoryPath ? gitignoreDraft : "";
  const normalizedProject = normalizeProjectSettings(visibleProject);
  const largeFileCheck =
    normalizedProject.largeFileCheck ?? defaultLargeFileCheck;
  const gitUser = gitUserFromSettings(draft);
  const email = gitUser.email ?? "";
  const identityValidation = validateGitUser(gitUser);
  const showIdentityValidation =
    identityTouched ||
    identitySaveAttempted ||
    Boolean(email.trim() && !isValidEmail(email));

  const updateDraftUser = (user: GitUserSettings) => {
    setIdentityTouched(true);
    setDraft((current) => ({
      ...normalizeAppSettings(current),
      git: {
        ...normalizeAppSettings(current).git,
        user,
      },
    }));
  };

  const persistSettings = async (
    nextSettings = draft,
    options: { validateIdentity?: boolean } = {},
  ) => {
    if (options.validateIdentity || identityTouched) {
      const validation = validateGitUser(gitUserFromSettings(nextSettings));
      if (!validation.valid) {
        setIdentitySaveAttempted(true);
        setStatus(
          t(validation.messageKey ?? "settings.general.identityRequired"),
        );
        return null;
      }
    }

    setSavingSettings(true);
    setStatus(null);
    try {
      const saved = await saveAppSettings({
        settings: normalizeAppSettings(nextSettings),
        openRepositoryPaths: activeRepositoryPath ? [activeRepositoryPath] : [],
        validateIdentity: options.validateIdentity,
      });
      const normalized = normalizeAppSettings(saved);
      setDraft(normalized);
      setAppSettings(normalized);
      if (options.validateIdentity) {
        setIdentityTouched(false);
        setIdentitySaveAttempted(false);
        setIdentitySources((current) =>
          current
            ? {
                ...current,
                settings: gitUserFromSettings(normalized),
              }
            : current,
        );
      }
      setStatus(t("settings.status.saved"));
      return normalized;
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
      return null;
    } finally {
      setSavingSettings(false);
    }
  };

  const persistLanguage = (value: "system" | "en" | "zh-CN") => {
    const next = settingsWithLanguage(draft, value);
    setDraft(next);
    setLanguagePreference(value);
    void persistSettings(next);
  };

  const persistTheme = (value: "system" | "light" | "dark") => {
    const next = settingsWithTheme(draft, value);
    setDraft(next);
    setThemePreference(value);
    void persistSettings(next);
  };

  const persistProject = async () => {
    if (!activeRepositoryPath) {
      return;
    }
    setSavingProject(true);
    setStatus(null);
    try {
      const saved = await saveProjectSettings({
        repositoryPath: activeRepositoryPath,
        largeFileCheck,
      });
      setProject(saved);
      setProjectSettings(activeRepositoryPath, saved);
      setStatus(t("settings.status.projectSaved"));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSavingProject(false);
    }
  };

  const persistGitignore = async () => {
    if (!activeRepositoryPath) {
      return;
    }
    setSavingGitignore(true);
    setStatus(null);
    try {
      const saved = await saveGitignore({
        repositoryPath: activeRepositoryPath,
        content: gitignoreDraft,
      });
      setGitignore(saved);
      setGitignoreDraft(saved.content);
      setStatus(t("settings.status.gitignoreSaved"));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSavingGitignore(false);
    }
  };

  const copyPublicKey = async () => {
    if (!sshKey?.publicKey) {
      return;
    }
    try {
      await navigator.clipboard.writeText(sshKey.publicKey);
      setStatus(t("settings.status.copied"));
    } catch {
      setStatus(t("settings.status.copyFailed"));
    }
  };

  const createSshKey = async () => {
    setStatus(null);
    try {
      const next = await generateSshKey({
        comment: gitUser.email ?? "artistic-git",
        passphrase: null,
      });
      setSshKey(next);
      setStatus(t("settings.status.sshGenerated"));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    }
  };

  return (
    <DialogFrame
      className="h-[min(760px,calc(100vh-48px))] max-w-5xl"
      description={t("settings.description")}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm text-muted-foreground">
            {loading ? t("settings.status.loading") : status}
          </div>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="secondary"
          >
            {t("actions.close")}
          </Button>
        </div>
      }
      onOpenChange={onOpenChange}
      title={t("settings.title")}
    >
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] gap-5 overflow-hidden">
        <nav
          aria-label={t("settings.navigation")}
          className="flex min-h-0 flex-col gap-1 border-r pr-4"
        >
          {sections.map((item) => (
            <button
              className={cn(
                "flex h-10 items-center gap-3 rounded-md px-3 text-left text-sm",
                section === item.key
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              key={item.key}
              onClick={() => setSection(item.key)}
              type="button"
            >
              {item.icon}
              <span className="truncate">{t(item.labelKey)}</span>
            </button>
          ))}
        </nav>

        <div className="min-h-0 overflow-auto pr-1">
          {section === "general" ? (
            <GeneralSettings
              draft={draft}
              gitUser={gitUser}
              identitySources={identitySources}
              identityValidation={identityValidation}
              onCopyPublicKey={copyPublicKey}
              onGenerateSshKey={createSshKey}
              onLanguageChange={persistLanguage}
              onSave={() =>
                void persistSettings(draft, { validateIdentity: true })
              }
              onThemeChange={persistTheme}
              onUpdateDraft={setDraft}
              onUpdateUser={updateDraftUser}
              saving={savingSettings}
              showIdentityValidation={showIdentityValidation}
              sshKey={sshKey}
            />
          ) : null}

          {section === "project" ? (
            <ProjectSettingsPanel
              activeRepositoryPath={activeRepositoryPath}
              gitignore={visibleGitignore}
              gitignoreDraft={visibleGitignoreDraft}
              largeFileCheck={largeFileCheck}
              onGitignoreChange={setGitignoreDraft}
              onLargeFileChange={(next) => {
                setProject((current) => ({
                  ...normalizeProjectSettings(current),
                  path: activeRepositoryPath ?? current?.path,
                  largeFileCheck: next,
                }));
              }}
              onSaveGitignore={() => void persistGitignore()}
              onSaveProject={() => void persistProject()}
              savingGitignore={savingGitignore}
              savingProject={savingProject}
            />
          ) : null}

          {section === "about" ? (
            <AboutSettings
              appVersion={appVersion ?? t("settings.about.unknown")}
            />
          ) : null}
        </div>
      </div>
    </DialogFrame>
  );
}

function GeneralSettings({
  draft,
  gitUser,
  identitySources,
  identityValidation,
  onCopyPublicKey,
  onGenerateSshKey,
  onLanguageChange,
  onSave,
  onThemeChange,
  onUpdateDraft,
  onUpdateUser,
  saving,
  showIdentityValidation,
  sshKey,
}: {
  draft: AppSettings;
  gitUser: GitUserSettings;
  identitySources: IdentitySourcesResponse | null;
  identityValidation: GitUserValidation;
  onCopyPublicKey: () => void;
  onGenerateSshKey: () => void;
  onLanguageChange: (value: "system" | "en" | "zh-CN") => void;
  onSave: () => void;
  onThemeChange: (value: "system" | "light" | "dark") => void;
  onUpdateDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
  onUpdateUser: (user: GitUserSettings) => void;
  saving: boolean;
  showIdentityValidation: boolean;
  sshKey: SshKeyStatus | null;
}) {
  const { t } = useTranslation();

  return (
    <section className="space-y-6">
      <SettingsGroup
        icon={<UserRound className="size-4" aria-hidden="true" />}
        title={t("settings.general.identity")}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            invalid={showIdentityValidation && identityValidation.nameMissing}
            label={t("settings.general.name")}
            onChange={(value) => onUpdateUser({ ...gitUser, name: value })}
            value={gitUser.name ?? ""}
          />
          <TextField
            invalid={
              showIdentityValidation &&
              (identityValidation.emailMissing ||
                identityValidation.emailInvalid)
            }
            label={t("settings.general.email")}
            onChange={(value) => onUpdateUser({ ...gitUser, email: value })}
            value={gitUser.email ?? ""}
          />
        </div>
        {showIdentityValidation && identityValidation.messageKey ? (
          <p className="text-sm text-destructive">
            {t(identityValidation.messageKey)}
          </p>
        ) : null}
        {identitySources?.globalGitconfigPath ? (
          <p className="text-sm text-muted-foreground">
            {t("settings.general.globalGitconfig", {
              path: identitySources.globalGitconfigPath,
            })}
          </p>
        ) : null}
        <div>
          <Button
            className="gap-2"
            disabled={saving}
            onClick={onSave}
            type="button"
          >
            <Save className="size-4" aria-hidden="true" />
            {t("settings.general.saveIdentity")}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        icon={<KeyRound className="size-4" aria-hidden="true" />}
        title={t("settings.general.ssh")}
      >
        <div className="rounded-md border bg-background p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {sshKey?.exists
                ? t("settings.general.sshDetected")
                : t("settings.general.sshMissing")}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {sshKey?.publicKeyPath ?? t("settings.general.noSshPath")}
            </span>
          </div>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
            {sshKey?.publicKey ?? t("settings.general.noPublicKey")}
          </pre>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="gap-2"
            disabled={!sshKey?.publicKey}
            onClick={onCopyPublicKey}
            type="button"
            variant="secondary"
          >
            <Clipboard className="size-4" aria-hidden="true" />
            {t("settings.general.copyPublicKey")}
          </Button>
          <Button
            className="gap-2"
            onClick={onGenerateSshKey}
            type="button"
            variant="secondary"
          >
            <KeyRound className="size-4" aria-hidden="true" />
            {t("settings.general.generateSshKey")}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        icon={<Palette className="size-4" aria-hidden="true" />}
        title={t("settings.general.appearance")}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label={t("language.label")}
            onChange={(value) =>
              onLanguageChange(value as "system" | "en" | "zh-CN")
            }
            options={[
              ["system", t("language.system")],
              ["en", t("language.en")],
              ["zh-CN", t("language.zhCN")],
            ]}
            value={appLanguageToUiLanguage(draft.language)}
          />
          <SelectField
            label={t("theme.label")}
            onChange={(value) =>
              onThemeChange(value as "system" | "light" | "dark")
            }
            options={[
              ["system", t("theme.system")],
              ["light", t("theme.light")],
              ["dark", t("theme.dark")],
            ]}
            value={appThemeToUiTheme(draft.appearance?.theme)}
          />
        </div>
        <ToggleRow
          checked={draft.privacy?.gravatarEnabled ?? false}
          label={t("settings.general.gravatar")}
          onChange={(checked) => {
            onUpdateDraft((current) => ({
              ...normalizeAppSettings(current),
              privacy: {
                ...normalizeAppSettings(current).privacy,
                gravatarEnabled: checked,
              },
            }));
          }}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.placeholders")}>
        <PlaceholderRow label={t("settings.general.credentialsPlaceholder")} />
        <PlaceholderRow label={t("settings.general.fetchPlaceholder")} />
        <PlaceholderRow label={t("settings.general.updatePlaceholder")} />
      </SettingsGroup>
    </section>
  );
}

function ProjectSettingsPanel({
  activeRepositoryPath,
  gitignore,
  gitignoreDraft,
  largeFileCheck,
  onGitignoreChange,
  onLargeFileChange,
  onSaveGitignore,
  onSaveProject,
  savingGitignore,
  savingProject,
}: {
  activeRepositoryPath: string | null;
  gitignore: GitignoreFileResponse | null;
  gitignoreDraft: string;
  largeFileCheck: Required<{ enabled: boolean; thresholdMb: number }>;
  onGitignoreChange: (value: string) => void;
  onLargeFileChange: (
    value: Required<{ enabled: boolean; thresholdMb: number }>,
  ) => void;
  onSaveGitignore: () => void;
  onSaveProject: () => void;
  savingGitignore: boolean;
  savingProject: boolean;
}) {
  const { t } = useTranslation();

  if (!activeRepositoryPath) {
    return (
      <section className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        {t("settings.project.noRepository")}
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <SettingsGroup title={t("settings.project.largeFiles")}>
        <ToggleRow
          checked={largeFileCheck.enabled}
          label={t("settings.project.largeFileCheck")}
          onChange={(checked) =>
            onLargeFileChange({ ...largeFileCheck, enabled: checked })
          }
        />
        <label className="grid gap-1 text-sm">
          <span className="font-medium">
            {t("settings.project.thresholdMb")}
          </span>
          <input
            className="h-9 w-32 rounded-md border bg-background px-3 text-sm"
            min={1}
            onChange={(event) =>
              onLargeFileChange({
                ...largeFileCheck,
                thresholdMb: Math.max(1, Number(event.target.value) || 1),
              })
            }
            type="number"
            value={largeFileCheck.thresholdMb}
          />
        </label>
        <Button
          className="gap-2"
          disabled={savingProject}
          onClick={onSaveProject}
          type="button"
        >
          <Save className="size-4" aria-hidden="true" />
          {t("settings.project.saveProject")}
        </Button>
      </SettingsGroup>

      <SettingsGroup title={t("settings.project.gitignore")}>
        <div className="text-sm text-muted-foreground">
          {gitignore?.path ?? t("settings.project.loadingGitignore")}
        </div>
        <textarea
          className="min-h-56 w-full resize-y rounded-md border bg-background p-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onGitignoreChange(event.target.value)}
          spellCheck={false}
          value={gitignoreDraft}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="gap-2"
            disabled={savingGitignore}
            onClick={onSaveGitignore}
            type="button"
          >
            <Save className="size-4" aria-hidden="true" />
            {t("settings.project.saveGitignore")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("settings.project.gitignoreLocalChange")}
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.project.remote")}>
        <PlaceholderRow label={t("settings.project.remotePlaceholder")} />
      </SettingsGroup>
    </section>
  );
}

function AboutSettings({ appVersion }: { appVersion: string }) {
  const { t } = useTranslation();

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md border bg-background">
          <Check className="size-5" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-base font-semibold">{t("app.name")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("settings.about.version", { version: appVersion })}
          </p>
        </div>
      </div>
    </section>
  );
}

function SettingsGroup({
  children,
  icon,
  title,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function TextField({
  invalid = false,
  label,
  onChange,
  value,
}: {
  invalid?: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        aria-invalid={invalid}
        className={cn(
          "h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
          invalid && "border-destructive focus-visible:ring-destructive",
        )}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function SelectField({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select
        className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>
            {labelText}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <span className="font-medium">{label}</span>
      <input
        checked={checked}
        className="size-4"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  );
}

function PlaceholderRow({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      {label}
    </div>
  );
}
