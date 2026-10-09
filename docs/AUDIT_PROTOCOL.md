# Audit protocol

A repeatable, evidence-based review process for AI Usage Tracker. Run one pass at a time, in a fresh session, read-only. Each pass is scoped to this app's real attack surface (a Tauri client with no server and no database), not a generic web stack.

`AGENTS.md` and `src-tauri/AGENTS.md` are the engineering contract and remain the source of truth for invariants. This file defines how to audit against them.

## When to run what

Do not run all passes every time. Match passes to what changed.

| Trigger | Passes |
| --- | --- |
| Touched OAuth, login windows, token refresh, credential storage | 2, 3, 7, 13 |
| Touched bridge API, pairing, mDNS, airgap QR | 4, 2, 13 |
| Touched `capabilities/`, `build.rs`, CSP, Tauri commands | 5 |
| Touched Android Kotlin, manifest, entitlements, plists | 6 |
| Touched store, migrations, settings schema | 8 |
| Touched a provider connector | 7 |
| Before any release, or after a dependency/CI change | 12, then the passes above that apply |
| Quarterly, or after a large feature | 0 through 13 in order |

## Ground rules for every pass

1. **Read-only.** Do not edit code, run builds, or run `cargo clean`. Running tests and the validation commands in `AGENTS.md` is allowed. Never build an APK or iOS app.
2. **Never open `.secrets/`, `release-apks/`, or credential files, and never print a secret value** you happen to find in the code, logs, or git history. Report its location and type only, redacted.
3. **Never say "looks good" without evidence.** A claim that something is safe must cite `file:line` and state what was verified. A claim without evidence is not a finding and not a clearance.
4. **Quote the code.** Every finding includes the relevant lines. If you cannot point to code, mark the finding `Unverified` and say what would confirm it.
5. **Separate what you read from what you ran.** Mark each claim `Read` (static inspection), `Ran` (executed a test or command, include the command), or `Unverified` (inference).
6. **Do not credit tests you have not read.** A test named `rejects_bad_token` is only evidence if you read its assertions and confirmed it would fail if the check were removed.
7. **Stay inside the product decisions in `AGENTS.md`.** Do not recommend a second usage endpoint, a dependency on external coding CLIs, or breaking the `/v1/paseo-usage` schema v1.
8. **End every pass with two lists**: *Checked and sound* (each item with evidence) and *Not examined* (what you skipped and why). An empty *Not examined* list is not credible.

## Severity rubric

| Severity | Meaning in this app |
| --- | --- |
| Critical | An attacker without prior access obtains provider credentials, executes code, or bypasses update signature verification. Includes any remote or other-LAN-device path to tokens. |
| High | A local unprivileged process, a malicious webpage, a paired-but-untrusted device, or a malicious provider response obtains credentials, corrupts stored accounts, or escalates beyond its intended permission. Credential or token written to a log, crash report, diagnostics export, or the frontend. |
| Medium | Requires unusual preconditions (rooted device, physical access to an unlocked machine, user mistakes), leaks non-secret metadata such as emails or quota numbers, or causes silent wrong data. |
| Low | Defence-in-depth gaps, hardening, robustness without a concrete exploit. |
| Info | Observations, cleanups, documentation drift. |

## Finding format

Return every finding as a block, ranked most severe first, with a stable ID (`P4-01`).

```
### P4-01  [High]  Local network  Bridge bearer token compared with ==
Status:       Read | Ran | Unverified
Confidence:   High | Medium | Low
Evidence:     src-tauri/src/bridge_api.rs:123  (quote the lines)
Impact:       what the attacker gains
Scenario:     attacker, preconditions, steps (for security findings)
Remediation:  the smallest change that fixes it
Test:         the regression test that would have caught it (file + what it asserts)
```

Findings that are a missing state, missing test, or maintainability issue may omit *Scenario*.

## Process around the passes

