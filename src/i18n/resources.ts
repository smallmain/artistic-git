export const supportedLanguages = ["en", "zh-CN"] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];
export type LanguagePreference = "system" | SupportedLanguage;

export const defaultLanguage: SupportedLanguage = "en";

export const resources = {
  en: {
    translation: {
      app: {
        name: "Artistic Git",
        tagline: "Visual Git workflows for artists",
        recentProjects: "Recent Projects",
        recentProjectsEmpty:
          "Project history will appear here after the first repository is opened.",
      },
      actions: {
        cancel: "Cancel",
        cloneProject: "Clone Project",
        close: "Close",
        confirm: "Confirm",
        copyDetails: "Copy details",
        openLogDir: "Open log folder",
        openProject: "Open Project",
        openSettings: "Open settings",
        restartApp: "Restart app",
      },
      onboarding: {
        finish: "Finish setup",
        placeholder:
          "The setup wizard is reserved for Phase 3E. This placeholder confirms the first-run route from settings.",
        skip: "Skip",
        title: "Setup Wizard",
      },
      repository: {
        applyStash: "Apply stash",
        branches: "Branches",
        busyTooltip: "An operation is running",
        checkout: "Switch branch",
        createFromBase: "Create new branch from base",
        deleteBranch: "Delete branch",
        deleteStash: "Delete stash",
        disabledWrite: "Write actions are disabled in this phase",
        focusedBranch:
          "Focused on {{branch}} at latest commit {{commit}}. History graph connects here in Phase 2C.",
        history: "History",
        historyPlaceholder: "History graph placeholder",
        localChanges: "Local Changes",
        localChangesCount:
          "{{count}} local changes are ready for the Diff engine in Phase 2D.",
        localChangesPlaceholder: "Local changes placeholder",
        moreActions: "More actions",
        noRemote: "No remote repository configured",
        noSearchResults: "No matching items",
        openProjectSettings: "Project settings",
        ready: "Ready",
        resizeSections: "Resize branch and stash sections",
        resizeSidebar: "Resize sidebar",
        reviewMode: "Review Mode",
        reviewModePlaceholder: "Review mode is implemented in a later phase",
        searchBranches: "Search branches",
        searchStashes: "Search stashes",
        stashDetails: "Stash details",
        stashes: "Stashes",
        sync: "Sync",
        syncBadge: "↑{{ahead}} to push ↓{{behind}} to pull",
        tabs: "Repository tabs",
        untitledProject: "Untitled project",
      },
      start: {
        clearRecent: "Clear history",
        clonePlaceholder: "Clone is implemented in Phase 4D",
        missingProject:
          "{{path}} was deleted or moved. Remove it from the recent projects list?",
        openOnboarding: "Open setup wizard",
        openOnboardingPlaceholder:
          "The setup wizard is implemented in Phase 3E",
        removeFromList: "Remove from list",
        removeRecent: "Remove {{name}}",
        removeRecentTooltip: "Remove from recent projects",
        settingsPlaceholder: "Settings are implemented in a later phase",
      },
      demo: {
        confirmDescription:
          "Destructive actions use this shared confirmation dialog base.",
        confirmTitle: "Confirm Action",
        confirmTrigger: "Preview confirmation",
        copiedPath: "Display path",
        dateLabel: "Localized date",
        fileSizeLabel: "File size",
        languageThemeTitle: "Language and Theme",
        numberLabel: "Number",
        relativeTimeLabel: "Relative time",
        statusTitle: "Status Tokens",
        success: "Success",
        sync: "Sync",
        typographyTitle: "Localized Formatting",
        warning: "Warning",
        danger: "Danger",
        review: "Review",
      },
      dialogs: {
        crash: {
          description:
            "The app hit an unrecoverable problem. The technical details can help with a bug report.",
          title: "Crash Details",
        },
        error: {
          copied: "Details copied",
          copyFailed: "Could not copy details",
          description:
            "The operation did not complete. Review the summary first, then expand the technical details if needed.",
          hideDetails: "Hide technical details",
          showDetails: "Show technical details",
          title: "Error Details",
        },
      },
      language: {
        en: "English",
        label: "Language",
        system: "System language",
        zhCN: "简体中文",
      },
      theme: {
        dark: "Dark",
        label: "Theme",
        light: "Light",
        system: "System theme",
      },
    },
  },
  "zh-CN": {
    translation: {
      app: {
        name: "Artistic Git",
        tagline: "为艺术创作者设计的可视化 Git 工作流",
        recentProjects: "最近项目",
        recentProjectsEmpty: "首次打开仓库后，项目历史会显示在这里。",
      },
      actions: {
        cancel: "取消",
        cloneProject: "克隆项目",
        close: "关闭",
        confirm: "确认",
        copyDetails: "复制详情",
        openLogDir: "打开日志目录",
        openProject: "打开项目",
        openSettings: "打开设置",
        restartApp: "重启应用",
      },
      onboarding: {
        finish: "完成设置",
        placeholder:
          "设置向导在 3E 阶段实现。此占位用于确认 settings 中首次进入标志的路由。",
        skip: "跳过",
        title: "设置向导",
      },
      repository: {
        applyStash: "应用储藏",
        branches: "分支",
        busyTooltip: "有操作正在进行",
        checkout: "切换分支",
        createFromBase: "作为基准创建新分支",
        deleteBranch: "删除分支",
        deleteStash: "删除储藏",
        disabledWrite: "本阶段禁用写操作",
        focusedBranch:
          "已聚焦 {{branch}} 的最新提交 {{commit}}。历史图在 2C 阶段接入。",
        history: "历史",
        historyPlaceholder: "历史图占位",
        localChanges: "本地更改",
        localChangesCount: "{{count}} 个本地更改等待 2D Diff 引擎接入。",
        localChangesPlaceholder: "本地更改占位",
        moreActions: "更多操作",
        noRemote: "未配置远程仓库",
        noSearchResults: "未搜索到相关内容",
        openProjectSettings: "项目设置",
        ready: "就绪",
        resizeSections: "调整分支和储藏区比例",
        resizeSidebar: "调整侧栏宽度",
        reviewMode: "审查模式",
        reviewModePlaceholder: "审查模式在后续阶段实现",
        searchBranches: "搜索分支",
        searchStashes: "搜索储藏",
        stashDetails: "储藏详情",
        stashes: "储藏",
        sync: "同步",
        syncBadge: "↑{{ahead}} 待推送 ↓{{behind}} 待拉取",
        tabs: "仓库选项卡",
        untitledProject: "未命名项目",
      },
      start: {
        clearRecent: "清空历史记录",
        clonePlaceholder: "克隆功能在 4D 阶段实现",
        missingProject: "{{path}} 已删除或移动。是否从最近项目列表移除？",
        openOnboarding: "打开设置向导",
        openOnboardingPlaceholder: "设置向导在 3E 阶段实现",
        removeFromList: "从列表中移除",
        removeRecent: "移除 {{name}}",
        removeRecentTooltip: "从最近项目移除",
        settingsPlaceholder: "设置功能在后续阶段实现",
      },
      demo: {
        confirmDescription: "破坏性操作使用这个共享确认弹窗基座。",
        confirmTitle: "确认操作",
        confirmTrigger: "预览确认弹窗",
        copiedPath: "显示路径",
        dateLabel: "本地化日期",
        fileSizeLabel: "文件大小",
        languageThemeTitle: "语言与主题",
        numberLabel: "数字",
        relativeTimeLabel: "相对时间",
        statusTitle: "状态令牌",
        success: "成功",
        sync: "同步",
        typographyTitle: "本地化格式",
        warning: "警告",
        danger: "危险",
        review: "审查",
      },
      dialogs: {
        crash: {
          description: "应用遇到了无法恢复的问题。技术详情可用于提交错误报告。",
          title: "崩溃详情",
        },
        error: {
          copied: "详情已复制",
          copyFailed: "无法复制详情",
          description: "操作未完成。请先查看摘要，需要时再展开技术详情。",
          hideDetails: "隐藏技术详情",
          showDetails: "显示技术详情",
          title: "错误详情",
        },
      },
      language: {
        en: "English",
        label: "语言",
        system: "系统语言",
        zhCN: "简体中文",
      },
      theme: {
        dark: "深色",
        label: "主题",
        light: "浅色",
        system: "跟随系统",
      },
    },
  },
} as const;

export function isSupportedLanguage(
  language: string,
): language is SupportedLanguage {
  return supportedLanguages.includes(language as SupportedLanguage);
}

export function isLanguagePreference(
  preference: string,
): preference is LanguagePreference {
  return preference === "system" || isSupportedLanguage(preference);
}

export function languageFromLocale(locale?: string): SupportedLanguage {
  if (!locale) {
    return defaultLanguage;
  }

  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : defaultLanguage;
}
