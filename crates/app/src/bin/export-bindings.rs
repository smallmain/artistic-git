use artistic_git_app::{
    DeleteHttpsCredentialRequest, GenerateSshKeyRequest, GitignoreFileResponse, GitignoreRequest,
    HealthResponse, HttpsCredentialEntry, HttpsCredentialListResponse, HttpsCredentialPromptReason,
    HttpsCredentialPromptRequest, HttpsCredentialScope, IdentitySourcesResponse,
    IdentityValidationRequest, IdentityValidationResponse, OpenLogDirResponse,
    ProjectSettingsRequest, SaveAppSettingsRequest, SaveGitignoreRequest,
    SaveHttpsCredentialRequest, SaveProjectSettingsRequest, SettingsSnapshot, SshKeyStatus,
    SshPassphrasePromptRequest,
};
use artistic_git_contracts::{
    AbortRevertRequest, AbortRevertResponse, AcceptRemoteHistoryRequest,
    AcceptRemoteHistoryResponse, AppError, AppEvent, BranchListResponse,
    BranchNameValidationRequest, BranchNameValidationResponse, BranchOperationResponse,
    CancelCloneRepositoryRequest, CancelCloneRepositoryResponse, CancelOperationRequest,
    CancelOperationResponse, CancelStashRestoreRequest, CancelStashRestoreResponse,
    CheckoutBranchRequest, CloneRepositoryRequest, CloneRepositoryResponse, CommitRequest,
    CommitResponse, ConflictCancelRequest, ConflictCancelResponse, ConflictCompleteRequest,
    ConflictCompleteResponse, ConflictDetailResponse, ConflictFile, ConflictListRequest,
    ConflictListResponse, ConflictPathRequest, ConflictSaveResolutionRequest,
    ConflictSaveResolutionResponse, ConflictSelectSideRequest, ConflictSelectSideResponse,
    CreateAutoStashRequest, CreateBranchRequest, CreateStashRequest, CreateStashResponse,
    DeleteBranchRequest, DeleteSafetyBackupRequest, DeleteSafetyBackupResponse, DeleteStashRequest,
    DeleteStashResponse, DiffAsset, DiffContent, DiffPayload, ExitReviewModeResponse,
    FetchRepositoryRequest, FetchRepositoryResponse, GitDistManifest, LargeFileWarning,
    LfsContentStatus, LocalChangesResponse, LogPageRequest, LogPageResponse, LogSearchRequest,
    OpenRepositoryRequest, OpenRepositoryResponse, RemoteSettingsResponse,
    RenormalizePreviewRequest, RenormalizePreviewResponse, RepositoryPathRequest,
    RepositorySummary, RestoreChangesRequest, RestoreChangesResponse, RestoreStashRequest,
    RestoreStashResponse, RevertCommitRequest, RevertCommitResponse, ReviewModeRecoveryRequest,
    ReviewModeRecoveryResponse, ReviewModeRequest, SafetyBackupListResponse,
    SaveRemoteSettingsRequest, StartReviewModeRequest, StartReviewModeResponse,
    StashDetailsRequest, StashDetailsResponse, StashListResponse, SyncAllBranchesRequest,
    SyncAllBranchesResponse, SyncBranchRequest, SyncBranchResponse, SyncCurrentBranchRequest,
    SyncCurrentBranchResponse, SyncReviewModeResponse,
};
use artistic_git_core::config::{
    AppSettings, ConfigChangeEvent, ProjectSettings, ProjectsDocument,
};
use specta::Types;
use specta_typescript::Typescript;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let types = Types::default()
        .register::<HealthResponse>()
        .register::<OpenLogDirResponse>()
        .register::<OpenRepositoryRequest>()
        .register::<OpenRepositoryResponse>()
        .register::<CloneRepositoryRequest>()
        .register::<CloneRepositoryResponse>()
        .register::<CancelCloneRepositoryRequest>()
        .register::<CancelCloneRepositoryResponse>()
        .register::<CancelOperationRequest>()
        .register::<CancelOperationResponse>()
        .register::<RepositoryPathRequest>()
        .register::<RepositorySummary>()
        .register::<FetchRepositoryRequest>()
        .register::<FetchRepositoryResponse>()
        .register::<SyncCurrentBranchRequest>()
        .register::<SyncCurrentBranchResponse>()
        .register::<SyncBranchRequest>()
        .register::<SyncBranchResponse>()
        .register::<SyncAllBranchesRequest>()
        .register::<SyncAllBranchesResponse>()
        .register::<AcceptRemoteHistoryRequest>()
        .register::<AcceptRemoteHistoryResponse>()
        .register::<StartReviewModeRequest>()
        .register::<StartReviewModeResponse>()
        .register::<ReviewModeRequest>()
        .register::<SyncReviewModeResponse>()
        .register::<ExitReviewModeResponse>()
        .register::<ReviewModeRecoveryRequest>()
        .register::<ReviewModeRecoveryResponse>()
        .register::<RemoteSettingsResponse>()
        .register::<SaveRemoteSettingsRequest>()
        .register::<BranchListResponse>()
        .register::<SafetyBackupListResponse>()
        .register::<BranchNameValidationRequest>()
        .register::<BranchNameValidationResponse>()
        .register::<CreateBranchRequest>()
        .register::<CheckoutBranchRequest>()
        .register::<DeleteBranchRequest>()
        .register::<DeleteSafetyBackupRequest>()
        .register::<DeleteSafetyBackupResponse>()
        .register::<BranchOperationResponse>()
        .register::<LocalChangesResponse>()
        .register::<RenormalizePreviewRequest>()
        .register::<RenormalizePreviewResponse>()
        .register::<StashListResponse>()
        .register::<CreateStashRequest>()
        .register::<CreateAutoStashRequest>()
        .register::<CreateStashResponse>()
        .register::<StashDetailsRequest>()
        .register::<StashDetailsResponse>()
        .register::<RestoreStashRequest>()
        .register::<RestoreStashResponse>()
        .register::<CancelStashRestoreRequest>()
        .register::<CancelStashRestoreResponse>()
        .register::<DeleteStashRequest>()
        .register::<DeleteStashResponse>()
        .register::<ConflictListRequest>()
        .register::<ConflictListResponse>()
        .register::<ConflictPathRequest>()
        .register::<ConflictDetailResponse>()
        .register::<ConflictSelectSideRequest>()
        .register::<ConflictSelectSideResponse>()
        .register::<ConflictSaveResolutionRequest>()
        .register::<ConflictSaveResolutionResponse>()
        .register::<ConflictCompleteRequest>()
        .register::<ConflictCompleteResponse>()
        .register::<ConflictCancelRequest>()
        .register::<ConflictCancelResponse>()
        .register::<CommitRequest>()
        .register::<CommitResponse>()
        .register::<LargeFileWarning>()
        .register::<RestoreChangesRequest>()
        .register::<RestoreChangesResponse>()
        .register::<RevertCommitRequest>()
        .register::<RevertCommitResponse>()
        .register::<AbortRevertRequest>()
        .register::<AbortRevertResponse>()
        .register::<LogPageRequest>()
        .register::<LogSearchRequest>()
        .register::<LogPageResponse>()
        .register::<SettingsSnapshot>()
        .register::<SaveAppSettingsRequest>()
        .register::<ProjectSettingsRequest>()
        .register::<SaveProjectSettingsRequest>()
        .register::<GitignoreRequest>()
        .register::<SaveGitignoreRequest>()
        .register::<GitignoreFileResponse>()
        .register::<IdentitySourcesResponse>()
        .register::<IdentityValidationRequest>()
        .register::<IdentityValidationResponse>()
        .register::<SshKeyStatus>()
        .register::<GenerateSshKeyRequest>()
        .register::<HttpsCredentialListResponse>()
        .register::<HttpsCredentialEntry>()
        .register::<DeleteHttpsCredentialRequest>()
        .register::<SaveHttpsCredentialRequest>()
        .register::<HttpsCredentialPromptRequest>()
        .register::<HttpsCredentialPromptReason>()
        .register::<HttpsCredentialScope>()
        .register::<SshPassphrasePromptRequest>()
        .register::<AppError>()
        .register::<AppEvent>()
        .register::<AppSettings>()
        .register::<ProjectsDocument>()
        .register::<ProjectSettings>()
        .register::<ConfigChangeEvent>()
        .register::<DiffAsset>()
        .register::<DiffContent>()
        .register::<DiffPayload>()
        .register::<LfsContentStatus>()
        .register::<ConflictFile>()
        .register::<GitDistManifest>();

    Typescript::default().export_to("src/lib/ipc/generated.ts", &types, specta_serde::Format)?;

    Ok(())
}