1. **Run** the pass in a fresh session. Use the runner prompt at the bottom.
2. **Keep the report out of the public repo.** Save it as `.audits/<date>-pass-<N>.md` and add `.audits/` to `.gitignore`. Committing unfixed Critical or High findings to a public repository publishes the exploit.
3. **Verify before fixing.** For each Critical and High finding, start a second session whose only job is to *refute* it: read the code, try to show the finding is wrong or already mitigated. Drop what it refutes. Downgrade what it cannot confirm.
4. **Fix one finding per pull request**, each with its regression test. Follow `docs/CHANGELOG_WORKFLOW.md`: Security fixes with user-visible effect go under `### Security`.
5. **Re-run the same pass** after fixes. A pass is done when it returns no new Critical or High findings and every earlier finding is Fixed, Accepted (with a written reason), or Refuted.
6. **Prove the test is real.** For each regression test, temporarily revert the fix in a scratch worktree and confirm the test fails.

---

## Pass 0: Threat model (run once, refresh yearly)

Produce an inventory of assets, entry points, and trust boundaries before auditing anything else. Later passes use it. The durable version of this inventory is `docs/THREAT_MODEL.md`: verify every entry point and guard it lists against the code, add anything missing, correct anything wrong, and report the corrections and omissions as findings in `.audits/`. Never record suspected vulnerabilities or unfixed weaknesses in the threat model file itself.

**Assets:** OAuth access, refresh, and ID tokens; Google AI Studio API keys; Grok and OpenCode session cookies; the bridge bearer token; pairing session keys; cached usage and account metadata (emails, plan names); the updater signing key; the Android sideload keystore; GitHub Actions secrets.

**Attackers to model (replace "no credentials / normal user / compromised user"):**

| Attacker | Capabilities |
| --- | --- |
| Remote web attacker | Can make the user's browser load a page; no direct network access to the device. Targets: loopback API via DNS rebinding or cross-origin requests, deep links, OAuth redirect handling. |
| Same-LAN device | Can see mDNS, reach any port bound beyond loopback, race a pairing session. |
| Local unprivileged process | Same OS user or another user on a shared machine. Can read world-readable files, scan loopback ports, read process arguments and logs. |
| Other Android app | Can send intents, query exported components, read shared storage. |
| Malicious or compromised provider | Returns hostile or malformed JSON, huge bodies, redirects, or slow responses. |
| Stolen or lost device | Locked and unlocked variants. |
| Supply-chain attacker | Compromised npm or crate dependency, GitHub Action, or release asset. |
| Public-repo reader | Sees all source, history, workflows, and `sidestore-source.json`. |

**Deliverable:** an updated `docs/THREAT_MODEL.md` — entry points (Tauri commands, loopback routes, mDNS records, deep links, Android receivers, WebView navigations, updater endpoint, QR payloads) mapped to the attackers above, with the code that guards each one — plus a Pass 0 report in `.audits/` listing corrections, omissions, and anything left unverified.

## Pass 1: Architecture and invariants

Verify each rule in `AGENTS.md` and `src-tauri/AGENTS.md` is actually enforced by code, not just written down.

- Credentials never cross into the frontend: trace every Tauri command response type in `src-tauri/src/commands/` and the TypeScript types in `src/types.ts`.
- Token refresh is serialized per account (`refresh_loop.rs`, `providers/oauth_refresh.rs`). Look for any second refresh path.
- Only `https://chatgpt.com/backend-api/wham/usage` is used for OpenAI quota retrieval.
- Last-known-good usage survives transient failure and is marked stale.
- All logging goes through `diagnostics::*`. Search for `eprintln!`, `println!`, `dbg!`, `console.log`, and Kotlin `Log.` calls.
- Coupling between providers and the dashboard model; duplicated normalization logic; dead code; modules that have grown past what one person can review (`updater.rs` is over 1,000 lines).

## Pass 2: Credentials and secrets

