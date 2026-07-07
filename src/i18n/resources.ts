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
