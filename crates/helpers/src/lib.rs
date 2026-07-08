use artistic_git_contracts::{InvocationId, IpcToken, OperationId};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use thiserror::Error;

pub const AUTH_SOCKET_ENV: &str = "ARTISTIC_GIT_AUTH_SOCKET";
pub const AUTH_TOKEN_ENV: &str = "ARTISTIC_GIT_AUTH_TOKEN";
pub const AUTH_INVOCATION_ID_ENV: &str = "ARTISTIC_GIT_AUTH_INVOCATION_ID";
pub const AUTH_OPERATION_ID_ENV: &str = "ARTISTIC_GIT_AUTH_OPERATION_ID";
const AUTH_IPC_IO_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperBinary {
    pub name: &'static str,
    pub purpose: &'static str,
}

pub fn planned_helpers() -> [HelperBinary; 2] {
    [
        HelperBinary {
            name: "artistic-git-credential-helper",
            purpose: "git credential helper callback bridge",
        },
        HelperBinary {
            name: "artistic-git-ssh-askpass",
            purpose: "ssh askpass callback bridge",
        },
    ]
}

#[derive(Debug, Error)]
pub enum HelperProtocolError {
    #[error("missing credential operation argument")]
    MissingCredentialOperation,
    #[error("unsupported credential operation: {0}")]
    UnsupportedCredentialOperation(String),
    #[error("credential protocol line {line} is missing '='")]
    MalformedCredentialLine { line: usize },
    #[error("credential protocol line {line} has an empty key")]
    EmptyCredentialKey { line: usize },
    #[error("missing askpass prompt argument")]
    MissingAskpassPrompt,
    #[error("missing required environment variable {0}")]
    MissingEnvironment(&'static str),
    #[error("environment variable {key} is not valid UTF-8")]
    InvalidUtf8Environment { key: &'static str },
    #[error("failed to serialize IPC request: {0}")]
    Encode(serde_json::Error),
    #[error("failed to decode IPC response: {0}")]
    Decode(serde_json::Error),
    #[error("local IPC failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("local IPC is not implemented for this platform yet")]
    UnsupportedPlatform,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialOperation {
    Get,
    Store,
    Erase,
}

impl CredentialOperation {
    pub fn parse(value: &str) -> Result<Self, HelperProtocolError> {
        match value {
            "get" => Ok(Self::Get),
            "store" => Ok(Self::Store),
            "erase" => Ok(Self::Erase),
            other => Err(HelperProtocolError::UnsupportedCredentialOperation(
                other.to_owned(),
            )),
        }
    }

    pub fn as_git_arg(self) -> &'static str {
        match self {
            Self::Get => "get",
            Self::Store => "store",
            Self::Erase => "erase",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialRequest {
    pub operation: CredentialOperation,
    pub protocol: Option<String>,
    pub host: Option<String>,
    pub path: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub fields: Vec<CredentialField>,
}

impl GitCredentialRequest {
    pub fn value(&self, key: &str) -> Option<&str> {
        self.fields
            .iter()
            .rev()
            .find(|field| field.key == key)
            .map(|field| field.value.as_str())
    }
}

pub fn parse_credential_input(
    operation: CredentialOperation,
    input: &str,
) -> Result<GitCredentialRequest, HelperProtocolError> {
    let mut fields = Vec::new();

    for (index, raw_line) in input.lines().enumerate() {
        let line_number = index + 1;
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            break;
        }

        let Some((key, value)) = line.split_once('=') else {
            return Err(HelperProtocolError::MalformedCredentialLine { line: line_number });
        };
        if key.is_empty() {
            return Err(HelperProtocolError::EmptyCredentialKey { line: line_number });
        }

        fields.push(CredentialField {
            key: key.to_owned(),
            value: value.to_owned(),
        });
    }

    let mut latest = BTreeMap::new();
    for field in &fields {
        latest.insert(field.key.as_str(), field.value.as_str());
    }

    Ok(GitCredentialRequest {
        operation,
        protocol: latest.get("protocol").map(|value| (*value).to_owned()),
        host: latest.get("host").map(|value| (*value).to_owned()),
        path: latest.get("path").map(|value| (*value).to_owned()),
        username: latest.get("username").map(|value| (*value).to_owned()),
        password: latest.get("password").map(|value| (*value).to_owned()),
        fields,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialResponse {
    pub username: Option<String>,
    pub password: Option<String>,
    pub fields: Vec<CredentialField>,
}

pub fn format_credential_response(response: &GitCredentialResponse) -> String {
    let mut output = String::new();
    if let Some(username) = &response.username {
        output.push_str("username=");
        output.push_str(username);
        output.push('\n');
    }
    if let Some(password) = &response.password {
        output.push_str("password=");
        output.push_str(password);
        output.push('\n');
    }
    for field in &response.fields {
        output.push_str(&field.key);
        output.push('=');
        output.push_str(&field.value);
        output.push('\n');
    }
    output.push('\n');
    output
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperInvocationEnv {
    pub socket_path: PathBuf,
    pub token: IpcToken,
    pub invocation_id: InvocationId,
    pub operation_id: Option<OperationId>,
}

impl HelperInvocationEnv {
    pub fn from_process_env() -> Result<Self, HelperProtocolError> {
        let socket_path = env::var_os(AUTH_SOCKET_ENV)
            .map(PathBuf::from)
            .ok_or(HelperProtocolError::MissingEnvironment(AUTH_SOCKET_ENV))?;
        let token = IpcToken(required_env_string(AUTH_TOKEN_ENV)?);
        let invocation_id = InvocationId(required_env_string(AUTH_INVOCATION_ID_ENV)?);
        let operation_id = optional_env_string(AUTH_OPERATION_ID_ENV)?.map(OperationId);

        Ok(Self {
            socket_path,
            token,
            invocation_id,
            operation_id,
        })
    }

    pub fn from_map(values: &BTreeMap<String, OsString>) -> Result<Self, HelperProtocolError> {
        let socket_path = values
            .get(AUTH_SOCKET_ENV)
            .map(PathBuf::from)
            .ok_or(HelperProtocolError::MissingEnvironment(AUTH_SOCKET_ENV))?;
        let token = IpcToken(required_map_string(values, AUTH_TOKEN_ENV)?);
        let invocation_id = InvocationId(required_map_string(values, AUTH_INVOCATION_ID_ENV)?);
        let operation_id = values
            .get(AUTH_OPERATION_ID_ENV)
            .map(|value| os_string_to_string(value, AUTH_OPERATION_ID_ENV).map(OperationId))
            .transpose()?;

        Ok(Self {
            socket_path,
            token,
            invocation_id,
            operation_id,
        })
    }
}

fn required_env_string(key: &'static str) -> Result<String, HelperProtocolError> {
    match env::var(key) {
        Ok(value) => Ok(value),
        Err(env::VarError::NotPresent) => Err(HelperProtocolError::MissingEnvironment(key)),
        Err(env::VarError::NotUnicode(_)) => {
            Err(HelperProtocolError::InvalidUtf8Environment { key })
        }
    }
}

fn optional_env_string(key: &'static str) -> Result<Option<String>, HelperProtocolError> {
    match env::var(key) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => {
            Err(HelperProtocolError::InvalidUtf8Environment { key })
        }
    }
}

fn required_map_string(
    values: &BTreeMap<String, OsString>,
    key: &'static str,
) -> Result<String, HelperProtocolError> {
    let value = values
        .get(key)
        .ok_or(HelperProtocolError::MissingEnvironment(key))?;
    os_string_to_string(value, key)
}

fn os_string_to_string(value: &OsString, key: &'static str) -> Result<String, HelperProtocolError> {
    value
        .clone()
        .into_string()
        .map_err(|_| HelperProtocolError::InvalidUtf8Environment { key })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperIpcEnvelope {
    pub invocation_id: InvocationId,
    pub token: IpcToken,
    #[serde(flatten)]
    pub payload: HelperIpcPayload,
}

impl HelperIpcEnvelope {
    pub fn askpass(env: &HelperInvocationEnv, prompt: impl Into<String>) -> Self {
        Self {
            invocation_id: env.invocation_id.clone(),
            token: env.token.clone(),
            payload: HelperIpcPayload::Askpass {
                prompt: prompt.into(),
            },
        }
    }

    pub fn credential(env: &HelperInvocationEnv, credential: GitCredentialRequest) -> Self {
        Self {
            invocation_id: env.invocation_id.clone(),
            token: env.token.clone(),
            payload: HelperIpcPayload::Credential { credential },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HelperIpcPayload {
    Askpass { prompt: String },
    Credential { credential: GitCredentialRequest },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HelperIpcResponse {
    Askpass { secret: String },
    Credential { credential: GitCredentialResponse },
    Empty,
    Error { message: String },
}

pub fn encode_ipc_request(envelope: &HelperIpcEnvelope) -> Result<Vec<u8>, HelperProtocolError> {
    let mut body = serde_json::to_vec(envelope).map_err(HelperProtocolError::Encode)?;
    body.push(b'\n');
    Ok(body)
}

pub fn decode_ipc_response(input: &[u8]) -> Result<HelperIpcResponse, HelperProtocolError> {
    serde_json::from_slice(input).map_err(HelperProtocolError::Decode)
}

pub fn askpass_prompt_from_args<I, S>(args: I) -> Result<String, HelperProtocolError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    args.into_iter()
        .next()
        .map(Into::into)
        .ok_or(HelperProtocolError::MissingAskpassPrompt)
}

pub fn invoke_helper_ipc(
    env: &HelperInvocationEnv,
    envelope: &HelperIpcEnvelope,
) -> Result<HelperIpcResponse, HelperProtocolError> {
    invoke_helper_ipc_at(&env.socket_path, envelope)
}

#[cfg(unix)]
pub fn invoke_helper_ipc_at(
    socket_path: &Path,
    envelope: &HelperIpcEnvelope,
) -> Result<HelperIpcResponse, HelperProtocolError> {
    use interprocess::local_socket::{prelude::*, ConnectOptions, GenericFilePath};

    let name = socket_path.to_fs_name::<GenericFilePath>()?;
    let mut stream = ConnectOptions::new()
        .name(name)
        .wait_mode(interprocess::ConnectWaitMode::Timeout(AUTH_IPC_IO_TIMEOUT))
        .connect_sync()?;
    set_stream_timeouts(&stream);
    let request = encode_ipc_request(envelope)?;
    stream.write_all(&request)?;
    stream.flush()?;

    let response = read_ipc_line(&mut stream)?;
    decode_ipc_response(&response)
}

#[cfg(windows)]
pub fn invoke_helper_ipc_at(
    socket_path: &Path,
    envelope: &HelperIpcEnvelope,
) -> Result<HelperIpcResponse, HelperProtocolError> {
    use interprocess::local_socket::{prelude::*, ConnectOptions, GenericNamespaced};

    let socket_name = socket_path.to_string_lossy();
    let name = socket_name.as_ref().to_ns_name::<GenericNamespaced>()?;
    let mut stream = ConnectOptions::new()
        .name(name)
        .wait_mode(interprocess::ConnectWaitMode::Timeout(AUTH_IPC_IO_TIMEOUT))
        .connect_sync()?;
    set_stream_timeouts(&stream);
    let request = encode_ipc_request(envelope)?;
    stream.write_all(&request)?;
    stream.flush()?;

    let response = read_ipc_line(&mut stream)?;
    decode_ipc_response(&response)
}

#[cfg(any(unix, windows))]
fn set_stream_timeouts(stream: &interprocess::local_socket::Stream) {
    use interprocess::local_socket::traits::Stream as _;

    let _ = stream.set_recv_timeout(Some(AUTH_IPC_IO_TIMEOUT));
    let _ = stream.set_send_timeout(Some(AUTH_IPC_IO_TIMEOUT));
}

#[cfg(not(any(unix, windows)))]
pub fn invoke_helper_ipc_at(
    _socket_path: &Path,
    _envelope: &HelperIpcEnvelope,
) -> Result<HelperIpcResponse, HelperProtocolError> {
    Err(HelperProtocolError::UnsupportedPlatform)
}

fn read_ipc_line(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut response = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        let read = reader.read(&mut byte)?;
        if read == 0 {
            break;
        }
        response.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
    }
    Ok(response)
}

pub fn parse_credential_operation_from_args<I, S>(
    args: I,
) -> Result<CredentialOperation, HelperProtocolError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let operation = args
        .into_iter()
        .next()
        .map(Into::into)
        .ok_or(HelperProtocolError::MissingCredentialOperation)?;
    CredentialOperation::parse(&operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declares_required_helper_binaries() {
        let helpers = planned_helpers();

        assert_eq!(helpers.len(), 2);
        assert!(helpers
            .iter()
            .any(|helper| helper.name == "artistic-git-ssh-askpass"));
        assert!(helpers
            .iter()
            .any(|helper| helper.name == "artistic-git-credential-helper"));
    }

    #[test]
    fn parses_git_credential_native_protocol() {
        let request = parse_credential_input(
            CredentialOperation::Store,
            "protocol=https\nhost=example.com\npath=org/repo\nusername=alice\npassword=s3cr3t\n\nignored=value\n",
        )
        .expect("parse credential");

        assert_eq!(request.operation, CredentialOperation::Store);
        assert_eq!(request.protocol.as_deref(), Some("https"));
        assert_eq!(request.host.as_deref(), Some("example.com"));
        assert_eq!(request.path.as_deref(), Some("org/repo"));
        assert_eq!(request.username.as_deref(), Some("alice"));
        assert_eq!(request.password.as_deref(), Some("s3cr3t"));
        assert_eq!(request.value("host"), Some("example.com"));
        assert_eq!(request.fields.len(), 5);
    }

    #[test]
    fn rejects_malformed_credential_protocol_line() {
        let error = parse_credential_input(CredentialOperation::Get, "protocol=https\nbroken\n")
            .expect_err("malformed line should fail");

        assert!(matches!(
            error,
            HelperProtocolError::MalformedCredentialLine { line: 2 }
        ));
    }

    #[test]
    fn encodes_askpass_request_with_token_and_invocation() {
        let mut values = BTreeMap::new();
        values.insert(AUTH_SOCKET_ENV.to_owned(), OsString::from("/tmp/ag.sock"));
        values.insert(AUTH_TOKEN_ENV.to_owned(), OsString::from("tok-1"));
        values.insert(AUTH_INVOCATION_ID_ENV.to_owned(), OsString::from("inv-1"));

        let env = HelperInvocationEnv::from_map(&values).expect("env");
        let envelope = HelperIpcEnvelope::askpass(&env, "Password for key:");
        let body = encode_ipc_request(&envelope).expect("encode");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("json");

        assert_eq!(json["invocationId"], "inv-1");
        assert_eq!(json["token"], "tok-1");
        assert_eq!(json["kind"], "askpass");
        assert_eq!(json["prompt"], "Password for key:");
        assert!(body.ends_with(b"\n"));
    }

    #[test]
    fn formats_git_credential_response_for_stdout() {
        let response = GitCredentialResponse {
            username: Some("alice".to_owned()),
            password: Some("token".to_owned()),
            fields: vec![CredentialField {
                key: "password_expiry_utc".to_owned(),
                value: "2000000000".to_owned(),
            }],
        };

        assert_eq!(
            format_credential_response(&response),
            "username=alice\npassword=token\npassword_expiry_utc=2000000000\n\n"
        );
    }
}
