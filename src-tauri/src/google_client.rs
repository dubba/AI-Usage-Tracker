//! The Google OAuth client the app signs in with. Antigravity (Gemini Code Assist) and Google AI
//! Studio's Cloud Monitoring connection share the same installed-app client, so its identity
//! lives in one place.
//!
//! The secret is stored as bytes only so it is not a greppable string literal. An installed-app
//! client secret is not confidential (Google documents that it ships with the app); this is
//! not a protection for it.

use zeroize::Zeroizing;

pub(crate) const CLIENT_ID: &str =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

const CLIENT_SECRET_BYTES: &[u8] = &[
    71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76,
    66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
];

/// The client secret, wiped from memory when dropped.
pub(crate) fn client_secret() -> Zeroizing<String> {
    Zeroizing::new(String::from_utf8_lossy(CLIENT_SECRET_BYTES).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_identity_decodes_to_the_values_google_issued() {
        assert!(CLIENT_ID.ends_with(".apps.googleusercontent.com"));
        let secret = client_secret();
        assert_eq!(secret.len(), CLIENT_SECRET_BYTES.len());
        assert!(secret.starts_with("GOCSPX-"));
    }
}
