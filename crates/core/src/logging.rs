use crate::config::DEFAULT_LOG_RETENTION_DAYS;
use serde::Serialize;
use std::{
    any::Any,
    error::Error as StdError,
    fs, io, panic,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
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
    pub retain_days: u16,
}

impl LoggingConfig {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            file_prefix: DEFAULT_LOG_FILE_PREFIX.to_owned(),
            filter: DEFAULT_LOG_FILTER.to_owned(),
            retain_days: DEFAULT_LOG_RETENTION_DAYS,
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

    pub fn with_retention_days(mut self, retain_days: u16) -> Self {
        self.retain_days = retain_days;
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
    cleanup_old_logs(config).map_err(|source| LoggingInitError::Retention { source })?;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanicReport {
    pub location: String,
    pub payload: String,
}

pub fn install_panic_hook() {
    install_panic_hook_with_reporter(|_| {});
}

pub fn install_panic_hook_with_reporter(reporter: impl Fn(PanicReport) + Send + Sync + 'static) {
    let default_hook = panic::take_hook();

    panic::set_hook(Box::new(move |panic_info| {
        let report = panic_report_from_parts(panic_info.location(), panic_info.payload());

        tracing::error!(
            panic_location = %report.location,
            panic_payload = %report.payload,
            "application panic crossed a runtime boundary"
        );

        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| reporter(report)));
        default_hook(panic_info);
    }));
}

pub fn panic_report_from_parts(
    location: Option<&panic::Location<'_>>,
    payload: &(dyn Any + Send),
) -> PanicReport {
    PanicReport {
        location: location
            .map(|panic_location| {
                format!(
                    "{}:{}:{}",
                    panic_location.file(),
                    panic_location.line(),
                    panic_location.column()
                )
            })
            .unwrap_or_else(|| "unknown".to_owned()),
        payload: panic_payload_summary(payload),
    }
}

fn panic_payload_summary(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }

    "non-string panic payload".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogRetentionReport {
    pub deleted_files: Vec<PathBuf>,
    pub retained_files: Vec<PathBuf>,
}

pub fn cleanup_old_logs(config: &LoggingConfig) -> Result<LogRetentionReport, LogRetentionError> {
    cleanup_old_logs_for_date(
        &config.directory,
        &config.file_prefix,
        config.retain_days,
        LogFileDate::today_utc(),
    )
}

