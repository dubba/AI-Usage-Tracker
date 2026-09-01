# Rust backend guidance

This directory owns all sensitive and platform-specific behavior.

- Keep OAuth authorization codes, access tokens, refresh tokens, and ID tokens out of Tauri command responses and logs.
- Store secrets only through the native operating-system credential store.
- Store only non-secret account metadata and cached usage in the application data directory.
- Use only `https://chatgpt.com/backend-api/wham/usage` for quota retrieval unless the product decision is explicitly changed.
- Serialize token refreshes per account so rotating refresh tokens cannot race.
- Preserve last-known-good usage and clearly mark it stale after transient failures.
- Bind integration APIs to loopback and require the bridge bearer token.
- Keep the `/v1/paseo-usage` response backward-compatible within schema version 1.
- OAuth on mobile opens the system browser; desktop OAuth uses loopback callbacks. Desktop Grok/OpenCode login windows are incognito and restricted with `on_navigation` host allowlists. Android Grok in-app sign-in still navigates the main webview because that platform only has one WebView and cookie capture requires it.
- Validate any URL loaded into a WebView (`view.loadUrl`, popup hijacks): HTTPS (or the exact loopback callback) only — never `javascript:`, `intent:`, `file:`, or `content:` schemes.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```
