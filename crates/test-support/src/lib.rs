use artistic_git_contracts::GitDistManifest;
use std::collections::BTreeMap;
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum GitDistError {
    #[error("ARTISTIC_GIT_DIST_DIR is not set; tests must use the embedded Git distribution")]
    MissingEnvironment,
    #[error("git distribution manifest is missing at {0}")]
    MissingManifest(PathBuf),
    #[error("failed to read git distribution manifest at {path}: {source}")]
    ReadManifest {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse git distribution manifest at {path}: {source}")]
    ParseManifest {
        path: PathBuf,
        source: serde_json::Error,
    },
}

#[derive(Debug, Error)]
pub enum WriteGitDistManifestError {
    #[error("failed to create git distribution test root at {path}: {source}")]
    CreateRoot {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to serialize git distribution manifest: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to write git distribution manifest at {path}: {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
}

#[derive(Debug, Clone)]
pub struct GitDist {
    pub root: PathBuf,
    pub manifest: GitDistManifest,
}

#[derive(Debug)]
pub struct TestTempDir {
    path: PathBuf,
}

impl TestTempDir {
    pub fn new(prefix: &str) -> io::Result<Self> {
        let mut path = env::temp_dir();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let counter = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        path.push(format!("{prefix}-{}-{now}-{counter}", std::process::id()));
        fs::create_dir_all(&path)?;

        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn require_git_dist() -> Result<GitDist, GitDistError> {
    let root = env::var_os("ARTISTIC_GIT_DIST_DIR")
        .map(PathBuf::from)
        .ok_or(GitDistError::MissingEnvironment)?;

    load_git_dist(root)
}

pub fn load_git_dist(root: PathBuf) -> Result<GitDist, GitDistError> {
    let manifest_path = root.join("manifest.json");

    if !manifest_path.exists() {
        return Err(GitDistError::MissingManifest(manifest_path));
    }

    let manifest_json =
        fs::read_to_string(&manifest_path).map_err(|source| GitDistError::ReadManifest {
            path: manifest_path.clone(),
            source,
        })?;
    let manifest =
        serde_json::from_str(&manifest_json).map_err(|source| GitDistError::ParseManifest {
            path: manifest_path,
            source,
        })?;

    Ok(GitDist { root, manifest })
}

pub fn command_path(root: &Path, relative_path: &str) -> PathBuf {
    root.join(relative_path)
}

pub fn git_dist_manifest_fixture() -> GitDistManifest {
    GitDistManifest {
        schema_version: 1,
        platform: std::env::consts::OS.to_owned(),
        git_version: "git version 2.50.0".to_owned(),
        git_lfs_version: "git-lfs/3.6.0".to_owned(),
        windows_open_ssh_version: None,
        helper_version: "test-helper".to_owned(),
        paths: artistic_git_contracts::GitDistPaths {
            git_executable: executable_path("git/bin/git"),
            git_lfs_executable: executable_path("git-lfs/git-lfs"),
            windows_ssh_executable: None,
            credential_helper: executable_path("helpers/artistic-git-credential-helper"),
            ssh_askpass: executable_path("helpers/artistic-git-ssh-askpass"),
        },
        sha256: BTreeMap::new(),
    }
}

pub fn write_git_dist_manifest(
    root: &Path,
    manifest: &GitDistManifest,
) -> Result<PathBuf, WriteGitDistManifestError> {
    fs::create_dir_all(root).map_err(|source| WriteGitDistManifestError::CreateRoot {
        path: root.to_path_buf(),
        source,
    })?;

    let manifest_path = root.join("manifest.json");
    let json = serde_json::to_vec_pretty(manifest).map_err(WriteGitDistManifestError::Serialize)?;
    fs::write(&manifest_path, json).map_err(|source| WriteGitDistManifestError::Write {
        path: manifest_path.clone(),
        source,
    })?;

    Ok(manifest_path)
}

pub fn write_executable_file(path: &Path) -> io::Result<()> {
    write_executable_script(path, "#!/bin/sh\nexit 0\n", "@echo off\r\nexit /b 0\r\n")
}

pub fn write_executable_script(
    path: &Path,
    unix_script: &str,
    windows_script: &str,
) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    if cfg!(windows) {
        fs::write(path, windows_script)?;
    } else {
        fs::write(path, unix_script)?;
    }

    mark_executable(path)
}

fn executable_path(path: &str) -> String {
    if cfg!(windows) {
        format!("{path}.exe")
    } else {
        path.to_owned()
    }
}

fn mark_executable(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
    }

    #[cfg(not(unix))]
    {
        let _ = path;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_manifest_is_explicit_error() {
        let root = PathBuf::from("/definitely/missing/artistic-git-dist");

        let error = load_git_dist(root).expect_err("missing manifest should fail");

        assert!(matches!(error, GitDistError::MissingManifest(_)));
    }
}
