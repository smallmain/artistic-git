use std::{
    error::Error as StdError,
    fs, io,
    path::{Path, PathBuf},
};
use thiserror::Error;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

pub const DEFAULT_LOG_FILE_PREFIX: &str = "artistic-git.log";
pub const DEFAULT_LOG_FILTER: &str = "info,artistic_git=debug";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoggingConfig {
    pub directory: PathBuf,
    pub file_prefix: String,
    pub filter: String,
}

impl LoggingConfig {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            file_prefix: DEFAULT_LOG_FILE_PREFIX.to_owned(),
            filter: DEFAULT_LOG_FILTER.to_owned(),
        }
    }

    pub fn with_file_prefix(mut self, file_prefix: impl Into<String>) -> Self {
        self.file_prefix = file_prefix.into();
        self
    }

    pub fn with_filter(mut self, filter: impl Into<String>) -> Self {
        self.filter = filter.into();
        self
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }
}

#[derive(Debug)]
pub struct LoggingGuard {
    _worker_guard: WorkerGuard,
}

pub fn initialize_logging(config: &LoggingConfig) -> Result<LoggingGuard, LoggingInitError> {
    fs::create_dir_all(&config.directory).map_err(|source| LoggingInitError::CreateDir {
        path: config.directory.clone(),
        source,
    })?;

    let env_filter =
        EnvFilter::try_new(&config.filter).map_err(|source| LoggingInitError::InvalidFilter {
            filter: config.filter.clone(),
            source,
        })?;
    let file_appender = tracing_appender::rolling::daily(&config.directory, &config.file_prefix);
    let (writer, worker_guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(writer)
        .with_ansi(false)
        .try_init()
        .map_err(|source| LoggingInitError::SetGlobalSubscriber { source })?;

    Ok(LoggingGuard {
        _worker_guard: worker_guard,
    })
}

#[derive(Debug, Error)]
pub enum LoggingInitError {
    #[error("failed to create log directory {path}: {source}")]
    CreateDir { path: PathBuf, source: io::Error },
    #[error("invalid tracing filter `{filter}`: {source}")]
    InvalidFilter {
        filter: String,
        source: tracing_subscriber::filter::ParseError,
    },
    #[error("failed to install global tracing subscriber: {source}")]
    SetGlobalSubscriber {
        source: Box<dyn StdError + Send + Sync>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_logging_config_uses_caller_provided_directory() {
        let config = LoggingConfig::new("/tmp/artistic-git-logs");

        assert_eq!(config.directory(), Path::new("/tmp/artistic-git-logs"));
        assert_eq!(config.file_prefix, DEFAULT_LOG_FILE_PREFIX);
        assert_eq!(config.filter, DEFAULT_LOG_FILTER);
    }
}
