use artistic_git_app::{HealthResponse, OpenLogDirResponse};
use artistic_git_contracts::{
    AppError, AppEvent, BranchListResponse, ConflictFile, DiffPayload, GitDistManifest,
    LocalChangesResponse, LogPageRequest, LogPageResponse, LogSearchRequest, OpenRepositoryRequest,
    OpenRepositoryResponse, RepositoryPathRequest, RepositorySummary, StashListResponse,
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
        .register::<RepositoryPathRequest>()
        .register::<RepositorySummary>()
        .register::<BranchListResponse>()
        .register::<LocalChangesResponse>()
        .register::<StashListResponse>()
        .register::<LogPageRequest>()
        .register::<LogSearchRequest>()
        .register::<LogPageResponse>()
        .register::<AppError>()
        .register::<AppEvent>()
        .register::<AppSettings>()
        .register::<ProjectsDocument>()
        .register::<ProjectSettings>()
        .register::<ConfigChangeEvent>()
        .register::<DiffPayload>()
        .register::<ConflictFile>()
        .register::<GitDistManifest>();

    Typescript::default().export_to("src/lib/ipc/generated.ts", &types, specta_serde::Format)?;

    Ok(())
}
