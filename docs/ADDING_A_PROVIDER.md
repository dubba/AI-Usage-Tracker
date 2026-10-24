# Adding a provider

A provider is wired in at a fixed set of places. Most of them are `match` statements or `Record<Provider, …>` types, so the compiler (`cargo check`, `npm run check`) lists what is missing once the id exists. This page lists them all, including the ones the compiler cannot see, in the order to work through them.

There is deliberately no provider trait. Each provider has its own usage client, and cookie and API-key providers stay explicit about how they sign in. What the OAuth providers share lives in functions (`with_fresh_secret`, `refresh_oauth_secret`), not in an interface.

Use an existing provider of the same kind as the model:

| Sign-in | Example | Usage client |
|---|---|---|
| Browser OAuth (loopback callback) | Anthropic | `providers/anthropic.rs`, `auth/oauth/` |
| Google OAuth | Antigravity | `providers/antigravity.rs`, `auth/oauth/` |
| Cookie capture in a login WebView | Grok, OpenCode Go | `providers/grok/`, `providers/opencode_go.rs`, `auth/grok_login.rs`, `auth/opencode_login.rs` |
| API key | Google AI Studio | `providers/google_ai_studio/` |

## 1. The id

- `src/types.ts` — add the id to the `Provider` union.
- `src-tauri/src/model.rs` — add a `Provider` variant, and its arms in `id()`, `display_name()` and `FromStr` (`"…" | alias`). Add a `ProviderSecret` variant carrying the credential type, and its arm in `ProviderSecret::provider()`. A credential struct needs a hand-written redacting `Debug` and `Zeroize` like `OAuthSecret` and `GrokSecret`.
- `src/shared/lib/providers.ts` — an entry in `PROVIDER_META` (`name`, `connectLabel`, `connectDetail`) and a place in `DEFAULT_PROVIDER_ORDER`.
- `src-tauri/src/frontend_contract.rs` — add the variant to `all_providers()` and update the count in `the_extractors_read_what_they_should`. `provider_display_names_match_the_frontend` then checks that `PROVIDER_META[...].name` equals `Provider::display_name()`.

## 2. Reading usage

- `src-tauri/src/providers/<name>.rs` (or a folder) — a `refresh` function that returns `ProviderUsage` with `UsageWindow`s. Window ids and labels are the provider's own words; the backend works out each window's `kind` (5 hour, weekly, monthly) from them in `WindowKind::classify` (`model.rs`), so check that a new provider's labels classify as intended by adding a case to `src/shared/lib/window-kinds.fixture.json`.
- `src-tauri/src/providers/mod.rs` — `pub mod <name>;` and the arm in `refresh`.
- Nothing to add for the Usage page (code: `features/activity`): a provider's first window that classifies as `Weekly` becomes a tracker on the Usage page automatically (`history::tracker_windows`; Antigravity tracks every weekly window), and an account with no weekly window gets a "No weekly limit" card. Keep window ids stable between refreshes, because they key the stored history.
- Token handling:
  - OAuth providers refresh through `with_fresh_secret` (it serializes refreshes and saves a rotated token even after a timeout) and `oauth_refresh::refresh_oauth_secret` with a `RefreshRequest`. The options on `RefreshRequest` (`InvalidGrant`, `Lifetime`, `IdToken`) are the places providers differ.
  - Map HTTP failures with `classify_status` and a `StatusPolicy`, so only a rejected credential marks the account as needing sign-in.
  - Errors must not echo provider text; use fixed sentences.
- Endpoints are fixed `https://` / `wss://` constants in the provider file. Never build a host from user or response data.
- `src/shared/lib/usage-sources.ts` — if the frontend branches on the provider's `source` values, add them to `USAGE_SOURCES` and to the matching constants in the provider file; `frontend_contract.rs` keeps both sides equal.

## 3. Signing in

Pick the path that matches the provider.

**Browser OAuth**