- Storage per platform: Windows Credential Manager, macOS Keychain (`credential_store.md`), Android Keystore-sealed files (`credential_file.rs`, `android_keystore.rs`, `CredentialVault.kt`). Confirm the debug-only plaintext path cannot be compiled into a release build.
- Key lifecycle: non-exportable Keystore key, behaviour on biometric/lock-screen change, key loss and recovery.
- In-memory handling: `zeroize` coverage, secrets in `Debug` or `Serialize` derives, secrets in error strings.
- Leak channels: `diagnostics.rs` redaction (test it with adversarial input: JWTs, cookies, emails, home paths, URLs with `code=` and `state=`), panic messages, crash dumps, clipboard, the diagnostics report, `reqwest` error `Display` output that includes URLs.
- Repository: `git log -p` for committed secrets, `.gitignore` coverage for `.secrets/`, signing keys, `.env`, `*.apk`, `release-apks/`. Report locations only.
- Build artifacts: secrets in `dist/`, source maps, the APK, and the Android `assets/`.
- Bridge token: generation entropy, storage, reveal and regenerate flow, exposure in UI state.

## Pass 3: Authentication flows

For each provider (OpenAI, Anthropic, Antigravity, Google AI Studio, Grok, OpenCode Go):

- OAuth: PKCE verifier entropy and one-time use; `state` generation and validation; redirect URI exactness; code replay; loopback callback listener lifetime, port binding to `127.0.0.1` only, and what a second local process can do by hitting the callback first; callback handling when the user cancels or the flow times out.
- Mobile: system-browser flow, deep-link scheme registration and hijacking by another app, intent filter `autoVerify`, state tied to the originating session (`mobile_auth.rs`).
- Cookie capture (`grok_login.rs`, `opencode_login.rs`): `on_navigation` host allowlists, incognito isolation, which cookies are retained, what happens to the session on logout and account removal, Android single-WebView limitation.
- Token refresh: rotating refresh tokens, failure after rotation but before persist, revoked-token handling, backoff (`refresh_backoff.rs`) that avoids lockout.
- Account removal: are credentials actually deleted from the OS store, memory cache, and any legacy item?
- URL validation for every WebView load: HTTPS or the exact loopback callback only; no `javascript:`, `intent:`, `file:`, `content:`.

## Pass 4: Local network surface (attack simulation)

Act as a penetration tester. For each path give prerequisites, steps, impact, likelihood, severity, remediation. Do not change anything.

**Loopback bridge API** (`bridge_api.rs`, `lan_binding.rs`, port 47831):
- Bind address: confirm loopback only, including after network change, IPv6, and `0.0.0.0` fallbacks.
- Auth: constant-time bearer comparison (`subtle`), behaviour on missing, malformed, or duplicate `Authorization` headers, token in query string or logs.
- Browser attacks: DNS rebinding (is the `Host` header validated?), cross-origin fetch (CORS headers, preflight handling), cross-site requests with simple methods.
- Rate limiting: can it be bypassed or used for denial of service; request size and slowloris limits; behaviour under many connections.
- Response: contains only sanitized data and stays within schema v1.

**Device pairing** (`pairing/`):
- mDNS exposure: confirm TXT records carry only the ephemeral public key, session id, and nonce.
- The 6-digit join code is a discovery handle only. Try to find any code path where it grants trust.
- Man-in-the-middle: SAS derivation covers both public keys and nonces; SAS comparison cannot be skipped or auto-confirmed; downgrade of role or the `allow_credential_replace` flag by the peer.
- Crypto: X25519 low-order points, HKDF context separation, XChaCha20-Poly1305 nonce uniqueness, key reuse across sessions, replay of a captured handshake.
- Transport: message size limits, timeouts, malformed frames, concurrent sessions, session cleanup after cancel.
- Payload import: what a malicious paired device can write into the importer (settings, accounts, credentials) and whether it can overwrite existing credentials without consent.

**Airgap QR transfer** (`pairing/airgap.rs`, `src/features/pairing/`):
- Confidentiality and integrity of the QR payload, decompression bombs (`miniz_oxide`), size caps, replay, and what is shown on screen while codes are displayed.

