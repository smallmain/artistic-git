use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use thiserror::Error;

pub type KeyringResult<T> = Result<T, KeyringError>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HttpsCredentialRecord {
    pub key: HttpsCredentialKey,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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

#[derive(Clone)]
pub struct SystemCredentialStore {
    service_prefix: String,
    backend: Arc<dyn SecretStoreBackend>,
}

impl SystemCredentialStore {
    pub const DEFAULT_SERVICE_PREFIX: &'static str = "artistic-git";

    pub fn new() -> Self {
        Self::with_service_prefix(Self::DEFAULT_SERVICE_PREFIX)
    }

    pub fn with_service_prefix(service_prefix: impl Into<String>) -> Self {
        Self {
            service_prefix: service_prefix.into(),
            backend: Arc::new(OsSecretStoreBackend),
        }
    }

    #[cfg(test)]
    fn with_backend(
        service_prefix: impl Into<String>,
        backend: Arc<dyn SecretStoreBackend>,
    ) -> Self {
        Self {
            service_prefix: service_prefix.into(),
            backend,
        }
    }

    fn service(&self, kind: &str) -> String {
        format!("{}:{kind}", self.service_prefix)
    }

    fn https_credential_account(key: &HttpsCredentialKey) -> String {
        key.service_name()
    }

    fn ssh_passphrase_account(key: &SshPassphraseKey) -> String {
        key.key_id.clone()
    }

    fn read_https_index(&self) -> KeyringResult<Vec<HttpsCredentialRecord>> {
        let Some(raw) = self
            .backend
            .get_password(&self.service("https-index"), SYSTEM_HTTPS_INDEX_ACCOUNT)?
        else {
            return Ok(Vec::new());
        };

        serde_json::from_str::<Vec<HttpsCredentialRecord>>(&raw)
            .map_err(|source| KeyringError::MalformedData(source.to_string()))
    }

    fn write_https_index(&self, mut records: Vec<HttpsCredentialRecord>) -> KeyringResult<()> {
        records.sort_by(|left, right| left.key.cmp(&right.key));
        let service = self.service("https-index");
        if records.is_empty() {
            return self
                .backend
                .delete_password(&service, SYSTEM_HTTPS_INDEX_ACCOUNT);
        }

        let value = serde_json::to_string(&records)
            .map_err(|source| KeyringError::MalformedData(source.to_string()))?;
        self.backend
            .set_password(&service, SYSTEM_HTTPS_INDEX_ACCOUNT, &value)
    }

    fn upsert_https_index(
        &self,
        key: &HttpsCredentialKey,
        username: impl Into<String>,
    ) -> KeyringResult<()> {
        let username = username.into();
        let mut records = self.read_https_index()?;
        if let Some(record) = records.iter_mut().find(|record| record.key == *key) {
            record.username = username;
        } else {
            records.push(HttpsCredentialRecord {
                key: key.clone(),
                username,
            });
        }
        self.write_https_index(records)
    }

    fn remove_https_index(&self, key: &HttpsCredentialKey) -> KeyringResult<()> {
        let mut records = self.read_https_index()?;
        records.retain(|record| record.key != *key);
        self.write_https_index(records)
    }
}

impl Default for SystemCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore for SystemCredentialStore {
    fn get_https_credential(
        &self,
        key: &HttpsCredentialKey,
    ) -> KeyringResult<Option<HttpsCredential>> {
        let Some(raw) = self
            .backend
            .get_password(&self.service("https"), &Self::https_credential_account(key))?
        else {
            return Ok(None);
        };

        serde_json::from_str::<HttpsCredential>(&raw)
            .map(Some)
            .map_err(|source| KeyringError::MalformedData(source.to_string()))
    }

    fn set_https_credential(
        &self,
        key: &HttpsCredentialKey,
        credential: HttpsCredential,
    ) -> KeyringResult<()> {
        let value = serde_json::to_string(&credential)
            .map_err(|source| KeyringError::MalformedData(source.to_string()))?;
        self.backend.set_password(
            &self.service("https"),
            &Self::https_credential_account(key),
            &value,
        )?;
        self.upsert_https_index(key, credential.username)
    }

    fn delete_https_credential(&self, key: &HttpsCredentialKey) -> KeyringResult<()> {
        self.backend
            .delete_password(&self.service("https"), &Self::https_credential_account(key))?;
        self.remove_https_index(key)
    }

    fn list_https_credentials(&self) -> KeyringResult<Vec<HttpsCredentialRecord>> {
        self.read_https_index()
    }

    fn get_ssh_passphrase(&self, key: &SshPassphraseKey) -> KeyringResult<Option<String>> {
        self.backend
            .get_password(&self.service("ssh"), &Self::ssh_passphrase_account(key))
    }

    fn set_ssh_passphrase(&self, key: &SshPassphraseKey, passphrase: String) -> KeyringResult<()> {
        self.backend.set_password(
            &self.service("ssh"),
            &Self::ssh_passphrase_account(key),
            &passphrase,
        )
    }

    fn delete_ssh_passphrase(&self, key: &SshPassphraseKey) -> KeyringResult<()> {
        self.backend
            .delete_password(&self.service("ssh"), &Self::ssh_passphrase_account(key))
    }
}

const SYSTEM_HTTPS_INDEX_ACCOUNT: &str = "__artistic_git_https_credentials_v1";

trait SecretStoreBackend: Send + Sync {
    fn get_password(&self, service: &str, account: &str) -> KeyringResult<Option<String>>;
    fn set_password(&self, service: &str, account: &str, password: &str) -> KeyringResult<()>;
    fn delete_password(&self, service: &str, account: &str) -> KeyringResult<()>;
}

#[derive(Debug)]
struct OsSecretStoreBackend;

impl SecretStoreBackend for OsSecretStoreBackend {
    fn get_password(&self, service: &str, account: &str) -> KeyringResult<Option<String>> {
        let entry = system_entry(service, account)?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(::keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_system_keyring_error(error)),
        }
    }

    fn set_password(&self, service: &str, account: &str, password: &str) -> KeyringResult<()> {
        system_entry(service, account)?
            .set_password(password)
            .map_err(map_system_keyring_error)
    }

    fn delete_password(&self, service: &str, account: &str) -> KeyringResult<()> {
        let entry = system_entry(service, account)?;
        match entry.delete_credential() {
            Ok(()) | Err(::keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_system_keyring_error(error)),
        }
    }
}

