pub mod config;
pub mod logging;

use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub product_name: &'static str,
    pub executable_name: &'static str,
    pub identifier: &'static str,
}

impl AppInfo {
    pub fn current() -> Self {
        Self {
            product_name: "Artistic Git",
            executable_name: "artistic-git",
            identifier: "com.smallmain.artistic-git",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_app_info_matches_spec() {
        let info = AppInfo::current();

        assert_eq!(info.product_name, "Artistic Git");
        assert_eq!(info.executable_name, "artistic-git");
        assert_eq!(info.identifier, "com.smallmain.artistic-git");
    }
}