## Pass 5: App shell and IPC boundary

- `capabilities/default.json` and `api-integration.json`: least privilege per window. Anything in the main window that the Bridge window does not need, and the reverse.
- `build.rs` `APP_COMMANDS` equals `generate_handler!` equals capabilities (a test exists; read it and check it is not vacuous).
- Every Tauri command: argument validation on the Rust side (lengths, enums, IDs referencing existing accounts), error messages that leak internals, commands that can be called with attacker-controlled strings by injected frontend code.
- CSP in `tauri.conf.json`: `style-src 'unsafe-inline'` justification, `connect-src` breadth, `img-src data: blob:`, whether `dev` CSP differs from production.
- `opener:allow-open-url` allowlist breadth and whether the frontend can open arbitrary URLs through any other route.
- XSS through provider data: account names, emails, plan names, error messages, and model names rendered in React. Search for `dangerouslySetInnerHTML`, `innerHTML`, `eval`, and dynamic `href` or `src` values.
- Window creation: login windows' preload scripts, `initialization_script` content, and navigation guards.

## Pass 6: Platform-specific security and behaviour

**Android** (`src-tauri/gen/android/`): exported flags on every component in `AndroidManifest.xml`; `ApkInstallReceiver.kt`, `BootReceiver.kt` (who can trigger them, intent validation, package and signature verification before install); `apk_install.rs` update integrity; `network_security_config.xml`; `file_paths.xml` FileProvider scope; `allowBackup` and `data_extraction_rules.xml`; WebView settings (file access, JavaScript interfaces); `CredentialVault.kt` Keystore parameters; ProGuard rules; permissions requested vs used; behaviour in Doze, background kill, and boot.

**macOS:** `Entitlements.plist` (every entitlement justified), hardened runtime, notarization, Keychain access group and prompt behaviour across updates, `Info.plist` usage strings.

**Windows:** installer mode, Credential Manager blob size and chunking, SmartScreen and code-signing state, single-instance behaviour, autostart registration path quoting.

**iOS (SideStore):** static review only, because Xcode is not installed locally. Review `Info.ios.plist`, bundle ID, generated project under `src-tauri/gen/apple`, unsigned IPA implications, and keychain behaviour when re-signed by SideStore.

## Pass 7: Provider integrations, concurrency, and failure handling

Six providers, four of which use undocumented interfaces. This is the app's most likely source of everyday bugs.

- Hostile or malformed responses: missing fields, wrong types, negative or NaN quotas, percentages above 100, very large bodies, unexpected redirects, HTML instead of JSON. Does each connector fail closed and keep last-known-good data?
- Response size limits, request timeouts, connect timeouts, and redirect policy in every `reqwest` client.
- Drift detection: how does the user learn a connector broke (stale marker, diagnostics) versus silently showing wrong numbers?
- Concurrency: simultaneous refresh from timer, window focus, manual refresh, and device resume; account removal during an in-flight refresh; reorder during refresh; two app instances (`single-instance`).
- Time handling: clock changes, DST, reset-time parsing, timezone display, sleep and wake.
- Alerts (`alerts.rs`): duplicate notifications, notification storms after resume, thresholds at boundaries.
- Retries and backoff: no tight retry loops, `Retry-After` honoured, 401 versus 429 versus 5xx treated differently.
- Each connector has fixture-based tests covering success, partial data, auth failure, and schema change.

## Pass 8: Local data, migrations, and upgrades

There is no database server. The equivalent concerns are the on-disk store (`src-tauri/src/store/`, `settings.rs`, `migrations.rs`, `fs_util.rs`).

