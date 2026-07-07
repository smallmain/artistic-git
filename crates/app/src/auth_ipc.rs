use artistic_git_contracts::{InvocationId, IpcToken, OperationId};
use artistic_git_helpers::{
    AUTH_INVOCATION_ID_ENV, AUTH_OPERATION_ID_ENV, AUTH_SOCKET_ENV, AUTH_TOKEN_ENV,
};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::{OsStr, OsString},
    fmt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static INVOCATION_COUNTER: AtomicU64 = AtomicU64::new(1);
static OPERATION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractionMode {
    Interactive,
    NonInteractive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonInteractiveAuthStrategy {
    FailImmediately,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InteractionPolicy {
    pub mode: InteractionMode,
    pub non_interactive_strategy: NonInteractiveAuthStrategy,
}

impl InteractionPolicy {
    pub fn interactive() -> Self {
        Self {
            mode: InteractionMode::Interactive,
            non_interactive_strategy: NonInteractiveAuthStrategy::FailImmediately,
        }
    }

    pub fn background_non_interactive() -> Self {
        Self {
            mode: InteractionMode::NonInteractive,
            non_interactive_strategy: NonInteractiveAuthStrategy::FailImmediately,
        }
    }

    pub fn prompt_decision(self) -> AuthPromptDecision {
        match self.mode {
            InteractionMode::Interactive => AuthPromptDecision::Prompt,
            InteractionMode::NonInteractive => match self.non_interactive_strategy {
                NonInteractiveAuthStrategy::FailImmediately => AuthPromptDecision::FailImmediately,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthPromptDecision {
    Prompt,
    FailImmediately,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthOperationSession {
    pub operation_id: OperationId,
    pub interaction_policy: InteractionPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthInvocation {
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub token: IpcToken,
    pub interaction_policy: InteractionPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedAuthInvocation {
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub interaction_policy: InteractionPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthIpcError {
    UnknownOperation(OperationId),
    UnknownInvocation(InvocationId),
    InvalidToken(InvocationId),
    TokenAlreadyUsed(InvocationId),
    RandomUnavailable(String),
}

impl fmt::Display for AuthIpcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownOperation(operation_id) => {
                write!(
                    formatter,
                    "unknown auth operation {}",
                    operation_id.as_str()
                )
            }
            Self::UnknownInvocation(invocation_id) => {
                write!(
                    formatter,
                    "unknown auth invocation {}",
                    invocation_id.as_str()
                )
            }
            Self::InvalidToken(invocation_id) => {
                write!(
                    formatter,
                    "invalid auth token for {}",
                    invocation_id.as_str()
                )
            }
            Self::TokenAlreadyUsed(invocation_id) => {
                write!(
                    formatter,
                    "auth token for {} was already consumed",
                    invocation_id.as_str()
                )
            }
            Self::RandomUnavailable(error) => {
                write!(formatter, "random token generation unavailable: {error}")
            }
        }
    }
}

impl std::error::Error for AuthIpcError {}

#[derive(Debug, Clone)]
struct OperationState {
    interaction_policy: InteractionPolicy,
    invocation_ids: Vec<InvocationId>,
}

#[derive(Debug, Clone)]
struct InvocationState {
    operation_id: OperationId,
    token: Option<IpcToken>,
    interaction_policy: InteractionPolicy,
}

#[derive(Debug, Default)]
pub struct AuthIpcSessionManager {
    operations: HashMap<String, OperationState>,
    invocations: HashMap<String, InvocationState>,
}

impl AuthIpcSessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start_operation(
        &mut self,
        interaction_policy: InteractionPolicy,
    ) -> Result<AuthOperationSession, AuthIpcError> {
        let operation_id = OperationId::new(random_identifier("op", &OPERATION_COUNTER, 16)?);
        Ok(self.start_operation_with_id(operation_id, interaction_policy))
    }

    pub fn start_operation_with_id(
        &mut self,
        operation_id: OperationId,
        interaction_policy: InteractionPolicy,
    ) -> AuthOperationSession {
        self.operations.insert(
            operation_id.as_str().to_owned(),
            OperationState {
                interaction_policy,
                invocation_ids: Vec::new(),
            },
        );

        AuthOperationSession {
            operation_id,
            interaction_policy,
        }
    }

    pub fn issue_invocation(
        &mut self,
        operation_id: &OperationId,
    ) -> Result<AuthInvocation, AuthIpcError> {
        let operation = self
            .operations
            .get_mut(operation_id.as_str())
            .ok_or_else(|| AuthIpcError::UnknownOperation(operation_id.clone()))?;
        let invocation_id = InvocationId::new(random_identifier("inv", &INVOCATION_COUNTER, 16)?);
        let token = IpcToken::new(random_token()?);

        operation.invocation_ids.push(invocation_id.clone());
        self.invocations.insert(
            invocation_id.as_str().to_owned(),
            InvocationState {
                operation_id: operation_id.clone(),
                token: Some(token.clone()),
                interaction_policy: operation.interaction_policy,
            },
        );

        Ok(AuthInvocation {
            operation_id: operation_id.clone(),
            invocation_id,
            token,
            interaction_policy: operation.interaction_policy,
        })
    }

    pub fn validate_token(
        &mut self,
        invocation_id: &InvocationId,
        token: &IpcToken,
    ) -> Result<ValidatedAuthInvocation, AuthIpcError> {
        let state = self
            .invocations
            .get_mut(invocation_id.as_str())
            .ok_or_else(|| AuthIpcError::UnknownInvocation(invocation_id.clone()))?;

        match &state.token {
            Some(expected) if expected == token => {
                state.token = None;
                Ok(ValidatedAuthInvocation {
                    operation_id: state.operation_id.clone(),
                    invocation_id: invocation_id.clone(),
                    interaction_policy: state.interaction_policy,
                })
            }
            Some(_) => Err(AuthIpcError::InvalidToken(invocation_id.clone())),
            None => Err(AuthIpcError::TokenAlreadyUsed(invocation_id.clone())),
        }
    }

    pub fn invocation_ids_for_operation(&self, operation_id: &OperationId) -> Vec<InvocationId> {
        self.operations
            .get(operation_id.as_str())
            .map(|operation| operation.invocation_ids.clone())
            .unwrap_or_default()
    }
}

fn random_identifier(
    prefix: &str,
    counter: &AtomicU64,
    random_bytes: usize,
) -> Result<String, AuthIpcError> {
    let value = counter.fetch_add(1, Ordering::Relaxed);
    Ok(format!(
        "{prefix}-{value}-{}",
        random_hex(random_bytes)
            .map_err(|error| AuthIpcError::RandomUnavailable(error.to_string()))?
    ))
}

fn random_token() -> Result<String, AuthIpcError> {
    random_hex(32).map_err(|error| AuthIpcError::RandomUnavailable(error.to_string()))
}

fn random_hex(bytes: usize) -> Result<String, getrandom::Error> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer)?;

    let mut output = String::with_capacity(buffer.len() * 2);
    for byte in buffer {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    Ok(output)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalIpcEndpoint {
    UnixSocket(PathBuf),
    WindowsNamedPipe(String),
}

impl LocalIpcEndpoint {
    pub fn socket_path(&self) -> Option<&Path> {
        match self {
            Self::UnixSocket(path) => Some(path.as_path()),
            Self::WindowsNamedPipe(_) => None,
        }
    }

    pub fn uses_network_transport(&self) -> bool {
        false
    }

    pub fn display_name(&self) -> String {
        match self {
            Self::UnixSocket(path) => path.to_string_lossy().into_owned(),
            Self::WindowsNamedPipe(name) => name.clone(),
        }
    }
}

#[derive(Debug)]
pub struct LocalIpcListener {
    endpoint: LocalIpcEndpoint,
    #[cfg(unix)]
    _listener: std::os::unix::net::UnixListener,
}

impl LocalIpcListener {
    #[cfg(unix)]
    pub fn bind_unix_socket(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let path = path.into();
        if path.exists() {
            fs::remove_file(&path)?;
        }

        let listener = std::os::unix::net::UnixListener::bind(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;

        Ok(Self {
            endpoint: LocalIpcEndpoint::UnixSocket(path),
            _listener: listener,
        })
    }

    pub fn endpoint(&self) -> &LocalIpcEndpoint {
        &self.endpoint
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsNamedPipeSecurityPlan {
    pub pipe_name: String,
    pub owner_only: bool,
}

impl WindowsNamedPipeSecurityPlan {
    pub fn owner_only(pipe_name: impl Into<String>) -> Self {
        Self {
            pipe_name: pipe_name.into(),
            owner_only: true,
        }
    }

    pub fn endpoint(&self) -> LocalIpcEndpoint {
        LocalIpcEndpoint::WindowsNamedPipe(self.pipe_name.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthHelperBinaries {
    pub credential_helper: PathBuf,
    pub ssh_askpass: PathBuf,
    pub core_ssh_command: OsString,
}

impl AuthHelperBinaries {
    pub fn new(
        credential_helper: impl Into<PathBuf>,
        ssh_askpass: impl Into<PathBuf>,
        core_ssh_command: impl Into<OsString>,
    ) -> Self {
        Self {
            credential_helper: credential_helper.into(),
            ssh_askpass: ssh_askpass.into(),
            core_ssh_command: core_ssh_command.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthGitConfigInjection {
    pub key: &'static str,
    pub value: OsString,
}

impl AuthGitConfigInjection {
    pub fn as_git_arg(&self) -> OsString {
        let mut arg = OsString::from(self.key);
        arg.push("=");
        arg.push(&self.value);
        arg
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthGitCommandInjectionPlan {
    pub socket_path: PathBuf,
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub token: IpcToken,
    pub environment: BTreeMap<String, OsString>,
    pub git_config: Vec<AuthGitConfigInjection>,
}

impl AuthGitCommandInjectionPlan {
    pub fn new(
        endpoint: &LocalIpcEndpoint,
        invocation: &AuthInvocation,
        helpers: &AuthHelperBinaries,
    ) -> Self {
        let socket_path = endpoint
            .socket_path()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(endpoint.display_name()));
        let mut environment = BTreeMap::new();
        environment.insert(
            AUTH_SOCKET_ENV.to_owned(),
            socket_path.clone().into_os_string(),
        );
        environment.insert(
            AUTH_TOKEN_ENV.to_owned(),
            OsString::from(invocation.token.as_str()),
        );
        environment.insert(
            AUTH_INVOCATION_ID_ENV.to_owned(),
            OsString::from(invocation.invocation_id.as_str()),
        );
        environment.insert(
            AUTH_OPERATION_ID_ENV.to_owned(),
            OsString::from(invocation.operation_id.as_str()),
        );
        environment.insert(
            "GIT_ASKPASS".to_owned(),
            helpers.ssh_askpass.clone().into_os_string(),
        );
        environment.insert(
            "SSH_ASKPASS".to_owned(),
            helpers.ssh_askpass.clone().into_os_string(),
        );

        Self {
            socket_path,
            operation_id: invocation.operation_id.clone(),
            invocation_id: invocation.invocation_id.clone(),
            token: invocation.token.clone(),
            environment,
            git_config: vec![
                AuthGitConfigInjection {
                    key: "credential.helper",
                    value: helpers.credential_helper.clone().into_os_string(),
                },
                AuthGitConfigInjection {
                    key: "core.sshCommand",
                    value: helpers.core_ssh_command.clone(),
                },
            ],
        }
    }

    pub fn env(&self, key: &str) -> Option<&OsStr> {
        self.environment.get(key).map(OsString::as_os_str)
    }

    pub fn git_config_args(&self) -> Vec<OsString> {
        let mut args = Vec::with_capacity(self.git_config.len() * 2);
        for config in &self.git_config {
            args.push(OsString::from("-c"));
            args.push(config.as_git_arg());
        }
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_token_is_consumed_after_successful_validation() {
        let mut sessions = AuthIpcSessionManager::new();
        let operation = sessions
            .start_operation_with_id(OperationId::new("op-1"), InteractionPolicy::interactive());
        let invocation = sessions
            .issue_invocation(&operation.operation_id)
            .expect("issue invocation");

        let validated = sessions
            .validate_token(&invocation.invocation_id, &invocation.token)
            .expect("first validation succeeds");
        assert_eq!(validated.operation_id, operation.operation_id);

        let error = sessions
            .validate_token(&invocation.invocation_id, &invocation.token)
            .expect_err("token is one-time");
        assert!(matches!(error, AuthIpcError::TokenAlreadyUsed(_)));
    }

    #[test]
    fn operation_id_can_thread_multiple_invocations() {
        let mut sessions = AuthIpcSessionManager::new();
        let operation_id = OperationId::new("fetch-op");
        sessions.start_operation_with_id(operation_id.clone(), InteractionPolicy::interactive());

        let first = sessions
            .issue_invocation(&operation_id)
            .expect("first invocation");
        let second = sessions
            .issue_invocation(&operation_id)
            .expect("second invocation");

        assert_eq!(first.operation_id, operation_id);
        assert_eq!(second.operation_id, operation_id);
        assert_ne!(first.invocation_id, second.invocation_id);
        assert_eq!(
            sessions.invocation_ids_for_operation(&operation_id),
            vec![first.invocation_id, second.invocation_id]
        );
    }

    #[test]
    fn non_interactive_background_policy_fails_without_prompting() {
        let policy = InteractionPolicy::background_non_interactive();

        assert_eq!(policy.mode, InteractionMode::NonInteractive);
        assert_eq!(
            policy.prompt_decision(),
            AuthPromptDecision::FailImmediately
        );
    }

    #[test]
    fn git_auth_injection_plan_exports_env_and_config() {
        let invocation = AuthInvocation {
            operation_id: OperationId::new("op-1"),
            invocation_id: InvocationId::new("inv-1"),
            token: IpcToken::new("token-1"),
            interaction_policy: InteractionPolicy::interactive(),
        };
        let endpoint = LocalIpcEndpoint::UnixSocket(PathBuf::from("/tmp/artistic-git.sock"));
        let helpers = AuthHelperBinaries::new(
            "/opt/ag/helpers/artistic-git-credential-helper",
            "/opt/ag/helpers/artistic-git-ssh-askpass",
            "/opt/ag/openssh/ssh -o BatchMode=no",
        );

        let plan = AuthGitCommandInjectionPlan::new(&endpoint, &invocation, &helpers);

        assert_eq!(
            plan.env(AUTH_SOCKET_ENV),
            Some(OsStr::new("/tmp/artistic-git.sock"))
        );
        assert_eq!(plan.env(AUTH_TOKEN_ENV), Some(OsStr::new("token-1")));
        assert_eq!(plan.env(AUTH_INVOCATION_ID_ENV), Some(OsStr::new("inv-1")));
        assert_eq!(
            plan.git_config_args(),
            vec![
                OsString::from("-c"),
                OsString::from("credential.helper=/opt/ag/helpers/artistic-git-credential-helper"),
                OsString::from("-c"),
                OsString::from("core.sshCommand=/opt/ag/openssh/ssh -o BatchMode=no"),
            ]
        );
    }

    #[test]
    fn local_ipc_endpoint_declares_non_network_transport() {
        let endpoint = LocalIpcEndpoint::UnixSocket(PathBuf::from("/tmp/artistic-git.sock"));

        assert!(!endpoint.uses_network_transport());
    }

    #[cfg(unix)]
    #[test]
    fn auth_unix_socket_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("auth.sock");
        let listener = LocalIpcListener::bind_unix_socket(&socket).expect("bind unix socket");

        assert_eq!(
            listener.endpoint(),
            &LocalIpcEndpoint::UnixSocket(socket.clone())
        );
        let permissions = std::fs::metadata(&socket)
            .expect("socket metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(permissions, 0o600);
    }
}
