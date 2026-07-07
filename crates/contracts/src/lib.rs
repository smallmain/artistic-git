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

impl InvocationId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl OperationId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IpcToken(pub String);

impl IpcToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

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
pub struct FetchRepositoryRequest {
    pub repository_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FetchRepositoryResponse {
    pub event: FetchStateEvent,
    pub skipped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncCurrentBranchRequest {
    pub repository_path: String,
    pub operation_id: Option<OperationId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncBranchRequest {
    pub repository_path: String,
    pub branch_name: String,
    pub operation_id: Option<OperationId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncAllBranchesRequest {
    pub repository_path: String,
    pub operation_id: Option<OperationId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncCurrentBranchStatus {
    AlreadyUpToDate,
    Pulled,
    Pushed,
    PulledAndPushed,
    Published,
    Conflicts,
    RemoteHistoryChanged,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncCurrentBranchResponse {
    pub repository_path: String,
    pub branch_name: String,
    pub upstream: Option<String>,
    pub status: SyncCurrentBranchStatus,
    pub attempts: u8,
    pub conflict: Option<ConflictEnteredEvent>,
    pub stash_recovery: Option<StashRecoveryPoint>,
    pub remote_history_change: Option<RemoteHistoryChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncBranchResponse {
    pub repository_path: String,
    pub branch_name: String,
    pub upstream: Option<String>,
    pub status: SyncCurrentBranchStatus,
    pub attempts: u8,
    pub message: Option<String>,
    pub conflict: Option<ConflictEnteredEvent>,
    pub stash_recovery: Option<StashRecoveryPoint>,
    pub remote_history_change: Option<RemoteHistoryChange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AutoTrackingRuleStatus {
    Applied,
    AlreadyUpToDate,
    Invalid,
    Conflicts,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoTrackingRuleResult {
    pub source_branch: String,
    pub target_branch: String,
    pub status: AutoTrackingRuleStatus,
    pub message: Option<String>,
    pub conflict: Option<ConflictEnteredEvent>,
    pub stash_recovery: Option<StashRecoveryPoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncAllBranchesResponse {
    pub repository_path: String,
    pub branches: Vec<SyncBranchResponse>,
    pub auto_tracking: Vec<AutoTrackingRuleResult>,
    pub all_up_to_date: bool,
    pub conflict: Option<ConflictEnteredEvent>,
    pub stash_recovery: Option<StashRecoveryPoint>,
    pub remote_history_change: Option<RemoteHistoryChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistoryChange {
    pub branch_name: String,
    pub upstream: String,
    pub local_head: String,
    pub previous_remote_head: String,
    pub remote_head: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AcceptRemoteHistoryRequest {
    pub repository_path: String,
    pub branch_name: String,
    pub operation_id: Option<OperationId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AcceptRemoteHistoryResponse {
    pub repository_path: String,
    pub branch_name: String,
    pub upstream: String,
    pub backup: SafetyBackupSummary,
    pub reset_to_oid: String,
    pub conflict: Option<ConflictEnteredEvent>,
    pub stash_recovery: Option<StashRecoveryPoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SafetyBackupListResponse {
    pub backups: Vec<SafetyBackupSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SafetyBackupSummary {
    pub name: String,
    pub ref_name: String,
    pub original_branch: Option<String>,
    pub created_at_unix_millis: Option<String>,
    pub head_oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSafetyBackupRequest {
    pub repository_path: String,
    pub backup_branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSafetyBackupResponse {
    pub repository_path: String,
    pub backup_branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartReviewModeRequest {
    pub repository_path: String,
    pub operation_id: Option<OperationId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewModeRequest {
    pub repository_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewModeRecoveryRequest {
    pub repository_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewModePullStatus {
    NoRemote,
    NoUpstream,
    AlreadyUpToDate,
    Pulled,
    Offline,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewModeExitStatus {
    Applied,
    NothingToRestore,
    Conflicts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewModeState {
    pub repository_path: String,
    pub branch_name: Option<String>,
    pub head_oid: Option<String>,
    pub latest_commit: Option<CommitSummary>,
    pub auto_stash: Option<StashEntry>,
    pub pull_status: ReviewModePullStatus,
    pub pull_message: Option<String>,
    pub has_remote_update: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartReviewModeResponse {
    pub state: ReviewModeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncReviewModeResponse {
    pub state: ReviewModeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExitReviewModeResponse {
    pub repository_path: String,
    pub status: ReviewModeExitStatus,
    pub conflict: Option<ConflictEnteredEvent>,
    pub stash_recovery: Option<StashRecoveryPoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewModeRecoveryResponse {
    pub repository_path: String,
    pub auto_stash: Option<StashEntry>,
    pub should_prompt: bool,
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
pub struct ConflictListRequest {
    pub repository_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictListResponse {
    pub operation: Option<ConflictOperation>,
    pub files: Vec<ConflictFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictOperation {
    pub kind: ConflictOperationKind,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictOperationKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPathRequest {
    pub repository_path: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDetailResponse {
    pub file: ConflictFile,
    pub detail: ConflictFileDetail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConflictFileDetail {
    Text {
        current_text: String,
        own_text: String,
        other_text: String,
        hunks: Vec<ConflictHunk>,
        language: Option<String>,
    },
    Binary {
        own: Option<ConflictSideFile>,
        other: Option<ConflictSideFile>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictHunk {
    pub id: u32,
    pub start_line: u32,
    pub end_line: u32,
    pub start_offset: u32,
    pub end_offset: u32,
    pub own_text: String,
    pub other_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSideFile {
    pub side: ConflictSide,
    pub oid: Option<String>,
    pub size_bytes: Option<u32>,
    pub modified_unix_seconds: Option<String>,
    pub mime_type: Option<String>,
    pub preview: Option<ConflictImagePreview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictImagePreview {
    pub data_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Own,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSelectSideRequest {
    pub repository_path: String,
    pub paths: Vec<String>,
    pub side: ConflictSide,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSelectSideResponse {
    pub files: Vec<ConflictFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSaveResolutionRequest {
    pub repository_path: String,
    pub path: String,
    pub content: String,
    pub pending_hunks: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSaveResolutionResponse {
    pub file: ConflictFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictCompleteRequest {
    pub repository_path: String,
    pub operation_id: OperationId,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictCompleteResponse {
    pub continuation: ConflictOperationKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictCancelRequest {
    pub repository_path: String,
    pub operation_id: OperationId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictCancelResponse {
    pub aborted: ConflictOperationKind,
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
pub struct CloneRepositoryRequest {
    pub url: String,
    pub target_parent_directory: String,
    pub directory_name: String,
    pub tool_identity: Option<ToolGitIdentity>,
    pub operation_id: Option<OperationId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelCloneRepositoryRequest {
    pub operation_id: OperationId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelCloneRepositoryResponse {
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloneRepositoryResponse {
    pub repository: OpenRepositoryResponse,
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
pub struct RemoteSettingsResponse {
    pub repository_path: String,
    pub remote_mode: RepositoryRemoteMode,
    pub origin_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveRemoteSettingsRequest {
    pub repository_path: String,
    pub origin_url: Option<String>,
    #[serde(default)]
    pub remove_origin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchListResponse {
    pub branches: Vec<BranchSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchNameValidationRequest {
    pub repository_path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchNameValidationResponse {
    pub name: String,
    pub valid: bool,
    pub exists: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchRequest {
    pub repository_path: String,
    pub name: String,
    pub base_branch: String,
    pub checkout_immediately: bool,
    pub create_remote: bool,
    pub local_changes_mode: CheckoutLocalChangesMode,
    pub operation_id: Option<OperationId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutBranchRequest {
    pub repository_path: String,
    pub branch_name: String,
    pub local_changes_mode: CheckoutLocalChangesMode,
    pub operation_id: Option<OperationId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckoutLocalChangesMode {
    RequireClean,
    AutoStash,
    Discard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchRequest {
    pub repository_path: String,
    pub branch_name: String,
    pub delete_remote: bool,
    pub force_remote_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BranchOperationResponse {
    Completed {
        repository_path: String,
        branch_name: String,
    },
    Conflicts {
        repository_path: String,
        branch_name: String,
        conflict: ConflictEnteredEvent,
        stash_recovery: Option<StashRecoveryPoint>,
    },
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
pub struct CommitRequest {
    pub repository_path: String,
    pub paths: Vec<String>,
    pub message: String,
    pub large_file_threshold_mb: Option<u32>,
    pub large_file_decision: LargeFileDecision,
    pub disable_repository_gpgsign: bool,
    pub push_immediately: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LargeFileDecision {
    Prompt,
    TrackWithLfs,
    CommitNormally,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CommitResponse {
    Committed {
        oid: String,
        committed_paths: Vec<String>,
        lfs_tracked_paths: Vec<String>,
    },
    LargeFilesNeedDecision {
        large_files: Vec<LargeFileWarning>,
        threshold_mb: u32,
    },
    GpgSignFailed {
        summary: String,
        stderr: String,
    },
    Conflicts {
        conflict: ConflictEnteredEvent,
        recovery: Option<StashRecoveryPoint>,
    },
    NothingToCommit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileWarning {
    pub path: String,
    pub size_bytes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreChangesRequest {
    pub repository_path: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestoreChangesResponse {
    pub restored_paths: Vec<String>,
    pub backup_root: Option<String>,
    pub backed_up_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RevertCommitRequest {
    pub repository_path: String,
    pub oid: String,
    pub push_after_revert: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RevertCommitResponse {
    Reverted {
        oid: String,
        message: String,
        pushed: bool,
    },
    Disabled {
        reason: RevertDisabledReason,
    },
    Conflicted {
        conflict: ConflictEnteredEvent,
        stash_recovery: Option<StashRecoveryPoint>,
        auto_stash: Option<StashEntry>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RevertDisabledReason {
    MergeCommit,
    NotOnCurrentBranch,
    DetachedHead,
    UnbornHead,
    OperationInProgress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AbortRevertRequest {
    pub repository_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AbortRevertResponse {
    pub aborted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalChange {
    pub path: String,
    pub old_path: Option<String>,
    pub change_kind: DiffChangeKind,
    pub index_status: String,
    pub worktree_status: String,
    pub payload: DiffPayload,
    pub diff: DiffContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiffContent {
    Text {
        old_text: Option<String>,
        new_text: Option<String>,
        language: Option<String>,
    },
    Image {
        old_image: Option<DiffAsset>,
        new_image: Option<DiffAsset>,
    },
    Binary {
        message: Option<String>,
    },
    OversizedText {
        message: Option<String>,
    },
    LfsPointer {
        status: LfsContentStatus,
        message: Option<String>,
    },
    Moved {
        message: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffAsset {
    pub alt: Option<String>,
    pub height: Option<u32>,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u32>,
    pub src: String,
    pub width: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LfsContentStatus {
    Loading,
    Missing,
    Error,
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
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
