use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use thiserror::Error;

pub type KeyringResult<T> = Result<T, KeyringError>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct HttpsCredentialKey {
    pub protocol: String,
    pub host: String,
    pub path: Option<String>,
}

impl HttpsCredentialKey {
    pub fn shared_host(protocol: impl Into<String>, host: impl Into<String>) -> Self {
        Self {
            protocol: normalize_protocol(protocol.into()),
            host: normalize_host(host.into()),
            path: None,
        }
    }

    pub fn path_override(
        protocol: impl Into<String>,
        host: impl Into<String>,
        path: impl Into<String>,
    ) -> Self {
        Self {
            protocol: normalize_protocol(protocol.into()),
            host: normalize_host(host.into()),
            path: normalize_path(Some(path.into())),
        }
    }

    pub fn service_name(&self) -> String {
        match &self.path {
            Some(path) => format!("https:{}:{}:{}", self.protocol, self.host, path),
            None => format!("https:{}:{}", self.protocol, self.host),
        }
    }

    pub fn source(&self) -> HttpsCredentialSource {
        match self.path {
            Some(_) => HttpsCredentialSource::PathOverride,
            None => HttpsCredentialSource::HostShared,
        }
    }

    pub fn candidates(protocol: &str, host: &str, path: Option<&str>) -> Vec<Self> {
        let mut candidates = Vec::with_capacity(2);
        if let Some(path) = normalize_path(path.map(str::to_owned)) {
            candidates.push(Self::path_override(protocol, host, path));
        }
        candidates.push(Self::shared_host(protocol, host));
        candidates
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpsCredential {
    pub username: String,
    pub token: String,
}

impl HttpsCredential {
    pub fn new(username: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            token: token.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpsCredentialSource {
    HostShared,
    PathOverride,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpsCredentialLookup {
    pub key: HttpsCredentialKey,
    pub credential: HttpsCredential,
    pub source: HttpsCredentialSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpsCredentialRecord {
    pub key: HttpsCredentialKey,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct SshPassphraseKey {
    pub key_id: String,
}

impl SshPassphraseKey {
    pub fn new(key_id: impl Into<String>) -> Self {
        Self {
            key_id: key_id.into(),
        }
    }
}

pub trait CredentialStore: Send + Sync {
    fn get_https_credential(
        &self,
        key: &HttpsCredentialKey,
    ) -> KeyringResult<Option<HttpsCredential>>;
    fn set_https_credential(
        &self,
        key: &HttpsCredentialKey,
        credential: HttpsCredential,
    ) -> KeyringResult<()>;
    fn delete_https_credential(&self, key: &HttpsCredentialKey) -> KeyringResult<()>;
    fn list_https_credentials(&self) -> KeyringResult<Vec<HttpsCredentialRecord>>;
    fn get_ssh_passphrase(&self, key: &SshPassphraseKey) -> KeyringResult<Option<String>>;
    fn set_ssh_passphrase(&self, key: &SshPassphraseKey, passphrase: String) -> KeyringResult<()>;
    fn delete_ssh_passphrase(&self, key: &SshPassphraseKey) -> KeyringResult<()>;
}

#[derive(Clone)]
pub struct KeyringVault {
    store: Arc<dyn CredentialStore>,
}

impl KeyringVault {
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self { store }
    }

    pub fn get_https_credential(
        &self,
        key: &HttpsCredentialKey,
    ) -> KeyringResult<Option<HttpsCredential>> {
        self.store.get_https_credential(key)
    }

    pub fn find_https_credential(
        &self,
        protocol: &str,
        host: &str,
        path: Option<&str>,
    ) -> KeyringResult<Option<HttpsCredentialLookup>> {
        for key in HttpsCredentialKey::candidates(protocol, host, path) {
            if let Some(credential) = self.store.get_https_credential(&key)? {
                return Ok(Some(HttpsCredentialLookup {
                    source: key.source(),
                    key,
                    credential,
                }));
            }
        }

        Ok(None)
    }

    pub fn set_https_credential(
        &self,
        key: &HttpsCredentialKey,
        credential: HttpsCredential,
    ) -> KeyringResult<()> {
        self.store.set_https_credential(key, credential)
    }

    pub fn delete_https_credential(&self, key: &HttpsCredentialKey) -> KeyringResult<()> {
        self.store.delete_https_credential(key)
    }

    pub fn list_https_credentials(&self) -> KeyringResult<Vec<HttpsCredentialRecord>> {
        self.store.list_https_credentials()
    }

    pub fn get_ssh_passphrase(&self, key: &SshPassphraseKey) -> KeyringResult<Option<String>> {
        self.store.get_ssh_passphrase(key)
    }

    pub fn set_ssh_passphrase(
        &self,
        key: &SshPassphraseKey,
        passphrase: impl Into<String>,
    ) -> KeyringResult<()> {
        self.store.set_ssh_passphrase(key, passphrase.into())
    }

    pub fn delete_ssh_passphrase(&self, key: &SshPassphraseKey) -> KeyringResult<()> {
        self.store.delete_ssh_passphrase(key)
    }
}

#[derive(Debug, Default)]
pub struct InMemoryCredentialStore {
    https: Mutex<BTreeMap<HttpsCredentialKey, HttpsCredential>>,
    ssh: Mutex<BTreeMap<SshPassphraseKey, String>>,
}

impl CredentialStore for InMemoryCredentialStore {
    fn get_https_credential(
        &self,
        key: &HttpsCredentialKey,
    ) -> KeyringResult<Option<HttpsCredential>> {
        Ok(self
            .https
            .lock()
            .map_err(|_| KeyringError::LockPoisoned)?
            .get(key)
            .cloned())
    }

    fn set_https_credential(
        &self,
        key: &HttpsCredentialKey,
        credential: HttpsCredential,
    ) -> KeyringResult<()> {
        self.https
            .lock()
            .map_err(|_| KeyringError::LockPoisoned)?
            .insert(key.clone(), credential);
        Ok(())
    }

    fn delete_https_credential(&self, key: &HttpsCredentialKey) -> KeyringResult<()> {
        self.https
            .lock()
            .map_err(|_| KeyringError::LockPoisoned)?
            .remove(key);
        Ok(())
    }

    fn list_https_credentials(&self) -> KeyringResult<Vec<HttpsCredentialRecord>> {
        Ok(self
            .https
            .lock()
            .map_err(|_| KeyringError::LockPoisoned)?
            .iter()
            .map(|(key, credential)| HttpsCredentialRecord {
                key: key.clone(),
                username: credential.username.clone(),
            })
            .collect())
    }

    fn get_ssh_passphrase(&self, key: &SshPassphraseKey) -> KeyringResult<Option<String>> {
        Ok(self
            .ssh
            .lock()
            .map_err(|_| KeyringError::LockPoisoned)?
            .get(key)
            .cloned())
    }

    fn set_ssh_passphrase(&self, key: &SshPassphraseKey, passphrase: String) -> KeyringResult<()> {
        self.ssh
            .lock()
            .map_err(|_| KeyringError::LockPoisoned)?
            .insert(key.clone(), passphrase);
        Ok(())
    }

    fn delete_ssh_passphrase(&self, key: &SshPassphraseKey) -> KeyringResult<()> {
        self.ssh
            .lock()
            .map_err(|_| KeyringError::LockPoisoned)?
            .remove(key);
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum KeyringError {
    #[error("keyring store lock poisoned")]
    LockPoisoned,
    #[error("system keyring support is not wired yet")]
    Unavailable,
}

fn normalize_protocol(value: String) -> String {
    value.trim().to_ascii_lowercase()
}

fn normalize_host(value: String) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn normalize_path(value: Option<String>) -> Option<String> {
    value.and_then(|path| {
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_credentials_support_host_shared_and_path_override_keys() {
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let host_key = HttpsCredentialKey::shared_host("https", "github.com");
        let path_key =
            HttpsCredentialKey::path_override("https", "github.com", "smallmain/artistic-git");

        vault
            .set_https_credential(&host_key, HttpsCredential::new("user", "host-token"))
            .expect("set host credential");
        vault
            .set_https_credential(&path_key, HttpsCredential::new("user", "path-token"))
            .expect("set path credential");

        assert_eq!(
            vault
                .get_https_credential(&host_key)
                .expect("get host credential")
                .expect("host credential")
                .token,
            "host-token"
        );
        assert_eq!(
            vault
                .get_https_credential(&path_key)
                .expect("get path credential")
                .expect("path credential")
                .token,
            "path-token"
        );
        assert_ne!(host_key.service_name(), path_key.service_name());
    }

    #[test]
    fn https_lookup_prefers_path_override_then_host_shared() {
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let host_key = HttpsCredentialKey::shared_host("HTTPS", "GitHub.com/");
        let path_key =
            HttpsCredentialKey::path_override("https", "github.com", "/smallmain/artistic-git/");

        vault
            .set_https_credential(&host_key, HttpsCredential::new("host-user", "host-token"))
            .expect("set host credential");

        let host_lookup = vault
            .find_https_credential("https", "github.com", Some("smallmain/artistic-git"))
            .expect("lookup host")
            .expect("host credential");
        assert_eq!(host_lookup.source, HttpsCredentialSource::HostShared);
        assert_eq!(host_lookup.credential.token, "host-token");

        vault
            .set_https_credential(&path_key, HttpsCredential::new("path-user", "path-token"))
            .expect("set path credential");

        let path_lookup = vault
            .find_https_credential("https", "github.com", Some("smallmain/artistic-git"))
            .expect("lookup path")
            .expect("path credential");
        assert_eq!(path_lookup.source, HttpsCredentialSource::PathOverride);
        assert_eq!(path_lookup.credential.token, "path-token");
    }

    #[test]
    fn https_credential_listing_omits_tokens() {
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let host_key = HttpsCredentialKey::shared_host("https", "example.com");

        vault
            .set_https_credential(&host_key, HttpsCredential::new("alice", "secret-token"))
            .expect("set host credential");

        assert_eq!(
            vault.list_https_credentials().expect("list credentials"),
            vec![HttpsCredentialRecord {
                key: host_key,
                username: "alice".to_owned(),
            }]
        );
    }

    #[test]
    fn ssh_passphrases_can_be_stored_and_deleted() {
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let key = SshPassphraseKey::new("~/.ssh/id_ed25519");

        vault
            .set_ssh_passphrase(&key, "secret")
            .expect("set passphrase");
        assert_eq!(
            vault.get_ssh_passphrase(&key).expect("get passphrase"),
            Some("secret".to_owned())
        );

        vault
            .delete_ssh_passphrase(&key)
            .expect("delete passphrase");
        assert_eq!(
            vault.get_ssh_passphrase(&key).expect("get passphrase"),
            None
        );
    }
}
