# Notifications and the Paseo daemon

Usage-limit alerts ship through the app's own notifier. The Paseo daemon client and ntfy phone delivery in the old v0.3.0 plan (researched against `getpaseo/paseo` at `b4ab0d9`, dated 2026-07-13) were not built.

What shipped is recorded in [THREAT_MODEL.md](THREAT_MODEL.md):

- Desktop notifications: `platform/macos_notifications.rs` and the `notification:default` capability.
- The vendored notification plugin and its iOS crash fix: `src-tauri/vendor/tauri-plugin-notification/VENDORED.md`.
- Android expandable notifications: `AlertNotifications.kt`.
- Clicks on the "update available" notification: `updater/version.rs` (`is_update_notice_version`), handled from `updater/mod.rs`.

`GET /v1/paseo-usage` is the versioned local API. The LAN bridge bearer token is the pairing bridge, not a Paseo daemon password. Neither is a daemon client.

Do not implement a daemon connection or ntfy from this file. The same note is in [paseo-daemon-notifications-plan.md](paseo-daemon-notifications-plan.md).
