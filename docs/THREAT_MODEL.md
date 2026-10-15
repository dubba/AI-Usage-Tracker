# Threat model

> **Draft: last verified by Pass 0 on 2026-10-11 against commit `535cab8`.**
> Every guard below was confirmed against that source unless marked **Unverified**; the
> Unverified entries are why this is still a draft.
> This file records assets, attackers, trust boundaries, entry points, and the code that
> guards each one. It deliberately contains no findings or suspected weaknesses — audit
> findings belong in the gitignored `.audits/` directory (see `docs/AUDIT_PROTOCOL.md`).
> Pass 0 of the audit protocol verifies and refreshes this document.

## Assets

| Asset | Where it lives |
| --- | --- |
| OAuth access + refresh tokens (OpenAI, Anthropic, Google/Antigravity, Google AI Studio Cloud) | OS credential store only (see [Credential storage](#credential-storage)); rotated refresh tokens also in the in-memory cache (`store/credentials/cache.rs`) |
| Google AI Studio API keys | OS credential store only |
| Grok session cookies (`sso*`, `auth_token`, `jwt`, `session`) | OS credential store; captured from the login WebView (`grok_login.rs:532-588,834-898`) |
| OpenCode Go `auth` cookie + workspace id | OS credential store (`opencode_login.rs:365-410,541-580`) |
| Paseo Bridge bearer token (64 alphanumeric chars, `store/credentials/mod.rs:401-407`) | Desktop release: OS credential store, user `bridge-api-token` (`store/credentials/mod.rs:355-379,392-399`, `keyring_store.rs:12`). Android: `credentials/bridge-token.txt` sealed like other credential files; debug builds: same file, plaintext (`store/credentials/mod.rs:334-352,381-389`) |
| Pairing session keys (X25519 ephemeral, HKDF-derived), airgap transfer key | Memory only, zeroized on drop (`pairing/crypto.rs:17,50`) |
| Account metadata: emails, labels, plan names, usage numbers | `accounts.json` and sibling JSON files in the app data dir; sanitized projections in the dashboard snapshot and the local API |
| Updater minisign private key, Android signing keystore | GitHub Actions secrets — never in the repository |
| Integrity of the update channel (`latest.json`, APK + `.apk.sha256` assets) | GitHub Releases of this repository |

ID tokens are decoded without signature verification for informational claims only; they are never used as authentication identity (`oauth.rs:996-1000,1052-1056`).

## Attackers

The app is a client with no server and no multi-user database, so the classic
"no credentials / normal user / compromised user" tiers are replaced by:

| Attacker | Capabilities |
| --- | --- |
| Remote web attacker | Can make the user's browser load a page; no direct network access to the device. Targets the loopback API, OAuth callbacks, deep links. |
| Same-LAN device | Can see mDNS, reach the pairing listener, race a pairing session. |
| Local unprivileged process | Same OS user or another user on a shared machine. Can read world-readable files, scan loopback ports, read process arguments. |
| Other Android app | Can send intents, query exported components, read shared storage. |
| Malicious or compromised provider | Returns hostile or malformed JSON, huge bodies, redirects, or slow responses. |
| Stolen or lost device | Locked and unlocked variants. |
| Supply-chain attacker | Compromised npm or crate dependency, GitHub Action, or release asset. |
| Public-repo reader | Sees all source, history, workflows, and `sidestore-source.json`. |

## Trust boundaries

1. **Webview → Rust backend** — 56 Tauri commands, gated by per-window capability files.
2. **Rust → OS credential stores** — Keychain / Credential Manager / Android Keystore.
3. **Rust → provider APIs** — outbound HTTPS; responses treated as untrusted input.
4. **Rust → LAN peers** — pairing TCP listener, mDNS, QR codes.
5. **Local processes → loopback bridge** — `127.0.0.1:47831`, HTTP.
6. **Browser pages → loopback bridge + OAuth callbacks** — DNS rebinding and cross-origin requests.
7. **Rust ↔ Kotlin (JNI)** — Android Keystore, APK install, LAN binding, notifications.
8. **Updater → GitHub release assets** — downloaded and verified before install.
9. **OS users → on-disk app data** — JSON files and (Android/debug) credential files.

## System map

### Initialization order (desktop)

`lib.rs::run()` → plugins → tray/window setup → `backend::initialize_backend()`
(`backend.rs:15-65`, idempotent via `BACKEND_INIT` mutex, `backend.rs:11`):
data dir → `store::set_data_dir` → `diagnostics::init` → (desktop) sweep stale Grok
profiles → (Android) `upgrade_plaintext_credentials` → bridge token load with
session-only fallback (`startup.rs:56-73`) → `AppState::new` → Antigravity→AI Studio
migration (`migrations.rs:3-32`) → app handle → (desktop) bridge controller spawn →
refresh loop spawn. Failure is reported on the startup screen, not swallowed
(`startup.rs:15-73`, `src/features/startup/StartupGate.tsx`).

### Frontend

React 19 with no state library: a single `DashboardSnapshot` fetched only by
`useDashboardData` (`src/features/dashboard/useDashboardData.ts:34-73`), 30 s poll +
focus/visibility refresh. All backend calls go through `bridgeApi` (37) and `pairingApi`
(18) wrappers in `src/shared/lib/api.ts:18-117` — exactly the 56 registered commands.
Backend events (`usage-alert`, `pairing-status`, `pairing-uri-received`,
`pairing-ui-state`, `open-update-notes`, `app-update-progress`) are consumed via `useTauriEvent`. The `api-integration` window
renders `ApiIntegrationWindow.tsx` and can call only three bridge methods
(enforced by the sync test, `lib.rs:322-333`).

### Backend module map

| Area | Modules |
| --- | --- |
| App shell / IPC | `lib.rs` (56 commands, `lib.rs:96-152`), `commands/*` (per-domain commands), `state.rs` (shared `AppState`: locks, rate-limit map, refresh semaphore), `backend.rs`, `startup.rs` |
| Usage engine | `usage.rs` (refresh orchestration, per-account locks), `refresh_loop.rs` (wall-clock ticker), `refresh_backoff.rs`, `limits.rs`, `buckets.rs`, `account_order.rs`, `alerts.rs`, `settings.rs` |
| Providers | `providers/{mod,openai,anthropic,antigravity,google_ai_studio,grok,opencode_go,oauth_refresh}.rs` — each normalizes a provider's quota response into `UsageWindow`s |
| Login flows | `oauth.rs`, `oauth_common.rs` (loopback OAuth), `google_ai_studio_oauth.rs` (Cloud connection), `grok_login.rs`, `opencode_login.rs` (WebView cookie capture), `mobile_auth.rs` (mobile in-app sign-in) |
| Local API | `bridge_api.rs` (loopback HTTP), `commands/bridge.rs` |
| Device transfer | `pairing/{mod,crypto,protocol,transport,discovery,dnssd,payload,airgap}.rs`, `commands/pairing.rs` |
| Storage | `store/*` (accounts, credentials), `fs_util.rs` (atomic owner-only writes), `migrations.rs` |
| Updater | `updater.rs`, `apk_install.rs` |
| Platform glue | `tray.rs`, `diagnostics.rs`, `macos_notifications.rs`, `camera_permission.rs`, `android_context.rs`, `android_keystore.rs`, `lan_binding.rs` |

### Key data flows

- **Usage refresh**: timer/resume/manual (`lib.rs:155-177`) → `refresh_all` (semaphore of 4, `state.rs:26,141`) → per-account async lock (`state.rs:280-286`) → provider call on a spawned task that owns the lock with a 45 s wait timeout (`usage.rs:16,31-135`) → normalize → persist to `accounts.json` keeping last-known-good marked `Stale` on failure (`usage.rs:394-430`); auth failure sets `auth_required` and suspends auto-refresh (`usage.rs:186-218`).
- **Credentials**: provider secret → `ProviderSecret` (Zeroize) → platform store dispatch (`store/credentials/mod.rs:107-174`) → in-memory cache with 300 s TTL and a dirty flag that survives until the native write succeeds (`cache.rs:10-93`). Secrets never appear in command responses or metadata files.
- **Local API**: account store → `PublicUsageResponse` (no tokens or cookies; carries labels, emails, provider account ids, plans, usage windows, and the sanitized last error) → `GET /v1/paseo-usage`, schema v1 (`model.rs:377-401`, `bridge_api.rs:191-253`).
- **Pairing**: QR URI or 6-digit code → host TCP listener bound to the advertised LAN address on an ephemeral port, and only if that address is private, link-local, CGNAT, or loopback (no fallback to all interfaces) (`pairing/mod.rs:203-206,544-555`; address choice `pairing/transport.rs:43-85`) → X25519 + HKDF + SAS confirmation → XChaCha20-Poly1305-encrypted payload import with per-field clamping (`payload.rs`, `limits.rs:103-121`).
- **Updater**: GitHub releases manifest (desktop minisign-verified by the updater plugin; Android SHA-256 + package name + APK signing certificate) → user-initiated install.

### On-disk data

All in the Tauri app data dir, written via `atomic_write_private` (temp + fsync + rename,
owner-only, `fs_util.rs:203-245`): `accounts.json` (v2) + hard-link backup `accounts.json.bak`
(`accounts.rs:456-470`), `deleted-accounts.json` (tombstones ≤500), `account-order.json`,
`usage-alerts.json`, `account-buckets.json`, `app-settings.json` (v3), `logs/app.log(.1)`
(rotating, 256 KiB, `diagnostics.rs:22,73`), `*.invalid` quarantine (`state.rs:336-385`), and on
Android + debug builds `credentials/{id}.json` and `credentials/bridge-token.txt` (sealed on
Android, plaintext in debug builds). Corrupt JSON is quarantined and reloaded, not crashed on
(`state.rs:336-354`). On Android, `BootReceiver` reads `app-settings.json` directly
(`BootReceiver.kt:16-19`).

## Entry points and guards

### 1. Tauri IPC commands (56) — reachable by injected frontend code

| Guard | Code |
| --- | --- |
| Per-window capability allowlists: main window = exactly the 56 commands; `api-integration` window = only `get-bridge-info`, `reveal-bridge-token`, `regenerate-bridge-token` | `capabilities/default.json`, `capabilities/api-integration.json`; five-way sync test `lib.rs:186-335` (handler list vs `build.rs APP_COMMANDS` vs capabilities vs every frontend `invoke()` vs the API window's three methods) |
| `build.rs APP_COMMANDS` mirrors the handler list into generated permissions | `build.rs:140-196,230-231` |
| Plugin permissions on the main window: `core:default`, `core:window:allow-set-theme`, `opener:allow-open-url` (URL allowlist, see §12), `autostart:allow-enable`/`allow-disable`/`allow-is-enabled`, `notification:default`, `window-state:default`. The `api-integration` window gets only `core:default` and `allow-set-theme` beyond its three commands | `capabilities/default.json`, `capabilities/api-integration.json` |
| Windows without a capability: the desktop `grok-login` and `opencode-go-login` windows match no capability file, so they are granted no commands. Neither capability file declares a `remote` URL scope | `capabilities/*.json` (`windows` keys), `grok_login.rs:33`, `opencode_login.rs:25` |
| Rust-side validation on every string input: labels trimmed ≤80 (`commands/mod.rs:16-28`), provider strings matched against a fixed whitelist (`model.rs:49-65`), emails trimmed ≤254 (`limits.rs:84-98`), refresh minutes restricted to {5,10,15,30,45,60} (`settings.rs:114-117`), reorder must be an exact permutation (`account_order.rs:80-109`), pending UI state object/null ≤64 KiB (`commands/pairing.rs:116-128`), pairing role `send`/`receive` only (`pairing/mod.rs:155-172`), join codes 6 digits with 5-attempt lockout (`pairing/mod.rs:510-541`) | as cited |
| `reveal_bridge_token` returns the full token only after the user confirms a native OS dialog opened by Rust, which page code cannot see or answer (`commands/bridge.rs:92-108`, `confirm.rs`); the webview holds no dialog permission; `get_bridge_info` and `regenerate_bridge_token` return only a masked token (`commands/bridge.rs:81-90,111-127`, `model.rs:288-297`) | as cited |
| CSP: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, no remote script/style origins | `src-tauri/tauri.conf.json:30` |

### 2. Loopback HTTP bridge (`127.0.0.1:47831`) — reachable by any local process, and indirectly by browsers

| Guard | Code |
| --- | --- |
| Loopback-only bind, hardcoded | `bridge_api.rs:25,48` |
| Controller off unless enabled in settings (default false) and token readable; rebind retry every 3 s; desktop-only | `bridge_api.rs:35-93`, `settings.rs:52`, `backend.rs:62-63`, `commands/bridge.rs:22-24` |
| Host header must be loopback (DNS-rebinding defense), Origin/Referer must be absent or loopback; checked before anything else on both routes | `bridge_api.rs:123-170,172-200` |
| Rate limit per client IP in two lanes, requests with the token and requests without it (burst 10, 1/s refill, 60 s entry TTL each); rejected requests get 401 and then 429 | `bridge_api.rs:28-33,262-325` |
| Bearer token: both sides hashed with SHA-256, then the digests compared with `subtle::ConstantTimeEq`, so length differences take the same path | `bridge_api.rs:337-353` |
| Forced response headers (no-store, nosniff, no-referrer, X-Frame-Options DENY, CSP, CORP same-origin), on success and error responses | `bridge_api.rs:101-118` |
| Responses carry no tokens or cookies (fields: id, label, provider, email, provider account id, plan, status, source, windows, credits, fetched-at, sanitized last error); `schemaVersion: 1`; the only routes are `GET /v1/health` and `GET /v1/paseo-usage` | `bridge_api.rs:51-54,172-243`, `model.rs:377-401` |
| Token: 64 alphanumeric chars, persisted in secure storage, masked in UI (first 4 + last 4 shown) | `store/credentials/mod.rs:401-407`, `model.rs:288-297` |

### 3. OAuth loopback callbacks — reachable by local processes and browser pages

| Guard | Code |
| --- | --- |
| Callback listener binds `127.0.0.1` only, or `::1` if the IPv4 bind fails for a reason other than the port being in use; fixed port allowlists (OpenAI 1455/1457, Anthropic 53692-53696, Antigravity ephemeral) | `oauth.rs:34-35,916-972` |
| PKCE (32-byte verifier, S256) and random state generated and validated | `oauth.rs:118-119,486-492,849-881`, `oauth_common.rs:28-37` |
| Callback requests are checked for this attempt's `state` first; a request without it gets a neutral page and does not claim the callback, end the attempt, or set its message. One-shot after that: `callback_claimed` AtomicBool ensures a code is processed at most once; status polls serialized by `login_status_lock` | `oauth.rs` (`handle_callback`), `oauth_common.rs` (`unrecognized_callback_response`) |
| Single-use codes: retried (up to 5 tries) only when the token endpoint never answered; never retried or restored after a definitive failure | `oauth.rs:293-295,377-378,548-570` |
| 5-minute login timeout | `oauth_common.rs:77,106-120` |
| Google AI Studio Cloud connection: separate ephemeral loopback callback, 24-byte state, 48-byte PKCE verifier (S256), state checked before anything else (a request without it leaves the attempt and the callback server running), read-only scopes unless the user asks to enable Cloud Monitoring | `google_ai_studio_oauth.rs:32-33,165-180,304-314,336-347,926-940` |
| Mobile: authorization URL must be HTTPS on `auth.openai.com`/`claude.ai`/`accounts.google.com` (or a subdomain) before WebView navigation; URL-poll recognizes only loopback callbacks carrying `code` or `error` | `oauth.rs:223-234,405-421`, `mobile_auth.rs:146-226` |

### 4. Login WebViews — reachable by any page loaded inside them

| Guard | Code |
| --- | --- |
| Grok login (desktop): incognito WebviewWindow with devtools off, fresh owner-only (0700/ACL) temp profile swept at startup and removed on close/10-minute timeout; navigation blocked unless HTTPS on an allowlisted host (about 20 Grok/X, CDN, captcha, and SSO hosts) or `about:blank`/`blob:`, or the exact `data:` "Account connected" page the app made (`oauth_common::is_connected_page`, never `data:` in general); cookies read only from `grok.com`/`accounts.x.ai`, only session-cookie names retained; cookie normalization rejects CR/LF | `grok_login.rs:37,216-266,365-444,777-823`, `providers/grok.rs:365-445` |
| OpenCode login (desktop): incognito window with devtools off; navigation allowlist: HTTPS on `opencode.ai` (and subdomains), `accounts.google.com`, `github.com`, `appleid.apple.com`, or `about:blank`, or the exact `data:` "Account connected" page the app made; workspace id taken only from `opencode.ai/workspace/<id>/go` and validated `[A-Za-z0-9_-]{1,160}`; cookie rejects control characters | `opencode_login.rs:184-187,602-635`, `providers/opencode_go.rs:17-25,113-123` |
| Mobile sign-in (Android/iOS, including Grok and OpenCode): the main app WebView is navigated to the provider and restored to the app URL when the attempt ends; the starting URL must be HTTPS on an allowlisted host; a navigation guard then checks every main-window navigation before it loads: only the app's own pages, `about:blank`, and the exact `data:` "Account connected" page the app made (`oauth_common::is_connected_page`) outside sign-in, plus HTTPS sign-in, single-sign-on, and challenge hosts and the loopback callback while a sign-in is in progress; blocked hosts are logged; FedCM-disabling shim injected | `mobile_auth.rs:18-37,115-226`, `signin_navigation.rs`, `lib.rs` (registered on mobile), `grok_login.rs:454-527`, `opencode_login.rs:411-460` |
| Sign-in popups (desktop provider-login window; iOS main WebView): opened only for an HTTPS `window.open` to an allowlisted sign-in host (Claude's Google Identity Services popup); built from the opener's WebView configuration so `window.opener` and the session work; every navigation held to the same sign-in host allowlist; no IPC; closed by the app when the sign-in window loads its next page or the attempt ends (desktop), or on `window.close()`, its Close button, or the attempt ending (iOS); the desktop Back button skips popups | `oauth.rs` (`open_provider_login_popup`, `close_provider_login_popups`), `ios_popups.rs`, `mobile_auth.rs` (`IOS_POPUP_SCRIPT`) |
| Android WebView patches (generated Kotlin): popup windows hand back to the main view only exact `localhost`/`127.0.0.1` URLs; `javascript:`/`file:`/`content:` blocked in popups; the Google/Apple SSO popup injects the Back button and treats only the exact `ai-usage-tracker-back` fragment as a return to the app, then sets that fragment on the host view with a constant script; `intent:`/`android-app:` in the main view follow only `https:` fallbacks | `build.rs` (`oauth_popup_window_methods`, `patch_chrome_client`, `patch_webview_client`) |
| Android IPC origin (generated Kotlin): the page's `ipc.postMessage` goes through `WebViewCompat.addWebMessageListener`, which reports the sending frame's own origin to Tauri, so the capability files decide local versus remote from the real origin; wry's `ipc` JavaScript interface is refused by name and its legacy handler drops messages; with no listener support IPC stays off; opaque or non-http(s) origins are dropped | `webview_ipc_patch.rs:26-101`, applied by `build.rs` (`patch_android_webview_templates`), tests `webview_ipc_patch.rs:102-182` |

### 5. Pairing (LAN) — reachable by same-LAN devices

| Guard | Code |
| --- | --- |
| QR pairing URIs accept only IP-literal hosts in loopback/private/link-local/CGNAT ranges; schemes `aiusage-pair:`/`aiusage:`; cryptographic parse before connecting | `pairing/protocol.rs:21-22,44-70,116` |
| Crypto: X25519 with non-contributory-key rejection, HKDF-SHA256, XChaCha20-Poly1305, 48-bit SAS code, constant-time confirmation tags, keys zeroized on drop | `pairing/crypto.rs:17,41-44,63,98-111,136-137,147` |
| SAS confirmation gates the payload transfer on both sides; rejection aborts both | `pairing/transport.rs:752-802,911-925`, `pairing/mod.rs:155-187` |
| Host listener binds only the LAN address it advertises in the QR code and mDNS record (chosen by `get_local_lan_ip`, which prefers a private address on a Wi-Fi/Ethernet interface over cellular, VPN, and virtual interfaces), and only if that address passes the same local-network rule receivers apply to QR codes (private, link-local, CGNAT, loopback); otherwise host mode fails with an explanation, with no fallback to all interfaces | `pairing/mod.rs:206-209,554-566`, `pairing/transport.rs:43-145` |
| mDNS `_aiut-pair._tcp.local` TXT records carry only sid/pk/nonce/v; join codes 6-digit, weak codes rejected, 5-attempt lockout. iOS advertises and resolves through the system's DNS-SD (mDNSResponder) instead of `mdns-sd`, on the listener's interface only, with no auto-rename; resolved records from either backend pass the same `parsed_from_resolved` validation (LAN allowlist, length and version checks); TXT parsing bounds-checks every length byte | `pairing/discovery.rs:28-72`, `pairing/dnssd.rs:168-275,431` |
| Framing: 1 KiB pre-auth / 16 MB post-auth frame caps; session/socket/confirm timeouts 300/30/60 s | `pairing/protocol.rs:23-30`, `pairing/transport.rs:33-38` |
| Import clamping: 64 accounts / 256 KiB secrets, per-field clamps, hostile account ids re-minted, buckets remapped | `pairing/payload.rs:14-16,307-312`, `limits.rs:103-121` |
| Credential replacement requires an explicit single-use per-transfer opt-in, default false, reset per session; sender-side deletions are never applied to the receiver | `commands/pairing.rs:105-114`, `pairing/payload.rs:260-265,294-296`, `pairing/mod.rs:195,404` |
| Airgap QR: the export is built only after the user confirms a native OS dialog opened by Rust (the frames carry their own key and decrypt to every stored sign-in); deflate + 16 MB decompression cap, 32-byte key in frames, 48-bit verify code, frame count/length bounds | `commands/pairing.rs:142-168`, `confirm.rs`, `pairing/airgap.rs:22-37,85,100-150,217-278,313-316` |
| Frontend QR decoder sandbox: 960 px dimension cap with downscale, 2048-char payload cap, scheme allowlist, exception isolation; QR SVGs sanitized (no scripts/handlers/`javascript:`) | `src/features/pairing/lib/qr-decoder.ts:14-71`, `src/features/pairing/lib/sanitizeSvg.ts:19-67` |

### 6. Deep links and intent extras (Android) — reachable by any Android app

| Entry | Guard | Code |
| --- | --- | --- |
| `aiusage-pair:`/`aiusage:` VIEW intent | Kotlin and the JNI `setPendingPairingUri` both length-bound (≤2048) and prefix-check the URI before storing; contents never logged; consumed once via `get_pending_pairing_uri`; full cryptographic validation before connecting | `MainActivity.kt:162-182`, `commands/pairing.rs:174-211`, `pairing/protocol.rs:116` |
| `open_update_notes` string extra (set by the app's own update notification) | Extra removed from the intent after reading; the JNI handler keeps it only if it is a version (three numeric parts, optional `v` and `-prerelease`, ≤32 chars); consumed once via `get_pending_update_notice`; the frontend uses the value only as display text in the update-notes dialog and runs the normal update check | `MainActivity.kt:184-195`, `updater.rs:655-704`, `src/features/settings/useAppUpdate.ts:133-156`, `src/features/settings/UpdateNotesModal.tsx:183,204` |

### 7. Updater — reachable by a compromised release channel or MITM

| Guard | Code |
| --- | --- |
| Desktop: endpoint pinned to this repo's `latest.json`; minisign public key pinned in config; the updater plugin verifies signatures before install (plugin-internal behavior — **Unverified** in this repo beyond the config and `updater.rs:454-459`); check 30 s / install 15 min bounds; Windows install mode `passive` | `src-tauri/tauri.conf.json:54-62`, `updater.rs:454-459` |
| Android: APK and `.apk.sha256` URLs are accepted only under `https://github.com/dubba/AI-Usage-Tracker/releases/download/` (checked on the parsed URL), and downloads follow at most 10 redirects, each HTTPS to `github.com`, `objects.githubusercontent.com`, or `release-assets.githubusercontent.com`; asset name must match this app, `.apk`, not "unsigned", ≤250 MB, `PK` zip magic; SHA-256 against the published `.apk.sha256`, failing closed if absent or mismatched; before the user install prompt, the APK's package name must equal this app's and the certificates that sign it now must equal those of the installed app (not its rotation history); the fallback installer intent grants read access only to the installer that is started | `updater.rs:26-87,198-248,409-432,493-605,765-801`, `apk_install.rs:33-45`, `MainActivity.kt:632-680,862-872`, `UpdateSigners.kt` |
| Beta channel: GitHub API listing, newest non-draft release with a manifest | `updater.rs:257-293,384-406` |
| Fixed manifest and API URLs: `github.com/dubba/AI-Usage-Tracker` and `api.github.com/repos/dubba/AI-Usage-Tracker`; a release tag must be letters, digits, `.`, `-`, `_` (no `..`, ≤64 chars) before it is used in the beta manifest or release-page URL | `updater.rs:13-22,79-87,295-356`, `tauri.conf.json:56-58` |
| iOS (SideStore): no in-place update; opens `sidestore://` or the releases page | `updater.rs:869-890` |

### 8. Provider APIs — reachable by a malicious or compromised provider

| Guard | Code |
| --- | --- |
| Fixed `https://` endpoint constants per provider (e.g. `providers/openai.rs:17`, `providers/anthropic.rs:16-19`, `providers/antigravity.rs:20`, `providers/google_ai_studio.rs:27-28`, `providers/grok.rs:22-28`, `providers/opencode_go.rs:9`); TLS via rustls (`Cargo.toml:31-32`); shared reqwest client with 10 s connect / 15 s total timeouts and reqwest's default redirect policy | `state.rs:111-116` |
| Responses treated as untrusted: window normalization with caps (≤32 windows), 401-only auth classification, unknown fields dropped, no plan guessing | `limits.rs:8-32`, `providers/anthropic.rs:407`, `providers/mod.rs:86-117` |
| Error messages sanitized: transport failures use fixed sentences, refresh errors pass an allowlist that drops tokens/keys/JWTs/URLs | `providers/mod.rs:43-56`, `usage.rs:356-378` |
| Token refresh: rotated refresh tokens replace old, `invalid_grant` → sign-in-again, unreadable replies never echoed | `providers/oauth_refresh.rs:84-128,232-407` |
| Grok cookies: host allowlist (`grok.com`, `accounts.x.ai`) and CR/LF injection rejection before header use | `providers/grok.rs:365-461` |

### 9. Credential storage — reachable by local processes and other OS users

| Platform/build | Mechanism | Code |
| --- | --- | --- |
| macOS/iOS release | Keychain item per account, service `ai-usage-tracker`, user `account:{id}`; legacy `paseo-usage-bridge` entries migrated on read | `store/credentials/mod.rs:107-117,198-215`, `keyring_store.rs:8-12` |
| Windows/other desktop release | Chunked `chunked-v1` entries in Credential Manager (DPAPI-backed): ≤32 chunks × 1200 UTF-16 units, generation ids so a crash never strands mixed secrets | `store/credentials/mod.rs:119-174`, `chunking.rs:13-20` |
| Android | `credentials/{id}.json` and `credentials/bridge-token.txt` sealed with AES-256-GCM under a non-exportable Android Keystore key; magic `AIUT-SEALED-1`; the file name is bound into the ciphertext (AAD) so files cannot be swapped between accounts; files without the magic are legacy plaintext and are re-sealed at startup and on dashboard reads; one that cannot be sealed is refused, never used, and the dashboard asks the user to retry or remove those accounts (`remove_unprotected_accounts` removes only the accounts the last seal pass reported) | `credential_file.rs:18-171`, `android_keystore.rs:13-21`, `CredentialVault.kt:24-67` |
| Debug builds | Plaintext files, by design; the file backend is compiled only for Android or `debug_assertions` | `lib.rs:14-15`, `store/credentials/mod.rs:79-105,220,334`, `credential_file.rs:1-10,29-38` |

Additional guards: all secret structs derive `Zeroize` (`model.rs:132-181`); the in-memory
cache zeroizes on drop and keeps dirty entries until the native write succeeds
(`cache.rs:10-93`); account ids are restricted to `[A-Za-z0-9_-]{1,64}` precisely because
they become credential filenames (`store/mod.rs:32-43`); if secure storage is unreadable the
bridge degrades to a session-only token instead of persisting (`startup.rs:56-73`).

### 10. Filesystem — reachable by local processes and other OS users

| Guard | Code |
| --- | --- |
| All metadata writes atomic (`atomic_write_private`: temp in same dir, fsync, rename) and owner-only: 0600/0700 Unix, Windows ACLs applied via `icacls.exe`/`whoami.exe` invoked only by absolute System32 path with SID shape-validation | `fs_util.rs:11-13,48-159,203-245` |
| Corrupt JSON quarantined to `*.invalid` and the store reloads | `state.rs:300-349` |
| `accounts.json.bak` previous-version backup via hard link (atomic-write fallback); tombstone list capped at 500 | `accounts.rs:380-412,456-470` |
| Grok login temp profiles: owner-only, swept at startup and on close/timeout | `grok_login.rs:213-265`, `backend.rs:31-32` |

### 11. Android components — reachable by other Android apps

| Component | Manifest state | Guard |
| --- | --- | --- |
| `MainActivity` | exported (launcher; `aiusage-pair:`/`aiusage:` BROWSABLE deep links) | See §6 for both intent inputs (pairing URI, `open_update_notes` extra) |
| `BootReceiver` | exported; filter action `BOOT_COMPLETED` only, a protected broadcast only the system can send (`AndroidManifest.xml:70-77`) | Acts only on `BOOT_COMPLETED`; reads no intent extras. If `autostartEnabled` is true in `app-settings.json`, starts the app's own launcher activity (`BootReceiver.kt:10-30`) |
| `ApkInstallReceiver` | not exported | Reached only through the `PendingIntent` the app creates for its own install session (`MainActivity.kt:828-836`, `ApkInstallReceiver.kt:9-20`) |
| `FileProvider` | not exported; scoped to `updates/` and `Pictures/` paths only | `file_paths.xml` (comment: never widen to `.`) |
| Backups | `allowBackup=false`; backup and data-extraction rules exclude all domains | `AndroidManifest.xml:32`, `backup_rules.xml`, `data_extraction_rules.xml` |
| Network | Cleartext forbidden except loopback hosts | `network_security_config.xml:8-11` |
| Keystore | AES-256-GCM, non-exportable key, no user-auth requirement (documented: background refresh while locked), AAD = credential file name | `CredentialVault.kt` |

### 12. External URLs / diagnostics egress

| Guard | Code |
| --- | --- |
| `opener` plugin restricted to 8 HTTPS URL prefixes (auth hosts + this repo) | `capabilities/default.json:9-36` |
| Frontend `openSafeUrl`/`isAllowedExternalUrl` allow exactly the opener's URL prefixes, compared on the parsed URL (no userinfo or port); the sync test fails if the two lists differ | `src/shared/lib/safeUrl.ts:3-42`, `lib.rs:250-282` |
| Diagnostics export: every log line and the report pass `redact()` (sensitive keys, `code`/`state` query parameters, bearer tokens, JWTs, opaque strings, masked emails, masked home folders); the report lists accounts by provider and id, not label or email | `diagnostics.rs:127-215,232-270,370-490` |
| Command error text returned to the page goes through `redact()` and is capped at 300 characters (paths with home-folder names, IO and plugin errors) | `diagnostics.rs:271-282`, used in `commands/{accounts,bridge,settings,pairing,system}.rs`, `grok_login.rs`, `opencode_login.rs` |

### 13. Platform permission surfaces

- macOS: camera TCC permission requested before QR scanning, 120 s timeout, failures non-fatal (`camera_permission.rs:85-91`); local-network + Bonjour usage strings and camera usage string declared (`src-tauri/Info.ios.plist:5-12`, merged into the generated iOS Info.plist at build time; identical keys in `src-tauri/Info.plist`); macOS entitlements: camera, network client, network server (`src-tauri/Entitlements.plist:5-10`).
- Android: Wi-Fi binding during pairing so VPN/DNS blockers cannot swallow LAN traffic, and the Wi-Fi multicast lock mDNS needs, both held only while a pairing session runs; expandable notifications via JNI (`lan_binding.rs:9-99`, `MainActivity.kt:354-413`).
- Windows: the start-at-login `Run` value is rewritten with the executable path quoted, only when the entry exists (`autostart.rs:1-55`).
- iOS: link-code discovery uses Bonjour through mDNSResponder, covered by the `NSBonjourServices` / `NSLocalNetworkUsageDescription` keys; no multicast entitlement is needed or requested (`pairing/dnssd.rs`).
- Outbound-only LAN IP discovery uses a UDP `connect` to `8.8.8.8:80` that sends no packets (`pairing/transport.rs:134-143`).

## Not yet verified in this draft

- The updater plugin's internal minisign enforcement (upstream plugin behavior; only the pinned config is verified here).
- Tauri's enforcement that capabilities without a `remote` scope deny IPC to remote origins loaded in a window (upstream behavior; only the capability files are verified here).
- macOS notarization/hardened-runtime state, Windows code-signing/SmartScreen state, Keychain behavior across app updates, and SideStore re-signing effects on the iOS keychain.
- CI workflow security (covered by Pass 12 of the audit protocol, not Pass 0).

## Maintenance

Refresh this file as part of Pass 0 (`docs/AUDIT_PROTOCOL.md`), and whenever an entry point
is added — a new command, listener, WebView, deep link, provider endpoint, or file the app
writes. Keep findings out of it.
