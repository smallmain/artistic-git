use crate::auth_ipc::{AuthPromptDecision, InteractionPolicy};
use artistic_git_core::keyring::{
    HttpsCredential, HttpsCredentialKey, HttpsCredentialRecord, HttpsCredentialSource,
    KeyringError, KeyringVault,
};
use artistic_git_helpers::{
    CredentialOperation, GitCredentialRequest, GitCredentialResponse, HelperIpcResponse,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeSet, error::Error, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HttpsCredentialScope {
    Host,
    Path,
}

impl HttpsCredentialScope {
    fn from_key(key: &HttpsCredentialKey) -> Self {
        match key.path {
            Some(_) => Self::Path,
            None => Self::Host,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpsCredentialEntry {
    pub protocol: String,
    pub host: String,
    pub path: Option<String>,
    pub username: String,
    pub scope: HttpsCredentialScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpsCredentialListResponse {
    pub credentials: Vec<HttpsCredentialEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteHttpsCredentialRequest {
    pub protocol: String,
    pub host: String,
    pub path: Option<String>,
    pub scope: HttpsCredentialScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveHttpsCredentialRequest {
    pub protocol: String,
    pub host: String,
    pub path: Option<String>,
    pub scope: HttpsCredentialScope,
    pub username: String,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HttpsCredentialPromptReason {
    Missing,
    InvalidOrExpired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpsCredentialPromptRequest {
    pub protocol: String,
    pub host: String,
    pub path: Option<String>,
    pub reason: HttpsCredentialPromptReason,
    pub suggested_username: Option<String>,
    pub default_scope: HttpsCredentialScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpsCredentialPromptSubmission {
    pub username: String,
    pub token: String,
    pub scope: HttpsCredentialScope,
}

impl HttpsCredentialPromptSubmission {
    pub fn new(
        username: impl Into<String>,
        token: impl Into<String>,
        scope: HttpsCredentialScope,
    ) -> Self {
        Self {
            username: username.into(),
            token: token.into(),
            scope,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpsCredentialPromptResult {
    Submit(HttpsCredentialPromptSubmission),
    Cancel,
}

pub trait HttpsCredentialPrompter {
    fn prompt_https_credentials(
        &mut self,
        request: HttpsCredentialPromptRequest,
    ) -> HttpsCredentialPromptResult;
}

pub trait HttpsCredentialPromptSink: Send + Sync + 'static {
    fn prompt_https_credentials(
        &self,
        request: HttpsCredentialPromptRequest,
    ) -> HttpsCredentialPromptResult;
}

#[derive(Debug, Default)]
pub struct CancellingHttpsCredentialPromptSink;

impl HttpsCredentialPromptSink for CancellingHttpsCredentialPromptSink {
    fn prompt_https_credentials(
        &self,
        _request: HttpsCredentialPromptRequest,
    ) -> HttpsCredentialPromptResult {
        HttpsCredentialPromptResult::Cancel
    }
}

impl<F> HttpsCredentialPrompter for F
where
    F: FnMut(HttpsCredentialPromptRequest) -> HttpsCredentialPromptResult,
{
    fn prompt_https_credentials(
        &mut self,
        request: HttpsCredentialPromptRequest,
    ) -> HttpsCredentialPromptResult {
        self(request)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpsCredentialFlowOutcome {
    pub response: HelperIpcResponse,
    pub decision: HttpsCredentialDecision,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpsCredentialDecision {
    IgnoredUnsupportedProtocol {
        protocol: Option<String>,
    },
    ReturnedStored {
        key: HttpsCredentialKey,
        source: HttpsCredentialSource,
    },
    PromptedAndStored {
        key: HttpsCredentialKey,
        reason: HttpsCredentialPromptReason,
    },
    Stored {
        key: HttpsCredentialKey,
    },
    Erased {
        key: HttpsCredentialKey,
    },
    FailedNonInteractive {
        host: String,
        path: Option<String>,
    },
    Cancelled {
        host: String,
        path: Option<String>,
        reason: HttpsCredentialPromptReason,
    },
}

#[derive(Debug)]
pub enum HttpsCredentialFlowError {
    MissingProtocol,
    MissingHost,
    MissingCredentialFields,
    PathScopeRequiresPath,
    Keyring(KeyringError),
}

impl fmt::Display for HttpsCredentialFlowError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingProtocol => {
                write!(formatter, "HTTPS credential request is missing protocol")
            }
            Self::MissingHost => write!(formatter, "HTTPS credential request is missing host"),
            Self::MissingCredentialFields => {
                write!(
                    formatter,
                    "HTTPS credential store request is missing username or token"
                )
            }
            Self::PathScopeRequiresPath => {
                write!(
                    formatter,
                    "path-scoped HTTPS credential requires a repository path"
                )
            }
            Self::Keyring(source) => write!(formatter, "HTTPS credential keyring failed: {source}"),
        }
    }
}

impl Error for HttpsCredentialFlowError {}

impl From<KeyringError> for HttpsCredentialFlowError {
    fn from(source: KeyringError) -> Self {
        Self::Keyring(source)
    }
}

#[derive(Clone)]
pub struct HttpsCredentialFlow {
    vault: KeyringVault,
    rejected_credentials: BTreeSet<HttpsCredentialKey>,
}

impl HttpsCredentialFlow {
    pub fn new(vault: KeyringVault) -> Self {
        Self {
            vault,
            rejected_credentials: BTreeSet::new(),
        }
    }

    pub fn vault(&self) -> &KeyringVault {
        &self.vault
    }

    pub fn handle_git_credential_request(
        &mut self,
        request: &GitCredentialRequest,
        interaction_policy: InteractionPolicy,
        prompter: &mut impl HttpsCredentialPrompter,
    ) -> Result<HttpsCredentialFlowOutcome, HttpsCredentialFlowError> {
        let Some(target) = HttpsCredentialTarget::from_request(request)? else {
            return Ok(HttpsCredentialFlowOutcome {
                response: HelperIpcResponse::Empty,
                decision: HttpsCredentialDecision::IgnoredUnsupportedProtocol {
                    protocol: request.protocol.clone(),
                },
            });
        };

        match request.operation {
            CredentialOperation::Get => self.handle_get(&target, interaction_policy, prompter),
            CredentialOperation::Store => self.handle_store(&target, request),
            CredentialOperation::Erase => self.handle_erase(&target),
        }
    }

    pub fn list_credentials(
        &self,
    ) -> Result<HttpsCredentialListResponse, HttpsCredentialFlowError> {
        list_https_credentials(&self.vault)
    }

    pub fn delete_credential(
        &mut self,
        request: DeleteHttpsCredentialRequest,
    ) -> Result<(), HttpsCredentialFlowError> {
        let key = key_for_scope(
            &request.protocol,
            &request.host,
            request.path.as_deref(),
            request.scope,
        )?;
        self.vault.delete_https_credential(&key)?;
        self.rejected_credentials.remove(&key);
        Ok(())
    }

    pub fn save_credential(
        &mut self,
        request: SaveHttpsCredentialRequest,
    ) -> Result<HttpsCredentialEntry, HttpsCredentialFlowError> {
        let username = request.username.trim();
        if username.is_empty() {
            return Err(HttpsCredentialFlowError::MissingCredentialFields);
        }

        let key = key_for_scope(
            &request.protocol,
            &request.host,
            request.path.as_deref(),
            request.scope,
        )?;
        let existing = self.vault.get_https_credential(&key)?;
        let token = request
            .token
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| existing.map(|credential| credential.token))
            .ok_or(HttpsCredentialFlowError::MissingCredentialFields)?;

        self.vault
            .set_https_credential(&key, HttpsCredential::new(username.to_owned(), token))?;
        self.rejected_credentials.remove(&key);
        Ok(credential_entry(HttpsCredentialRecord {
            key,
            username: username.to_owned(),
        }))
    }

    fn handle_get(
        &mut self,
        target: &HttpsCredentialTarget,
        interaction_policy: InteractionPolicy,
        prompter: &mut impl HttpsCredentialPrompter,
    ) -> Result<HttpsCredentialFlowOutcome, HttpsCredentialFlowError> {
        if let Some(lookup) = self.vault.find_https_credential(
            &target.protocol,
            &target.host,
            target.path.as_deref(),
        )? {
            self.rejected_credentials.remove(&lookup.key);
            return Ok(HttpsCredentialFlowOutcome {
                response: credential_response(&lookup.credential),
                decision: HttpsCredentialDecision::ReturnedStored {
                    key: lookup.key,
                    source: lookup.source,
                },
            });
        }

        if interaction_policy.prompt_decision() == AuthPromptDecision::FailImmediately {
            return Ok(HttpsCredentialFlowOutcome {
                response: HelperIpcResponse::Error {
                    message: format!(
                        "HTTPS credentials for {} are required but this operation is non-interactive",
                        target.host
                    ),
                },
                decision: HttpsCredentialDecision::FailedNonInteractive {
                    host: target.host.clone(),
                    path: target.path.clone(),
                },
            });
        }

        let reason = self.prompt_reason(target);
        let prompt_request = HttpsCredentialPromptRequest {
            protocol: target.protocol.clone(),
            host: target.host.clone(),
            path: target.path.clone(),
            reason,
            suggested_username: None,
            default_scope: HttpsCredentialScope::Host,
        };

        match prompter.prompt_https_credentials(prompt_request) {
            HttpsCredentialPromptResult::Cancel => Ok(HttpsCredentialFlowOutcome {
                response: HelperIpcResponse::Error {
                    message: format!("HTTPS credential entry for {} was cancelled", target.host),
                },
                decision: HttpsCredentialDecision::Cancelled {
                    host: target.host.clone(),
                    path: target.path.clone(),
                    reason,
                },
            }),
            HttpsCredentialPromptResult::Submit(submission) => {
                let key = key_for_scope(
                    &target.protocol,
                    &target.host,
                    target.path.as_deref(),
                    submission.scope,
                )?;
                let credential = HttpsCredential::new(submission.username, submission.token);
                self.vault.set_https_credential(&key, credential.clone())?;
                self.rejected_credentials.remove(&key);
                Ok(HttpsCredentialFlowOutcome {
                    response: credential_response(&credential),
                    decision: HttpsCredentialDecision::PromptedAndStored { key, reason },
                })
            }
        }
    }

    fn handle_store(
        &mut self,
        target: &HttpsCredentialTarget,
        request: &GitCredentialRequest,
    ) -> Result<HttpsCredentialFlowOutcome, HttpsCredentialFlowError> {
        let username = request
            .username
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(HttpsCredentialFlowError::MissingCredentialFields)?;
        let password = request
            .password
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or(HttpsCredentialFlowError::MissingCredentialFields)?;
        let key = self.storage_key_for_git_store(target)?;
        self.vault.set_https_credential(
            &key,
            HttpsCredential::new(username.to_owned(), password.to_owned()),
        )?;
        self.rejected_credentials.remove(&key);

        Ok(HttpsCredentialFlowOutcome {
            response: HelperIpcResponse::Empty,
            decision: HttpsCredentialDecision::Stored { key },
        })
    }

    fn handle_erase(
        &mut self,
        target: &HttpsCredentialTarget,
    ) -> Result<HttpsCredentialFlowOutcome, HttpsCredentialFlowError> {
        let key = self.storage_key_for_git_erase(target)?;
        self.vault.delete_https_credential(&key)?;
        self.rejected_credentials.insert(key.clone());

        Ok(HttpsCredentialFlowOutcome {
            response: HelperIpcResponse::Empty,
            decision: HttpsCredentialDecision::Erased { key },
        })
    }

    fn storage_key_for_git_store(
        &self,
        target: &HttpsCredentialTarget,
    ) -> Result<HttpsCredentialKey, HttpsCredentialFlowError> {
        let path_key = target
            .path
            .as_deref()
            .map(|path| HttpsCredentialKey::path_override(&target.protocol, &target.host, path));
        if let Some(path_key) = path_key {
            if self.vault.get_https_credential(&path_key)?.is_some()
                || self.rejected_credentials.contains(&path_key)
            {
                return Ok(path_key);
            }
        }

        Ok(HttpsCredentialKey::shared_host(
            &target.protocol,
            &target.host,
        ))
    }

    fn storage_key_for_git_erase(
        &self,
        target: &HttpsCredentialTarget,
    ) -> Result<HttpsCredentialKey, HttpsCredentialFlowError> {
        let path_key = target
            .path
            .as_deref()
            .map(|path| HttpsCredentialKey::path_override(&target.protocol, &target.host, path));
        if let Some(path_key) = path_key {
            if self.vault.get_https_credential(&path_key)?.is_some() {
                return Ok(path_key);
            }
        }

        Ok(HttpsCredentialKey::shared_host(
            &target.protocol,
            &target.host,
        ))
    }

    fn prompt_reason(&self, target: &HttpsCredentialTarget) -> HttpsCredentialPromptReason {
        let host_key = HttpsCredentialKey::shared_host(&target.protocol, &target.host);
        let path_was_rejected = target.path.as_deref().is_some_and(|path| {
            self.rejected_credentials
                .contains(&HttpsCredentialKey::path_override(
                    &target.protocol,
                    &target.host,
                    path,
                ))
        });

        if path_was_rejected || self.rejected_credentials.contains(&host_key) {
            HttpsCredentialPromptReason::InvalidOrExpired
        } else {
            HttpsCredentialPromptReason::Missing
        }
    }
}

pub fn list_https_credentials(
    vault: &KeyringVault,
) -> Result<HttpsCredentialListResponse, HttpsCredentialFlowError> {
    let mut credentials = vault
        .list_https_credentials()?
        .into_iter()
        .map(credential_entry)
        .collect::<Vec<_>>();
    credentials.sort_by(|left, right| {
        left.host
            .cmp(&right.host)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.username.cmp(&right.username))
    });
    Ok(HttpsCredentialListResponse { credentials })
}

fn credential_entry(record: HttpsCredentialRecord) -> HttpsCredentialEntry {
    let scope = HttpsCredentialScope::from_key(&record.key);
    HttpsCredentialEntry {
        protocol: record.key.protocol,
        host: record.key.host,
        path: record.key.path,
        username: record.username,
        scope,
    }
}

fn key_for_scope(
    protocol: &str,
    host: &str,
    path: Option<&str>,
    scope: HttpsCredentialScope,
) -> Result<HttpsCredentialKey, HttpsCredentialFlowError> {
    match scope {
        HttpsCredentialScope::Host => Ok(HttpsCredentialKey::shared_host(protocol, host)),
        HttpsCredentialScope::Path => path
            .map(|path| HttpsCredentialKey::path_override(protocol, host, path))
            .ok_or(HttpsCredentialFlowError::PathScopeRequiresPath),
    }
}

fn credential_response(credential: &HttpsCredential) -> HelperIpcResponse {
    HelperIpcResponse::Credential {
        credential: GitCredentialResponse {
            username: Some(credential.username.clone()),
            password: Some(credential.token.clone()),
            fields: Vec::new(),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HttpsCredentialTarget {
    protocol: String,
    host: String,
    path: Option<String>,
}

impl HttpsCredentialTarget {
    fn from_request(
        request: &GitCredentialRequest,
    ) -> Result<Option<Self>, HttpsCredentialFlowError> {
        let protocol = request
            .protocol
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(HttpsCredentialFlowError::MissingProtocol)?
            .to_ascii_lowercase();

        if protocol != "https" {
            return Ok(None);
        }

        let host = request
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(HttpsCredentialFlowError::MissingHost)?
            .trim_end_matches('/')
            .to_ascii_lowercase();

        let path = request.path.as_deref().and_then(|path| {
            let path = path
                .trim()
                .trim_start_matches('/')
                .trim_end_matches('/')
                .to_owned();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        });

        Ok(Some(Self {
            protocol,
            host,
            path,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_core::keyring::InMemoryCredentialStore;
    use artistic_git_helpers::{CredentialField, CredentialOperation};
    use std::sync::Arc;

    fn request(operation: CredentialOperation, path: Option<&str>) -> GitCredentialRequest {
        GitCredentialRequest {
            operation,
            protocol: Some("https".to_owned()),
            host: Some("github.com".to_owned()),
            path: path.map(str::to_owned),
            username: None,
            password: None,
            fields: vec![
                CredentialField {
                    key: "protocol".to_owned(),
                    value: "https".to_owned(),
                },
                CredentialField {
                    key: "host".to_owned(),
                    value: "github.com".to_owned(),
                },
            ],
        }
    }

    fn store_request(username: &str, password: &str, path: Option<&str>) -> GitCredentialRequest {
        GitCredentialRequest {
            username: Some(username.to_owned()),
            password: Some(password.to_owned()),
            ..request(CredentialOperation::Store, path)
        }
    }

    fn flow() -> HttpsCredentialFlow {
        HttpsCredentialFlow::new(KeyringVault::new(Arc::new(
            InMemoryCredentialStore::default(),
        )))
    }

    #[test]
    fn get_returns_host_shared_credential_for_path_request() {
        let mut flow = flow();
        let key = HttpsCredentialKey::shared_host("https", "github.com");
        flow.vault()
            .set_https_credential(&key, HttpsCredential::new("alice", "host-token"))
            .expect("set host credential");
        let mut prompt = |_request| HttpsCredentialPromptResult::Cancel;

        let outcome = flow
            .handle_git_credential_request(
                &request(CredentialOperation::Get, Some("smallmain/artistic-git")),
                InteractionPolicy::interactive(),
                &mut prompt,
            )
            .expect("handle get");

        assert_eq!(
            outcome.decision,
            HttpsCredentialDecision::ReturnedStored {
                key,
                source: HttpsCredentialSource::HostShared,
            }
        );
        assert_eq!(
            outcome.response,
            credential_response(&HttpsCredential::new("alice", "host-token"))
        );
    }

    #[test]
    fn path_override_wins_over_host_shared_credential() {
        let mut flow = flow();
        let host_key = HttpsCredentialKey::shared_host("https", "github.com");
        let path_key =
            HttpsCredentialKey::path_override("https", "github.com", "smallmain/artistic-git");
        flow.vault()
            .set_https_credential(&host_key, HttpsCredential::new("alice", "host-token"))
            .expect("set host credential");
        flow.vault()
            .set_https_credential(&path_key, HttpsCredential::new("alice", "path-token"))
            .expect("set path credential");
        let mut prompt = |_request| HttpsCredentialPromptResult::Cancel;

        let outcome = flow
            .handle_git_credential_request(
                &request(CredentialOperation::Get, Some("smallmain/artistic-git")),
                InteractionPolicy::interactive(),
                &mut prompt,
            )
            .expect("handle get");

        assert_eq!(
            outcome.decision,
            HttpsCredentialDecision::ReturnedStored {
                key: path_key,
                source: HttpsCredentialSource::PathOverride,
            }
        );
        assert_eq!(
            outcome.response,
            credential_response(&HttpsCredential::new("alice", "path-token"))
        );
    }

    #[test]
    fn first_missing_interactive_get_prompts_and_stores_host_credential() {
        let mut flow = flow();
        let mut seen_prompt = None;
        let mut prompt = |request| {
            seen_prompt = Some(request);
            HttpsCredentialPromptResult::Submit(HttpsCredentialPromptSubmission::new(
                "alice",
                "new-token",
                HttpsCredentialScope::Host,
            ))
        };

        let outcome = flow
            .handle_git_credential_request(
                &request(CredentialOperation::Get, Some("smallmain/artistic-git")),
                InteractionPolicy::interactive(),
                &mut prompt,
            )
            .expect("handle get");
        let key = HttpsCredentialKey::shared_host("https", "github.com");

        assert_eq!(
            seen_prompt.expect("prompted").reason,
            HttpsCredentialPromptReason::Missing
        );
        assert_eq!(
            outcome.decision,
            HttpsCredentialDecision::PromptedAndStored {
                key: key.clone(),
                reason: HttpsCredentialPromptReason::Missing,
            }
        );
        assert_eq!(
            flow.vault()
                .get_https_credential(&key)
                .expect("read stored credential"),
            Some(HttpsCredential::new("alice", "new-token"))
        );
    }

    #[test]
    fn non_interactive_missing_get_fails_without_prompting() {
        let mut flow = flow();
        let mut prompt_called = false;
        let mut prompt = |_request| {
            prompt_called = true;
            HttpsCredentialPromptResult::Cancel
        };

        let outcome = flow
            .handle_git_credential_request(
                &request(CredentialOperation::Get, Some("smallmain/artistic-git")),
                InteractionPolicy::background_non_interactive(),
                &mut prompt,
            )
            .expect("handle get");

        assert!(!prompt_called);
        assert_eq!(
            outcome.decision,
            HttpsCredentialDecision::FailedNonInteractive {
                host: "github.com".to_owned(),
                path: Some("smallmain/artistic-git".to_owned()),
            }
        );
        assert!(matches!(outcome.response, HelperIpcResponse::Error { .. }));
    }

    #[test]
    fn erase_marks_credential_invalid_and_next_get_prompts_update() {
        let mut flow = flow();
        let host_key = HttpsCredentialKey::shared_host("https", "github.com");
        flow.vault()
            .set_https_credential(&host_key, HttpsCredential::new("alice", "expired-token"))
            .expect("set expired credential");
        let mut no_prompt = |_request| HttpsCredentialPromptResult::Cancel;

        let erase = flow
            .handle_git_credential_request(
                &request(CredentialOperation::Erase, Some("smallmain/artistic-git")),
                InteractionPolicy::interactive(),
                &mut no_prompt,
            )
            .expect("handle erase");
        assert_eq!(
            erase.decision,
            HttpsCredentialDecision::Erased {
                key: host_key.clone(),
            }
        );

        let mut prompt_reason = None;
        let mut prompt = |request: HttpsCredentialPromptRequest| {
            prompt_reason = Some(request.reason);
            HttpsCredentialPromptResult::Submit(HttpsCredentialPromptSubmission::new(
                "alice",
                "replacement-token",
                HttpsCredentialScope::Host,
            ))
        };
        let get = flow
            .handle_git_credential_request(
                &request(CredentialOperation::Get, Some("smallmain/artistic-git")),
                InteractionPolicy::interactive(),
                &mut prompt,
            )
            .expect("handle get");

        assert_eq!(
            prompt_reason,
            Some(HttpsCredentialPromptReason::InvalidOrExpired)
        );
        assert_eq!(
            get.response,
            credential_response(&HttpsCredential::new("alice", "replacement-token"))
        );
    }

    #[test]
    fn cancel_returns_error_without_storing_credentials() {
        let mut flow = flow();
        let mut prompt = |_request| HttpsCredentialPromptResult::Cancel;

        let outcome = flow
            .handle_git_credential_request(
                &request(CredentialOperation::Get, None),
                InteractionPolicy::interactive(),
                &mut prompt,
            )
            .expect("handle get");

        assert_eq!(
            outcome.decision,
            HttpsCredentialDecision::Cancelled {
                host: "github.com".to_owned(),
                path: None,
                reason: HttpsCredentialPromptReason::Missing,
            }
        );
        assert!(matches!(outcome.response, HelperIpcResponse::Error { .. }));
        assert!(flow
            .vault()
            .list_https_credentials()
            .expect("list credentials")
            .is_empty());
    }

    #[test]
    fn git_store_defaults_to_host_but_preserves_existing_path_override() {
        let mut flow = flow();
        let mut no_prompt = |_request| HttpsCredentialPromptResult::Cancel;
        let host_store = flow
            .handle_git_credential_request(
                &store_request("alice", "host-token", Some("smallmain/artistic-git")),
                InteractionPolicy::interactive(),
                &mut no_prompt,
            )
            .expect("store host");
        assert_eq!(
            host_store.decision,
            HttpsCredentialDecision::Stored {
                key: HttpsCredentialKey::shared_host("https", "github.com"),
            }
        );

        let path_key =
            HttpsCredentialKey::path_override("https", "github.com", "smallmain/artistic-git");
        flow.vault()
            .set_https_credential(&path_key, HttpsCredential::new("alice", "old-path-token"))
            .expect("set path override");
        let path_store = flow
            .handle_git_credential_request(
                &store_request("alice", "new-path-token", Some("smallmain/artistic-git")),
                InteractionPolicy::interactive(),
                &mut no_prompt,
            )
            .expect("store path");

        assert_eq!(
            path_store.decision,
            HttpsCredentialDecision::Stored {
                key: path_key.clone(),
            }
        );
        assert_eq!(
            flow.vault()
                .get_https_credential(&path_key)
                .expect("read path credential"),
            Some(HttpsCredential::new("alice", "new-path-token"))
        );
    }

    #[test]
    fn lists_saved_credentials_without_tokens_for_settings_contract() {
        let mut flow = flow();
        let mut no_prompt = |_request| HttpsCredentialPromptResult::Cancel;
        flow.handle_git_credential_request(
            &store_request("alice", "host-token", None),
            InteractionPolicy::interactive(),
            &mut no_prompt,
        )
        .expect("store host");

        assert_eq!(
            flow.list_credentials().expect("list credentials"),
            HttpsCredentialListResponse {
                credentials: vec![HttpsCredentialEntry {
                    protocol: "https".to_owned(),
                    host: "github.com".to_owned(),
                    path: None,
                    username: "alice".to_owned(),
                    scope: HttpsCredentialScope::Host,
                }],
            }
        );
    }

    #[test]
    fn settings_save_can_update_username_without_revealing_existing_token() {
        let mut flow = flow();
        let key = HttpsCredentialKey::shared_host("https", "github.com");
        flow.vault()
            .set_https_credential(&key, HttpsCredential::new("alice", "saved-token"))
            .expect("set existing credential");

        let entry = flow
            .save_credential(SaveHttpsCredentialRequest {
                protocol: "https".to_owned(),
                host: "github.com".to_owned(),
                path: None,
                scope: HttpsCredentialScope::Host,
                username: "bob".to_owned(),
                token: None,
            })
            .expect("save credential");

        assert_eq!(entry.username, "bob");
        assert_eq!(
            flow.vault()
                .get_https_credential(&key)
                .expect("read credential"),
            Some(HttpsCredential::new("bob", "saved-token"))
        );
    }

    #[test]
    fn settings_save_requires_token_for_new_credential() {
        let mut flow = flow();

        let error = flow
            .save_credential(SaveHttpsCredentialRequest {
                protocol: "https".to_owned(),
                host: "github.com".to_owned(),
                path: None,
                scope: HttpsCredentialScope::Host,
                username: "alice".to_owned(),
                token: None,
            })
            .expect_err("new credential requires token");

        assert!(matches!(
            error,
            HttpsCredentialFlowError::MissingCredentialFields
        ));
    }
}
