use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InvocationId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub category: AppErrorCategory,
    pub summary: String,
    pub context: Box<OperationContext>,
    pub git: Option<Box<GitCommandError>>,
}

impl AppError {
    pub fn new(
        category: AppErrorCategory,
        summary: impl Into<String>,
        context: OperationContext,
    ) -> Self {
        Self {
            category,
            summary: summary.into(),
            context: Box::new(context),
            git: None,
        }
    }

    pub fn expected(summary: impl Into<String>, operation_name: impl Into<String>) -> Self {
        Self::new(
            AppErrorCategory::Expected,
            summary,
            OperationContext::new(operation_name),
        )
    }

    pub fn unexpected(summary: impl Into<String>, operation_name: impl Into<String>) -> Self {
        Self::new(
            AppErrorCategory::Unexpected,
            summary,
            OperationContext::new(operation_name),
        )
    }

    pub fn fatal(summary: impl Into<String>, operation_name: impl Into<String>) -> Self {
        Self::new(
            AppErrorCategory::Fatal,
            summary,
            OperationContext::new(operation_name),
        )
    }

    pub fn with_context(mut self, context: OperationContext) -> Self {
        self.context = Box::new(context);
        self
    }

    pub fn with_git(mut self, git: GitCommandError) -> Self {
        self.git = Some(Box::new(git));
        self
    }

    pub fn is_user_recoverable(&self) -> bool {
        self.category.is_user_recoverable()
    }

