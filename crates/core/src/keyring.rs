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
            protocol: protocol.into(),
            host: host.into(),
            path: None,
        }
    }

    pub fn path_override(
        protocol: impl Into<String>,
        host: impl Into<String>,
        path: impl Into<String>,
    ) -> Self {
        Self {
            protocol: protocol.into(),
            host: host.into(),
            path: Some(path.into()),
        }
    }

    pub fn service_name(&self) -> String {
        match &self.path {
            Some(path) => format!("https:{}:{}:{}", self.protocol, self.host, path),
            None => format!("https:{}:{}", self.protocol, self.host),
        }
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
