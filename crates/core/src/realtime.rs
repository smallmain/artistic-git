use std::collections::BTreeSet;
use std::time::Duration;

use serde::Serialize;
use specta::Type;

const DEFAULT_DEBOUNCE_MS: u64 = 400;
const MIN_DEBOUNCE_MS: u64 = 300;
const MAX_DEBOUNCE_MS: u64 = 500;
const DEFAULT_POLLING_INTERVAL_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RealtimePlatform {
    Macos,
    Windows,
    Linux,
    Other,
}

impl RealtimePlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePlanInput {
    pub platform: RealtimePlatform,
    pub git_builtin_fsmonitor_supported: bool,
    pub requested_workspace_watches: usize,
    pub os_watch_limit: Option<usize>,
}

impl RealtimePlanInput {
    pub fn current(git_builtin_fsmonitor_supported: bool) -> Self {
        Self {
            platform: RealtimePlatform::current(),
            git_builtin_fsmonitor_supported,
            requested_workspace_watches: 0,
            os_watch_limit: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePlan {
    pub fsmonitor: FsmonitorPlan,
    pub git_watcher: GitWatcherPlan,
    pub workspace_watcher: WorkspaceWatcherPlan,
    pub debounce_ms: u64,
}

impl RealtimePlan {
    pub fn git_config_args(&self) -> Vec<String> {
        let mut args = Vec::new();

        if self.fsmonitor.enable_builtin {
            args.push("-c".to_owned());
            args.push("core.fsmonitor=true".to_owned());
        }

        if self.fsmonitor.enable_untracked_cache {
            args.push("-c".to_owned());
            args.push("core.untrackedCache=true".to_owned());
        }

        args
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FsmonitorPlan {
    pub enable_builtin: bool,
    pub enable_untracked_cache: bool,
    pub reason: FsmonitorReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FsmonitorReason {
    PlatformDefault,
    GitUnsupported,
    PlatformUnsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitWatcherPlan {
    pub mode: WatcherMode,
    pub critical_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWatcherPlan {
    pub mode: WatcherMode,
    pub reason: WorkspaceWatcherReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WatcherMode {
    Precise,
    Disabled,
    Polling { interval_ms: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceWatcherReason {
    Enabled,
    WatchLimitExceeded,
    SetupFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchSetupError {
    WatchLimitExceeded,
    Other,
}

pub fn plan_realtime(input: RealtimePlanInput) -> RealtimePlan {
    let fsmonitor = plan_fsmonitor(input.platform, input.git_builtin_fsmonitor_supported);
    let workspace_watcher = plan_workspace_watcher(input);

    RealtimePlan {
        fsmonitor,
        git_watcher: GitWatcherPlan {
            mode: WatcherMode::Precise,
            critical_paths: git_critical_paths(),
        },
        workspace_watcher,
        debounce_ms: DEFAULT_DEBOUNCE_MS,
    }
}

pub fn downgrade_workspace_watcher(error: WatchSetupError) -> WorkspaceWatcherPlan {
    match error {
        WatchSetupError::WatchLimitExceeded => WorkspaceWatcherPlan {
            mode: WatcherMode::Polling {
                interval_ms: DEFAULT_POLLING_INTERVAL_MS,
            },
            reason: WorkspaceWatcherReason::WatchLimitExceeded,
        },
        WatchSetupError::Other => WorkspaceWatcherPlan {
            mode: WatcherMode::Polling {
                interval_ms: DEFAULT_POLLING_INTERVAL_MS,
            },
            reason: WorkspaceWatcherReason::SetupFailed,
        },
    }
}

fn plan_fsmonitor(
    platform: RealtimePlatform,
    git_builtin_fsmonitor_supported: bool,
) -> FsmonitorPlan {
    match platform {
        RealtimePlatform::Macos | RealtimePlatform::Windows => FsmonitorPlan {
            enable_builtin: true,
            enable_untracked_cache: true,
            reason: FsmonitorReason::PlatformDefault,
        },
        RealtimePlatform::Linux if git_builtin_fsmonitor_supported => FsmonitorPlan {
            enable_builtin: true,
            enable_untracked_cache: true,
            reason: FsmonitorReason::PlatformDefault,
        },
        RealtimePlatform::Linux => FsmonitorPlan {
            enable_builtin: false,
            enable_untracked_cache: true,
            reason: FsmonitorReason::GitUnsupported,
        },
        RealtimePlatform::Other => FsmonitorPlan {
            enable_builtin: false,
            enable_untracked_cache: true,
            reason: FsmonitorReason::PlatformUnsupported,
        },
    }
}

fn plan_workspace_watcher(input: RealtimePlanInput) -> WorkspaceWatcherPlan {
    let exceeded = input
        .os_watch_limit
        .is_some_and(|limit| input.requested_workspace_watches > limit);

    if exceeded {
        downgrade_workspace_watcher(WatchSetupError::WatchLimitExceeded)
    } else {
        WorkspaceWatcherPlan {
            mode: WatcherMode::Precise,
            reason: WorkspaceWatcherReason::Enabled,
        }
    }
}

pub fn git_critical_paths() -> Vec<String> {
    [
        "HEAD",
        "ORIG_HEAD",
        "FETCH_HEAD",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "REBASE_HEAD",
        "index",
        "packed-refs",
        "refs",
        "logs/HEAD",
        "logs/refs",
        "sequencer",
        "rebase-apply",
        "rebase-merge",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

pub fn is_git_critical_path(path: &str) -> bool {
    let normalized = path.trim_start_matches(".git/").replace('\\', "/");

    git_critical_paths()
        .into_iter()
        .any(|critical| normalized == critical || normalized.starts_with(&format!("{critical}/")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchEventKind {
    GitCritical,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DebounceDecision {
    pub deadline_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Debouncer {
    debounce_ms: u64,
    pending: Option<u64>,
    pending_kinds: BTreeSet<WatchEventKindKey>,
}

impl Debouncer {
    pub fn new(debounce: Duration) -> Self {
        let debounce_ms = debounce
            .as_millis()
            .clamp(u128::from(MIN_DEBOUNCE_MS), u128::from(MAX_DEBOUNCE_MS))
            as u64;

        Self {
            debounce_ms,
            pending: None,
            pending_kinds: BTreeSet::new(),
        }
    }

    pub fn default_status_debounce() -> Self {
        Self::new(Duration::from_millis(DEFAULT_DEBOUNCE_MS))
    }

    pub fn push(&mut self, now_ms: u64, kind: WatchEventKind) -> DebounceDecision {
        let deadline_ms = now_ms.saturating_add(self.debounce_ms);

        self.pending = Some(deadline_ms);
        self.pending_kinds.insert(kind.into());

        DebounceDecision { deadline_ms }
    }

    pub fn take_due(&mut self, now_ms: u64) -> Option<Vec<WatchEventKind>> {
        let deadline_ms = self.pending?;

        if now_ms < deadline_ms {
            return None;
        }

        self.pending = None;

        Some(
            std::mem::take(&mut self.pending_kinds)
                .into_iter()
                .map(Into::into)
                .collect(),
        )
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }
}

impl Default for Debouncer {
    fn default() -> Self {
        Self::default_status_debounce()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum WatchEventKindKey {
    GitCritical,
    Workspace,
}

impl From<WatchEventKind> for WatchEventKindKey {
    fn from(value: WatchEventKind) -> Self {
        match value {
            WatchEventKind::GitCritical => Self::GitCritical,
            WatchEventKind::Workspace => Self::Workspace,
        }
    }
}

impl From<WatchEventKindKey> for WatchEventKind {
    fn from(value: WatchEventKindKey) -> Self {
        match value {
            WatchEventKindKey::GitCritical => Self::GitCritical,
            WatchEventKindKey::Workspace => Self::Workspace,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshDecision {
    Scheduled { deadline_ms: u64 },
    RunNow,
    SuppressedByWriteLock,
    SkippedStatusInProgress,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StatusRefreshCoordinator {
    debouncer: Debouncer,
    write_lock_depth: usize,
    status_in_progress: bool,
    refresh_after_write: bool,
    refresh_after_status: bool,
}

impl StatusRefreshCoordinator {
    pub fn new(debouncer: Debouncer) -> Self {
        Self {
            debouncer,
            ..Self::default()
        }
    }

    pub fn begin_write(&mut self) {
        self.write_lock_depth = self.write_lock_depth.saturating_add(1);
    }

    pub fn end_write(&mut self) -> Option<RefreshDecision> {
        self.write_lock_depth = self.write_lock_depth.saturating_sub(1);

        if self.write_lock_depth == 0 && self.refresh_after_write {
            self.refresh_after_write = false;

            if self.status_in_progress {
                self.refresh_after_status = true;
                Some(RefreshDecision::SkippedStatusInProgress)
            } else {
                self.status_in_progress = true;
                Some(RefreshDecision::RunNow)
            }
        } else {
            None
        }
    }

    pub fn watcher_event(&mut self, now_ms: u64, kind: WatchEventKind) -> RefreshDecision {
        if self.write_lock_depth > 0 {
            self.refresh_after_write = true;
            return RefreshDecision::SuppressedByWriteLock;
        }

        let decision = self.debouncer.push(now_ms, kind);
        RefreshDecision::Scheduled {
            deadline_ms: decision.deadline_ms,
        }
    }

    pub fn poll_due(&mut self, now_ms: u64) -> Option<RefreshDecision> {
        self.debouncer.take_due(now_ms)?;

        if self.write_lock_depth > 0 {
            self.refresh_after_write = true;
            return Some(RefreshDecision::SuppressedByWriteLock);
        }

        if self.status_in_progress {
            self.refresh_after_status = true;
            return Some(RefreshDecision::SkippedStatusInProgress);
        }

        self.status_in_progress = true;
        Some(RefreshDecision::RunNow)
    }

    pub fn finish_status(&mut self) -> Option<RefreshDecision> {
        self.status_in_progress = false;

        if self.refresh_after_status {
            self.refresh_after_status = false;
            self.status_in_progress = true;
            Some(RefreshDecision::RunNow)
        } else {
            None
        }
    }

    pub fn status_in_progress(&self) -> bool {
        self.status_in_progress
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_plan_enables_fsmonitor_and_untracked_cache() {
        let plan = plan_realtime(RealtimePlanInput {
            platform: RealtimePlatform::Macos,
            git_builtin_fsmonitor_supported: false,
            requested_workspace_watches: 10,
            os_watch_limit: Some(10),
        });

        assert!(plan.fsmonitor.enable_builtin);
        assert!(plan.fsmonitor.enable_untracked_cache);
        assert_eq!(
            plan.git_config_args(),
            [
                "-c",
                "core.fsmonitor=true",
                "-c",
                "core.untrackedCache=true"
            ]
        );
    }

    #[test]
    fn linux_without_builtin_fsmonitor_falls_back_to_untracked_cache() {
        let plan = plan_realtime(RealtimePlanInput {
            platform: RealtimePlatform::Linux,
            git_builtin_fsmonitor_supported: false,
            requested_workspace_watches: 1,
            os_watch_limit: None,
        });

        assert!(!plan.fsmonitor.enable_builtin);
        assert!(plan.fsmonitor.enable_untracked_cache);
        assert_eq!(plan.fsmonitor.reason, FsmonitorReason::GitUnsupported);
        assert_eq!(plan.git_config_args(), ["-c", "core.untrackedCache=true"]);
    }

    #[test]
    fn git_watcher_tracks_critical_state_paths() {
        let paths = git_critical_paths();

        assert!(paths.contains(&"HEAD".to_owned()));
        assert!(paths.contains(&"refs".to_owned()));
        assert!(paths.contains(&"index".to_owned()));
        assert!(paths.contains(&"packed-refs".to_owned()));
        assert!(paths.contains(&"MERGE_HEAD".to_owned()));
        assert!(is_git_critical_path(".git/refs/heads/main"));
        assert!(is_git_critical_path("rebase-merge/head-name"));
        assert!(!is_git_critical_path("objects/pack/pack-1.idx"));
    }

    #[test]
    fn workspace_watcher_degrades_to_polling_when_watch_limit_is_exceeded() {
        let plan = plan_realtime(RealtimePlanInput {
            platform: RealtimePlatform::Windows,
            git_builtin_fsmonitor_supported: true,
            requested_workspace_watches: 101,
            os_watch_limit: Some(100),
        });

        assert_eq!(
            plan.workspace_watcher,
            WorkspaceWatcherPlan {
                mode: WatcherMode::Polling {
                    interval_ms: DEFAULT_POLLING_INTERVAL_MS,
                },
                reason: WorkspaceWatcherReason::WatchLimitExceeded,
            }
        );
    }

    #[test]
    fn debouncer_clamps_to_supported_status_window_and_coalesces_events() {
        let mut debouncer = Debouncer::new(Duration::from_millis(10));

        assert_eq!(
            debouncer.push(1_000, WatchEventKind::Workspace),
            DebounceDecision { deadline_ms: 1_300 }
        );
        assert_eq!(
            debouncer.push(1_100, WatchEventKind::GitCritical),
            DebounceDecision { deadline_ms: 1_400 }
        );
        assert_eq!(debouncer.take_due(1_399), None);
        assert_eq!(
            debouncer.take_due(1_400),
            Some(vec![WatchEventKind::GitCritical, WatchEventKind::Workspace])
        );
        assert!(!debouncer.has_pending());
    }

    #[test]
    fn write_lock_suppresses_self_events_and_refreshes_once_after_unlock() {
        let mut coordinator =
            StatusRefreshCoordinator::new(Debouncer::new(Duration::from_millis(400)));

        coordinator.begin_write();
        assert_eq!(
            coordinator.watcher_event(10, WatchEventKind::Workspace),
            RefreshDecision::SuppressedByWriteLock
        );
        assert_eq!(
            coordinator.watcher_event(20, WatchEventKind::GitCritical),
            RefreshDecision::SuppressedByWriteLock
        );

        assert_eq!(coordinator.end_write(), Some(RefreshDecision::RunNow));
        assert!(coordinator.status_in_progress());
        assert_eq!(coordinator.finish_status(), None);
    }

    #[test]
    fn only_one_status_runs_at_a_time_and_pending_refresh_runs_after_finish() {
        let mut coordinator =
            StatusRefreshCoordinator::new(Debouncer::new(Duration::from_millis(400)));

        assert_eq!(
            coordinator.watcher_event(0, WatchEventKind::Workspace),
            RefreshDecision::Scheduled { deadline_ms: 400 }
        );
        assert_eq!(coordinator.poll_due(400), Some(RefreshDecision::RunNow));
        assert_eq!(
            coordinator.watcher_event(410, WatchEventKind::GitCritical),
            RefreshDecision::Scheduled { deadline_ms: 810 }
        );
        assert_eq!(
            coordinator.poll_due(810),
            Some(RefreshDecision::SkippedStatusInProgress)
        );
        assert_eq!(coordinator.finish_status(), Some(RefreshDecision::RunNow));
    }
}
