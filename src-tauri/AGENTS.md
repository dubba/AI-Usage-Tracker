# Rust backend guidance

This directory owns all sensitive and platform-specific behavior.

- Keep OAuth authorization codes, access tokens, refresh tokens, and ID tokens out of Tauri command responses and logs.
- Store secrets only through the native operating-system credential store. On Android that is credential files sealed with a non-exportable Android Keystore key (`store/credential_file.rs`, `platform/android_keystore.rs`, `CredentialVault.kt`); plaintext credential files are only for desktop development builds.
- Store only non-secret account metadata and cached usage in the application data directory.
- Use only `https://chatgpt.com/backend-api/wham/usage` for quota retrieval unless the product decision is explicitly changed.
- Serialize token refreshes per account so rotating refresh tokens cannot race.
- Preserve last-known-good usage and clearly mark it stale after transient failures.
- Bind integration APIs to loopback and require the bridge bearer token.
- Log through `diagnostics::info/warn/error`, never `eprintln!`: it redacts tokens, cookies, emails, and home-folder names and writes the rotating log that the diagnostics report includes. Still never pass raw provider responses or credentials to it.
- Every Tauri command is listed in `APP_COMMANDS` in `build.rs` and granted per window in `capabilities/`. Adding a command means updating `generate_handler!`, `APP_COMMANDS`, and `capabilities/default.json` (a test fails otherwise).
- Keep the `/v1/paseo-usage` response backward-compatible within schema version 1.
- OAuth sign-ins (Claude, ChatGPT, Antigravity) finish through loopback callbacks everywhere. Desktop opens them in an incognito sign-in window; Android opens them in a Custom Tab (`auth/sign_in_tab.rs`, `SignInTab.kt`), because Google refuses sign-in in embedded WebViews, and falls back to the main webview only without a Custom Tabs browser; iOS navigates the main webview. Desktop Grok/OpenCode login windows are incognito and restricted with `on_navigation` host allowlists. Android Grok and OpenCode in-app sign-in still navigate the main webview because that platform only has one WebView and cookie capture requires it.
- Validate any URL loaded into a WebView (`view.loadUrl`, popup hijacks): HTTPS (or the exact loopback callback) only — never `javascript:`, `intent:`, `file:`, or `content:` schemes.
- Device pairing transfers credentials directly between devices over the local network, or as one file by AirDrop or Quick Share. The link code (ten letters; six digits for older versions, Wi-Fi only) is the pairing secret: SPAKE2 over it (`pairing/crypto.rs`, `PakeExchange`), then HKDF-SHA256 and XChaCha20-Poly1305. The file's key is Argon2id over the ten-letter code (`pairing/file_transfer.rs`): the file can be tested offline, so never let a six-digit code make or open one, and never lower the Argon2 cost. A peer must prove it derived the same key before the host shows it to the user, and the host ends the session after three wrong codes. Sensitive keys and payloads are zeroized in memory and persisted into native credential storage.
- Never send, log, or announce the link code. mDNS (`_aiut-pair._tcp`) carries only a random instance name, the session id, the nonce and the protocol version (`v=2`), never the code, a key, or credentials.
- Only the sending device confirms a transfer. A receiver applies the sender's settings, order, alerts and layout only when its own user ticked "Also Transfer Settings & Layout" (`accept_incoming_settings`); accounts it already has are never replaced.
- The app opens no pairing links. Pairing starts only inside the app, by link code or the air-gap QR frames.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --workspace
cargo check --manifest-path src-tauri/Cargo.toml
```
