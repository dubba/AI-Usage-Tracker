# AI Usage Tracker

[![Validate](https://github.com/dubba/AI-Usage-Tracker/actions/workflows/validate.yml/badge.svg)](https://github.com/dubba/AI-Usage-Tracker/actions/workflows/validate.yml)

A standalone desktop and mobile application (Windows, macOS, and Android) for monitoring AI subscription quotas and usage across GPT/Codex (OpenAI), Claude (Anthropic), Google Antigravity, Google AI Studio, Grok/Cursor (xAI), and OpenCode Go. It can optionally expose normalized, sanitized usage data to Paseo over localhost.

## Supported providers

| Provider | Authentication | Usage source |
| --- | --- | --- |
| **GPT/Codex** (OpenAI) | Browser OAuth with PKCE | ChatGPT Codex `wham/usage` endpoint |
| **Claude** (Anthropic) | Browser OAuth with PKCE | Anthropic OAuth usage endpoint |
| **Google Antigravity** | Browser Google OAuth with offline refresh token | Internal Cloud Code quota APIs |
| **Google AI Studio** | API key validation + optional Cloud Monitoring OAuth | Google AI Studio model list & Cloud Monitoring quota metrics |
| **Grok / Cursor** (xAI) | Guided browser sign-in / session cookie capture | Grok rate-limit and subscription RPC endpoints |
| **OpenCode Go** | Workspace ID and OpenCode console `auth` cookie | Server-rendered Go dashboard |

The Anthropic, Antigravity, Google AI Studio, Grok, and OpenCode Go integrations rely on provider interfaces that are not documented as stable third-party APIs. Each connector is isolated so it can be repaired without changing the dashboard or localhost response contract. Last-known-good results remain visible and are marked stale when a provider changes or temporarily rejects a request.

## Key Features

- **Multi-Provider Account Tracking**: Authenticates multiple accounts across OpenAI, Anthropic, Google Antigravity, Google AI Studio, Grok, and OpenCode Go independently.
- **Cross-Platform**: Runs natively on Windows (x64), macOS (Apple Silicon & Intel), and Android (sideloadable APK with full touch support and automatic start-on-boot).
- **Custom Groups (Buckets)**: Organize accounts into custom groups (e.g. Work vs. Personal, or team pools) with aggregate usage summaries and dedicated sidebar navigation.
- **Drag-and-Drop Card Reordering**: Reorder account cards freely with drag-and-drop on desktop or long-press (≥350ms) dragging on mobile with haptic vibration feedback. Custom sort order is persisted across app launches.
- **Collapsible Account Cards**: Click any provider icon to collapse the card down to its header, hiding metrics for a compact overview. Collapsed state is remembered per account with zero layout shift.
- **Usage Threshold Alerts & System Notifications**: Configure custom alert thresholds (e.g., alert when remaining limit drops below 20%) with native system notifications per account.
- **Configurable Refresh Intervals**: Customize background update intervals (5, 10, 15, 30, 45, 60 minutes; 15 minutes default) with automatic refresh on window focus and device resume.
- **Secure Native Credential Storage**: Stores OAuth access and refresh tokens, API keys, and session cookies strictly in the native OS credential store (Windows Credential Manager, macOS Keychain, or private Android encrypted storage). Credentials are never exposed to the frontend or local API.
- **Localhost API**: Exposes a rate-limited, bearer-protected loopback API at `http://127.0.0.1:47831/v1/paseo-usage` for optional Paseo integration.
- **In-App & Automatic Updates**: Integrated update checker with signed updater support, real-time update status indicators, and background checks.
- **Obsidian Dark Theme & Responsive UI**: Beautiful obsidian dark styling with custom dropdown components, resizable navigation sidebar (desktop & mobile), and mobile slide-out drawer with dedicated close controls.

## Connecting providers

### GPT/Codex (OpenAI)

Choose **GPT/Codex** in the Add Account modal and complete the browser sign-in. The app requests only the OAuth access needed to identify the account and read Codex subscription usage through OpenAI's loopback callback.

### Claude (Anthropic)

Choose **Claude** and complete the browser sign-in. The app reads the 5-hour, 7-day, model-specific, and extra-usage windows returned by Anthropic's OAuth usage service.

### Google Antigravity

Choose **Google Antigravity** and complete the Google consent screen. The app stores the offline refresh token securely, discovers the Cloud AI Companion project, and reads the account's quota-summary and model-quota metrics.

### Google AI Studio

Choose **Google AI Studio** to connect via API key or Google Cloud:
- **API Key**: Enter a Google AI Studio API key to validate and retrieve accessible Gemini models directly from Google.
- **Google Cloud Monitoring**: Optionally connect the owning Google Cloud project via least-privilege OAuth to track real-time RPM, TPM, RPD, and TPD quota metrics.

### Grok / Cursor (xAI)

Choose **Grok** and complete the guided in-app sign-in. The app captures only the necessary session cookies (`grok.com` and `accounts.x.ai`) in an isolated private window and polls xAI's subscription and rate-limit RPCs.

### OpenCode Go

Choose **OpenCode Go** and provide:
- The OpenCode workspace ID (`wrk_...`).
- The `auth` session cookie from the signed-in OpenCode console.

The cookie is stored only in the native credential store and is used only for read-only requests to `https://opencode.ai/workspace/<workspace-id>/go`.

## Security model

- Passwords are never requested or handled by the app.
- OAuth tokens, API keys, and session cookies remain in the native operating-system credential store.
- Account metadata and cached usage are stored separately in the app data directory.
- OAuth callback listeners bind only to loopback (`127.0.0.1`) on dynamic ephemeral ports with PKCE.
- The local API binds only to `127.0.0.1`.
- The local API requires a random bearer token stored in the native credential store.
- Authenticated local API requests are rate-limited to 1 request per second (extra requests return `429` with `Retry-After: 1`).
- The local API never returns access tokens, refresh tokens, ID tokens, session cookies, or raw provider responses.
- The app does not perform inference requests merely to probe usage limits.
- Desktop application updates must pass Tauri signature verification before installation.
- The updater private key is stored only as a GitHub Actions repository secret.

## Development

### Prerequisites

- Node.js 22+
- Rust stable
- **Windows**: Microsoft C++ Build Tools and WebView2
- **macOS**: Xcode Command Line Tools
- **Android**: Android SDK (API 34+), NDK 27+, Java 17 (OpenJDK)

### Run the web interface

```bash
npm install
npm run dev
```

### Run the desktop app

```bash
npm install
npm run tauri:dev
```

### Run the Android app (Live Dev with HMR)

```bash
npx tauri android dev
```

### Validate

```bash
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Provider network calls require real user credentials and are not exercised in CI. Parser, migration, and normalization behavior is covered by unit tests; each live login flow must also be exercised in a packaged build before release.

### Build installers

#### Desktop (Windows / macOS)

```bash
npm run tauri:build
```

Tauri generates the platform-appropriate bundle under `src-tauri/target/release/bundle`.

#### Android APK

```bash
npx tauri android build --target aarch64 --apk
```

Outputs the APK under `src-tauri/gen/android/app/build/outputs/apk/`.

## Releases and automatic updates

- The **`Publish desktop release`** workflow builds Windows (`.exe` / `.msi`), macOS Apple Silicon (`aarch64`), and macOS Intel (`x64`) packages, uploading signed updater artifacts and a `latest.json` manifest to the GitHub Release.
- The **`Build Android APK`** workflow compiles a sideloadable `AI Usage Tracker_<version>.apk` on every push to `main` and attaches it directly to versioned GitHub Releases.
- Releases can be triggered by pushing a version request string to `.github/release-trigger`.

## Local API

### Health

```http
GET http://127.0.0.1:47831/v1/health
Authorization: Bearer <token shown in the Integration screen>
```

Authenticated health and usage requests are limited to one per second. Additional requests return `429` with `Retry-After: 1`.

### Usage

```http
GET http://127.0.0.1:47831/v1/paseo-usage
Authorization: Bearer <token shown in the Integration screen>
```

Response contract:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-03T12:00:00Z",
  "accounts": [
    {
      "id": "local-account-id",
      "label": "Personal Claude",
      "provider": "anthropic",
      "email": "person@example.com",
      "providerAccountId": "provider-account-id",
      "plan": "max",
      "status": "available",
      "source": "anthropic_oauth_usage",
      "windows": [
        {
          "id": "five_hour",
          "label": "5 hour",
          "usedPercent": 18,
          "remainingPercent": 82,
          "resetsAt": "2026-09-03T17:00:00Z",
          "windowSeconds": 18000
        }
      ],
      "creditsUsd": null,
      "fetchedAt": "2026-09-03T12:00:00Z",
      "error": null
    }
  ]
}
```

## Repository structure

```text
src/                               React dashboard and components
src-tauri/src/oauth.rs             Provider browser OAuth and callback flows
src-tauri/src/providers/           Provider-specific usage clients and parsers
src-tauri/src/usage.rs             Common refresh, cache, and stale-state behavior
src-tauri/src/store.rs             Metadata and native credential storage
src-tauri/src/bridge_api.rs        Versioned localhost API
src-tauri/src/buckets.rs           Custom group (bucket) data and filtering
src-tauri/src/alerts.rs            Quota usage threshold alerts and notifications

docs/provider-integrations-plan.md Implementation and security plan
docs/CHANGELOG_WORKFLOW.md         Changelog maintenance guide
```

## License

MIT