- Atomic writes (temp file plus rename plus fsync), behaviour on crash or full disk mid-write, file permissions on creation.
- Corrupt or truncated JSON: does the app recover, back up, or crash-loop (`startup.rs` startup-issue handling)?
- Schema versioning and forward compatibility: what happens when an older app opens data written by a newer one (downgrade, SideStore re-install, pairing import from a newer peer).
- Migrations: idempotence, interruption halfway, the `paseo-usage-bridge` to `ai-usage-tracker` Keychain migration (delete only after verified write), the product rename, and Android upgrade over an older APK.
- Account deletion removes metadata, cache, credentials, alerts, buckets, and ordering entries with no orphans.
- Concurrent writers: refresh loop versus UI commands versus pairing import.
- Disaster recovery: what a user can do if the Keychain item is lost or the Keystore key is invalidated. Is re-adding an account clearly guided?
- Versioned local API backward compatibility: diff `/v1/paseo-usage` output against the documented schema and the previous release.

## Pass 9: Frontend and UX states

Audit every screen in `src/features/` (accounts, add-account, alerts, api-integration, buckets, dashboard, pairing, reorder, settings, shortcuts, startup).

- For each: loading, empty, first-use, error, success, disabled, stale-data, offline, permission-denied (camera, notifications), and "provider changed" states.
- Flows that can strand the user: cancelled OAuth, closed login window, pairing cancelled mid-handshake, update failing halfway, startup issue screen.
- Race conditions: stale responses overwriting newer state, double-click on add or remove, drag-and-drop during refresh.
- Accessibility: keyboard navigation, focus management in modals and dropdowns, labels on icon buttons, colour contrast of the dark theme, reduced motion, screen-reader announcement for toasts and stale markers, touch-target size on mobile.
- Responsiveness: 960px minimum desktop width, phone widths, safe-area insets, iOS 16 and older Android WebViews.
- Consistency with `docs/CSS_ARCHITECTURE.md`.

## Pass 10: Testing

- `TESTING.md` maintains the inventory and the security-invariant → test map. Verify it is still accurate — read the tests it cites rather than trusting the table — then look for what it misses.
- For each security invariant in `AGENTS.md`, find the test that would fail if the invariant were broken. Read the assertions. List invariants with no such test.
- Missing categories, ranked by risk: bridge auth and Host validation; diagnostics redaction with adversarial input; pairing MITM and replay; OAuth state mismatch; migration interruption; provider schema drift fixtures; Tauri capability drift; frontend rendering of hostile account names.
- Run the full validation block from `AGENTS.md` and report actual results, including flaky or skipped tests.
- Mutation spot-check: for the five highest-risk checks, break the check in a scratch worktree and confirm a test fails.
- CI coverage gaps: which platforms and targets are tested, and which (Android, iOS) are not.

## Pass 11: Performance and resource use

A desktop and mobile client does not have "10,000 users". Scale the questions to accounts, providers, and uptime.

- Accounts: 1, 10, 50, 200. Dashboard render cost, refresh-all duration, memory, and drag-and-drop smoothness.
- Idle cost: CPU wakeups, timers, open sockets, and mDNS activity when nothing is happening; tray-only operation.
- Battery and background on Android: boot receiver, foreground service, refresh scheduling under Doze, notification rate.
- Network: concurrent request fan-out, redundant refreshes, conditional requests, behaviour on metered or captive-portal networks.
- Long uptime: log rotation size, cache growth, memory growth over days.
- Bundle size and startup time of the web frontend; unused dependencies.

## Pass 12: Supply chain, CI/CD, and release

- Dependencies: run `npm audit` and `cargo audit`; review new or unmaintained crates; check feature flags that widen attack surface; verify lockfiles are committed and CI uses them (`npm install` versus `npm ci`).
- GitHub Actions (`.github/workflows/`): third-party actions pinned to commit SHAs; `permissions:` minimal per job; no `pull_request_target` with untrusted checkout; secrets not exposed to fork PRs; `GITHUB_TOKEN` scope; script injection through `${{ }}` in `run:` steps; the `.github/release-trigger` mechanism and the scheduled-release `check-changes` job.
- Updater: public key handling, what is signed, endpoint is HTTPS and pinned to the repo, downgrade protection, behaviour when `latest.json` is malformed or points elsewhere, beta channel handling, the Android APK install path.
- Release integrity: signing key storage and rotation plan, Apple Developer ID and notarization, Windows signing, checksum publication, `sidestore-source.json` generation and its trust model.
- Reproducibility: can a release be rebuilt, and is there a documented rollback (pulling a bad release, yanking `latest.json`)?
- Repository exposure: assume the repo is public. Review git history, workflows, and docs for internal URLs, tokens, or personal data (`docs/` contains discovery notes on provider endpoints; confirm they contain no live credentials or account identifiers).

