use crate::auth_ipc::{AuthPromptDecision, InteractionPolicy};
use artistic_git_core::keyring::{KeyringResult, KeyringVault, SshPassphraseKey};
use artistic_git_git_runner::GitDistribution;
use serde::Serialize;
use specta::Type;
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshPlatform {
    Current,
    Windows,
    MacOs,
    Linux,
}

impl SshPlatform {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }

    fn resolve(self) -> Self {
        match self {
            Self::Current => Self::current(),
            platform => platform,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshAuthError {
    MissingHomeDirectory,
    MissingBundledWindowsSsh,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshBinarySource {
    BundledWindowsOpenSsh(PathBuf),
    SystemSsh,
}

impl SshBinarySource {
    pub fn executable(&self) -> OsString {
        match self {
            Self::BundledWindowsOpenSsh(path) => path.clone().into_os_string(),
            Self::SystemSsh => OsString::from("ssh"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshCommandPlan {
    pub binary: SshBinarySource,
    pub known_hosts_path: PathBuf,
    pub strict_host_key_checking: &'static str,
    pub core_ssh_command: OsString,
}

impl SshCommandPlan {
    pub fn for_distribution(
        distribution: &GitDistribution,
        platform: SshPlatform,
    ) -> Result<Self, SshAuthError> {
        let home = real_home_dir().ok_or(SshAuthError::MissingHomeDirectory)?;
        Self::for_distribution_with_home(distribution, platform, home)
    }

    pub fn for_distribution_with_home(
        distribution: &GitDistribution,
        platform: SshPlatform,
        home: impl Into<PathBuf>,
    ) -> Result<Self, SshAuthError> {
        let platform = platform.resolve();
        let binary = match platform {
            SshPlatform::Windows => SshBinarySource::BundledWindowsOpenSsh(
                distribution
                    .windows_ssh_executable
                    .clone()
                    .ok_or(SshAuthError::MissingBundledWindowsSsh)?,
            ),
            SshPlatform::MacOs | SshPlatform::Linux => SshBinarySource::SystemSsh,
            SshPlatform::Current => unreachable!("current platform is resolved above"),
        };
        let known_hosts_path = home.into().join(".ssh").join("known_hosts");
        let strict_host_key_checking = "accept-new";
        let core_ssh_command =
            build_core_ssh_command(&binary, strict_host_key_checking, &known_hosts_path);

        Ok(Self {
            binary,
            known_hosts_path,
            strict_host_key_checking,
            core_ssh_command,
        })
    }
}

pub fn build_core_ssh_command(
    binary: &SshBinarySource,
    strict_host_key_checking: &str,
    known_hosts_path: &Path,
) -> OsString {
    let command = format!(
        "{} -o StrictHostKeyChecking={} -o UserKnownHostsFile={}",
        quote_command_atom(&display_os_string(binary.executable())),
        quote_command_atom(strict_host_key_checking),
        quote_command_atom(&known_hosts_path.to_string_lossy())
    );
    OsString::from(command)
}

#[derive(Debug, Default, Clone)]
pub struct SshPassphraseCache {
    passphrases: Arc<Mutex<BTreeMap<SshPassphraseKey, String>>>,
}

impl SshPassphraseCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &SshPassphraseKey) -> Option<String> {
        self.passphrases.lock().ok()?.get(key).cloned()
    }

    pub fn insert(&self, key: SshPassphraseKey, passphrase: impl Into<String>) {
        if let Ok(mut passphrases) = self.passphrases.lock() {
            passphrases.insert(key, passphrase.into());
        }
    }

    pub fn remove(&self, key: &SshPassphraseKey) {
        if let Ok(mut passphrases) = self.passphrases.lock() {
            passphrases.remove(key);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut passphrases) = self.passphrases.lock() {
            passphrases.clear();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshAskpassDecision {
    ReturnSecret {
        secret: String,
        source: SshSecretSource,
    },
    PromptUser {
        key: SshPassphraseKey,
        prompt: String,
        remember_available: bool,
    },
    Fail {
        reason: SshAskpassFailureReason,
        classification: SshAuthFailureClassification,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshSecretSource {
    MemoryCache,
    Keyring,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshAskpassFailureReason {
    PassphraseRequired,
    UnsupportedPrompt,
    KeyringUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshAuthFailureClassification {
    ExpectedOffline,
    ExpectedAuthenticationFailure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshPromptKind {
    KeyPassphrase(SshPassphraseKey),
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshPassphrasePromptRequest {
    pub key_id: String,
    pub prompt: String,
    pub remember_available: bool,
}

impl SshPassphrasePromptRequest {
    pub fn new(
        key: &SshPassphraseKey,
        prompt: impl Into<String>,
        remember_available: bool,
    ) -> Self {
        Self {
            key_id: key.key_id.clone(),
            prompt: prompt.into(),
            remember_available,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshPassphrasePromptSubmission {
    pub passphrase: String,
    pub remember: bool,
}

impl SshPassphrasePromptSubmission {
    pub fn new(passphrase: impl Into<String>, remember: bool) -> Self {
        Self {
            passphrase: passphrase.into(),
            remember,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshPassphrasePromptResult {
    Submit(SshPassphrasePromptSubmission),
    Cancel,
}

pub trait SshPassphrasePromptSink: Send + Sync + 'static {
    fn prompt_ssh_passphrase(
        &self,
        request: SshPassphrasePromptRequest,
    ) -> SshPassphrasePromptResult;
}

#[derive(Debug, Default)]
pub struct CancellingSshPassphrasePromptSink;

impl SshPassphrasePromptSink for CancellingSshPassphrasePromptSink {
    fn prompt_ssh_passphrase(
        &self,
        _request: SshPassphrasePromptRequest,
    ) -> SshPassphrasePromptResult {
        SshPassphrasePromptResult::Cancel
    }
}

pub fn resolve_askpass_prompt(
    cache: &SshPassphraseCache,
    keyring: Option<&KeyringVault>,
    interaction_policy: InteractionPolicy,
    remember_ssh_passphrase: bool,
    prompt: impl Into<String>,
) -> SshAskpassDecision {
    let prompt = prompt.into();
    let key = match classify_ssh_prompt(&prompt) {
        SshPromptKind::KeyPassphrase(key) => key,
        SshPromptKind::Unsupported => {
            return SshAskpassDecision::Fail {
                reason: SshAskpassFailureReason::UnsupportedPrompt,
                classification: SshAuthFailureClassification::ExpectedAuthenticationFailure,
            };
        }
    };

    if let Some(secret) = cache.get(&key) {
        return SshAskpassDecision::ReturnSecret {
            secret,
            source: SshSecretSource::MemoryCache,
        };
    }

    if remember_ssh_passphrase {
        if let Some(vault) = keyring {
            match vault.get_ssh_passphrase(&key) {
                Ok(Some(secret)) => {
                    cache.insert(key, secret.clone());
                    return SshAskpassDecision::ReturnSecret {
                        secret,
                        source: SshSecretSource::Keyring,
                    };
                }
                Ok(None) => {}
                Err(_) => {
                    return SshAskpassDecision::Fail {
                        reason: SshAskpassFailureReason::KeyringUnavailable,
                        classification: SshAuthFailureClassification::ExpectedAuthenticationFailure,
                    };
                }
            }
        }
    }

    match interaction_policy.prompt_decision() {
        AuthPromptDecision::Prompt => SshAskpassDecision::PromptUser {
            key,
            prompt,
            remember_available: remember_ssh_passphrase && keyring.is_some(),
        },
        AuthPromptDecision::FailImmediately => SshAskpassDecision::Fail {
            reason: SshAskpassFailureReason::PassphraseRequired,
            classification: SshAuthFailureClassification::ExpectedOffline,
        },
    }
}

pub fn remember_prompted_passphrase(
    cache: &SshPassphraseCache,
    keyring: Option<&KeyringVault>,
    key: &SshPassphraseKey,
    passphrase: impl Into<String>,
    remember_in_keyring: bool,
) -> KeyringResult<()> {
    let passphrase = passphrase.into();
    cache.insert(key.clone(), passphrase.clone());

    if remember_in_keyring {
        if let Some(vault) = keyring {
            vault.set_ssh_passphrase(key, passphrase)?;
        }
    }

    Ok(())
}

pub fn classify_ssh_prompt(prompt: &str) -> SshPromptKind {
    let lower = prompt.to_ascii_lowercase();
    if !lower.contains("passphrase") {
        return SshPromptKind::Unsupported;
    }

    SshPromptKind::KeyPassphrase(SshPassphraseKey::new(
        extract_quoted_key_path(prompt).unwrap_or_else(|| prompt.trim().to_owned()),
    ))
}

fn extract_quoted_key_path(prompt: &str) -> Option<String> {
    let start = prompt.find('\'')?;
    let rest = &prompt[start + 1..];
    let end = rest.find('\'')?;
    let key = rest[..end].trim();
    (!key.is_empty()).then(|| key.to_owned())
}

fn real_home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn display_os_string(value: OsString) -> String {
    value.to_string_lossy().into_owned()
}

fn quote_command_atom(value: &str) -> String {
    if !needs_shell_quotes(value) {
        return value.to_owned();
    }

    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '"' | '\\' | '$' | '`' => {
                quoted.push('\\');
                quoted.push(character);
            }
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

fn needs_shell_quotes(value: &str) -> bool {
    value.is_empty()
        || value.chars().any(|character| {
            character.is_whitespace() || matches!(character, '"' | '\'' | '$' | '`' | '\\')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_core::keyring::InMemoryCredentialStore;
    use artistic_git_test_support::{git_dist_manifest_fixture, write_executable_file};
    use std::sync::Arc;

    #[test]
    fn windows_uses_bundled_openssh_and_accept_new_known_hosts() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut manifest = git_dist_manifest_fixture();
        manifest.paths.windows_ssh_executable = Some("openssh/ssh.exe".to_owned());
        write_manifest_executables(temp.path(), &manifest);
        let distribution =
            GitDistribution::from_manifest(temp.path(), manifest).expect("distribution");

        let plan = SshCommandPlan::for_distribution_with_home(
            &distribution,
            SshPlatform::Windows,
            temp.path().join("User Profile"),
        )
        .expect("ssh plan");

        assert_eq!(
            plan.binary,
            SshBinarySource::BundledWindowsOpenSsh(temp.path().join("openssh/ssh.exe"))
        );
        assert_eq!(
            plan.known_hosts_path,
            temp.path().join("User Profile/.ssh/known_hosts")
        );
        assert_eq!(plan.strict_host_key_checking, "accept-new");
        let command = plan.core_ssh_command.to_string_lossy();
        assert!(command.contains("StrictHostKeyChecking=accept-new"));
        assert!(command.contains("UserKnownHostsFile="));
        assert!(command.contains("\""));
    }

    #[test]
    fn macos_and_linux_use_system_ssh() {
        let temp = tempfile::tempdir().expect("tempdir");
        let distribution = fake_distribution(temp.path());

        for platform in [SshPlatform::MacOs, SshPlatform::Linux] {
            let plan = SshCommandPlan::for_distribution_with_home(
                &distribution,
                platform,
                temp.path().join("home"),
            )
            .expect("ssh plan");

            assert_eq!(plan.binary, SshBinarySource::SystemSsh);
            assert!(plan
                .core_ssh_command
                .to_string_lossy()
                .starts_with("ssh -o StrictHostKeyChecking=accept-new"));
        }
    }

    #[test]
    fn interactive_passphrase_prompt_requests_user_when_cache_is_empty() {
        let cache = SshPassphraseCache::new();
        let decision = resolve_askpass_prompt(
            &cache,
            None,
            InteractionPolicy::interactive(),
            false,
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
        );

        assert_eq!(
            decision,
            SshAskpassDecision::PromptUser {
                key: SshPassphraseKey::new("/Users/me/.ssh/id_ed25519"),
                prompt: "Enter passphrase for key '/Users/me/.ssh/id_ed25519':".to_owned(),
                remember_available: false,
            }
        );
    }

    #[test]
    fn non_interactive_without_cache_fails_as_expected_offline() {
        let cache = SshPassphraseCache::new();
        let decision = resolve_askpass_prompt(
            &cache,
            None,
            InteractionPolicy::background_non_interactive(),
            false,
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
        );

        assert_eq!(
            decision,
            SshAskpassDecision::Fail {
                reason: SshAskpassFailureReason::PassphraseRequired,
                classification: SshAuthFailureClassification::ExpectedOffline,
            }
        );
    }

    #[test]
    fn memory_cache_satisfies_background_askpass_without_prompting() {
        let cache = SshPassphraseCache::new();
        let key = SshPassphraseKey::new("/Users/me/.ssh/id_ed25519");
        cache.insert(key, "secret");

        let decision = resolve_askpass_prompt(
            &cache,
            None,
            InteractionPolicy::background_non_interactive(),
            false,
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
        );

        assert_eq!(
            decision,
            SshAskpassDecision::ReturnSecret {
                secret: "secret".to_owned(),
                source: SshSecretSource::MemoryCache,
            }
        );
    }

    #[test]
    fn remembered_passphrase_round_trips_through_keyring_then_memory() {
        let cache = SshPassphraseCache::new();
        let vault = KeyringVault::new(Arc::new(InMemoryCredentialStore::default()));
        let key = SshPassphraseKey::new("/Users/me/.ssh/id_ed25519");

        remember_prompted_passphrase(&cache, Some(&vault), &key, "secret", true)
            .expect("remember passphrase");
        cache.clear();

        let decision = resolve_askpass_prompt(
            &cache,
            Some(&vault),
            InteractionPolicy::background_non_interactive(),
            true,
            "Enter passphrase for key '/Users/me/.ssh/id_ed25519':",
        );

        assert_eq!(
            decision,
            SshAskpassDecision::ReturnSecret {
                secret: "secret".to_owned(),
                source: SshSecretSource::Keyring,
            }
        );
        assert_eq!(cache.get(&key), Some("secret".to_owned()));
    }

    #[test]
    fn unsupported_askpass_prompt_is_expected_auth_failure() {
        let cache = SshPassphraseCache::new();
        let decision = resolve_askpass_prompt(
            &cache,
            None,
            InteractionPolicy::interactive(),
            false,
            "Password for git@example.test:",
        );

        assert_eq!(
            decision,
            SshAskpassDecision::Fail {
                reason: SshAskpassFailureReason::UnsupportedPrompt,
                classification: SshAuthFailureClassification::ExpectedAuthenticationFailure,
            }
        );
    }

    fn fake_distribution(root: &Path) -> GitDistribution {
        let manifest = git_dist_manifest_fixture();
        write_manifest_executables(root, &manifest);
        GitDistribution::from_manifest(root, manifest).expect("distribution")
    }

    fn write_manifest_executables(root: &Path, manifest: &artistic_git_contracts::GitDistManifest) {
        write_executable_file(&root.join(&manifest.paths.git_executable)).expect("git");
        write_executable_file(&root.join(&manifest.paths.git_lfs_executable)).expect("git-lfs");
        write_executable_file(&root.join(&manifest.paths.credential_helper))
            .expect("credential helper");
        write_executable_file(&root.join(&manifest.paths.ssh_askpass)).expect("ssh askpass");
        if let Some(windows_ssh_executable) = &manifest.paths.windows_ssh_executable {
            write_executable_file(&root.join(windows_ssh_executable)).expect("ssh");
        }
    }
}