    pub fn should_report(&self) -> bool {
        self.category.should_report()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AppErrorCategory {
    Expected,
    Unexpected,
    Fatal,
}

impl AppErrorCategory {
    pub fn is_user_recoverable(self) -> bool {
        matches!(self, Self::Expected)
    }

    pub fn should_report(self) -> bool {
        matches!(self, Self::Unexpected | Self::Fatal)
    }

    pub fn terminates_app(self) -> bool {
        matches!(self, Self::Fatal)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationContext {
    pub operation_id: Option<OperationId>,
    pub window_label: Option<String>,
    pub repository_path: Option<String>,
    pub operation_name: String,
}

impl OperationContext {
    pub fn new(operation_name: impl Into<String>) -> Self {
        Self {
            operation_id: None,
            window_label: None,
            repository_path: None,
            operation_name: operation_name.into(),
        }
    }

    pub fn with_operation_id(mut self, operation_id: impl Into<String>) -> Self {
        self.operation_id = Some(OperationId(operation_id.into()));
        self
    }

    pub fn with_window_label(mut self, window_label: impl Into<String>) -> Self {
        self.window_label = Some(window_label.into());
        self
    }

    pub fn with_repository_path(mut self, repository_path: impl Into<String>) -> Self {
        self.repository_path = Some(repository_path.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandError {
    pub command: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppEvent {
    RepoChanged(RepoChangedEvent),
    OperationProgress(OperationProgressEvent),
    FetchState(FetchStateEvent),
    ConflictEntered(ConflictEnteredEvent),
    StashRestoreState(StashRestoreStateEvent),
}

impl AppEvent {
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::RepoChanged(_) => "repo-changed",
            Self::OperationProgress(_) => "operation-progress",
            Self::FetchState(_) => "fetch-state",
            Self::ConflictEntered(_) => "conflict-entered",
            Self::StashRestoreState(_) => "stash-restore-state",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoChangedEvent {
    pub repository_path: String,
    pub changed_queries: Vec<RepoQueryKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RepoQueryKind {
    Summary,
    Branches,
    Stashes,
    LocalChanges,
    History,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgressEvent {
    pub operation_id: OperationId,
    pub label: String,
    pub progress: ProgressState,
    pub cancellable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProgressState {
    Indeterminate,
    Percent { value: f32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FetchStateEvent {
    pub repository_path: String,
    pub state: FetchState,
    pub last_success_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FetchState {
    Idle,
    Fetching,
    Offline,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEnteredEvent {
    pub operation_id: OperationId,
    pub repository_path: String,
    pub operation_name: String,
    pub files: Vec<ConflictFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub status: ConflictResolutionStatus,
    pub file_kind: DiffFileKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashRestoreStateEvent {
    pub repository_path: String,
    pub selector: String,
    pub recovery: StashRecoveryPoint,
    pub status: StashRestoreStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolutionStatus {
    Unresolved,
    Resolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub old_path: Option<String>,
    pub new_path: String,
    pub change_kind: DiffChangeKind,
    pub file_kind: DiffFileKind,
    pub lfs_lock: Option<LfsLockStatus>,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffFileKind {
    Text,
    Binary,
    Image,
    LfsPointer,
    OversizedText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LfsLockStatus {
    pub locked: bool,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolGitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenRepositoryRequest {
    pub path: String,
    pub tool_identity: Option<ToolGitIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenRepositoryResponse {
    pub repository_path: String,
    pub git_dir: String,
    pub remote_mode: RepositoryRemoteMode,
    pub remotes: Vec<RepositoryRemote>,
    pub warnings: Vec<RepositoryOpenWarning>,
    pub health: RepositoryHealth,
    pub summary: RepositorySummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRemote {
    pub name: String,
    pub url: String,
    pub is_origin: bool,
    pub managed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryRemoteMode {
    Origin,
    NoRemote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOpenWarning {
    pub kind: RepositoryOpenWarningKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryOpenWarningKind {
    MultipleRemotesOriginManaged,
    MultipleRemotesNoOrigin,
    NoRemote,
    DetachedHead,
    UnbornHead,
    OperationInProgress,
    IndexLockPresent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryHealth {
    pub head: RepositoryHeadState,
    pub middle_states: Vec<RepositoryMiddleState>,
    pub index_lock: Option<IndexLockInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepositoryHeadState {
    Branch { name: String, oid: Option<String> },
    Detached { oid: String },
    Unborn { branch: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMiddleState {
    pub kind: RepositoryMiddleStateKind,
    pub path: String,
    pub abort_command: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryMiddleStateKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexLockInfo {
    pub path: String,
    pub age_seconds: u32,
    pub warning: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySummary {
    pub repository_path: String,
    pub current_branch: Option<String>,
    pub head_oid: Option<String>,
    pub remote_mode: RepositoryRemoteMode,
    pub has_origin: bool,
    pub is_detached: bool,
    pub is_unborn: bool,
    pub in_progress: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryPathRequest {
    pub repository_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchListResponse {
    pub branches: Vec<BranchSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummary {
    pub name: String,
    pub short_name: String,
    pub existence: BranchExistence,
    pub current: bool,
    pub head_oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub latest_commit_unix_seconds: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BranchExistence {
    LocalOnly,
    RemoteOnly,
    LocalAndRemote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalChangesResponse {
    pub changes: Vec<LocalChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalChange {
    pub path: String,
    pub old_path: Option<String>,
    pub change_kind: DiffChangeKind,
    pub index_status: String,
    pub worktree_status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashListResponse {
    pub stashes: Vec<StashEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub selector: String,
    pub oid: String,
    pub message: String,
    pub branch: Option<String>,
    pub created_at_unix_seconds: Option<String>,
    pub is_auto_stash: bool,
    pub origin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateStashRequest {
    pub repository_path: String,
    pub message: String,
    pub include_untracked: bool,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateAutoStashRequest {
    pub repository_path: String,
    pub reason: String,
    pub include_untracked: bool,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateStashResponse {
    pub created: bool,
    pub stash: Option<StashEntry>,
    pub stdout: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteStashRequest {
    pub repository_path: String,
    pub selector: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteStashResponse {
    pub deleted_selector: String,
    pub stdout: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashDetailsRequest {
    pub repository_path: String,
    pub selector: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashDetailsResponse {
    pub entry: StashEntry,
    pub files: Vec<StashDiffFile>,
    pub raw_diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashDiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub change_kind: DiffChangeKind,
    pub file_kind: DiffFileKind,
    pub patch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStashRequest {
    pub repository_path: String,
    pub selector: String,
    pub drop_on_success: bool,
    pub operation_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStashResponse {
    pub selector: String,
    pub oid: String,
    pub recovery: StashRecoveryPoint,
    pub outcome: StashRestoreOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum StashRestoreOutcome {
    Applied { dropped: bool },
    Conflicts { conflict: ConflictEnteredEvent },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelStashRestoreRequest {
    pub repository_path: String,
    pub recovery: StashRecoveryPoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelStashRestoreResponse {
    pub restored: bool,
    pub dropped_recovery_stash: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StashRecoveryPoint {
    pub id: String,
    pub head_oid: Option<String>,
    pub stash_oid: Option<String>,
    pub stash_selector: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StashRestoreStatus {
    Applying,
    Applied,
    Conflicted,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogPageRequest {
    pub repository_path: String,
    pub after: Option<String>,
    pub limit: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchRequest {
    pub repository_path: String,
    pub grep: Option<String>,
    pub author: Option<String>,
    pub pickaxe: Option<String>,
    pub after: Option<String>,
    pub limit: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogPageResponse {
    pub commits: Vec<CommitSummary>,
    pub next_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at_unix_seconds: String,
    pub subject: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitDistManifest {
    pub schema_version: u32,
    pub platform: String,
    pub git_version: String,
    pub git_lfs_version: String,
    pub windows_open_ssh_version: Option<String>,
    pub helper_version: String,
    pub paths: GitDistPaths,
    pub sha256: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitDistPaths {
    pub git_executable: String,
    pub git_lfs_executable: String,
    pub windows_ssh_executable: Option<String>,
    pub credential_helper: String,
    pub ssh_askpass: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_error_serializes_with_camel_case_fields() {
        let error = AppError::unexpected("git failed", "status").with_context(
            OperationContext::new("status")
                .with_operation_id("op-1")
                .with_window_label("main")
                .with_repository_path("/repo"),
        );

        let json = serde_json::to_value(error).expect("serialize error");

        assert_eq!(json["category"], "unexpected");
        assert_eq!(json["summary"], "git failed");
        assert_eq!(json["context"]["operationId"], "op-1");
        assert_eq!(json["context"]["operationName"], "status");
        assert_eq!(json["git"], serde_json::Value::Null);
    }

    #[test]
    fn app_error_category_helpers_express_reporting_semantics() {
        let expected = AppError::expected("invalid path", "openRepository");
        let fatal = AppError::fatal("config unavailable", "startup");

        assert!(expected.is_user_recoverable());
        assert!(!expected.should_report());
        assert!(fatal.should_report());
        assert!(fatal.category.terminates_app());
    }

    #[test]
    fn app_error_serializes_full_git_command_output() {
        let error = AppError::unexpected("git failed", "fetch").with_git(GitCommandError {
            command: vec!["git".to_owned(), "fetch".to_owned(), "origin".to_owned()],
            exit_code: Some(128),
            stdout: "stdout text".to_owned(),
            stderr: "stderr text".to_owned(),
        });

        let json = serde_json::to_value(error).expect("serialize error");

        assert_eq!(json["git"]["command"][1], "fetch");
        assert_eq!(json["git"]["exitCode"], 128);
        assert_eq!(json["git"]["stdout"], "stdout text");
        assert_eq!(json["git"]["stderr"], "stderr text");
    }
}