pub fn cleanup_old_logs_for_date(
    directory: &Path,
    file_prefix: &str,
    retain_days: u16,
    today: LogFileDate,
) -> Result<LogRetentionReport, LogRetentionError> {
    let mut report = LogRetentionReport {
        deleted_files: Vec::new(),
        retained_files: Vec::new(),
    };

    let entries = fs::read_dir(directory).map_err(|source| LogRetentionError::ReadDir {
        path: directory.to_path_buf(),
        source,
    })?;

    for entry in entries {
        let entry = entry.map_err(|source| LogRetentionError::Entry {
            path: directory.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| LogRetentionError::FileType {
                path: path.clone(),
                source,
            })?;

        if !file_type.is_file() {
            continue;
        }

        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let Some(log_date) = extract_log_file_date(&file_name, file_prefix) else {
            continue;
        };

        if should_delete_log_file(log_date, today, retain_days) {
            fs::remove_file(&path).map_err(|source| LogRetentionError::Remove {
                path: path.clone(),
                source,
            })?;
            report.deleted_files.push(path);
        } else {
            report.retained_files.push(path);
        }
    }

    Ok(report)
}

fn should_delete_log_file(log_date: LogFileDate, today: LogFileDate, retain_days: u16) -> bool {
    let age_days = today.days_since_unix_epoch() - log_date.days_since_unix_epoch();
    age_days >= i64::from(retain_days)
}

fn extract_log_file_date(file_name: &str, file_prefix: &str) -> Option<LogFileDate> {
    if !file_name.starts_with(file_prefix) {
        return None;
    }

    let bytes = file_name.as_bytes();
    let start = bytes.len().checked_sub(10)?;
    if start <= file_prefix.len() {
        return None;
    }
    if !matches!(bytes[start - 1], b'.' | b'-' | b'_') {
        return None;
    }

    let candidate = file_name.get(start..)?;
    LogFileDate::parse(candidate)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LogFileDate {
    year: i32,
    month: u8,
    day: u8,
}

impl LogFileDate {
    pub fn new(year: i32, month: u8, day: u8) -> Option<Self> {
        let date = Self { year, month, day };
        let round_trip = Self::from_unix_days(date.days_since_unix_epoch());
        (round_trip == date).then_some(date)
    }

    pub fn parse(value: &str) -> Option<Self> {
        let mut parts = value.split('-');
        let year = parts.next()?.parse().ok()?;
        let month = parts.next()?.parse().ok()?;
        let day = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }

        Self::new(year, month, day)
    }

    pub fn today_utc() -> Self {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self::from_unix_days((seconds / 86_400) as i64)
    }

    fn days_since_unix_epoch(self) -> i64 {
        let year = self.year - i32::from(self.month <= 2);
        let era = if year >= 0 { year } else { year - 399 } / 400;
        let year_of_era = year - era * 400;
        let shifted_month = i32::from(self.month) + if self.month > 2 { -3 } else { 9 };
        let day_of_year = (153 * shifted_month + 2) / 5 + i32::from(self.day) - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;

        i64::from(era * 146_097 + day_of_era - 719_468)
    }

    fn from_unix_days(days: i64) -> Self {
        let days = days + 719_468;
        let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
        let day_of_era = days - era * 146_097;
        let year_of_era =
            (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let mut year = year_of_era + era * 400;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_prime = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
        let month = month_prime + if month_prime < 10 { 3 } else { -9 };
        year += i64::from(month <= 2);

        Self {
            year: year as i32,
            month: month as u8,
            day: day as u8,
        }
    }
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
    #[error("failed to clean up old log files: {source}")]
    Retention { source: LogRetentionError },
}

#[derive(Debug, Error)]
pub enum LogRetentionError {
    #[error("failed to read log directory {path}: {source}")]
    ReadDir { path: PathBuf, source: io::Error },
    #[error("failed to read log directory entry in {path}: {source}")]
    Entry { path: PathBuf, source: io::Error },
    #[error("failed to read file type for {path}: {source}")]
    FileType { path: PathBuf, source: io::Error },
    #[error("failed to remove old log file {path}: {source}")]
    Remove { path: PathBuf, source: io::Error },
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
        assert_eq!(config.retain_days, DEFAULT_LOG_RETENTION_DAYS);
    }

    #[test]
    fn cleanup_old_logs_removes_files_outside_retention_window() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let old_log = temp_dir.path().join("artistic-git.log.2026-07-01");
        let retained_log = temp_dir.path().join("artistic-git.log.2026-07-02");
        let active_log = temp_dir.path().join("artistic-git.log");
        let unrelated_log = temp_dir.path().join("other.log.2026-06-01");
        fs::write(&old_log, "old").expect("write old log");
        fs::write(&retained_log, "retained").expect("write retained log");
        fs::write(&active_log, "active").expect("write active log");
        fs::write(&unrelated_log, "unrelated").expect("write unrelated log");

        let report = cleanup_old_logs_for_date(
            temp_dir.path(),
            DEFAULT_LOG_FILE_PREFIX,
            30,
            LogFileDate::new(2026, 7, 31).expect("valid date"),
        )
        .expect("cleanup logs");

        assert_eq!(report.deleted_files, vec![old_log.clone()]);
        assert!(!old_log.exists());
        assert!(retained_log.exists());
        assert!(active_log.exists());
        assert!(unrelated_log.exists());
    }

    #[test]
    fn panic_payload_summary_extracts_string_messages() {
        assert_eq!(panic_payload_summary(&"borrow failed"), "borrow failed");
        assert_eq!(
            panic_payload_summary(&"owned message".to_owned()),
            "owned message"
        );
        assert_eq!(panic_payload_summary(&42_u32), "non-string panic payload");
    }
}
