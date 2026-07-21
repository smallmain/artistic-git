import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Cloud,
  Download,
  ExternalLink,
  FolderCog,
  GitBranch,
  Info,
  KeyRound,
  Loader2,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DialogFrame } from "@/components/dialogs/DialogFrame";
import { Button } from "@/components/ui/button";
import { BranchSelect } from "@/components/ui/branch-select";
import type {
  AppSettings,
  AutoTrackingRule,
  BranchSummary,
  GitUserSettings,
  GitignoreFileResponse,
  HttpsCredentialEntry,
  HttpsCredentialListResponse,
  IdentitySourcesResponse,
  ProjectSettings,
  RemoteSettingsResponse,
  SshKeyStatus,
} from "@/lib/ipc/generated";
import type {
  UpdateInstallGateResponse,
  UpdateStatusEvent,
} from "@/lib/ipc/update-types";
import {
  deleteHttpsCredential,
  generateSshKey,
  listHttpsCredentials,
  listBranches,
  loadGitignore,
  loadProjectSettings,
  loadRemoteSettings,
  openUpdateReleasePage,
  saveAppSettings,
  saveGitignore,
  saveHttpsCredential,
  saveProjectSettings,
  saveRemoteSettings,
  settingsSnapshot,
} from "@/lib/ipc/commands";
import { cn } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import { dispatchErrorGroup } from "@/lib/runtime-errors";
import { useWindowStore, type SettingsSection } from "@/store/window-store";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useTheme } from "@/theme/ThemeProvider";

import {
  appLanguageToUiLanguage,
  appThemeToUiTheme,
  defaultLargeFileCheck,
  gitUserFromSettings,
  identityRepositoryPaths,
  isValidEmail,
  normalizeAppSettings,
  normalizeProjectSettings,
  settingsWithFetchPreferences,
  settingsWithLanguage,
  settingsWithNetworkPreferences,
  settingsWithRememberSshPassphrase,
  settingsWithTheme,
  settingsWithUpdatePreferences,
  validateFetchIntervalSeconds,
  validateProxyUrl,
  type FetchIntervalValidation,
  validateGitUser,
  type GitUserValidation,
} from "./settings-model";

interface SettingsModalProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

