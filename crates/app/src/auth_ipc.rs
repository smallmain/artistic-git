use artistic_git_contracts::{InvocationId, IpcToken, OperationId};
use artistic_git_git_runner::GitCommandPlan;
use artistic_git_helpers::{
    HelperIpcEnvelope, HelperIpcPayload, HelperIpcResponse, AUTH_INVOCATION_ID_ENV,
    AUTH_OPERATION_ID_ENV, AUTH_SOCKET_ENV, AUTH_TOKEN_ENV,
};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::{OsStr, OsString},
    fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex},
    thread,
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
    pub repository_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthInvocation {
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub token: IpcToken,
    pub interaction_policy: InteractionPolicy,
    pub repository_path: Option<PathBuf>,
    pub host: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedAuthInvocation {
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub interaction_policy: InteractionPolicy,
    pub repository_path: Option<PathBuf>,
    pub host: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AuthInvocationContext {
    pub repository_path: Option<PathBuf>,
    pub host: Option<String>,
    pub path: Option<String>,
}

impl AuthInvocationContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_repository_path(mut self, repository_path: impl Into<PathBuf>) -> Self {
        self.repository_path = Some(repository_path.into());
        self
    }

    pub fn with_host(mut self, host: impl Into<String>) -> Self {
        self.host = Some(host.into());
        self
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
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
    repository_path: Option<PathBuf>,
    invocation_ids: Vec<InvocationId>,
}

#[derive(Debug, Clone)]
struct InvocationState {
    operation_id: OperationId,
    token: Option<IpcToken>,
    interaction_policy: InteractionPolicy,
    context: AuthInvocationContext,
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
        self.start_operation_with_context(operation_id, interaction_policy, None)
    }

    pub fn start_operation_with_context(
        &mut self,
        operation_id: OperationId,
        interaction_policy: InteractionPolicy,
        repository_path: Option<PathBuf>,
    ) -> AuthOperationSession {
        self.operations.insert(
            operation_id.as_str().to_owned(),
            OperationState {
                interaction_policy,
                repository_path: repository_path.clone(),
                invocation_ids: Vec::new(),
            },
        );

        AuthOperationSession {
            operation_id,
            interaction_policy,
            repository_path,
        }
    }

    pub fn issue_invocation(
        &mut self,
        operation_id: &OperationId,
    ) -> Result<AuthInvocation, AuthIpcError> {
        self.issue_invocation_with_context(operation_id, AuthInvocationContext::new())
    }

    pub fn issue_invocation_with_context(
        &mut self,
        operation_id: &OperationId,
        mut context: AuthInvocationContext,
    ) -> Result<AuthInvocation, AuthIpcError> {
        let operation = self
            .operations
            .get_mut(operation_id.as_str())
            .ok_or_else(|| AuthIpcError::UnknownOperation(operation_id.clone()))?;
        let invocation_id = InvocationId::new(random_identifier("inv", &INVOCATION_COUNTER, 16)?);
        let token = IpcToken::new(random_token()?);
        if context.repository_path.is_none() {
            context.repository_path = operation.repository_path.clone();
        }

        operation.invocation_ids.push(invocation_id.clone());
        self.invocations.insert(
            invocation_id.as_str().to_owned(),
            InvocationState {
                operation_id: operation_id.clone(),
                token: Some(token.clone()),
                interaction_policy: operation.interaction_policy,
                context: context.clone(),
            },
        );

        Ok(AuthInvocation {
            operation_id: operation_id.clone(),
            invocation_id,
            token,
            interaction_policy: operation.interaction_policy,
            repository_path: context.repository_path,
            host: context.host,
            path: context.path,
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
                    repository_path: state.context.repository_path.clone(),
                    host: state.context.host.clone(),
                    path: state.context.path.clone(),
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthIpcRequestContext {
    pub operation_id: OperationId,
    pub invocation_id: InvocationId,
    pub interaction_policy: InteractionPolicy,
    pub prompt_decision: AuthPromptDecision,
    pub repository_path: Option<PathBuf>,
    pub host: Option<String>,
    pub path: Option<String>,
}

impl AuthIpcRequestContext {
    fn from_validated(
        validated: ValidatedAuthInvocation,
        payload: &HelperIpcPayload,
    ) -> AuthIpcRequestContext {
        let (payload_host, payload_path) = match payload {
            HelperIpcPayload::Credential { credential } => {
                (credential.host.clone(), credential.path.clone())
            }
            HelperIpcPayload::Askpass { .. } => (None, None),
        };

        AuthIpcRequestContext {
            operation_id: validated.operation_id,
            invocation_id: validated.invocation_id,
            interaction_policy: validated.interaction_policy,
            prompt_decision: validated.interaction_policy.prompt_decision(),
            repository_path: validated.repository_path,
            host: validated.host.or(payload_host),
            path: validated.path.or(payload_path),
        }
    }
}

pub trait AuthIpcHandler: Send + Sync + 'static {
    fn handle_auth_ipc_request(
        &self,
        context: AuthIpcRequestContext,
        payload: HelperIpcPayload,
    ) -> HelperIpcResponse;
}

impl<F> AuthIpcHandler for F
where
    F: Fn(AuthIpcRequestContext, HelperIpcPayload) -> HelperIpcResponse + Send + Sync + 'static,
{
    fn handle_auth_ipc_request(
        &self,
        context: AuthIpcRequestContext,
        payload: HelperIpcPayload,
    ) -> HelperIpcResponse {
        self(context, payload)
    }
}

#[derive(Debug)]
pub struct StaticAuthIpcHandler {
    askpass_secret: Option<String>,
    credential: Option<artistic_git_helpers::GitCredentialResponse>,
}

impl StaticAuthIpcHandler {
    pub fn empty() -> Self {
        Self {
            askpass_secret: None,
            credential: None,
        }
    }

    pub fn askpass(secret: impl Into<String>) -> Self {
        Self {
            askpass_secret: Some(secret.into()),
            credential: None,
        }
    }

    pub fn credential(credential: artistic_git_helpers::GitCredentialResponse) -> Self {
        Self {
            askpass_secret: None,
            credential: Some(credential),
        }
    }
}

impl AuthIpcHandler for StaticAuthIpcHandler {
    fn handle_auth_ipc_request(
        &self,
        context: AuthIpcRequestContext,
        payload: HelperIpcPayload,
    ) -> HelperIpcResponse {
        if context.prompt_decision == AuthPromptDecision::FailImmediately {
            return HelperIpcResponse::Error {
                message: "authentication is required but this operation is non-interactive"
                    .to_owned(),
            };
        }

        match payload {
            HelperIpcPayload::Askpass { .. } => self
                .askpass_secret
                .clone()
                .map(|secret| HelperIpcResponse::Askpass { secret })
                .unwrap_or(HelperIpcResponse::Empty),
            HelperIpcPayload::Credential { .. } => self
                .credential
                .clone()
                .map(|credential| HelperIpcResponse::Credential { credential })
                .unwrap_or(HelperIpcResponse::Empty),
        }
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
    listener: interprocess::local_socket::Listener,
}

impl LocalIpcListener {
    pub fn bind_unix_socket(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
        use std::fs;
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let path = path.into();
        if path.exists() {
            fs::remove_file(&path)?;
        }

        let name = path.clone().to_fs_name::<GenericFilePath>()?;
        let listener = ListenerOptions::new().name(name).create_sync()?;
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;

        Ok(Self {
            endpoint: LocalIpcEndpoint::UnixSocket(path),
            listener,
        })
    }

    #[cfg(windows)]
    pub fn bind_windows_named_pipe(pipe_name: impl Into<String>) -> std::io::Result<Self> {
        use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};

        let pipe_name = pipe_name.into();
        let name = pipe_name.as_str().to_ns_name::<GenericNamespaced>()?;
        let listener = ListenerOptions::new().name(name).create_sync()?;

        Ok(Self {
            endpoint: LocalIpcEndpoint::WindowsNamedPipe(pipe_name),
            listener,
        })
    }

    pub fn bind_platform(path_or_name: impl Into<PathBuf>) -> std::io::Result<Self> {
        let path_or_name = path_or_name.into();
        #[cfg(windows)]
        {
            let name = path_or_name.to_string_lossy().into_owned();
            Self::bind_windows_named_pipe(name)
        }
        #[cfg(not(windows))]
        {
            Self::bind_unix_socket(path_or_name)
        }
    }

    pub fn endpoint(&self) -> &LocalIpcEndpoint {
        &self.endpoint
    }

    pub fn accept(&self) -> std::io::Result<interprocess::local_socket::Stream> {
        use interprocess::local_socket::traits::Listener as _;

        self.listener.accept()
    }
}

pub struct AuthIpcService {
    listener: LocalIpcListener,
    sessions: Arc<Mutex<AuthIpcSessionManager>>,
    handler: Arc<dyn AuthIpcHandler>,
}

impl AuthIpcService {
    pub fn new(
        listener: LocalIpcListener,
        sessions: Arc<Mutex<AuthIpcSessionManager>>,
        handler: Arc<dyn AuthIpcHandler>,
    ) -> Self {
        Self {
            listener,
            sessions,
            handler,
        }
    }

    pub fn endpoint(&self) -> &LocalIpcEndpoint {
        self.listener.endpoint()
    }

    pub fn serve_one(&self) -> std::io::Result<()> {
        let stream = self.listener.accept()?;
        handle_helper_stream(
            stream,
            Arc::clone(&self.sessions),
            Arc::clone(&self.handler),
        );
        Ok(())
    }

    pub fn run_in_background(self) -> AuthIpcServiceHandle {
        let endpoint = self.listener.endpoint().clone();
        let thread = thread::spawn(move || loop {
            match self.listener.accept() {
                Ok(stream) => {
                    let sessions = Arc::clone(&self.sessions);
                    let handler = Arc::clone(&self.handler);
                    thread::spawn(move || handle_helper_stream(stream, sessions, handler));
                }
                Err(error) => {
                    tracing::warn!(error = %error, "auth IPC listener stopped accepting helper connections");
                    break;
                }
            }
        });

        AuthIpcServiceHandle {
            endpoint,
            thread: Some(thread),
        }
    }
}

#[derive(Debug)]
pub struct AuthIpcServiceHandle {
    endpoint: LocalIpcEndpoint,
    thread: Option<thread::JoinHandle<()>>,
}

impl AuthIpcServiceHandle {
    pub fn endpoint(&self) -> &LocalIpcEndpoint {
        &self.endpoint
    }

    pub fn forget(mut self) {
        self.thread.take();
    }
}

fn handle_helper_stream(
    mut stream: interprocess::local_socket::Stream,
    sessions: Arc<Mutex<AuthIpcSessionManager>>,
    handler: Arc<dyn AuthIpcHandler>,
) {
    let response = handle_helper_stream_request(&mut stream, sessions, handler);
    if let Err(error) = write_helper_response(&mut stream, response) {
        tracing::warn!(error = %error, "failed to write auth IPC helper response");
    }
}

fn handle_helper_stream_request(
    stream: &mut interprocess::local_socket::Stream,
    sessions: Arc<Mutex<AuthIpcSessionManager>>,
    handler: Arc<dyn AuthIpcHandler>,
) -> HelperIpcResponse {
    let mut request = Vec::new();
    if let Err(error) = read_ipc_line(stream, &mut request) {
        return HelperIpcResponse::Error {
            message: format!("failed to read auth IPC request: {error}"),
        };
    }

    let envelope = match serde_json::from_slice::<HelperIpcEnvelope>(&request) {
        Ok(envelope) => envelope,
        Err(error) => {
            return HelperIpcResponse::Error {
                message: format!("failed to decode auth IPC request: {error}"),
            };
        }
    };

    // Only token validation touches the session mutex. The prompt/credential handler
    // runs after the lock is released, so helper IPC can continue while a git
    // operation is holding the write permit and waiting for this callback.
    let validated = {
        let mut sessions = match sessions.lock() {
            Ok(sessions) => sessions,
            Err(error) => {
                return HelperIpcResponse::Error {
                    message: format!("auth IPC session table is poisoned: {error}"),
                };
            }
        };
        match sessions.validate_token(&envelope.invocation_id, &envelope.token) {
            Ok(validated) => validated,
            Err(error) => {
                return HelperIpcResponse::Error {
                    message: error.to_string(),
                };
            }
        }
    };

    let context = AuthIpcRequestContext::from_validated(validated, &envelope.payload);
    handler.handle_auth_ipc_request(context, envelope.payload)
}

fn write_helper_response(
    stream: &mut interprocess::local_socket::Stream,
    response: HelperIpcResponse,
) -> std::io::Result<()> {
    let mut body = serde_json::to_vec(&response)?;
    body.push(b'\n');
    stream.write_all(&body)?;
    stream.flush()
}

fn read_ipc_line(
    reader: &mut interprocess::local_socket::Stream,
    output: &mut Vec<u8>,
) -> std::io::Result<()> {
    let mut byte = [0_u8; 1];
    loop {
        let read = reader.read(&mut byte)?;
        if read == 0 {
            break;
        }
        output.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
    }
    Ok(())
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
        environment.insert("SSH_ASKPASS_REQUIRE".to_owned(), OsString::from("force"));

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
                    key: "credential.useHttpPath",
                    value: OsString::from("true"),
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

    pub fn apply_to_command_plan(&self, mut plan: GitCommandPlan) -> GitCommandPlan {
        let mut args = self.git_config_args();
        args.extend(plan.args);
        plan.args = args;
        plan.environment = plan.environment.with_overrides(self.environment.clone());
        plan
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
            repository_path: None,
            host: None,
            path: None,
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
        assert_eq!(plan.env("SSH_ASKPASS_REQUIRE"), Some(OsStr::new("force")));
        assert_eq!(
            plan.git_config_args(),
            vec![
                OsString::from("-c"),
                OsString::from("credential.helper=/opt/ag/helpers/artistic-git-credential-helper"),
                OsString::from("-c"),
                OsString::from("credential.useHttpPath=true"),
                OsString::from("-c"),
                OsString::from("core.sshCommand=/opt/ag/openssh/ssh -o BatchMode=no"),
            ]
        );
    }

    #[test]
    fn git_auth_injection_plan_applies_to_runner_command_plan() {
        use artistic_git_git_runner::{GitDistribution, GitRunner};
        use artistic_git_test_support::{git_dist_manifest_fixture, write_executable_file};

        let temp = tempfile::tempdir().expect("tempdir");
        let manifest = git_dist_manifest_fixture();
        write_manifest_executables(temp.path(), &manifest);
        let distribution =
            GitDistribution::from_manifest(temp.path(), manifest).expect("distribution");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        let invocation = AuthInvocation {
            operation_id: OperationId::new("op-1"),
            invocation_id: InvocationId::new("inv-1"),
            token: IpcToken::new("token-1"),
            interaction_policy: InteractionPolicy::interactive(),
            repository_path: Some(PathBuf::from("/repo")),
            host: Some("example.com".to_owned()),
            path: Some("org/repo".to_owned()),
        };
        let socket_path = temp.path().join("auth.sock");
        let credential_helper_path = temp.path().join("helpers/artistic-git-credential-helper");
        let askpass_path = temp.path().join("helpers/artistic-git-ssh-askpass");
        let endpoint = LocalIpcEndpoint::UnixSocket(socket_path.clone());
        let core_ssh_command =
            "ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/home/me/.ssh/known_hosts";
        let helpers = AuthHelperBinaries::new(
            credential_helper_path.clone(),
            askpass_path.clone(),
            core_ssh_command,
        );

        let base_plan = runner
            .git_command_builder()
            .args(["fetch", "origin"])
            .with_progress()
            .build();
        let plan = AuthGitCommandInjectionPlan::new(&endpoint, &invocation, &helpers)
            .apply_to_command_plan(base_plan);

        assert_eq!(
            plan.environment.variable(AUTH_SOCKET_ENV),
            Some(socket_path.as_os_str())
        );
        assert_eq!(
            plan.environment.variable(AUTH_INVOCATION_ID_ENV),
            Some(OsStr::new("inv-1"))
        );
        assert_eq!(
            plan.environment.variable("GIT_ASKPASS"),
            Some(askpass_path.as_os_str())
        );
        assert_eq!(
            plan.environment.variable("SSH_ASKPASS_REQUIRE"),
            Some(OsStr::new("force"))
        );
        assert_eq!(
            plan.environment.variable("GIT_CONFIG_NOSYSTEM"),
            Some(OsStr::new("1"))
        );

        let args = plan
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let expected_auth_args = vec![
            "-c".to_owned(),
            format!(
                "credential.helper={}",
                credential_helper_path.to_string_lossy()
            ),
            "-c".to_owned(),
            "credential.useHttpPath=true".to_owned(),
            "-c".to_owned(),
            format!("core.sshCommand={core_ssh_command}"),
        ];
        assert_eq!(&args[..6], expected_auth_args.as_slice());
        let expected_tail_args = ["fetch", "origin", "--progress"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(&args[6..], expected_tail_args.as_slice());
        assert!(!endpoint.uses_network_transport());

        fn write_manifest_executables(
            root: &Path,
            manifest: &artistic_git_contracts::GitDistManifest,
        ) {
            write_executable_file(&root.join(&manifest.paths.git_executable)).expect("git");
            write_executable_file(&root.join(&manifest.paths.git_lfs_executable)).expect("git-lfs");
            write_executable_file(&root.join(&manifest.paths.credential_helper))
                .expect("credential helper");
            write_executable_file(&root.join(&manifest.paths.ssh_askpass)).expect("ssh askpass");
        }
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

    #[cfg(unix)]
    #[test]
    fn helper_round_trip_validates_and_consumes_one_time_token() {
        use artistic_git_helpers::{
            invoke_helper_ipc_at, CredentialOperation, GitCredentialRequest, HelperInvocationEnv,
            HelperIpcEnvelope,
        };
        use std::sync::mpsc;

        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("auth.sock");
        let listener = LocalIpcListener::bind_unix_socket(&socket).expect("bind unix socket");
        let sessions = Arc::new(Mutex::new(AuthIpcSessionManager::new()));
        let operation_id = OperationId::new("fetch-op");
        let invocation = {
            let mut sessions = sessions.lock().expect("sessions");
            sessions.start_operation_with_context(
                operation_id.clone(),
                InteractionPolicy::interactive(),
                Some(PathBuf::from("/repo")),
            );
            sessions
                .issue_invocation_with_context(
                    &operation_id,
                    AuthInvocationContext::new().with_host("example.com"),
                )
                .expect("invocation")
        };
        let (tx, rx) = mpsc::channel();
        let handler = move |context: AuthIpcRequestContext, payload: HelperIpcPayload| {
            tx.send(context).expect("send context");
            match payload {
                HelperIpcPayload::Credential { .. } => HelperIpcResponse::Empty,
                HelperIpcPayload::Askpass { .. } => HelperIpcResponse::Empty,
            }
        };
        let service = AuthIpcService::new(listener, Arc::clone(&sessions), Arc::new(handler));
        let server = thread::spawn(move || service.serve_one().expect("serve one"));

        let env = HelperInvocationEnv {
            socket_path: socket.clone(),
            token: invocation.token.clone(),
            invocation_id: invocation.invocation_id.clone(),
            operation_id: Some(operation_id.clone()),
        };
        let envelope = HelperIpcEnvelope::credential(
            &env,
            GitCredentialRequest {
                operation: CredentialOperation::Get,
                protocol: Some("https".to_owned()),
                host: Some("example.com".to_owned()),
                path: Some("org/repo".to_owned()),
                username: None,
                password: None,
                fields: Vec::new(),
            },
        );

        let response = invoke_helper_ipc_at(&socket, &envelope).expect("ipc response");
        assert_eq!(response, HelperIpcResponse::Empty);
        server.join().expect("server thread");

        let context = rx.recv().expect("context");
        assert_eq!(context.operation_id, invocation.operation_id);
        assert_eq!(context.invocation_id, invocation.invocation_id);
        assert_eq!(context.prompt_decision, AuthPromptDecision::Prompt);
        assert_eq!(context.repository_path, Some(PathBuf::from("/repo")));
        assert_eq!(context.host.as_deref(), Some("example.com"));
        assert_eq!(context.path.as_deref(), Some("org/repo"));

        let error = sessions
            .lock()
            .expect("sessions")
            .validate_token(&invocation.invocation_id, &invocation.token)
            .expect_err("token was consumed by service");
        assert!(matches!(error, AuthIpcError::TokenAlreadyUsed(_)));
    }

    #[cfg(unix)]
    #[test]
    fn helper_ipc_serves_callback_while_repo_write_permit_is_held() {
        use artistic_git_git_runner::OperationConcurrency;
        use artistic_git_helpers::{invoke_helper_ipc_at, HelperInvocationEnv, HelperIpcEnvelope};

        let concurrency = OperationConcurrency::default();
        let _write = concurrency.try_begin_write().expect("write permit");

        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("auth.sock");
        let listener = LocalIpcListener::bind_unix_socket(&socket).expect("bind unix socket");
        let sessions = Arc::new(Mutex::new(AuthIpcSessionManager::new()));
        let operation_id = OperationId::new("write-op");
        let invocation = {
            let mut sessions = sessions.lock().expect("sessions");
            sessions.start_operation_with_context(
                operation_id.clone(),
                InteractionPolicy::interactive(),
                Some(PathBuf::from("/repo")),
            );
            sessions
                .issue_invocation(&operation_id)
                .expect("invocation")
        };
        let handler = |context: AuthIpcRequestContext, payload: HelperIpcPayload| {
            assert_eq!(context.prompt_decision, AuthPromptDecision::Prompt);
            assert!(matches!(payload, HelperIpcPayload::Askpass { .. }));
            HelperIpcResponse::Askpass {
                secret: "passphrase".to_owned(),
            }
        };
        let service = AuthIpcService::new(listener, Arc::clone(&sessions), Arc::new(handler));
        let server = thread::spawn(move || service.serve_one().expect("serve one"));

        // The helper service only uses the auth session mutex and never requests the
        // repo write permit, so an in-flight git operation can wait for this callback.
        let env = HelperInvocationEnv {
            socket_path: socket.clone(),
            token: invocation.token.clone(),
            invocation_id: invocation.invocation_id.clone(),
            operation_id: Some(operation_id),
        };
        let envelope = HelperIpcEnvelope::askpass(&env, "Enter passphrase:");
        let response = invoke_helper_ipc_at(&socket, &envelope).expect("ipc response");
        assert_eq!(
            response,
            HelperIpcResponse::Askpass {
                secret: "passphrase".to_owned(),
            }
        );
        server.join().expect("server thread");
    }

    #[test]
    fn non_interactive_handler_returns_error_without_prompt() {
        let handler = StaticAuthIpcHandler::askpass("secret");
        let response = handler.handle_auth_ipc_request(
            AuthIpcRequestContext {
                operation_id: OperationId::new("op-1"),
                invocation_id: InvocationId::new("inv-1"),
                interaction_policy: InteractionPolicy::background_non_interactive(),
                prompt_decision: AuthPromptDecision::FailImmediately,
                repository_path: Some(PathBuf::from("/repo")),
                host: Some("example.com".to_owned()),
                path: Some("org/repo".to_owned()),
            },
            HelperIpcPayload::Askpass {
                prompt: "Passphrase:".to_owned(),
            },
        );

        assert!(matches!(response, HelperIpcResponse::Error { .. }));
    }
}