fn system_entry(service: &str, account: &str) -> KeyringResult<::keyring::Entry> {
    ::keyring::Entry::new(service, account).map_err(map_system_keyring_error)
}

fn map_system_keyring_error(error: ::keyring::Error) -> KeyringError {
    KeyringError::System(error.to_string())
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
    #[error("system keyring failed: {0}")]
    System(String),
    #[error("keyring data is malformed: {0}")]
    MalformedData(String),
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

    #[derive(Debug, Default)]
    struct FakeSecretStoreBackend {
        values: Mutex<BTreeMap<(String, String), String>>,
    }

    impl FakeSecretStoreBackend {
        fn contains_secret(&self, secret: &str) -> bool {
            self.values
                .lock()
                .expect("fake store")
                .values()
                .any(|value| value.contains(secret))
        }
    }

    impl SecretStoreBackend for FakeSecretStoreBackend {
        fn get_password(&self, service: &str, account: &str) -> KeyringResult<Option<String>> {
            Ok(self
                .values
                .lock()
                .map_err(|_| KeyringError::LockPoisoned)?
                .get(&(service.to_owned(), account.to_owned()))
                .cloned())
        }

        fn set_password(&self, service: &str, account: &str, password: &str) -> KeyringResult<()> {
            self.values
                .lock()
                .map_err(|_| KeyringError::LockPoisoned)?
                .insert(
                    (service.to_owned(), account.to_owned()),
                    password.to_owned(),
                );
            Ok(())
        }

        fn delete_password(&self, service: &str, account: &str) -> KeyringResult<()> {
            self.values
                .lock()
                .map_err(|_| KeyringError::LockPoisoned)?
                .remove(&(service.to_owned(), account.to_owned()));
            Ok(())
        }
    }

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

    #[test]
    fn system_keyring_store_round_trips_https_credentials_and_index() {
        let backend = Arc::new(FakeSecretStoreBackend::default());
        let store = SystemCredentialStore::with_backend("ag-test", backend.clone());
        let key = HttpsCredentialKey::path_override("HTTPS", "GitHub.com/", "/org/repo/");

        store
            .set_https_credential(&key, HttpsCredential::new("alice", "secret-token"))
            .expect("set https credential");

        assert_eq!(
            store
                .get_https_credential(&key)
                .expect("get https credential"),
            Some(HttpsCredential::new("alice", "secret-token"))
        );
        assert_eq!(
            store.list_https_credentials().expect("list credentials"),
            vec![HttpsCredentialRecord {
                key: key.clone(),
                username: "alice".to_owned(),
            }]
        );

        let index_service = store.service("https-index");
        let index = backend
            .get_password(&index_service, SYSTEM_HTTPS_INDEX_ACCOUNT)
            .expect("read index")
            .expect("index");
        assert!(index.contains("alice"));
        assert!(!index.contains("secret-token"));
        assert!(backend.contains_secret("secret-token"));
    }

    #[test]
    fn system_keyring_store_deletes_https_credentials_and_index_entry() {
        let backend = Arc::new(FakeSecretStoreBackend::default());
        let store = SystemCredentialStore::with_backend("ag-test", backend);
        let key = HttpsCredentialKey::shared_host("https", "example.com");

        store
            .set_https_credential(&key, HttpsCredential::new("alice", "token"))
            .expect("set credential");
        store
            .delete_https_credential(&key)
            .expect("delete credential");

        assert_eq!(
            store
                .get_https_credential(&key)
                .expect("get deleted credential"),
            None
        );
        assert_eq!(
            store.list_https_credentials().expect("list credentials"),
            Vec::<HttpsCredentialRecord>::new()
        );
    }

    #[test]
    fn system_keyring_store_round_trips_ssh_passphrase() {
        let backend = Arc::new(FakeSecretStoreBackend::default());
        let store = SystemCredentialStore::with_backend("ag-test", backend);
        let key = SshPassphraseKey::new("/Users/me/.ssh/id_ed25519");

        store
            .set_ssh_passphrase(&key, "ssh-secret".to_owned())
            .expect("set passphrase");
        assert_eq!(
            store.get_ssh_passphrase(&key).expect("get passphrase"),
            Some("ssh-secret".to_owned())
        );

        store
            .delete_ssh_passphrase(&key)
            .expect("delete passphrase");
        assert_eq!(
            store
                .get_ssh_passphrase(&key)
                .expect("get deleted passphrase"),
            None
        );
    }
}
