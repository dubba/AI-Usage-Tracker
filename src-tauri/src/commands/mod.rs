//! Tauri commands, grouped by what they act on. Each is registered by name in
//! `generate_handler!` (`lib.rs`), listed in `build.rs`, and granted in `capabilities/`;
//! moving one between modules changes none of that.

pub mod accounts;
pub mod alerts;
pub mod auth;
pub mod bridge;
pub mod buckets;
pub mod pairing;
pub mod settings;
pub mod system;

use crate::limits;

pub(crate) fn validate_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("Account label is required.".into());
    }
    if label.chars().count() > limits::MAX_LABEL_CHARS {
        return Err(format!(
            "Account label must be {} characters or fewer.",
            limits::MAX_LABEL_CHARS
        ));
    }
    Ok(label.to_string())
}
