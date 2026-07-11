use artistic_git_contracts::{
    AppError, AppResult, RemoteSettingsResponse, RepositoryRemoteMode, SaveRemoteSettingsRequest,
};
use artistic_git_git_runner::GitRunner;
use std::{ffi::OsString, path::Path};

use crate::git_ops::{
    canonical_repository_path, command_failure, display_path, git_stdout, run_git, run_git_raw,
};

pub fn load_remote_settings(
    runner: &GitRunner,
    repository_path: impl AsRef<str>,
) -> AppResult<RemoteSettingsResponse> {
    let root = canonical_repository_path(repository_path.as_ref(), "loadRemoteSettings")?;
    let origin_url = read_origin_url(runner, &root, "loadRemoteSettings")?;
    Ok(remote_settings_response(root.as_path(), origin_url))
}

pub fn save_remote_settings(
    runner: &GitRunner,
    request: SaveRemoteSettingsRequest,
) -> AppResult<RemoteSettingsResponse> {
    let root = canonical_repository_path(&request.repository_path, "saveRemoteSettings")?;
    let _permit = crate::begin_identity_write(runner, "saveRemoteSettings", &root, false)?;
    let existing_origin = read_origin_url(runner, &root, "saveRemoteSettings")?;
    let next_origin = request
        .origin_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match (
        existing_origin.as_deref(),
        next_origin,
        request.remove_origin,
    ) {
        (_, Some(url), _) => {
            if existing_origin.is_some() {
                git_stdout(
                    runner,
                    Some(&root),
                    [
                        OsString::from("config"),
                        OsString::from("--local"),
                        OsString::from("remote.origin.url"),
                        OsString::from(url),
                    ],
                    "saveRemoteSettings",
                )?;
            } else {
                git_stdout(
                    runner,
                    Some(&root),
                    [
                        OsString::from("remote"),
                        OsString::from("add"),
                        OsString::from("origin"),
                        OsString::from(url),
                    ],
                    "saveRemoteSettings",
                )?;
            }
        }
        (Some(_), None, true) => {
            run_git(
                runner,
                Some(&root),
                ["remote", "remove", "origin"],
                "saveRemoteSettings",
            )?;
        }
        (Some(_), None, false) => {
            return Err(crate::logged_app_error(AppError::expected(
                "confirm origin removal before saving an empty remote URL",
                "saveRemoteSettings",
            )));
        }
        (None, None, _) => {}
    }

    let origin_url = read_origin_url(runner, &root, "saveRemoteSettings")?;
    Ok(remote_settings_response(root.as_path(), origin_url))
}

pub(crate) fn read_origin_url(
    runner: &GitRunner,
    root: &Path,
    operation_name: &str,
) -> AppResult<Option<String>> {
    let (plan, output) = run_git_raw(
        runner,
        Some(root),
        ["remote", "get-url", "origin"],
        operation_name,
    )?;
    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Ok((!url.is_empty()).then_some(url));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if is_missing_origin_error(&stderr) {
        Ok(None)
    } else {
        Err(command_failure(&plan, output, operation_name))
    }
}

fn remote_settings_response(root: &Path, origin_url: Option<String>) -> RemoteSettingsResponse {
    let remote_mode = if origin_url.is_some() {
        RepositoryRemoteMode::Origin
    } else {
        RepositoryRemoteMode::NoRemote
    };

    RemoteSettingsResponse {
        repository_path: display_path(root),
        remote_mode,
        origin_url,
    }
}

fn is_missing_origin_error(stderr: &str) -> bool {
    let normalized = stderr.to_ascii_lowercase();
    normalized.contains("no such remote 'origin'")
        || normalized.contains("no such remote \"origin\"")
        || normalized.contains("no such remote: origin")
}

#[cfg(test)]
mod tests {
    use super::*;
    use artistic_git_git_runner::{GitDistribution, GitRunner};
    use artistic_git_test_support::{require_git_dist, TestTempDir};
    use std::{ffi::OsString, fs, io::Write, path::PathBuf};

    #[test]
    fn loads_no_remote_mode_when_origin_is_missing() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);

        let response =
            load_remote_settings(&runner, display_path(&repo.path)).expect("remote settings");

        assert_eq!(response.remote_mode, RepositoryRemoteMode::NoRemote);
        assert_eq!(response.origin_url, None);
    }

    #[test]
    fn updates_origin_url_and_requires_confirmation_before_removal() {
        let (runner, _dist_temp) = real_runner();
        let repo = TestRepo::new(&runner);
        repo.git(["init", "-b", "main"]);
        repo.git(["remote", "add", "origin", "https://example.test/old.git"]);

        let saved = save_remote_settings(
            &runner,
            SaveRemoteSettingsRequest {
                repository_path: display_path(&repo.path),
                origin_url: Some("https://example.test/new.git".to_owned()),
                remove_origin: false,
            },
        )
        .expect("save remote url");

        assert_eq!(saved.remote_mode, RepositoryRemoteMode::Origin);
        assert_eq!(
            saved.origin_url.as_deref(),
            Some("https://example.test/new.git")
        );
        assert_eq!(
            repo.git_output(["config", "--local", "--get", "remote.origin.url"])
                .trim(),
            "https://example.test/new.git"
        );

        let error = save_remote_settings(
            &runner,
            SaveRemoteSettingsRequest {
                repository_path: display_path(&repo.path),
                origin_url: None,
                remove_origin: false,
            },
        )
        .expect_err("empty origin requires confirmation");
        assert_eq!(error.context.operation_name, "saveRemoteSettings");

        let removed = save_remote_settings(
            &runner,
            SaveRemoteSettingsRequest {
                repository_path: display_path(&repo.path),
                origin_url: None,
                remove_origin: true,
            },
        )
        .expect("remove origin");

        assert_eq!(removed.remote_mode, RepositoryRemoteMode::NoRemote);
        assert_eq!(removed.origin_url, None);
        assert!(repo.git_output(["remote"]).trim().is_empty());
    }

    fn real_runner() -> (GitRunner, TestTempDir) {
        let dist = require_git_dist().expect("load embedded git distribution");
        let distribution = GitDistribution::from_manifest(dist.root, dist.manifest)
            .expect("load embedded git distribution");
        let temp = TestTempDir::new("ag-remote-runner-home").expect("temp home");
        let runner = GitRunner::from_distribution(distribution, temp.path().join("home"));
        (runner, temp)
    }

    struct TestRepo {
        path: PathBuf,
        _temp: TestTempDir,
        runner: GitRunner,
    }

    impl TestRepo {
        fn new(runner: &GitRunner) -> Self {
            let temp = TestTempDir::new("ag-remote-repo").expect("temp repo");
            Self {
                path: temp.path().to_path_buf(),
                _temp: temp,
                runner: runner.clone(),
            }
        }

        fn git<I, S>(&self, args: I)
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            self.git_output(args);
        }

        fn git_output<I, S>(&self, args: I) -> String
        where
            I: IntoIterator<Item = S>,
            S: Into<OsString>,
        {
            git_stdout(&self.runner, Some(&self.path), args, "test").expect("git command")
        }

        #[allow(dead_code)]
        fn write(&self, relative: &str, content: &str) {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("parent dir");
            }
            let mut file = fs::File::create(path).expect("create file");
            file.write_all(content.as_bytes()).expect("write file");
        }
    }
}
