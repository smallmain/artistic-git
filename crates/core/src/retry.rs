use std::time::Duration;

pub const DEFAULT_NETWORK_RETRY_COUNT: u8 = 3;
pub const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    max_retries: u8,
    initial_delay: Duration,
}

impl RetryPolicy {
    pub fn new(max_retries: u8, initial_delay: Duration) -> Self {
        Self {
            max_retries,
            initial_delay,
        }
    }

    pub fn network() -> Self {
        Self {
            max_retries: DEFAULT_NETWORK_RETRY_COUNT,
            initial_delay: DEFAULT_INITIAL_BACKOFF,
        }
    }

    pub fn max_retries(&self) -> u8 {
        self.max_retries
    }

    pub fn delay_for_retry(&self, retry_index: u8) -> Option<Duration> {
        if retry_index >= self.max_retries {
            return None;
        }

        let multiplier = 1u32.checked_shl(u32::from(retry_index)).unwrap_or(u32::MAX);
        Some(self.initial_delay.saturating_mul(multiplier))
    }

    pub fn retry_delays(&self) -> Vec<Duration> {
        (0..self.max_retries)
            .filter_map(|retry_index| self.delay_for_retry(retry_index))
            .collect()
    }
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::network()
    }
}

pub fn retry_with_backoff<T, E, Operation, IsRetryable, Sleep>(
    policy: RetryPolicy,
    mut operation: Operation,
    mut is_retryable: IsRetryable,
    mut sleep: Sleep,
) -> Result<T, E>
where
    Operation: FnMut() -> Result<T, E>,
    IsRetryable: FnMut(&E) -> bool,
    Sleep: FnMut(Duration),
{
    let mut retry_index = 0;

    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if is_retryable(&error) => {
                let Some(delay) = policy.delay_for_retry(retry_index) else {
                    return Err(error);
                };
                retry_index += 1;
                sleep(delay);
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum TestError {
        Network,
        Fatal,
    }

    #[test]
    fn network_policy_uses_one_two_four_second_backoff() {
        let policy = RetryPolicy::network();

        assert_eq!(
            policy.retry_delays(),
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
            ]
        );
    }

    #[test]
    fn retry_with_backoff_retries_retryable_failures_until_success() {
        let mut attempts = 0;
        let mut slept = Vec::new();

        let result = retry_with_backoff(
            RetryPolicy::network(),
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(TestError::Network)
                } else {
                    Ok("ok")
                }
            },
            |error| matches!(error, TestError::Network),
            |delay| slept.push(delay),
        );

        assert_eq!(result, Ok("ok"));
        assert_eq!(attempts, 3);
        assert_eq!(slept, vec![Duration::from_secs(1), Duration::from_secs(2)]);
    }

    #[test]
    fn retry_with_backoff_stops_on_non_retryable_failure() {
        let mut attempts = 0;

        let result = retry_with_backoff(
            RetryPolicy::network(),
            || {
                attempts += 1;
                Err::<(), _>(TestError::Fatal)
            },
            |error| matches!(error, TestError::Network),
            |_| panic!("non-retryable errors must not sleep"),
        );

        assert_eq!(result, Err(TestError::Fatal));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn retry_with_backoff_returns_last_retryable_error_after_budget() {
        let mut attempts = 0;
        let mut slept = Vec::new();

        let result = retry_with_backoff(
            RetryPolicy::network(),
            || {
                attempts += 1;
                Err::<(), _>(TestError::Network)
            },
            |error| matches!(error, TestError::Network),
            |delay| slept.push(delay),
        );

        assert_eq!(result, Err(TestError::Network));
        assert_eq!(attempts, 4);
        assert_eq!(slept, RetryPolicy::network().retry_delays());
    }
}
