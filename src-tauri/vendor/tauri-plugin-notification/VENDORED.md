# Vendored `tauri-plugin-notification` 2.6.0

A trimmed copy of the published crate (https://crates.io/crates/tauri-plugin-notification,
MIT or Apache-2.0, see the license files here), used through `[patch.crates-io]` in
`src-tauri/Cargo.toml`. Tests, build output and the changelog were left out.

## The one change

`ios/Sources/NotificationHandler.swift`, `toActiveNotification`: the lookup
`notificationsMap[request.identifier]!` is no longer force-unwrapped. The map is in memory only,
so a notification delivered after iOS terminated the app has no entry, and tapping it crashed the
app on launch. This affects every notification the app shows, usage alerts included. Upstream
reports it as https://github.com/tauri-apps/plugins-workspace/issues/3533 (open, no fix when this
was vendored).

## Removing this copy

When a released `tauri-plugin-notification` fixes that issue: delete this directory and the
`[patch.crates-io]` entry in `src-tauri/Cargo.toml`, run `cargo update -p tauri-plugin-notification`,
and drop the `vendored_notification_plugin_keeps_the_ios_crash_fix` test in
`src-tauri/src/updater/tests.rs`. Until then, a plugin upgrade means re-copying the new version
and re-applying the change above (the `PATCHED` comment marks it).