- `src-tauri/src/auth/oauth/mod.rs` — scopes and callback ports at the top; `build_authorization_url` and `redirect_uri` each have an arm per provider.
- `src-tauri/src/auth/oauth/exchange.rs` — an `exchange_<name>` function and the arm in `exchange_tokens`. Build the request with `RefreshBody` and parse the reply as `TokenResponse`; the exchange keeps its own `ExchangeError`, because a single-use code is retried only when the token endpoint never answered.
- `src-tauri/src/auth/oauth/identity.rs` — where the account's email and plan come from.
- `src-tauri/src/auth/oauth/callback_server.rs` — `bind_callback_port`: the fixed loopback ports the provider's client registration allows (or an ephemeral port).
- `src-tauri/src/auth/mobile_auth.rs` — the host allowlist for the mobile in-app sign-in.

**Cookie capture in a login WebView**

- `src-tauri/src/auth/<name>_login.rs` — built on `login_window::open_private_login_window` (private profile, navigation allowlist, Back button, close and timeout handling) and `oauth_common::finish_window_login`.
- The window label: add a `LOGIN_WINDOW_LABEL` constant in that file and put it in `LOGIN_WINDOW_LABELS` in `src-tauri/src/commands/auth.rs`, so `cancel_login` closes the window. `cancel_login_closes_every_sign_in_window` scans the sources and fails if a label is missing.
- Cookie normalization must reject CR/LF and keep only the cookie names the provider's usage client needs.
- A login window gets no capability file: it must have no IPC commands.

**API key**

- A command that validates the key against the provider and stores a `ProviderSecret` (`add_google_ai_studio_account` is the model). Validate the key's shape before any request.

All paths:

- `src-tauri/src/commands/auth.rs` — `start_login` routes by provider; add the branch (or the error that says this provider signs in elsewhere), plus a command such as `add_<name>_account` for cookie and key providers.
- `src-tauri/src/auth/oauth_common.rs` — the icon the "Account connected" page shows (`GROK_ICON`, `OPENCODE_ICON`, …).

A new command means four edits, and a test fails if one is missing:

1. `generate_handler!` in `src-tauri/src/lib.rs`
2. `APP_COMMANDS` in `src-tauri/build.rs`
3. `src-tauri/capabilities/default.json`
4. a caller in `src/shared/lib/api.ts` (a command nothing calls is rejected)

## 4. The interface

- `src/shared/ui/ProviderIcon.tsx` — the mark. `PROVIDER_META` and the `Provider` union are enforced by the compiler; the icon is not, because the component falls through to the last provider.
- `src/features/add-account/strategies.ts` — an entry in `STRATEGIES` (`Record<Provider, ProviderStrategy>`). Start from `browserSignIn("<id>")` and override only what differs: `connectMode`, `validate`, `description`, `connectDirect`, `actionLabel`.
- `src/features/add-account/AddAccountModal.tsx` — `PICKER_ORDER` (the order in the picker) and, when the provider needs its own fields, the case in `providerFields` plus a component in `add-account/fields/`.
- `src/features/accounts/AccountsView.tsx` — `EMPTY_STATE_PROVIDERS` is the short list of first-run cards. Add the provider only if it should be offered there.
- `src/shared/lib/display.ts` — `PLAN_RULES` and `PLAN_FALLBACK` (how the stored plan string is shown), and `DEFAULT_GROUP_BY_PROVIDER` (the group a window falls into when its label names none). Add cases to `display.test.ts`.
- `src/types.ts` — only if the provider adds a field. Then run `UPDATE_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --lib type_contract` and `npx vitest run src/shared/lib/types-contract.test.ts`.

## 5. Documents and release notes

- `docs/THREAT_MODEL.md` — the provider's endpoints and hosts (section 8), its login window or callback (sections 3 and 4), and where its credential is stored (section 9). Update `file:line` references in the same change.
- `TESTING.md` — the test map rows for new guards.
- `CHANGELOG.md` — an `Added` entry under `## Unreleased`, with the counts updated (`docs/CHANGELOG_WORKFLOW.md`).

## Checklist of checks

```bash
npm run check
npx vitest run
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --lib --target aarch64-apple-ios-sim
```

If the provider touches Android-only code, build it for Android too; those files do not compile on the other targets.
