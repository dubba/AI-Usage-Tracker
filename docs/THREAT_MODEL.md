# Threat model

> **Draft: derived from code reading, not yet verified by a full audit run.**
> Every guard below was confirmed against the current source unless marked **Unverified**.
> This file records assets, attackers, trust boundaries, entry points, and the code that
> guards each one. It deliberately contains no findings or suspected weaknesses — audit
> findings belong in the gitignored `.audits/` directory (see `docs/AUDIT_PROTOCOL.md`).
> Pass 0 of the audit protocol verifies and refreshes this document.

## Assets

| Asset | Where it lives |
| --- | --- |
| OAuth access + refresh tokens (OpenAI, Anthropic, Google/Antigravity, Google AI Studio Cloud) | OS credential store only (see [Credential storage](#credential-storage)); rotated refresh tokens also in the in-memory cache (`store/credentials/cache.rs`) |
| Google AI Studio API keys | OS credential store only |
| Grok session cookies (`sso*`, `auth_token`, `jwt`, `session`) | OS credential store; captured from the login WebView (`grok_login.rs:536-590`) |
| OpenCode Go `auth` cookie + workspace id | OS credential store (`opencode_login.rs:557-595`) |
| Paseo Bridge bearer token (64 alphanumeric chars) | OS credential store (`store/credentials/mod.rs:401-407`, `keyring_store.rs:12`) |
| Pairing session keys (X25519 ephemeral, HKDF-derived), airgap transfer key | Memory only, zeroized on drop (`pairing/crypto.rs:17,50`) |
| Account metadata: emails, labels, plan names, usage numbers | `accounts.json` and sibling JSON files in the app data dir; sanitized projections in the dashboard snapshot and the local API |
| Updater minisign private key, Android signing keystore | GitHub Actions secrets — never in the repository |
| Integrity of the update channel (`latest.json`, APK + `.apk.sha256` assets) | GitHub Releases of this repository |

ID tokens are decoded without signature verification for informational claims only; they are never used as authentication identity (`oauth.rs:1015-1023`).

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

1. **Webview → Rust backend** — 55 Tauri commands, gated by per-window capability files.
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
(18) wrappers in `src/shared/lib/api.ts:18-117` — exactly the 55 registered commands.
Backend events (`usage-alert`, `pairing-status`, `pairing-uri-received`,
`app-update-progress`) are consumed via `useTauriEvent`. The `api-integration` window
renders `ApiIntegrationWindow.tsx` and can call only three bridge methods
(enforced by the sync test, `lib.rs:322-333`).

### Backend module map

| Area | Modules |
| --- | --- |
| App shell / IPC | `lib.rs` (55 commands, `lib.rs:96-152`), `commands/*` (per-domain commands), `state.rs` (shared `AppState`: locks, rate-limit map, refresh semaphore), `backend.rs`, `startup.rs` |
| Usage engine | `usage.rs` (refresh orchestration, per-account locks), `refresh_loop.rs` (wall-clock ticker), `refresh_backoff.rs`, `limits.rs`, `buckets.rs`, `account_order.rs`, `alerts.rs`, `settings.rs` |
| Providers | `providers/{mod,openai,anthropic,antigravity,google_ai_studio,grok,opencode_go,oauth_refresh}.rs` — each normalizes a provider's quota response into `UsageWindow`s |
| Login flows | `oauth.rs`, `oauth_common.rs` (loopback OAuth), `google_ai_studio_oauth.rs` (Cloud connection), `grok_login.rs`, `opencode_login.rs` (WebView cookie capture), `mobile_auth.rs` (mobile in-app sign-in) |
| Local API | `bridge_api.rs` (loopback HTTP), `commands/bridge.rs` |
| Device transfer | `pairing/{mod,crypto,protocol,transport,discovery,payload,airgap}.rs`, `commands/pairing.rs` |
| Storage | `store/*` (accounts, credentials), `fs_util.rs` (atomic owner-only writes), `migrations.rs` |
| Updater | `updater.rs`, `apk_install.rs` |
| Platform glue | `tray.rs`, `diagnostics.rs`, `macos_notifications.rs`, `camera_permission.rs`, `android_context.rs`, `android_keystore.rs`, `lan_binding.rs` |

### Key data flows

- **Usage refresh**: timer/resume/manual (`lib.rs:155-177`) → `refresh_all` (semaphore of 4, `state.rs:26,141`) → per-account async lock (`state.rs:244-262`) → provider call on a spawned task that owns the lock with a 45 s wait timeout (`usage.rs:31-119`) → normalize → persist to `accounts.json` keeping last-known-good marked `Stale` on failure (`usage.rs:380-414`); auth failure sets `auth_required` and suspends auto-refresh (`usage.rs:172-204`).
- **Credentials**: provider secret → `ProviderSecret` (Zeroize) → platform store dispatch (`store/credentials/mod.rs:107-174`) → in-memory cache with 300 s TTL and a dirty flag that survives until the native write succeeds (`cache.rs:10-93`). Secrets never appear in command responses or metadata files.
- **Local API**: dashboard snapshot → sanitized `PublicUsageResponse` (no tokens/cookies) → `GET /v1/paseo-usage`, schema v1 (`model.rs:336-359`, `bridge_api.rs:190-252`).
- **Pairing**: QR URI or 6-digit code → host TCP listener (`0.0.0.0:0`, `pairing/mod.rs:203` — all interfaces, by design, for LAN transfer) → X25519 + HKDF + SAS confirmation → XChaCha20-Poly1305-encrypted payload import with per-field clamping (`payload.rs`, `limits.rs:103-121`).
- **Updater**: GitHub releases manifest (desktop minisign-verified by the updater plugin; Android SHA-256 + APK signing certificate) → user-initiated install.

### On-disk data

All in the Tauri app data dir, written via `atomic_write_private` (temp + fsync + rename,
owner-only, `fs_util.rs:203-245`): `accounts.json` (v2) + hard-link backup `accounts.json.bak`
(`accounts.rs:456-470`), `deleted-accounts.json` (tombstones ≤500), `account-order.json`,
`usage-alerts.json`, `account-buckets.json`, `app-settings.json` (v3), `logs/app.log(.1)`
(rotating, 256 KiB), `*.invalid` quarantine (`state.rs:300-349`), and on Android + debug
builds `credentials/{id}.json` sealed files. Corrupt JSON is quarantined and reloaded, not
crashed on (`state.rs:300-318`).

## Entry points and guards

### 1. Tauri IPC commands (55) — reachable by injected frontend code

| Guard | Code |
| --- | --- |
| Per-window capability allowlists: main window = exactly the 55 commands; `api-integration` window = only `get-bridge-info`, `reveal-bridge-token`, `regenerate-bridge-token` | `capabilities/default.json`, `capabilities/api-integration.json`; five-way sync test `lib.rs:186-335` (handler list vs `build.rs APP_COMMANDS` vs capabilities vs every frontend `invoke()` vs the API window's three methods) |
| `build.rs APP_COMMANDS` mirrors the handler list into generated permissions | `build.rs:140-196,230-231` |
| Rust-side validation on every string input: labels trimmed ≤80 (`commands/mod.rs:16-28`), provider strings matched against a fixed whitelist (`model.rs:48-65`), emails trimmed ≤254 (`limits.rs:84-98`), refresh minutes restricted to {5,10,15,30,45,60} (`settings.rs:114-117`), reorder must be an exact permutation (`account_order.rs:81-109`), pending UI state object/null ≤64 KiB (`commands/pairing.rs:117-128`), pairing role `send`/`receive` only (`pairing/mod.rs:154-171`), join codes 6 digits with 5-attempt lockout (`pairing/mod.rs:509-540`) | as cited |
| `reveal_bridge_token` returns the full token; doc-comment restricts it to an explicit user click (`commands/bridge.rs:92-98`); `get_bridge_info` returns only a masked token (`commands/bridge.rs:111-127`, `model.rs:248-257`) | as cited |
| CSP: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, no remote script/style origins | `src-tauri/tauri.conf.json:30` |

### 2. Loopback HTTP bridge (`127.0.0.1:47831`) — reachable by any local process, and indirectly by browsers

| Guard | Code |
| --- | --- |
| Loopback-only bind, hardcoded | `bridge_api.rs:24` |
| Controller off unless enabled in settings (default false) and token readable; rebind retry every 3 s; desktop-only | `bridge_api.rs:34-92`, `settings.rs:52`, `backend.rs:62-63`, `commands/bridge.rs:22-24` |
| Host header must be loopback (DNS-rebinding defense), Origin/Referer must be absent or loopback | `bridge_api.rs:122-157` |
| Per-IP rate limit (burst 10, 1/s refill, 60 s entry TTL) applied before auth | `bridge_api.rs:27-32,176-184` |
| Bearer token compared with `subtle::ConstantTimeEq` | `bridge_api.rs:313-327` |
| Forced response headers (no-store, nosniff, no-referrer, X-Frame-Options DENY, CSP, CORP same-origin) | `bridge_api.rs:100-117` |
| Responses contain only sanitized usage fields; `schemaVersion: 1`; the only routes are `GET /v1/health` and `GET /v1/paseo-usage` | `bridge_api.rs:50-52,171-252`, `model.rs:336-359` |
| Token: 64 alphanumeric chars, persisted in secure storage, masked in UI | `store/credentials/mod.rs:401-407`, `model.rs:248-257` |

### 3. OAuth loopback callbacks — reachable by local processes and browser pages

| Guard | Code |
| --- | --- |
| Callback listener binds loopback only; fixed port allowlists (OpenAI 1455/1457, Anthropic 53692-53696, Antigravity ephemeral) | `oauth.rs:33,935-986` |
| PKCE (32-byte verifier, S256) and random state generated and validated | `oauth.rs:118-120,501`, `oauth_common.rs:28-37` |
| One-shot callback: `callback_claimed` AtomicBool prevents code replay; status polls serialized by `login_status_lock` | `oauth.rs:53,346,466-468` |
| Single-use codes: never retried after a definitive failure | `oauth.rs:297-299,380-382,567-595` |
| 5-minute login timeout | `oauth_common.rs:77` |
| Mobile: authorization URL must be HTTPS on `auth.openai.com`/`claude.ai`/`accounts.google.com` before WebView navigation; URL-poll recognizes only loopback callbacks | `oauth.rs:227-238,417-433`, `mobile_auth.rs:171-228` |

### 4. Login WebViews — reachable by any page loaded inside them

| Guard | Code |
| --- | --- |
| Grok login: incognito WebviewWindow, fresh owner-only (0700/ACL) temp profile swept at startup and removed on close/timeout; navigation blocked unless HTTPS on an allowlisted host; only session-cookie names retained; cookie normalization rejects CR/LF | `grok_login.rs:121,213-265,374-440,798-840`, `providers/grok.rs:365-461` |
| OpenCode login: HTTPS-only navigation allowlist (`opencode.ai`, `accounts.google.com`, `github.com`, `appleid.apple.com`); workspace id validated `[A-Za-z0-9_-]{1,160}`; cookie rejects control characters | `opencode_login.rs:618-651`, `providers/opencode_go.rs:17-25,116-124` |
| Mobile sign-in WebView: HTTPS-only + host allowlist (auth hosts of all six providers); FedCM-disabling shim | `mobile_auth.rs:21-37,122-144` |
| Android WebView patches (generated Kotlin): popup windows accept only loopback `localhost`/`127.0.0.1` hosts; `javascript:`/`file:`/`content:` blocked; `intent:`/`android-app:` downgraded only to `https:` fallbacks | `build.rs:300-314,343-346,458-475` |

### 5. Pairing (LAN) — reachable by same-LAN devices

| Guard | Code |
| --- | --- |
| QR pairing URIs accept only IP-literal hosts in loopback/private/link-local/CGNAT ranges; schemes `aiusage-pair:`/`aiusage:`; cryptographic parse before connecting | `pairing/protocol.rs:21-22,44-70,116` |
| Crypto: X25519 with non-contributory-key rejection, HKDF-SHA256, XChaCha20-Poly1305, 48-bit SAS code, constant-time confirmation tags, keys zeroized on drop | `pairing/crypto.rs:17,41-44,63,98-111,136-137,147` |
| SAS confirmation gates the payload transfer on both sides; rejection aborts both | `pairing/transport.rs:752-802,911-925`, `pairing/mod.rs:154-186` |
| mDNS `_aiut-pair._tcp.local` TXT records carry only sid/pk/nonce/v; join codes 6-digit, weak codes rejected, 5-attempt lockout | `pairing/discovery.rs:21-26,38-61,113-118` |
| Framing: 1 KiB pre-auth / 16 MB post-auth frame caps; session/socket/confirm timeouts 300/30/60 s | `pairing/protocol.rs:23-30`, `pairing/transport.rs:33-38` |
| Import clamping: 64 accounts / 256 KiB secrets, per-field clamps, hostile account ids re-minted, buckets remapped | `pairing/payload.rs:14-16,307-312`, `limits.rs:103-121` |
| Credential replacement requires an explicit single-use per-transfer opt-in, default false, reset per session; sender-side deletions are never applied to the receiver | `commands/pairing.rs:105-114`, `pairing/payload.rs:260-265,294-296`, `pairing/mod.rs:194,404` |
| Airgap QR: deflate + 16 MB decompression cap, 32-byte key in frames, 48-bit verify code, frame count/length bounds | `pairing/airgap.rs:22-37,85,100-150,217-278,313-316` |
| Frontend QR decoder sandbox: 960 px dimension cap with downscale, 2048-char payload cap, scheme allowlist, exception isolation; QR SVGs sanitized (no scripts/handlers/`javascript:`) | `src/features/pairing/lib/qr-decoder.ts:14-71`, `src/features/pairing/lib/sanitizeSvg.ts:19-67` |

### 6. Deep links (Android `aiusage-pair:`/`aiusage:`) — reachable by any Android app

| Guard | Code |
| --- | --- |
| VIEW intent → JNI `setPendingPairingUri` length-bounds (≤2048) and prefix-checks the URI before storing; consumed once via `get_pending_pairing_uri`; full cryptographic validation before connecting | `commands/pairing.rs:176-209`, `pairing/protocol.rs:116` |

### 7. Updater — reachable by a compromised release channel or MITM

| Guard | Code |
| --- | --- |
| Desktop: endpoint pinned to this repo's `latest.json`; minisign public key pinned in config; the updater plugin verifies signatures before install (plugin-internal behavior — **Unverified** in this repo beyond the config and `updater.rs:380-383`); check 30 s / install 15 min bounds; Windows install mode `passive` | `src-tauri/tauri.conf.json:54-62`, `updater.rs:378-383` |
| Android: asset name must match this app, `.apk`, not "unsigned", ≤250 MB, `PK` zip magic, ≤10 redirects; SHA-256 against the published `.apk.sha256`, failing closed if absent or mismatched; APK signing certificate verified via JNI before the user install prompt | `updater.rs:124-131,372,417-526,694-722`, `apk_install.rs:33-45` |
| Beta channel: GitHub API listing, newest non-draft release with a manifest | `updater.rs:318-334` |
| Outbound hosts limited to `github.com/dubba/AI-Usage-Tracker` and `api.github.com/repos/dubba/...` | `updater.rs:13-22` |
| iOS (SideStore): no in-place update; opens `sidestore://` or the releases page | `updater.rs:790-810` |

### 8. Provider APIs — reachable by a malicious or compromised provider

| Guard | Code |
| --- | --- |
| Outbound HTTPS only (rustls); fixed endpoint constants per provider (e.g. `providers/openai.rs:17`, `providers/anthropic.rs:16-19`, `providers/antigravity.rs:20`, `providers/google_ai_studio.rs:27-28`, `providers/grok.rs:22-28`, `providers/opencode_go.rs:9`); shared reqwest client with 10 s connect / 15 s total timeouts | `state.rs:111-116` |
| Responses treated as untrusted: window normalization with caps (≤32 windows), 401-only auth classification, unknown fields dropped, no plan guessing | `limits.rs:8-32`, `providers/anthropic.rs:407`, `providers/mod.rs:86-117` |
| Error messages sanitized: transport failures use fixed sentences, refresh errors pass an allowlist that drops tokens/keys/JWTs/URLs | `providers/mod.rs:43-56`, `usage.rs:356-378` |
| Token refresh: rotated refresh tokens replace old, `invalid_grant` → sign-in-again, unreadable replies never echoed | `providers/oauth_refresh.rs:84-128,232-407` |
| Grok cookies: host allowlist (`grok.com`, `accounts.x.ai`) and CR/LF injection rejection before header use | `providers/grok.rs:365-461` |

### 9. Credential storage — reachable by local processes and other OS users

| Platform/build | Mechanism | Code |
| --- | --- | --- |
| macOS/iOS release | Keychain item per account, service `ai-usage-tracker`, user `account:{id}`; legacy `paseo-usage-bridge` entries migrated on read | `store/credentials/mod.rs:107-117,198-215`, `keyring_store.rs:8-12` |
| Windows/other desktop release | Chunked `chunked-v1` entries in Credential Manager (DPAPI-backed): ≤32 chunks × 1200 UTF-16 units, generation ids so a crash never strands mixed secrets | `store/credentials/mod.rs:119-174`, `chunking.rs:13-20` |
| Android | `credentials/{id}.json` sealed with AES-256-GCM under a non-exportable Android Keystore key; magic `AIUT-SEALED-1`; the account id is bound into the ciphertext (AAD) so files cannot be swapped between accounts; legacy plaintext upgraded at startup and retried on dashboard reads | `credential_file.rs:18-171`, `android_keystore.rs:13-21`, `CredentialVault.kt` |
| Debug builds | Plaintext files, by design, `debug_assertions`-gated | `credential_file.rs:1-10,29-38` |

Additional guards: all secret structs derive `Zeroize` (`model.rs:132-181`); the in-memory
cache zeroizes on drop and keeps dirty entries until the native write succeeds
(`cache.rs:10-93`); account ids are restricted to `[A-Za-z0-9_-]{1,64}` precisely because
they become credential filenames (`store/mod.rs:30-41`); if secure storage is unreadable the
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
| `MainActivity` | exported (launcher; `aiusage-pair:`/`aiusage:` BROWSABLE deep links) | Deep-link URIs only land in `setPendingPairingUri` after length + prefix checks (`commands/pairing.rs:176-209`); full validation before any connection |
| `BootReceiver` | exported, `BOOT_COMPLETED` | Receives only boot intents; its post-boot behavior is **Unverified** in this draft |
| `ApkInstallReceiver` | not exported | Install prompts only from the updater flow (`apk_install.rs`) |
| `FileProvider` | not exported; scoped to `updates/` and `Pictures/` paths only | `file_paths.xml` (comment: never widen to `.`) |
| Backups | `allowBackup=false`; backup and data-extraction rules exclude all domains | `AndroidManifest.xml:32`, `backup_rules.xml`, `data_extraction_rules.xml` |
| Network | Cleartext forbidden except loopback hosts | `network_security_config.xml:8-11` |
| Keystore | AES-256-GCM, non-exportable key, no user-auth requirement (documented: background refresh while locked), AAD = credential file name | `CredentialVault.kt` |

### 12. External URLs / diagnostics egress

| Guard | Code |
| --- | --- |
| `opener` plugin restricted to 8 HTTPS URL prefixes (auth hosts + this repo) | `capabilities/default.json:13-34` |
| Frontend `openSafeUrl` enforces HTTPS + host allowlist before any `openUrl` | `src/shared/lib/safeUrl.ts:3-38` |
| Diagnostics export: every log line and the report pass `redact()` (sensitive keys, bearer tokens, JWTs, opaque strings, masked emails, masked home folders); the report omits account labels and emails | `diagnostics.rs:232-260,357-470,186-216` |

### 13. Platform permission surfaces

- macOS: camera TCC permission requested before QR scanning, 120 s timeout, failures non-fatal (`camera_permission.rs:85-91`); local-network + Bonjour usage strings and camera usage string declared (`src-tauri/Info.ios.plist:5-12`, merged into the generated iOS Info.plist at build time; identical keys in `src-tauri/Info.plist`); macOS entitlements: camera, network client, network server (`src-tauri/Entitlements.plist:5-10`).
- Android: Wi-Fi binding during pairing so VPN/DNS blockers cannot swallow LAN traffic, plus expandable notifications via JNI (`lan_binding.rs:9-99`).
- Outbound-only LAN IP discovery uses a UDP `connect` to `8.8.8.8:80` that sends no packets (`pairing/transport.rs:74-83`).

## Not yet verified in this draft

- The updater plugin's internal minisign enforcement (upstream plugin behavior; only the pinned config is verified here).
- `BootReceiver`'s post-boot behavior (manifest flags verified; handler logic not read).
- macOS notarization/hardened-runtime state, Windows code-signing/SmartScreen state, Keychain behavior across app updates, and SideStore re-signing effects on the iOS keychain.
- CI workflow security (covered by Pass 12 of the audit protocol, not Pass 0).

## Maintenance

Refresh this file as part of Pass 0 (`docs/AUDIT_PROTOCOL.md`), and whenever an entry point
is added — a new command, listener, WebView, deep link, provider endpoint, or file the app
writes. Keep findings out of it.
