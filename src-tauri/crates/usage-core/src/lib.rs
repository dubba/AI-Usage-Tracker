//! The usage data model and the rules about what it means, apart from the app.
//!
//! Nothing here depends on Tauri, the app's state, storage or the network, so its tests build in
//! seconds (`cargo test -p usage-core`) instead of waiting for the whole app crate. The app crate
//! re-exports these modules at their old paths (`crate::model`, `crate::limits`, ...).

pub mod headline;
pub mod health;
pub mod history;
pub mod limits;
pub mod model;
pub mod providers;
pub mod refresh_backoff;
