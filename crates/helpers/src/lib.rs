use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperBinary {
    pub name: &'static str,
    pub purpose: &'static str,
}

pub fn planned_helpers() -> [HelperBinary; 2] {
    [
        HelperBinary {
            name: "artistic-git-credential-helper",
            purpose: "git credential helper callback bridge",
        },
        HelperBinary {
            name: "artistic-git-askpass",
            purpose: "ssh askpass callback bridge",
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declares_required_helper_binaries() {
        let helpers = planned_helpers();

        assert_eq!(helpers.len(), 2);
        assert!(helpers.iter().any(|helper| helper.name.contains("askpass")));
        assert!(helpers
            .iter()
            .any(|helper| helper.name.contains("credential-helper")));
    }
}