## Pass 13: Final red team

Run last, with the earlier reports in hand.

Assume every previous pass missed something and that every "Checked and sound" item may be wrong.

- Try to refute five randomly chosen *sound* claims from earlier passes by reading the code yourself.
- Chain findings: a Low plus a Low that becomes a High (for example, a loopback callback race plus verbose error logging plus a diagnostics export).
- Look at seams between components: Rust to Kotlin, Rust to frontend, frontend to OS, app to installer, pairing import to store.
- Look for logic flaws: state machines that can be driven out of order (pairing `select_role`, `confirm_sas`, `set_include_settings`), operations that succeed partially, and time-of-check to time-of-use gaps.
- Look for assumptions: "the provider will always return X", "only one instance runs", "the user never clears the Keychain", "the clock is correct".
- Give no credit to tests you have not read. Do not report anything already in the ledger unless its status is wrong.

---

## Runner prompt

Paste this at the start of each session, changing the pass number.

```
Run Pass <N> from docs/AUDIT_PROTOCOL.md against this repository.

Read AGENTS.md, src-tauri/AGENTS.md, and the "Ground rules", "Severity rubric", and "Finding format" sections of docs/AUDIT_PROTOCOL.md first. Then read the Pass <N> section and follow it.

Do not modify any file. Do not open .secrets/ or release-apks/. Redact any secret you see.
Every claim needs file:line evidence and a Read / Ran / Unverified status. Do not write "looks good"; list what you verified under "Checked and sound" and what you skipped under "Not examined".
Return findings in the specified format, most severe first. Save the report to .audits/<today>-pass-<N>.md.
```

## Standing instruction for day-to-day coding

Keep this short in `AGENTS.md` rather than pasting the whole protocol every session. The coding agent should, for every change:

- Identify which trust boundary it touches (see Pass 0) before editing.
- Reuse existing patterns; add no dependency without a stated reason.
- Validate every argument on the Rust side; never rely on frontend validation.
- Keep secrets out of logs, errors, frontend types, test fixtures, and commits.
- Handle loading, empty, error, stale, and offline states for any UI it adds.
- Consider concurrent refreshes, retries, and provider failures.
- Add a regression test for each bug fixed and a negative test for each security check added.
- Run the validation block from `AGENTS.md`, then self-review the diff against the questions: does it fail safely, is the input validated, what does a hostile peer or provider response do, and is it tested.
- State what was verified by running versus by reading. Do not claim a security property you did not check.

## Supporting documents

The original suggestion was `SECURITY.md`, `ARCHITECTURE.md`, `TESTING.md`, and `AI_RULES.md`. The final state for this repo:

- **`SECURITY.md`** (root): the public vulnerability-reporting policy — supported versions, the GitHub private reporting channel, and a short threat-model summary.
- **`docs/THREAT_MODEL.md`**: the Pass 0 deliverable — assets, attackers, trust boundaries, system map, and the entry-point → guard inventory. Kept free of findings.
- **`TESTING.md`** (root): the test inventory plus the security-invariant → test map; doubles as the baseline for Pass 10.
- **`AI_RULES.md`**: deliberately not maintained. `AGENTS.md` (referenced from `CLAUDE.md`) already is this file; a second copy will drift.
- **`ARCHITECTURE.md`**: deliberately not maintained. `src-tauri/AGENTS.md`, `docs/CSS_ARCHITECTURE.md`, and `src-tauri/src/credential_store.md` cover the conventions, and the system map lives in `docs/THREAT_MODEL.md`.