interface HttpsCredentialDraft {
  editingKey: string | null;
  protocol: string;
  host: string;
  path: string;
  scope: HttpsCredentialEntry["scope"];
  username: string;
  token: string;
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
const maxAutoTrackingRules = 100;
const httpsCredentialPageSize = 50;

export function SettingsModal({ onOpenChange, open }: SettingsModalProps) {
  const { i18n, t } = useTranslation();
  const { setLanguagePreference } = useLanguage();
  const { setThemePreference } = useTheme();
  const activeRepositoryPath = useWindowStore(
    (state) => state.activeRepositoryPath,
  );
  const appSettings = useWindowStore((state) => state.appSettings);
  const appVersion = useWindowStore((state) => state.appVersion);
  const section = useWindowStore((state) => state.settingsSection);
  const updateInstallGate = useWindowStore((state) => state.updateInstallGate);
  const updateInstallInProgress = useWindowStore(
    (state) => state.updateInstallInProgress,
  );
  const updateStatus = useWindowStore((state) => state.updateStatus);
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
  const [remoteSettings, setRemoteSettings] =
    React.useState<RemoteSettingsResponse | null>(null);
  const [branchOptions, setBranchOptions] = React.useState<BranchSummary[]>([]);
  const [httpsCredentials, setHttpsCredentials] =
    React.useState<HttpsCredentialListResponse | null>(null);
  const [gitignoreDraft, setGitignoreDraft] = React.useState("");
  const [remoteUrlDraft, setRemoteUrlDraft] = React.useState("");
  const [loading, setLoading] = React.useState(open);
  const [settingsLoadReady, setSettingsLoadReady] = React.useState(false);
  const [settingsLoadFailure, setSettingsLoadFailure] =
    React.useState<unknown>(null);
  const [settingsLoadAttempt, setSettingsLoadAttempt] = React.useState(0);
  const [identitySourceFailure, setIdentitySourceFailure] =
    React.useState<unknown>(null);
  const [sshKeyFailure, setSshKeyFailure] = React.useState<unknown>(null);
  const [loadingProject, setLoadingProject] = React.useState(false);
  const [projectLoadResolvedPath, setProjectLoadResolvedPath] = React.useState<
    string | null
  >(null);
  const [projectLoadFailure, setProjectLoadFailure] = React.useState<{
    error: unknown;
    path: string;
  } | null>(null);
  const [gitignoreLoadFailure, setGitignoreLoadFailure] =
    React.useState<unknown>(null);
  const [remoteLoadFailure, setRemoteLoadFailure] =
    React.useState<unknown>(null);
  const [branchLoadFailure, setBranchLoadFailure] =
    React.useState<unknown>(null);
  const [loadingGitignore, setLoadingGitignore] = React.useState(false);
  const [loadingRemote, setLoadingRemote] = React.useState(false);
  const [loadingBranches, setLoadingBranches] = React.useState(false);
  const [projectLoadAttempt, setProjectLoadAttempt] = React.useState(0);
  const [gitignoreLoadAttempt, setGitignoreLoadAttempt] = React.useState(0);
  const [remoteLoadAttempt, setRemoteLoadAttempt] = React.useState(0);
  const [branchLoadAttempt, setBranchLoadAttempt] = React.useState(0);
  const [loadingCredentials, setLoadingCredentials] = React.useState(false);
  const [credentialLoadFailure, setCredentialLoadFailure] =
    React.useState<unknown>(null);
  const [credentialLoadAttempt, setCredentialLoadAttempt] = React.useState(0);
  const [savingSettings, setSavingSettings] = React.useState(false);
  const [savingProject, setSavingProject] = React.useState(false);
  const [savingGitignore, setSavingGitignore] = React.useState(false);
  const [savingRemote, setSavingRemote] = React.useState(false);
  const [savingCredential, setSavingCredential] = React.useState(false);
  const [generatingSshKey, setGeneratingSshKey] = React.useState(false);
  const [credentialDraft, setCredentialDraft] =
    React.useState<HttpsCredentialDraft | null>(null);
  const [deletingCredentialKey, setDeletingCredentialKey] = React.useState<
    string | null
  >(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [remoteRemoveArmed, setRemoteRemoveArmed] = React.useState(false);
  const [credentialRemoveArmed, setCredentialRemoveArmed] = React.useState<
    string | null
  >(null);
  const [identityTouched, setIdentityTouched] = React.useState(false);
  const [identitySaveAttempted, setIdentitySaveAttempted] =
    React.useState(false);
  const mutationInFlightRef = React.useRef(false);
  const manualUpdateCheckRef = React.useRef(false);
  const credentialLoadRequestKeyRef = React.useRef<string | null>(null);
  const projectLoadRequestKeyRef = React.useRef<string | null>(null);
  const gitignoreLoadRequestKeyRef = React.useRef<string | null>(null);
  const remoteLoadRequestKeyRef = React.useRef<string | null>(null);
  const branchLoadRequestKeyRef = React.useRef<string | null>(null);

  const showSettingsResult = React.useCallback((message: string) => {
    setStatus(null);
    showToast({ key: "settings-result", message, tone: "success" });
  }, []);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        setLoading(true);
        setSettingsLoadReady(false);
        setSettingsLoadFailure(null);
        setIdentitySourceFailure(null);
        setSshKeyFailure(null);
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
        setIdentitySourceFailure(snapshot.identitySourcesError);
        setSshKeyFailure(snapshot.sshKeyError);
        dispatchErrorGroup(
          [snapshot.identitySourcesError, snapshot.sshKeyError],
          i18n.t("settings.supplementalLoadFailed"),
        );
        setSettingsLoadReady(true);
        setIdentityTouched(false);
        setIdentitySaveAttempted(false);
      })
      .catch((error) => {
        if (active) {
          setSettingsLoadFailure(error);
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [i18n, open, setAppSettings, setAppVersion, settingsLoadAttempt]);

  React.useEffect(() => {
    if (!manualUpdateCheckRef.current) {
      return;
    }
    const updateState = updateStatus?.status.state;
    if (!updateState || updateState === "checking") {
      return;
    }
    manualUpdateCheckRef.current = false;
    if (updateState === "notAvailable") {
      showToast({
        key: "settings-update-result",
        message: t("settings.about.updateNotAvailable"),
        tone: "success",
      });
    }
  }, [t, updateStatus]);

  React.useEffect(() => {
    if (!open || !settingsLoadReady || section !== "general") {
      return;
    }

    const requestKey = String(credentialLoadAttempt);
    if (credentialLoadRequestKeyRef.current === requestKey) {
      return;
    }
    credentialLoadRequestKeyRef.current = requestKey;
    let active = true;
    let finished = false;
    void Promise.resolve().then(() => {
      if (active) {
        setLoadingCredentials(true);
        setCredentialLoadFailure(null);
      }
    });
    void listHttpsCredentials()
      .then((response) => {
        if (active) {
          setHttpsCredentials(response);
          setCredentialRemoveArmed(null);
          setCredentialDraft(null);
        }
      })
      .catch((error) => {
        if (active) {
          setCredentialLoadFailure(error);
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      })
      .finally(() => {
        finished = true;
        if (active) {
          setLoadingCredentials(false);
        }
      });

    return () => {
      active = false;
      if (!finished && credentialLoadRequestKeyRef.current === requestKey) {
        credentialLoadRequestKeyRef.current = null;
      }
    };
  }, [credentialLoadAttempt, open, section, settingsLoadReady]);

  React.useEffect(() => {
    if (
      !open ||
      !settingsLoadReady ||
      !activeRepositoryPath ||
      section !== "project"
    ) {
      return;
    }

    const requestKey = `${activeRepositoryPath}\0${projectLoadAttempt}`;
    if (projectLoadRequestKeyRef.current === requestKey) {
      return;
    }
    projectLoadRequestKeyRef.current = requestKey;
    let active = true;
    let finished = false;
    void Promise.resolve().then(() => {
      if (active) {
        setLoadingProject(true);
        setProjectLoadResolvedPath(null);
        setProjectLoadFailure(null);
        setProject(null);
      }
    });
    void loadProjectSettings({ repositoryPath: activeRepositoryPath })
      .then((loadedProject) => {
        if (active) {
          setProject(loadedProject);
          setProjectSettings(activeRepositoryPath, loadedProject);
          setProjectLoadResolvedPath(activeRepositoryPath);
        }
      })
      .catch((error) => {
        if (active) {
          setProjectLoadFailure({ error, path: activeRepositoryPath });
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      })
      .finally(() => {
        finished = true;
        if (active) {
          setLoadingProject(false);
        }
      });
    return () => {
      active = false;
      if (!finished && projectLoadRequestKeyRef.current === requestKey) {
        projectLoadRequestKeyRef.current = null;
      }
    };
  }, [
    activeRepositoryPath,
    open,
    projectLoadAttempt,
    section,
    setProjectSettings,
    settingsLoadReady,
  ]);

  React.useEffect(() => {
    if (
      !open ||
      !settingsLoadReady ||
      !activeRepositoryPath ||
      section !== "project"
    ) {
      return;
    }

    const requestKey = `${activeRepositoryPath}\0${gitignoreLoadAttempt}`;
    if (gitignoreLoadRequestKeyRef.current === requestKey) {
      return;
    }
    gitignoreLoadRequestKeyRef.current = requestKey;
    let active = true;
    let finished = false;
    void Promise.resolve().then(() => {
      if (active) {
        setLoadingGitignore(true);
        setGitignoreLoadFailure(null);
        setGitignore(null);
        setGitignoreDraft("");
      }
    });
    void loadGitignore({ repositoryPath: activeRepositoryPath })
      .then((loadedGitignore) => {
        if (active) {
          setGitignore(loadedGitignore);
          setGitignoreDraft(loadedGitignore.content);
        }
      })
      .catch((error) => {
        if (active) {
          setGitignoreLoadFailure(error);
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      })
      .finally(() => {
        finished = true;
        if (active) {
          setLoadingGitignore(false);
        }
      });

    return () => {
      active = false;
      if (!finished && gitignoreLoadRequestKeyRef.current === requestKey) {
        gitignoreLoadRequestKeyRef.current = null;
      }
    };
  }, [
    activeRepositoryPath,
    gitignoreLoadAttempt,
    open,
    section,
    settingsLoadReady,
  ]);

  React.useEffect(() => {
    if (
      !open ||
      !settingsLoadReady ||
      !activeRepositoryPath ||
      section !== "project"
    ) {
      return;
    }

    const requestKey = `${activeRepositoryPath}\0${remoteLoadAttempt}`;
    if (remoteLoadRequestKeyRef.current === requestKey) {
      return;
    }
    remoteLoadRequestKeyRef.current = requestKey;
    let active = true;
    let finished = false;
    void Promise.resolve().then(() => {
      if (active) {
        setLoadingRemote(true);
        setRemoteLoadFailure(null);
        setRemoteSettings(null);
        setRemoteUrlDraft("");
      }
    });
    void loadRemoteSettings({ repositoryPath: activeRepositoryPath })
      .then((loadedRemoteSettings) => {
        if (active) {
          setRemoteSettings(loadedRemoteSettings);
          setRemoteUrlDraft(loadedRemoteSettings.originUrl ?? "");
          setRemoteRemoveArmed(false);
        }
      })
      .catch((error) => {
        if (active) {
          setRemoteLoadFailure(error);
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      })
      .finally(() => {
        finished = true;
        if (active) {
          setLoadingRemote(false);
        }
      });

    return () => {
      active = false;
      if (!finished && remoteLoadRequestKeyRef.current === requestKey) {
        remoteLoadRequestKeyRef.current = null;
      }
    };
  }, [
    activeRepositoryPath,
    open,
    remoteLoadAttempt,
    section,
    settingsLoadReady,
  ]);

  React.useEffect(() => {
    if (
      !open ||
      !settingsLoadReady ||
      !activeRepositoryPath ||
      section !== "project"
    ) {
      return;
    }

    const requestKey = `${activeRepositoryPath}\0${branchLoadAttempt}`;
    if (branchLoadRequestKeyRef.current === requestKey) {
      return;
    }
    branchLoadRequestKeyRef.current = requestKey;
    let active = true;
    let finished = false;
    void Promise.resolve().then(() => {
      if (active) {
        setLoadingBranches(true);
        setBranchLoadFailure(null);
        setBranchOptions([]);
      }
    });
    void listBranches({ repositoryPath: activeRepositoryPath })
      .then((loadedBranches) => {
        if (active) {
          setBranchOptions(loadedBranches.branches);
        }
      })
      .catch((error) => {
        if (active) {
          setBranchLoadFailure(error);
          window.dispatchEvent(
            new CustomEvent("artistic-git:error", { detail: error }),
          );
        }
      })
      .finally(() => {
        finished = true;
        if (active) {
          setLoadingBranches(false);
        }
      });

    return () => {
      active = false;
      if (!finished && branchLoadRequestKeyRef.current === requestKey) {
        branchLoadRequestKeyRef.current = null;
      }
    };
  }, [
    activeRepositoryPath,
    branchLoadAttempt,
    open,
    section,
    settingsLoadReady,
  ]);

  if (!open) {
    return null;
  }

  const projectScopeReady =
    Boolean(activeRepositoryPath) &&
    projectLoadResolvedPath === activeRepositoryPath;
  const visibleProject = projectScopeReady ? project : null;
  const visibleGitignore = activeRepositoryPath ? gitignore : null;
  const visibleGitignoreDraft = activeRepositoryPath ? gitignoreDraft : "";
  const visibleRemoteSettings = activeRepositoryPath ? remoteSettings : null;
  const visibleRemoteUrlDraft = activeRepositoryPath ? remoteUrlDraft : "";
  const normalizedProject = normalizeProjectSettings(visibleProject);
  const largeFileCheck =
    normalizedProject.largeFileCheck ?? defaultLargeFileCheck;
  const gitUser = gitUserFromSettings(draft);
  const email = gitUser.email ?? "";
  const identityValidation = validateGitUser(gitUser);
  const fetchIntervalValidation = validateFetchIntervalSeconds(
    draft.git?.fetchIntervalSeconds,
  );
  const showIdentityValidation =
    identityTouched ||
    identitySaveAttempted ||
    Boolean(email.trim() && !isValidEmail(email));
  const mutationBusy =
    savingSettings ||
    savingProject ||
    savingGitignore ||
    savingRemote ||
    savingCredential ||
    generatingSshKey ||
    deletingCredentialKey !== null;
  const operationBusy =
    updateInstallInProgress ||
    loading ||
    (section === "general" && loadingCredentials) ||
    mutationBusy;

  const beginMutation = () => {
    if (mutationInFlightRef.current) {
      return false;
    }
    mutationInFlightRef.current = true;
    return true;
  };

  const endMutation = () => {
    mutationInFlightRef.current = false;
  };

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
        return null;
      }
    }
    const intervalValidation = validateFetchIntervalSeconds(
      nextSettings.git?.fetchIntervalSeconds,
    );
    if (!intervalValidation.valid) {
      return null;
    }
    if (!beginMutation()) {
      return null;
    }

    setSavingSettings(true);
    setStatus(null);
    try {
      const saved = await saveAppSettings({
        settings: normalizeAppSettings(nextSettings),
        openRepositoryPaths: identityRepositoryPaths([activeRepositoryPath]),
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
      showSettingsResult(i18n.t("settings.status.saved"));
      return normalized;
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
      return null;
    } finally {
      setSavingSettings(false);
      endMutation();
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
    if (!activeRepositoryPath || !beginMutation()) {
      return;
    }
    setSavingProject(true);
    setStatus(null);
    try {
      const saved = await saveProjectSettings({
        autoTrackingRules: normalizedProject.autoTrackingRules,
        largeFileCheck,
        localChangesViewMode: null,
        repositoryPath: activeRepositoryPath,
        sidebar: null,
      });
      setProject(saved);
      setProjectSettings(activeRepositoryPath, saved);
      showSettingsResult(t("settings.status.projectSaved"));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSavingProject(false);
      endMutation();
    }
  };

  const persistGitignore = async () => {
    if (!activeRepositoryPath || !beginMutation()) {
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
      showSettingsResult(t("settings.status.gitignoreSaved"));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSavingGitignore(false);
      endMutation();
    }
  };

  const persistRemote = async () => {
    if (!activeRepositoryPath) {
      return;
    }

    const trimmedUrl = remoteUrlDraft.trim();
    const hasExistingOrigin = Boolean(remoteSettings?.originUrl);
    if (!trimmedUrl && hasExistingOrigin && !remoteRemoveArmed) {
      setRemoteRemoveArmed(true);
      return;
    }
    if (!beginMutation()) {
      return;
    }

    setSavingRemote(true);
    setStatus(null);
    try {
      const saved = await saveRemoteSettings({
        repositoryPath: activeRepositoryPath,
        originUrl: trimmedUrl ? trimmedUrl : null,
        removeOrigin: hasExistingOrigin && !trimmedUrl && remoteRemoveArmed,
      });
      setRemoteSettings(saved);
      setRemoteUrlDraft(saved.originUrl ?? "");
      setRemoteRemoveArmed(false);
      showSettingsResult(
        saved.originUrl
          ? t("settings.status.remoteSaved")
          : t("settings.status.originRemoved"),
      );
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSavingRemote(false);
      endMutation();
    }
  };

  const copyRemoteUrl = async () => {
    const remoteUrl = remoteUrlDraft.trim() || remoteSettings?.originUrl;
    if (!remoteUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(remoteUrl);
      showSettingsResult(t("settings.status.copied"));
    } catch (error) {
      reportCopyFailure(error, "copyRemoteUrl");
    }
  };

  const copyPublicKey = async () => {
    if (!sshKey?.publicKey) {
      return;
    }
    try {
      await navigator.clipboard.writeText(sshKey.publicKey);
      showSettingsResult(t("settings.status.copied"));
    } catch (error) {
      reportCopyFailure(error, "copySshPublicKey");
    }
  };

  const reportCopyFailure = (error: unknown, operationName: string) => {
    const summary = t("settings.status.copyFailed");
    setStatus(null);
    showToast({ key: "settings-result", message: summary, tone: "error" });
    window.dispatchEvent(
      new CustomEvent("artistic-git:error", {
        detail: { cause: error, operationName, summary },
      }),
    );
  };

  const createSshKey = async () => {
    if (!beginMutation()) {
      return;
    }
    setGeneratingSshKey(true);
    setStatus(null);
    try {
      const next = await generateSshKey({
        comment: gitUser.email ?? "artistic-git",
        passphrase: null,
      });
      setSshKey(next);
      showSettingsResult(t("settings.status.sshGenerated"));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setGeneratingSshKey(false);
      endMutation();
    }
  };

  const persistRememberSshPassphrase = (rememberSshPassphrase: boolean) => {
    const next = settingsWithRememberSshPassphrase(
      draft,
      rememberSshPassphrase,
    );
    setDraft(next);
    void persistSettings(next);
  };

  const persistAutoUpdateCheck = (autoCheck: boolean) => {
    const next = settingsWithUpdatePreferences(draft, { autoCheck });
    setDraft(next);
    void persistSettings(next);
  };

  const persistGravatar = (gravatarEnabled: boolean) => {
    const normalized = normalizeAppSettings(draft);
    const next = {
      ...normalized,
      privacy: {
        ...normalized.privacy,
        gravatarEnabled,
      },
    };
    setDraft(next);
    void persistSettings(next);
  };

  const startNewHttpsCredential = () => {
    setCredentialRemoveArmed(null);
    setStatus(null);
    setCredentialDraft({
      editingKey: null,
      protocol: "https",
      host: "",
      path: "",
      scope: "host",
      username: "",
      token: "",
    });
  };

  const editHttpsCredential = (credential: HttpsCredentialEntry) => {
    setCredentialRemoveArmed(null);
    setStatus(null);
    setCredentialDraft({
      editingKey: httpsCredentialKey(credential),
      protocol: credential.protocol,
      host: credential.host,
      path: credential.path ?? "",
      scope: credential.scope,
      username: credential.username,
      token: "",
    });
  };

  const persistHttpsCredential = async () => {
    if (!credentialDraft) {
      return;
    }
    const host = credentialDraft.host.trim();
    const username = credentialDraft.username.trim();
    const path = credentialDraft.path.trim().replace(/^\/+|\/+$/g, "");
    if (!host || !username) {
      setStatus(t("settings.status.credentialFieldsRequired"));
      return;
    }
    if (!credentialDraft.editingKey && !credentialDraft.token) {
      setStatus(t("settings.status.credentialTokenRequired"));
      return;
    }
    if (credentialDraft.scope === "path" && !path) {
      setStatus(t("settings.status.credentialPathRequired"));
      return;
    }
    if (!beginMutation()) {
      return;
    }

    setSavingCredential(true);
    setStatus(null);
    try {
      await saveHttpsCredential({
        protocol: credentialDraft.protocol,
        host,
        path: credentialDraft.scope === "path" ? path : null,
        scope: credentialDraft.scope,
        username,
        token: credentialDraft.token || null,
      });
      const next = await listHttpsCredentials();
      setHttpsCredentials(next);
      setCredentialDraft(null);
      showSettingsResult(t("settings.status.credentialSaved"));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setSavingCredential(false);
      endMutation();
    }
  };

  const forgetHttpsCredential = async (credential: HttpsCredentialEntry) => {
    const key = httpsCredentialKey(credential);
    if (credentialRemoveArmed !== key) {
      setCredentialRemoveArmed(key);
      setStatus(t("settings.status.credentialRemoveArmed"));
      return;
    }
    if (!beginMutation()) {
      return;
    }

    setDeletingCredentialKey(key);
    setStatus(null);
    try {
      await deleteHttpsCredential({
        protocol: credential.protocol,
        host: credential.host,
        path: credential.path,
        scope: credential.scope,
      });
      const next = await listHttpsCredentials();
      setHttpsCredentials(next);
      setCredentialRemoveArmed(null);
      showSettingsResult(t("settings.status.credentialForgotten"));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("artistic-git:error", { detail: error }),
      );
    } finally {
      setDeletingCredentialKey(null);
      endMutation();
    }
  };

  return (
    <DialogFrame
      className="h-[min(760px,calc(100vh-48px))] max-w-5xl"
      closeOnEscape={!operationBusy}
      description={t("settings.description")}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm text-muted-foreground">{status}</div>
          <Button
            disabled={operationBusy}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="secondary"
          >
            {t("actions.close")}
          </Button>
        </div>
      }
      hideCloseButton={operationBusy}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !operationBusy) {
          onOpenChange(nextOpen);
        }
      }}
      title={t("settings.title")}
    >
      <div aria-busy={operationBusy} className="relative flex min-h-0 flex-1">
        <div
          className="grid min-h-0 min-w-0 flex-1 grid-cols-[220px_minmax(0,1fr)] gap-5 overflow-hidden"
          data-testid="settings-content"
          inert={operationBusy}
        >
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
                onClick={() => {
                  setStatus(null);
                  setRemoteRemoveArmed(false);
                  setCredentialRemoveArmed(null);
                  setSection(item.key);
                }}
                type="button"
              >
                {item.icon}
                <span className="truncate">{t(item.labelKey)}</span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 overflow-auto pr-1">
            {settingsLoadFailure ? (
              <div
                className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-md border border-destructive/40 bg-destructive/5 p-6 text-center"
                role="alert"
              >
                <AlertTriangle
                  className="size-6 text-destructive"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <h3 className="font-semibold">
                    {t("settings.loadFailedTitle")}
                  </h3>
                  <p className="max-w-lg text-sm text-muted-foreground">
                    {t("settings.loadFailedDescription")}
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent("artistic-git:error", {
                          detail: settingsLoadFailure,
                        }),
                      );
                    }}
                    type="button"
                    variant="ghost"
                  >
                    {t("settings.viewLoadErrorDetails")}
                  </Button>
                  <Button
                    onClick={() =>
                      setSettingsLoadAttempt((current) => current + 1)
                    }
                    type="button"
                    variant="secondary"
                  >
                    {t("settings.retryLoad")}
                  </Button>
                </div>
              </div>
            ) : null}

            {settingsLoadReady && section === "general" ? (
              <GeneralSettings
                draft={draft}
                fetchIntervalValidation={fetchIntervalValidation}
                gitUser={gitUser}
                identitySources={identitySources}
                identitySourceFailure={identitySourceFailure}
                identityValidation={identityValidation}
                onCopyPublicKey={copyPublicKey}
                onGenerateSshKey={createSshKey}
                onGravatarChange={persistGravatar}
                onLanguageChange={persistLanguage}
                onSave={() =>
                  void persistSettings(draft, { validateIdentity: true })
                }
                onSaveFetch={() => void persistSettings(draft)}
                onSaveNetwork={() => void persistSettings(draft)}
                onThemeChange={persistTheme}
                onUpdateDraft={setDraft}
                onUpdateUser={updateDraftUser}
                onRememberSshPassphraseChange={persistRememberSshPassphrase}
                onAutoUpdateCheckChange={persistAutoUpdateCheck}
                credentials={httpsCredentials?.credentials ?? []}
                credentialDraft={credentialDraft}
                credentialRemoveArmed={credentialRemoveArmed}
                credentialLoadFailure={credentialLoadFailure}
                deletingCredentialKey={deletingCredentialKey}
                onCancelCredentialEdit={() => {
                  setCredentialDraft(null);
                  setStatus(null);
                }}
                onEditCredential={editHttpsCredential}
                onForgetCredential={(credential) =>
                  void forgetHttpsCredential(credential)
                }
                onRetryCredentials={() =>
                  setCredentialLoadAttempt((current) => current + 1)
                }
                onRetrySupplementalSettings={() =>
                  setSettingsLoadAttempt((current) => current + 1)
                }
                onViewCredentialLoadError={() => {
                  if (credentialLoadFailure) {
                    window.dispatchEvent(
                      new CustomEvent("artistic-git:error", {
                        detail: credentialLoadFailure,
                      }),
                    );
                  }
                }}
                onNewCredential={startNewHttpsCredential}
                onSaveCredential={() => void persistHttpsCredential()}
                onUpdateCredentialDraft={setCredentialDraft}
                savingCredential={savingCredential}
                saving={savingSettings}
                showIdentityValidation={showIdentityValidation}
                sshKey={sshKey}
                sshKeyFailure={sshKeyFailure}
              />
            ) : null}

            {settingsLoadReady && section === "project" ? (
              <ProjectSettingsPanel
                activeRepositoryPath={activeRepositoryPath}
                gitignore={visibleGitignore}
                gitignoreDraft={visibleGitignoreDraft}
                largeFileCheck={largeFileCheck}
                autoTrackingRules={normalizedProject.autoTrackingRules}
                branchOptions={branchOptions}
                branchLoadFailure={branchLoadFailure}
                gitignoreLoadFailure={gitignoreLoadFailure}
                loadingBranches={loadingBranches}
                loadingGitignore={loadingGitignore}
                loadingProject={loadingProject}
                loadingRemote={loadingRemote}
                onAutoTrackingRulesChange={(autoTrackingRules) => {
                  setProject((current) => ({
                    ...normalizeProjectSettings(current),
                    path: activeRepositoryPath ?? current?.path,
                    autoTrackingRules,
                  }));
                }}
                onGitignoreChange={setGitignoreDraft}
                onLargeFileChange={(next) => {
                  setProject((current) => ({
                    ...normalizeProjectSettings(current),
                    path: activeRepositoryPath ?? current?.path,
                    largeFileCheck: next,
                  }));
                }}
                onRemoteChange={(value) => {
                  setRemoteUrlDraft(value);
                  setRemoteRemoveArmed(false);
                }}
                onRemoteCopy={() => void copyRemoteUrl()}
                onRetryBranches={() =>
                  setBranchLoadAttempt((current) => current + 1)
                }
                onRetryGitignore={() =>
                  setGitignoreLoadAttempt((current) => current + 1)
                }
                onRetryProject={() =>
                  setProjectLoadAttempt((current) => current + 1)
                }
                onRetryRemote={() =>
                  setRemoteLoadAttempt((current) => current + 1)
                }
                onSaveRemote={() => void persistRemote()}
                onSaveGitignore={() => void persistGitignore()}
                onSaveProject={() => void persistProject()}
                remoteRemoveArmed={remoteRemoveArmed}
                remoteLoadFailure={remoteLoadFailure}
                remoteSettings={visibleRemoteSettings}
                remoteUrlDraft={visibleRemoteUrlDraft}
                savingGitignore={savingGitignore}
                savingProject={savingProject}
                savingRemote={savingRemote}
                projectLoadFailure={projectLoadFailure?.error ?? null}
              />
            ) : null}

            {settingsLoadReady && section === "about" ? (
              <AboutSettings
                appVersion={appVersion ?? t("settings.about.unknown")}
                installGate={updateInstallGate}
                installing={updateInstallInProgress}
                onCheckUpdates={() => {
                  manualUpdateCheckRef.current = true;
                  window.dispatchEvent(
                    new CustomEvent("artistic-git:check-updates"),
                  );
                }}
                onOpenReleasePage={() => {
                  void openUpdateReleasePage().catch((error) => {
                    window.dispatchEvent(
                      new CustomEvent("artistic-git:error", {
                        detail: error,
                      }),
                    );
                  });
                }}
                onInstallUpdate={() =>
                  window.dispatchEvent(
                    new CustomEvent("artistic-git:install-update"),
                  )
                }
                updateStatus={updateStatus}
              />
            ) : null}
          </div>
        </div>
        {operationBusy ? (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-card/80 text-sm font-medium"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span>
              {updateInstallInProgress
                ? t("updaterPrompt.installing")
                : generatingSshKey
                  ? t("settings.status.generatingSshKey")
                  : deletingCredentialKey !== null
                    ? t("settings.status.deletingCredential")
                    : savingRemote
                      ? t("settings.status.savingRemote")
                      : savingGitignore
                        ? t("settings.status.savingGitignore")
                        : savingProject
                          ? t("settings.status.savingProject")
                          : savingCredential
                            ? t("settings.status.savingCredential")
                            : mutationBusy
                              ? t("settings.status.saving")
                              : t("settings.status.loading")}
            </span>
          </div>
        ) : null}
      </div>
    </DialogFrame>
  );
}

