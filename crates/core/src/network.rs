use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::BTreeMap, env, ffi::OsString, process::Command};

pub const PROXY_ENV_KEYS: [&str; 8] = [
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    #[default]
    System,
    None,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct NetworkSettings {
    pub proxy_mode: ProxyMode,
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub all_proxy: Option<String>,
    pub no_proxy: Option<String>,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            proxy_mode: ProxyMode::System,
            http_proxy: None,
            https_proxy: None,
            all_proxy: None,
            no_proxy: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ResolvedProxyEnvironment {
    pub variables: BTreeMap<String, String>,
    pub force_http1: bool,
}

impl ResolvedProxyEnvironment {
    pub fn is_empty(&self) -> bool {
        self.variables.is_empty()
    }

    pub fn as_os_map(&self) -> BTreeMap<String, OsString> {
        self.variables
            .iter()
            .map(|(key, value)| (key.clone(), OsString::from(value)))
            .collect()
    }
}

pub fn resolve_proxy_environment(settings: &NetworkSettings) -> ResolvedProxyEnvironment {
    match settings.proxy_mode {
        ProxyMode::None => ResolvedProxyEnvironment::default(),
        ProxyMode::Custom => {
            let mut variables = BTreeMap::new();
            insert_proxy_pair(
                &mut variables,
                "http_proxy",
                "HTTP_PROXY",
                settings.http_proxy.as_deref(),
            );
            insert_proxy_pair(
                &mut variables,
                "https_proxy",
                "HTTPS_PROXY",
                settings
                    .https_proxy
                    .as_deref()
                    .or(settings.http_proxy.as_deref()),
            );
            insert_proxy_pair(
                &mut variables,
                "all_proxy",
                "ALL_PROXY",
                settings.all_proxy.as_deref(),
            );
            insert_proxy_pair(
                &mut variables,
                "no_proxy",
                "NO_PROXY",
                settings.no_proxy.as_deref(),
            );
            ResolvedProxyEnvironment {
                force_http1: !variables.is_empty(),
                variables,
            }
        }
        ProxyMode::System => resolve_system_proxy_environment(),
    }
}

pub fn apply_process_proxy_environment(resolved: &ResolvedProxyEnvironment) {
    for key in PROXY_ENV_KEYS {
        // SAFETY: process-wide proxy configuration is intentionally global for
        // libraries (updater, etc.) that only read standard environment variables.
        unsafe {
            env::remove_var(key);
        }
    }
    for (key, value) in &resolved.variables {
        unsafe {
            env::set_var(key, value);
        }
    }
}

fn resolve_system_proxy_environment() -> ResolvedProxyEnvironment {
    let mut variables = BTreeMap::new();

    // Prefer explicit process environment first (terminal launches / CI).
    for (lower, upper) in [
        ("http_proxy", "HTTP_PROXY"),
        ("https_proxy", "HTTPS_PROXY"),
        ("all_proxy", "ALL_PROXY"),
        ("no_proxy", "NO_PROXY"),
    ] {
        if let Some(value) = env::var_os(lower)
            .or_else(|| env::var_os(upper))
            .and_then(|value| {
                let text = value.to_string_lossy().trim().to_owned();
                (!text.is_empty()).then_some(text)
            })
        {
            variables.insert(lower.to_owned(), value.clone());
            variables.insert(upper.to_owned(), value);
        }
    }

    if variables.is_empty() {
        if let Some(system) = detect_platform_system_proxy() {
            variables.extend(system);
        }
    }

    ResolvedProxyEnvironment {
        force_http1: !variables.is_empty(),
        variables,
    }
}

fn detect_platform_system_proxy() -> Option<BTreeMap<String, String>> {
    #[cfg(target_os = "macos")]
    {
        return detect_macos_system_proxy();
    }
    #[cfg(target_os = "windows")]
    {
        return detect_windows_system_proxy();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return detect_linux_system_proxy();
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(target_os = "macos")]
fn detect_macos_system_proxy() -> Option<BTreeMap<String, String>> {
    let output = Command::new("scutil").arg("--proxy").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_macos_scutil_proxy(&text)
}

#[cfg(target_os = "macos")]
fn parse_macos_scutil_proxy(text: &str) -> Option<BTreeMap<String, String>> {
    let mut values = BTreeMap::<String, String>::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        values.insert(key.trim().to_owned(), value.trim().to_owned());
    }

    let mut variables = BTreeMap::new();
    if values.get("HTTPEnable").is_some_and(|value| value == "1") {
        if let (Some(host), Some(port)) = (values.get("HTTPProxy"), values.get("HTTPPort")) {
            let url = proxy_url("http", host, port);
            insert_proxy_pair(&mut variables, "http_proxy", "HTTP_PROXY", Some(&url));
        }
    }
    if values.get("HTTPSEnable").is_some_and(|value| value == "1") {
        if let (Some(host), Some(port)) = (values.get("HTTPSProxy"), values.get("HTTPSPort")) {
            let url = proxy_url("http", host, port);
            insert_proxy_pair(&mut variables, "https_proxy", "HTTPS_PROXY", Some(&url));
        }
    }
    if values.get("SOCKSEnable").is_some_and(|value| value == "1") {
        if let (Some(host), Some(port)) = (values.get("SOCKSProxy"), values.get("SOCKSPort")) {
            let url = proxy_url("socks5", host, port);
            insert_proxy_pair(&mut variables, "all_proxy", "ALL_PROXY", Some(&url));
        }
    }

    if let Some(exceptions) = values.get("ExceptionsList") {
        // scutil prints ExceptionsList as a nested array; fall back to common local exclusions.
        let _ = exceptions;
    }
    if !variables.is_empty() && !variables.contains_key("no_proxy") {
        insert_proxy_pair(
            &mut variables,
            "no_proxy",
            "NO_PROXY",
            Some("localhost,127.0.0.1,::1"),
        );
    }

    // If only SOCKS is enabled, still useful; if only HTTP, mirror to HTTPS when missing.
    if variables.contains_key("http_proxy") && !variables.contains_key("https_proxy") {
        if let Some(http) = variables.get("http_proxy").cloned() {
            insert_proxy_pair(
                &mut variables,
                "https_proxy",
                "HTTPS_PROXY",
                Some(http.as_str()),
            );
        }
    }

    (!variables.is_empty()).then_some(variables)
}

#[cfg(target_os = "windows")]
fn detect_windows_system_proxy() -> Option<BTreeMap<String, String>> {
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_windows_internet_settings_proxy(&text)
}

#[cfg(target_os = "windows")]
fn parse_windows_internet_settings_proxy(text: &str) -> Option<BTreeMap<String, String>> {
    let mut proxy_enable = false;
    let mut proxy_server = None;
    let mut proxy_override = None;
    for line in text.lines() {
        let line = line.trim();
        if line.contains("ProxyEnable") {
            proxy_enable = line.ends_with('1');
        } else if line.contains("ProxyServer") {
            proxy_server = line.split_whitespace().last().map(str::to_owned);
        } else if line.contains("ProxyOverride") {
            proxy_override = line.split_whitespace().last().map(str::to_owned);
        }
    }
    if !proxy_enable {
        return None;
    }
    let server = proxy_server.filter(|value| !value.is_empty())?;
    let mut variables = BTreeMap::new();
    // ProxyServer may be "host:port" or "http=host:port;https=host:port"
    if server.contains('=') {
        for part in server.split(';') {
            if let Some((scheme, endpoint)) = part.split_once('=') {
                let url = normalize_proxy_endpoint(endpoint);
                match scheme.to_ascii_lowercase().as_str() {
                    "http" => {
                        insert_proxy_pair(&mut variables, "http_proxy", "HTTP_PROXY", Some(&url))
                    }
                    "https" => {
                        insert_proxy_pair(&mut variables, "https_proxy", "HTTPS_PROXY", Some(&url))
                    }
                    "socks" | "socks5" => {
                        insert_proxy_pair(&mut variables, "all_proxy", "ALL_PROXY", Some(&url))
                    }
                    _ => {}
                }
            }
        }
    } else {
        let url = normalize_proxy_endpoint(&server);
        insert_proxy_pair(&mut variables, "http_proxy", "HTTP_PROXY", Some(&url));
        insert_proxy_pair(&mut variables, "https_proxy", "HTTPS_PROXY", Some(&url));
    }
    if let Some(override_list) = proxy_override {
        let cleaned = override_list.replace(';', ",");
        insert_proxy_pair(&mut variables, "no_proxy", "NO_PROXY", Some(&cleaned));
    }
    (!variables.is_empty()).then_some(variables)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn detect_linux_system_proxy() -> Option<BTreeMap<String, String>> {
    // Prefer already-exported environment (handled earlier). Fall back to GNOME settings when present.
    let mode = gsettings_string("org.gnome.system.proxy", "mode")?;
    if mode != "manual" {
        return None;
    }
    let mut variables = BTreeMap::new();
    if let Some(url) = gnome_proxy_url("org.gnome.system.proxy.http", "http") {
        insert_proxy_pair(&mut variables, "http_proxy", "HTTP_PROXY", Some(&url));
    }
    if let Some(url) = gnome_proxy_url("org.gnome.system.proxy.https", "http") {
        insert_proxy_pair(&mut variables, "https_proxy", "HTTPS_PROXY", Some(&url));
    }
    if let Some(url) = gnome_proxy_url("org.gnome.system.proxy.socks", "socks5") {
        insert_proxy_pair(&mut variables, "all_proxy", "ALL_PROXY", Some(&url));
    }
    if let Some(ignore) = gsettings_string("org.gnome.system.proxy", "ignore-hosts") {
        let cleaned = ignore
            .trim_matches(|c| c == '[' || c == ']')
            .replace('\'', "")
            .replace(", ", ",");
        insert_proxy_pair(&mut variables, "no_proxy", "NO_PROXY", Some(&cleaned));
    }
    (!variables.is_empty()).then_some(variables)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn gnome_proxy_url(schema: &str, scheme: &str) -> Option<String> {
    let host = gsettings_string(schema, "host").filter(|value| !value.is_empty())?;
    let port = gsettings_string(schema, "port").filter(|value| value != "0")?;
    Some(format!("{scheme}://{host}:{port}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn gsettings_string(schema: &str, key: &str) -> Option<String> {
    let output = Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Some(text.trim_matches('\'').to_owned())
}

fn insert_proxy_pair(
    variables: &mut BTreeMap<String, String>,
    lower: &str,
    upper: &str,
    value: Option<&str>,
) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    variables.insert(lower.to_owned(), value.to_owned());
    variables.insert(upper.to_owned(), value.to_owned());
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn normalize_proxy_endpoint(endpoint: &str) -> String {
    let endpoint = endpoint.trim();
    if endpoint.contains("://") {
        endpoint.to_owned()
    } else {
        proxy_url("http", endpoint, "")
    }
}

fn proxy_url(scheme: &str, host: &str, port: &str) -> String {
    if port.is_empty() {
        format!("{scheme}{}{host}", "://")
    } else {
        format!("{scheme}{}{host}:{port}", "://")
    }
}

pub fn validate_proxy_url(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return true;
    }
    if value.chars().any(|character| character.is_whitespace()) {
        return false;
    }
    let has_explicit_host_form = value.contains("://")
        || value.starts_with("localhost")
        || value.starts_with('[')
        || value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit());
    if !has_explicit_host_form {
        // Require a scheme for hostnames so free-form text is rejected.
        return false;
    }
    let Ok(url) = url_like_parts(value) else {
        return false;
    };
    !url.host.is_empty() && !url.host.contains(' ') && url.port.map(|port| port > 0).unwrap_or(true)
}

struct UrlLike {
    host: String,
    port: Option<u16>,
}

fn url_like_parts(value: &str) -> Result<UrlLike, ()> {
    let without_scheme = value
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    let authority = without_scheme.split('/').next().unwrap_or_default().trim();
    if authority.is_empty() {
        return Err(());
    }
    // strip credentials
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    if let Some(host) = host_port.strip_prefix('[') {
        // IPv6
        let end = host.find(']').ok_or(())?;
        let (address, rest) = host.split_at(end);
        let port = if let Some(port_text) = rest.strip_prefix("]:") {
            Some(port_text.parse().map_err(|_| ())?)
        } else if rest == "]" {
            None
        } else {
            return Err(());
        };
        return Ok(UrlLike {
            host: address.to_owned(),
            port,
        });
    }
    if let Some((host, port_text)) = host_port.rsplit_once(':') {
        if !port_text.is_empty() && port_text.chars().all(|c| c.is_ascii_digit()) {
            return Ok(UrlLike {
                host: host.to_owned(),
                port: Some(port_text.parse().map_err(|_| ())?),
            });
        }
    }
    Ok(UrlLike {
        host: host_port.to_owned(),
        port: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_proxy_resolution_sets_standard_env_keys() {
        let resolved = resolve_proxy_environment(&NetworkSettings {
            proxy_mode: ProxyMode::Custom,
            http_proxy: Some("http://127.0.0.1:6152".to_owned()),
            https_proxy: None,
            all_proxy: Some("socks5://127.0.0.1:6153".to_owned()),
            no_proxy: Some("localhost,127.0.0.1".to_owned()),
        });

        assert_eq!(
            resolved.variables.get("http_proxy").map(String::as_str),
            Some("http://127.0.0.1:6152")
        );
        assert_eq!(
            resolved.variables.get("https_proxy").map(String::as_str),
            Some("http://127.0.0.1:6152")
        );
        assert_eq!(
            resolved.variables.get("ALL_PROXY").map(String::as_str),
            Some("socks5://127.0.0.1:6153")
        );
        assert!(resolved.force_http1);
    }

    #[test]
    fn none_proxy_mode_clears_all_proxy_variables() {
        let resolved = resolve_proxy_environment(&NetworkSettings {
            proxy_mode: ProxyMode::None,
            http_proxy: Some(format!("{}{}127.0.0.1:8080", "http", "://")),
            https_proxy: None,
            all_proxy: None,
            no_proxy: None,
        });
        assert!(resolved.variables.is_empty());
        assert!(!resolved.force_http1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_scutil_proxy_output() {
        let text = r#"
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 6152
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 6152
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 6153
  SOCKSProxy : 127.0.0.1
}
"#;
        let variables = parse_macos_scutil_proxy(text).expect("proxy");
        assert_eq!(
            variables.get("https_proxy").map(String::as_str),
            Some("http://127.0.0.1:6152")
        );
        assert_eq!(
            variables.get("all_proxy").map(String::as_str),
            Some("socks5://127.0.0.1:6153")
        );
    }

    #[test]
    fn validates_proxy_urls() {
        assert!(validate_proxy_url(""));
        assert!(validate_proxy_url("http://127.0.0.1:6152"));
        assert!(validate_proxy_url("socks5://127.0.0.1:6153"));
        assert!(validate_proxy_url("localhost:6152"));
        assert!(validate_proxy_url("127.0.0.1:6152"));
        assert!(validate_proxy_url("[::1]:6152"));
        assert!(!validate_proxy_url("http://"));
        assert!(!validate_proxy_url("proxy.example:6152"));
        assert!(!validate_proxy_url("not a url"));
    }
}