function GeneralSettings({
  credentialLoadFailure,
  credentialDraft,
  credentialRemoveArmed,
  credentials,
  deletingCredentialKey,
  draft,
  fetchIntervalValidation,
  gitUser,
  identitySources,
  identitySourceFailure,
  identityValidation,
  onCopyPublicKey,
  onCancelCredentialEdit,
  onEditCredential,
  onForgetCredential,
  onGenerateSshKey,
  onGravatarChange,
  onAutoUpdateCheckChange,
  onLanguageChange,
  onRememberSshPassphraseChange,
  onSave,
  onSaveCredential,
  onSaveNetwork,
  onSaveFetch,
  onThemeChange,
  onNewCredential,
  onRetryCredentials,
  onRetrySupplementalSettings,
  onUpdateDraft,
  onUpdateCredentialDraft,
  onUpdateUser,
  onViewCredentialLoadError,
  savingCredential,
  saving,
  showIdentityValidation,
  sshKey,
  sshKeyFailure,
}: {
  credentialLoadFailure: unknown;
  credentialDraft: HttpsCredentialDraft | null;
  credentialRemoveArmed: string | null;
  credentials: HttpsCredentialEntry[];
  deletingCredentialKey: string | null;
  draft: AppSettings;
  fetchIntervalValidation: FetchIntervalValidation;
  gitUser: GitUserSettings;
  identitySources: IdentitySourcesResponse | null;
  identitySourceFailure: unknown;
  identityValidation: GitUserValidation;
  onCopyPublicKey: () => void;
  onCancelCredentialEdit: () => void;
  onEditCredential: (credential: HttpsCredentialEntry) => void;
  onForgetCredential: (credential: HttpsCredentialEntry) => void;
  onGenerateSshKey: () => void;
  onGravatarChange: (checked: boolean) => void;
  onAutoUpdateCheckChange: (checked: boolean) => void;
  onLanguageChange: (value: "system" | "en" | "zh-CN") => void;
  onRememberSshPassphraseChange: (checked: boolean) => void;
  onNewCredential: () => void;
  onRetryCredentials: () => void;
  onRetrySupplementalSettings: () => void;
  onSave: () => void;
  onSaveCredential: () => void;
  onSaveNetwork: () => void;
  onSaveFetch: () => void;
  onThemeChange: (value: "system" | "light" | "dark") => void;
  onUpdateDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
  onUpdateCredentialDraft: React.Dispatch<
    React.SetStateAction<HttpsCredentialDraft | null>
  >;
  onUpdateUser: (user: GitUserSettings) => void;
  onViewCredentialLoadError: () => void;
  savingCredential: boolean;
  saving: boolean;
  showIdentityValidation: boolean;
  sshKey: SshKeyStatus | null;
  sshKeyFailure: unknown;
}) {
  const { t } = useTranslation();
  const [credentialPageIndex, setCredentialPageIndex] = React.useState(0);
  const credentialPageCount = Math.max(
    1,
    Math.ceil(credentials.length / httpsCredentialPageSize),
  );
  const currentCredentialPageIndex = Math.min(
    credentialPageIndex,
    credentialPageCount - 1,
  );
  const visibleCredentials = credentials.slice(
    currentCredentialPageIndex * httpsCredentialPageSize,
    (currentCredentialPageIndex + 1) * httpsCredentialPageSize,
  );

  return (
    <section className="space-y-6">
      <SettingsGroup
        icon={<UserRound className="size-4" aria-hidden="true" />}
        title={t("settings.general.identity")}
      >
        {identitySourceFailure ? (
          <SupplementalSettingsFailure
            error={identitySourceFailure}
            onRetry={onRetrySupplementalSettings}
            title={t("settings.general.identitySourcesLoadFailed")}
          />
        ) : null}
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
        {sshKeyFailure ? (
          <SupplementalSettingsFailure
            error={sshKeyFailure}
            onRetry={onRetrySupplementalSettings}
            title={t("settings.general.sshStatusLoadFailed")}
          />
        ) : null}
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
        <ToggleRow
          checked={draft.git?.rememberSshPassphrase ?? false}
          label={t("settings.general.rememberSshPassphrase")}
          onChange={onRememberSshPassphraseChange}
        />
      </SettingsGroup>

      <SettingsGroup
        icon={<KeyRound className="size-4" aria-hidden="true" />}
        title={t("settings.general.httpsCredentials")}
      >
        {credentialLoadFailure ? (
          <div
            className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
            role="alert"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-destructive"
              />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {t("settings.general.credentialsLoadFailedTitle")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("settings.general.credentialsLoadFailedDescription")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={onViewCredentialLoadError}
                type="button"
                variant="ghost"
              >
                {t("settings.general.viewCredentialsLoadErrorDetails")}
              </Button>
              <Button
                onClick={onRetryCredentials}
                type="button"
                variant="secondary"
              >
                {t("settings.general.retryCredentialsLoad")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <Button
                className="gap-2"
                onClick={onNewCredential}
                type="button"
                variant="secondary"
              >
                <Plus className="size-4" aria-hidden="true" />
                {t("settings.general.addCredential")}
              </Button>
            </div>
            {credentials.length > 0 ? (
              <div className="space-y-2">
                {visibleCredentials.map((credential) => {
                  const key = httpsCredentialKey(credential);
                  const armed = credentialRemoveArmed === key;
                  return (
                    <div
                      className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
                      data-testid="https-credential-item"
                      key={key}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {credential.host}
                          {credential.path ? `/${credential.path}` : ""}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {credential.username} -{" "}
                          {credential.scope === "path"
                            ? t("settings.general.pathCredential")
                            : t("settings.general.hostCredential")}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          className="gap-2"
                          disabled={deletingCredentialKey === key}
                          onClick={() => onEditCredential(credential)}
                          type="button"
                          variant="secondary"
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                          {t("settings.general.editCredential")}
                        </Button>
                        <Button
                          className="gap-2"
                          disabled={deletingCredentialKey === key}
                          onClick={() => onForgetCredential(credential)}
                          type="button"
                          variant={armed ? "destructive" : "secondary"}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                          {armed
                            ? t("settings.general.confirmForgetCredential")
                            : t("settings.general.forgetCredential")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {credentialPageCount > 1 ? (
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <Button
                      aria-label={t("settings.general.previousCredentialsPage")}
                      disabled={currentCredentialPageIndex === 0}
                      onClick={() =>
                        setCredentialPageIndex(
                          Math.max(0, currentCredentialPageIndex - 1),
                        )
                      }
                      size="icon"
                      title={t("settings.general.previousCredentialsPage")}
                      type="button"
                      variant="ghost"
                    >
                      <ChevronLeft aria-hidden="true" className="size-4" />
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {t("settings.general.credentialsPage", {
                        page: currentCredentialPageIndex + 1,
                        total: credentialPageCount,
                      })}
                    </span>
                    <Button
                      aria-label={t("settings.general.nextCredentialsPage")}
                      disabled={
                        currentCredentialPageIndex >= credentialPageCount - 1
                      }
                      onClick={() =>
                        setCredentialPageIndex(
                          Math.min(
                            credentialPageCount - 1,
                            currentCredentialPageIndex + 1,
                          ),
                        )
                      }
                      size="icon"
                      title={t("settings.general.nextCredentialsPage")}
                      type="button"
                      variant="ghost"
                    >
                      <ChevronRight aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {t("settings.general.noHttpsCredentials")}
              </p>
            )}
            {credentialDraft ? (
              <HttpsCredentialEditor
                draft={credentialDraft}
                onCancel={onCancelCredentialEdit}
                onChange={onUpdateCredentialDraft}
                onSave={onSaveCredential}
                saving={savingCredential}
              />
            ) : null}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup
        icon={<RefreshCw className="size-4" aria-hidden="true" />}
        title={t("settings.general.updates")}
      >
        <ToggleRow
          checked={draft.updates?.autoCheck ?? true}
          label={t("settings.general.autoCheckUpdates")}
          onChange={onAutoUpdateCheckChange}
        />
      </SettingsGroup>

      <SettingsGroup
        icon={<RefreshCw className="size-4" aria-hidden="true" />}
        title={t("settings.general.fetch")}
      >
        <ToggleRow
          checked={draft.git?.autoFetch ?? true}
          label={t("settings.general.autoFetch")}
          onChange={(checked) => {
            onUpdateDraft((current) =>
              settingsWithFetchPreferences(current, { autoFetch: checked }),
            );
          }}
        />
        <label className="grid gap-1 text-sm">
          <span className="font-medium">
            {t("settings.general.fetchIntervalSeconds")}
          </span>
          <input
            aria-invalid={!fetchIntervalValidation.valid}
            className={cn(
              "h-9 w-36 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
              !fetchIntervalValidation.valid &&
                "border-destructive focus-visible:ring-destructive",
            )}
            max={fetchIntervalValidation.max}
            min={fetchIntervalValidation.min}
            onChange={(event) => {
              onUpdateDraft((current) =>
                settingsWithFetchPreferences(current, {
                  fetchIntervalSeconds: Number(event.target.value),
                }),
              );
            }}
            type="number"
            value={draft.git?.fetchIntervalSeconds ?? 60}
          />
        </label>
        {!fetchIntervalValidation.valid ? (
          <p className="text-sm text-destructive">
            {t("settings.general.fetchIntervalRange", {
              max: fetchIntervalValidation.max,
              min: fetchIntervalValidation.min,
            })}
          </p>
        ) : null}
        <Button
          className="gap-2"
          disabled={saving || !fetchIntervalValidation.valid}
          onClick={onSaveFetch}
          type="button"
        >
          <Save className="size-4" aria-hidden="true" />
          {t("settings.general.saveFetch")}
        </Button>
      </SettingsGroup>

      <SettingsGroup
        icon={<Cloud className="size-4" aria-hidden="true" />}
        title={t("settings.general.network")}
      >
        <p className="text-sm text-muted-foreground">
          {t("settings.general.networkHelp")}
        </p>
        <SelectField
          label={t("settings.general.proxyMode")}
          onChange={(value) => {
            onUpdateDraft((current) =>
              settingsWithNetworkPreferences(current, {
                proxyMode: value as "system" | "none" | "custom",
              }),
            );
          }}
          options={[
            ["system", t("settings.general.proxyModeSystem")],
            ["none", t("settings.general.proxyModeNone")],
            ["custom", t("settings.general.proxyModeCustom")],
          ]}
          value={draft.network?.proxyMode ?? "system"}
        />
        {draft.network?.proxyMode === "custom" ? (
          <div className="grid gap-3">
            <ProxyField
              invalid={!validateProxyUrl(draft.network?.httpProxy)}
              label={t("settings.general.httpProxy")}
              onChange={(httpProxy) =>
                onUpdateDraft((current) =>
                  settingsWithNetworkPreferences(current, {
                    httpProxy: httpProxy || null,
                  }),
                )
              }
              placeholder="http://127.0.0.1:6152"
              value={draft.network?.httpProxy ?? ""}
            />
            <ProxyField
              invalid={!validateProxyUrl(draft.network?.httpsProxy)}
              label={t("settings.general.httpsProxy")}
              onChange={(httpsProxy) =>
                onUpdateDraft((current) =>
                  settingsWithNetworkPreferences(current, {
                    httpsProxy: httpsProxy || null,
                  }),
                )
              }
              placeholder="http://127.0.0.1:6152"
              value={draft.network?.httpsProxy ?? ""}
            />
            <ProxyField
              invalid={!validateProxyUrl(draft.network?.allProxy)}
              label={t("settings.general.allProxy")}
              onChange={(allProxy) =>
                onUpdateDraft((current) =>
                  settingsWithNetworkPreferences(current, {
                    allProxy: allProxy || null,
                  }),
                )
              }
              placeholder="socks5://127.0.0.1:6153"
              value={draft.network?.allProxy ?? ""}
            />
            <ProxyField
              invalid={false}
              label={t("settings.general.noProxy")}
              onChange={(noProxy) =>
                onUpdateDraft((current) =>
                  settingsWithNetworkPreferences(current, {
                    noProxy: noProxy || null,
                  }),
                )
              }
              placeholder="localhost,127.0.0.1"
              value={draft.network?.noProxy ?? ""}
            />
            {!validateProxyUrl(draft.network?.httpProxy) ||
            !validateProxyUrl(draft.network?.httpsProxy) ||
            !validateProxyUrl(draft.network?.allProxy) ? (
              <p className="text-sm text-destructive">
                {t("settings.general.proxyUrlInvalid")}
              </p>
            ) : null}
          </div>
        ) : null}
        <Button
          className="gap-2"
          disabled={
            saving ||
            (draft.network?.proxyMode === "custom" &&
              (!validateProxyUrl(draft.network?.httpProxy) ||
                !validateProxyUrl(draft.network?.httpsProxy) ||
                !validateProxyUrl(draft.network?.allProxy)))
          }
          onClick={onSaveNetwork}
          type="button"
        >
          <Save className="size-4" aria-hidden="true" />
          {t("settings.general.saveNetwork")}
        </Button>
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
          onChange={onGravatarChange}
        />
      </SettingsGroup>
    </section>
  );
}

function HttpsCredentialEditor({
  draft,
  onCancel,
  onChange,
  onSave,
  saving,
}: {
  draft: HttpsCredentialDraft;
  onCancel: () => void;
  onChange: React.Dispatch<React.SetStateAction<HttpsCredentialDraft | null>>;
  onSave: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const update = (patch: Partial<HttpsCredentialDraft>) => {
    onChange((current) => (current ? { ...current, ...patch } : current));
  };

  return (
    <div className="grid gap-3 rounded-md border bg-background p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("settings.general.credentialHost")}
          onChange={(host) => update({ host })}
          value={draft.host}
        />
        <SelectField
          label={t("settings.general.credentialScope")}
          onChange={(scope) =>
            update({ scope: scope as HttpsCredentialEntry["scope"] })
          }
          options={[
            ["host", t("settings.general.hostCredential")],
            ["path", t("settings.general.pathCredential")],
          ]}
          value={draft.scope}
        />
      </div>
      <TextField
        label={t("settings.general.credentialPath")}
        onChange={(path) => update({ path })}
        value={draft.scope === "path" ? draft.path : ""}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("settings.general.credentialUsername")}
          onChange={(username) => update({ username })}
          value={draft.username}
        />
        <label className="grid gap-1 text-sm">
          <span className="font-medium">
            {t("settings.general.credentialToken")}
          </span>
          <input
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => update({ token: event.target.value })}
            type="password"
            value={draft.token}
          />
        </label>
      </div>
      {draft.editingKey ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.general.credentialTokenUnchanged")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          className="gap-2"
          disabled={saving}
          onClick={onSave}
          type="button"
        >
          <Save className="size-4" aria-hidden="true" />
          {t("settings.general.saveCredential")}
        </Button>
        <Button
          disabled={saving}
          onClick={onCancel}
          type="button"
          variant="secondary"
        >
          {t("settings.general.cancelCredentialEdit")}
        </Button>
      </div>
    </div>
  );
}

function ProjectSettingsPanel({
  activeRepositoryPath,
  autoTrackingRules,
  branchLoadFailure,
  branchOptions,
  gitignore,
  gitignoreDraft,
  gitignoreLoadFailure,
  largeFileCheck,
  loadingBranches,
  loadingGitignore,
  loadingProject,
  loadingRemote,
  onAutoTrackingRulesChange,
  onGitignoreChange,
  onLargeFileChange,
  onRemoteChange,
  onRemoteCopy,
  onRetryBranches,
  onRetryGitignore,
  onRetryProject,
  onRetryRemote,
  onSaveGitignore,
  onSaveProject,
  onSaveRemote,
  remoteRemoveArmed,
  remoteLoadFailure,
  remoteSettings,
  remoteUrlDraft,
  savingGitignore,
  savingProject,
  savingRemote,
  projectLoadFailure,
}: {
  activeRepositoryPath: string | null;
  autoTrackingRules: AutoTrackingRule[];
  branchLoadFailure: unknown;
  branchOptions: BranchSummary[];
  gitignore: GitignoreFileResponse | null;
  gitignoreDraft: string;
  gitignoreLoadFailure: unknown;
  largeFileCheck: Required<{ enabled: boolean; thresholdMb: number }>;
  loadingBranches: boolean;
  loadingGitignore: boolean;
  loadingProject: boolean;
  loadingRemote: boolean;
  onAutoTrackingRulesChange: (rules: AutoTrackingRule[]) => void;
  onGitignoreChange: (value: string) => void;
  onLargeFileChange: (
    value: Required<{ enabled: boolean; thresholdMb: number }>,
  ) => void;
  onRemoteChange: (value: string) => void;
  onRemoteCopy: () => void;
  onRetryBranches: () => void;
  onRetryGitignore: () => void;
  onRetryProject: () => void;
  onRetryRemote: () => void;
  onSaveGitignore: () => void;
  onSaveProject: () => void;
  onSaveRemote: () => void;
  remoteRemoveArmed: boolean;
  remoteLoadFailure: unknown;
  remoteSettings: RemoteSettingsResponse | null;
  remoteUrlDraft: string;
  savingGitignore: boolean;
  savingProject: boolean;
  savingRemote: boolean;
  projectLoadFailure: unknown;
}) {
  const { t } = useTranslation();
  const {
    sourceOptions,
    sourceSelectOptions,
    targetOptions,
    targetSelectOptions,
  } = React.useMemo(() => {
    const nextSourceOptions = branchOptions.filter(
      (branch) =>
        branch.existence === "localAndRemote" ||
        branch.existence === "remoteOnly" ||
        Boolean(branch.upstream),
    );
    const nextTargetOptions = branchOptions.filter(
      (branch) =>
        branch.existence === "localAndRemote" ||
        branch.existence === "remoteOnly",
    );
    const toSelectOption = (branch: BranchSummary) => ({
      label:
        branch.existence === "remoteOnly"
          ? t("settings.project.remoteBranchOption", {
              branch: branch.shortName,
            })
          : branch.shortName,
      value: branch.shortName,
    });

    return {
      sourceOptions: nextSourceOptions,
      sourceSelectOptions: nextSourceOptions.map(toSelectOption),
      targetOptions: nextTargetOptions,
      targetSelectOptions: nextTargetOptions.map(toSelectOption),
    };
  }, [branchOptions, t]);
  const autoTrackingValidation = validateAutoTrackingRules(
    autoTrackingRules,
    targetOptions,
  );
  const projectReady = !loadingProject && !projectLoadFailure;
  const gitignoreReady = !loadingGitignore && !gitignoreLoadFailure;
  const remoteReady = !loadingRemote && !remoteLoadFailure;
  const branchesReady = !loadingBranches && !branchLoadFailure;

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
        <ProjectSourceStatus
          error={projectLoadFailure}
          loading={loadingProject}
          onRetry={onRetryProject}
        />
        {projectReady ? (
          <>
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
          </>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.project.gitignore")}>
        <ProjectSourceStatus
          error={gitignoreLoadFailure}
          loading={loadingGitignore}
          onRetry={onRetryGitignore}
        />
        {gitignoreReady ? (
          <>
            <div className="text-sm text-muted-foreground">
              {gitignore?.path ?? t("settings.project.loadingGitignore")}
            </div>
            <textarea
              aria-label={t("settings.project.gitignore")}
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
          </>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.project.remote")}>
        <ProjectSourceStatus
          error={remoteLoadFailure}
          loading={loadingRemote}
          onRetry={onRetryRemote}
        />
        {remoteReady ? (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {remoteSettings?.remoteMode === "origin" ? (
                <Cloud className="size-4" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              <span>
                {remoteSettings?.remoteMode === "origin"
                  ? t("settings.project.originConfigured")
                  : t("settings.project.noOriginConfigured")}
              </span>
            </div>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  label={t("settings.project.originUrl")}
                  onChange={onRemoteChange}
                  value={remoteUrlDraft}
                />
              </div>
              <Button
                className="gap-2"
                disabled={!remoteUrlDraft.trim()}
                onClick={onRemoteCopy}
                type="button"
                variant="secondary"
              >
                <Clipboard className="size-4" aria-hidden="true" />
                {t("actions.copy")}
              </Button>
            </div>
            {remoteRemoveArmed ? (
              <p className="text-sm text-destructive">
                {t("settings.project.removeOriginWarning")}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("settings.project.clearOriginHelp")}
              </p>
            )}
            <Button
              className="gap-2"
              disabled={savingRemote}
              onClick={onSaveRemote}
              type="button"
              variant={remoteRemoveArmed ? "destructive" : "default"}
            >
              <Save className="size-4" aria-hidden="true" />
              {remoteRemoveArmed
                ? t("settings.project.removeOrigin")
                : t("settings.project.saveRemote")}
            </Button>
          </>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        icon={<GitBranch className="size-4" aria-hidden="true" />}
        title={t("settings.project.autoTracking")}
      >
        <ProjectSourceStatus
          error={projectLoadFailure ?? branchLoadFailure}
          loading={loadingProject || loadingBranches}
          onRetry={() => {
            if (projectLoadFailure) {
              onRetryProject();
            }
            if (branchLoadFailure) {
              onRetryBranches();
            }
          }}
        />
        {projectReady && branchesReady ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t("settings.project.autoTrackingHelp")}
            </p>
            <div className="space-y-2">
              {autoTrackingRules.length === 0 ? (
                <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  {t("settings.project.noAutoTrackingRules")}
                </p>
              ) : null}
              {autoTrackingRules.map((rule, index) => {
                const rowError = autoTrackingValidation.rowErrors[index];
                const rowWarning = autoTrackingValidation.rowWarnings[index];
                return (
                  <div
                    className="grid gap-2 rounded-md border bg-background p-3"
                    key={index}
                  >
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <BranchSelect
                        label={t("settings.project.autoTrackingSource")}
                        noResultsLabel={t("repository.noSearchResults")}
                        onChange={(sourceBranch) => {
                          onAutoTrackingRulesChange(
                            autoTrackingRules.map(
                              (candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? { ...candidate, sourceBranch }
                                  : candidate,
                            ),
                          );
                        }}
                        options={sourceSelectOptions}
                        searchLabel={t("repository.searchBranches")}
                        value={rule.sourceBranch}
                      />
                      <BranchSelect
                        label={t("settings.project.autoTrackingTarget")}
                        noResultsLabel={t("repository.noSearchResults")}
                        onChange={(targetBranch) => {
                          onAutoTrackingRulesChange(
                            autoTrackingRules.map(
                              (candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? { ...candidate, targetBranch }
                                  : candidate,
                            ),
                          );
                        }}
                        options={targetSelectOptions}
                        searchLabel={t("repository.searchBranches")}
                        value={rule.targetBranch}
                      />
                      <Button
                        className="self-end gap-2"
                        onClick={() => {
                          onAutoTrackingRulesChange(
                            autoTrackingRules.filter(
                              (_, candidateIndex) => candidateIndex !== index,
                            ),
                          );
                        }}
                        type="button"
                        variant="secondary"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                        {t("actions.remove")}
                      </Button>
                    </div>
                    {rowError ? (
                      <p className="text-sm text-destructive">{t(rowError)}</p>
                    ) : null}
                    {!rowError && rowWarning ? (
                      <p className="text-sm text-warning">{t(rowWarning)}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="gap-2"
                disabled={
                  sourceOptions.length === 0 ||
                  targetOptions.length === 0 ||
                  autoTrackingRules.length >= maxAutoTrackingRules
                }
                onClick={() => {
                  onAutoTrackingRulesChange([
                    ...autoTrackingRules,
                    {
                      sourceBranch: sourceOptions[0]?.shortName ?? "",
                      targetBranch: targetOptions[0]?.shortName ?? "",
                    },
                  ]);
                }}
                type="button"
                variant="secondary"
              >
                <GitBranch className="size-4" aria-hidden="true" />
                {t("settings.project.addAutoTrackingRule")}
              </Button>
              <Button
                className="gap-2"
                disabled={savingProject || !autoTrackingValidation.valid}
                onClick={onSaveProject}
                type="button"
              >
                <Save className="size-4" aria-hidden="true" />
                {t("settings.project.saveProject")}
              </Button>
            </div>
            {autoTrackingRules.length >= maxAutoTrackingRules ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t("settings.project.autoTrackingRuleLimit", {
                  count: maxAutoTrackingRules,
                })}
              </p>
            ) : null}
            {!autoTrackingValidation.valid ? (
              <p className="text-sm text-destructive">
                {t("settings.project.autoTrackingInvalid")}
              </p>
            ) : null}
          </>
        ) : null}
      </SettingsGroup>
    </section>
  );
}

function validateAutoTrackingRules(
  rules: AutoTrackingRule[],
  targetOptions: BranchSummary[],
): {
  rowErrors: Array<string | null>;
  rowWarnings: Array<string | null>;
  valid: boolean;
} {
  const sourceCounts = new Map<string, number>();
  for (const rule of rules) {
    const source = rule.sourceBranch.trim();
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  const cyclicSources = cyclicAutoTrackingSources(rules);
  const targetBranches = new Set(
    targetOptions.map((branch) => branch.shortName),
  );

  const rowErrors = rules.map((rule) => {
    const source = rule.sourceBranch.trim();
    const target = rule.targetBranch.trim();
    if (!source || !target) {
      return "settings.project.autoTrackingMissing";
    }
    if (source === target) {
      return "settings.project.autoTrackingSelf";
    }
    if ((sourceCounts.get(source) ?? 0) > 1) {
      return "settings.project.autoTrackingDuplicateSource";
    }
    if (cyclicSources.has(source)) {
      return "settings.project.autoTrackingCycle";
    }
    return null;
  });
  const rowWarnings = rules.map((rule, index) => {
    const target = rule.targetBranch.trim();
    if (
      rowErrors[index] === null &&
      target &&
      targetOptions.length > 0 &&
      !targetBranches.has(target)
    ) {
      return "settings.project.autoTrackingTargetDeleted";
    }
    return null;
  });

  return {
    rowErrors,
    rowWarnings,
    valid: rowErrors.every((error) => error === null),
  };
}

function cyclicAutoTrackingSources(rules: AutoTrackingRule[]): Set<string> {
  const graph = new Map(
    rules.map((rule) => [rule.sourceBranch.trim(), rule.targetBranch.trim()]),
  );
  const cyclic = new Set<string>();

  for (const source of graph.keys()) {
    const seen = new Set<string>();
    let cursor = source;
    while (graph.has(cursor)) {
      if (seen.has(cursor)) {
        for (const branch of seen) {
          cyclic.add(branch);
        }
        break;
      }
      seen.add(cursor);
      cursor = graph.get(cursor) ?? "";
    }
  }

  return cyclic;
}

function AboutSettings({
  appVersion,
  installGate,
  installing,
  onCheckUpdates,
  onInstallUpdate,
  onOpenReleasePage,
  updateStatus,
}: {
  appVersion: string;
  installGate: UpdateInstallGateResponse;
  installing: boolean;
  onCheckUpdates: () => void;
  onInstallUpdate: () => void;
  onOpenReleasePage: () => void;
  updateStatus: UpdateStatusEvent | null;
}) {
  const { t } = useTranslation();
  const status = updateStatus?.status ?? null;
  const checking =
    status?.state === "checking" ||
    status?.state === "available" ||
    status?.state === "downloading";
  const ready = status?.state === "ready";
  const releaseAvailable = status?.state === "releaseAvailable";
  const notes =
    status?.state === "available" ||
    status?.state === "releaseAvailable" ||
    status?.state === "downloading" ||
    status?.state === "ready"
      ? status.notes
      : null;
  const installBlockedMessage = installGate.blocked
    ? updateInstallGateMessage(installGate, t)
    : null;

  return (
    <section className="space-y-6">
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

      <SettingsGroup
        icon={<RefreshCw className="size-4" aria-hidden="true" />}
        title={t("settings.about.updates")}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            className="gap-2"
            disabled={checking || installing}
            onClick={onCheckUpdates}
            type="button"
            variant="secondary"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {t("settings.about.checkForUpdates")}
          </Button>
          <Button
            className="gap-2"
            disabled={!ready || installGate.blocked || installing}
            onClick={onInstallUpdate}
            type="button"
          >
            {installing ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            {installing
              ? t("updaterPrompt.installing")
              : t("settings.about.installUpdate")}
          </Button>
          {releaseAvailable ? (
            <Button className="gap-2" onClick={onOpenReleasePage} type="button">
              <ExternalLink className="size-4" aria-hidden="true" />
              {t("settings.about.openReleases")}
            </Button>
          ) : null}
        </div>

        <UpdateStatusMessage status={status} />

        {status?.state === "downloading" ? (
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary"
              style={{
                width: `${Math.round((status.progress ?? 0) * 100)}%`,
              }}
            />
          </div>
        ) : null}

        {installBlockedMessage && ready ? (
          <p className="text-sm text-muted-foreground">
            {installBlockedMessage}
          </p>
        ) : null}

        {notes ? (
          <div className="max-h-52 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-sm">
            {notes}
          </div>
        ) : null}
      </SettingsGroup>
    </section>
  );
}

function UpdateStatusMessage({
  status,
}: {
  status: UpdateStatusEvent["status"] | null;
}) {
  const { t } = useTranslation();

  if (!status) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("settings.about.updateIdle")}
      </p>
    );
  }

  switch (status.state) {
    case "checking":
      return (
        <p className="text-sm text-muted-foreground">
          {t("settings.about.updateChecking")}
        </p>
      );
    case "available":
      return (
        <p className="text-sm text-muted-foreground">
          {t("settings.about.updateAvailable", { version: status.version })}
        </p>
      );
    case "releaseAvailable":
      return (
        <p className="text-sm text-muted-foreground">
          {t("settings.about.updateReleaseAvailable", {
            version: status.version,
          })}
        </p>
      );
    case "downloading":
      return (
        <p className="text-sm text-muted-foreground">
          {t("settings.about.updateDownloading", {
            percent: Math.round((status.progress ?? 0) * 100),
            version: status.version,
          })}
        </p>
      );
    case "ready":
      return (
        <p className="text-sm text-muted-foreground">
          {t("settings.about.updateReady", { version: status.version })}
        </p>
      );
    case "notAvailable":
      return null;
    case "failed":
      return (
        <p className="text-sm text-destructive">
          {t(
            status.failureStage === "install"
              ? "settings.about.updateInstallFailed"
              : "settings.about.updateFailed",
            { message: status.message },
          )}
        </p>
      );
  }
}

function updateInstallGateMessage(
  gate: UpdateInstallGateResponse,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (gate.reason) {
    case "gitOperation":
    case "backgroundOperation":
      return t("settings.about.installBlockedGitOperation");
    case "closeGuard":
      return t("settings.about.installBlockedCloseGuard");
    case "conflict":
      return t("settings.about.installBlockedConflict");
    case "reviewMode":
      return t("settings.about.installBlockedReviewMode");
    case "gateUnavailable":
      return t("settings.about.installBlockedGateUnavailable");
    case "noReadyUpdate":
      return t("settings.about.installBlockedNoReadyUpdate");
    case "unsupportedInstallFormat":
      return t("settings.about.installBlockedUnsupportedFormat");
    default:
      return t("settings.about.installBlocked");
  }
}

function httpsCredentialKey(credential: HttpsCredentialEntry): string {
  return [
    credential.protocol,
    credential.host,
    credential.scope,
    credential.path ?? "",
  ].join("\n");
}

function SupplementalSettingsFailure({
  error,
  onRetry,
  title,
}: {
  error: unknown;
  onRetry: () => void;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
      role="alert"
    >
      <p className="text-sm font-medium text-destructive">{title}</p>
      <p className="text-sm text-muted-foreground">
        {t("settings.general.supplementalLoadFailedDescription")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("artistic-git:error", { detail: error }),
            );
          }}
          type="button"
          variant="ghost"
        >
          {t("dialogs.error.showDetails")}
        </Button>
        <Button onClick={onRetry} type="button" variant="secondary">
          {t("actions.retry")}
        </Button>
      </div>
    </div>
  );
}

function ProjectSourceStatus({
  error,
  loading,
  onRetry,
}: {
  error: unknown;
  loading: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("settings.project.loadingSource")}
      </div>
    );
  }
  if (!error) {
    return null;
  }
  return (
    <div
      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
      role="alert"
    >
      <p className="text-sm text-muted-foreground">
        {t("settings.project.sourceLoadFailed")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("artistic-git:error", { detail: error }),
            );
          }}
          type="button"
          variant="ghost"
        >
          {t("settings.project.viewLoadErrorDetails")}
        </Button>
        <Button onClick={onRetry} type="button" variant="secondary">
          {t("settings.project.retryLoad")}
        </Button>
      </div>
    </div>
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

function ProxyField({
  invalid,
  label,
  onChange,
  placeholder,
  value,
}: {
  invalid: boolean;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
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
        placeholder={placeholder}
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
