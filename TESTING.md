# Testing

How this project tests, what currently exists, and which test guards each security
invariant. This is the baseline for Pass 10 of `docs/AUDIT_PROTOCOL.md` — an audit pass
verifies this map is still accurate and then looks for what is missing.

Every "test" listed below has been read; a test only counts as guarding an invariant if
its assertions would plausibly fail if the guard were removed.

## How to run

| Suite | Command | Scope |
| --- | --- | --- |
| Frontend unit tests | `npm test` (`vitest run`) | 49 `*.test.ts(x)` files under `src/` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` | 265 `#[test]`/`#[tokio::test]` in 38 files (all lib unit tests; no `src-tauri/tests/` integration dir, no doc tests) |
| Release-script tests | `npm run test:resolve-version`, `test:sidestore-source`, `test:gemini-quota-probe` | 3 `node --test` suites in `scripts/` (18 tests) |
| Type check + lint | `npm run check` | `tsc -b` + `oxlint src` |
| Rust lint/format | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | |

### Local-only vs CI

CI (`validate.yml`, on every push/PR) runs: `npm audit --audit-level=high`, `npm run
check`, `npm run build`, rustsec `audit-check` for `src-tauri`, `cargo fmt --check`,
`cargo clippy -D warnings` in **both debug and release**, `cargo test --lib` (which covers
all 265 tests), and `cargo check` on Windows + macOS.

**CI never runs the JavaScript test suites** — the 49 vitest files and 3 `node --test`
suites execute locally only. They must be run before every push that touches `src/` or
`scripts/`. Release scripts also escape `tsc`/`oxlint` (both target `src/` only), so their
`node --test` suites are their only guard.

## Conventions

- **Rust**: tests live in-file under `#[cfg(test)]` (heavy modules use a sibling
  `tests.rs`, e.g. `pairing/tests.rs`, `store/tests.rs`). `tempfile` is the only
  dev-dependency. Security checks come with a negative test (feed it a hostile input,
  assert rejection) — required by `AGENTS.md`.
- **Frontend**: vitest, node environment by default; DOM tests opt in per file with
  `// @vitest-environment happy-dom`. No `@testing-library` — use the hand-rolled
  `src/test-utils/react.tsx` (`mount`/`click`/`typeInto`/`settle`) and
  `fakeWindow.ts`. Mock `@tauri-apps/api` via `vi.hoisted` + `vi.mock("../../shared/lib/api")`
  and invoke captured `listen` handlers to simulate backend events.
- **Scripts**: plain `node --test` (`scripts/*.test.mjs`), no build step.
- Every bug fix gets a regression test; every new security check gets a negative test
  that fails without it.

## Security invariant → test map

| Invariant (guard) | Guard code | Test(s) | Verdict |
| --- | --- | --- | --- |
| Local API requires bearer token (constant-time compare) | `bridge_api.rs:313-327` | `local_api_requires_bearer_token` (bridge_api.rs:392); `constant_time_equal_compares_accurately` (:383) | guards / partial (timing not testable) |
| Local API rejects DNS-rebinding hosts | `bridge_api.rs:122-130` | `host_validation_rejects_rebinding_hosts` (:411) | guards |
| Local API origin rules (no browser origins) | `bridge_api.rs:134-157` | `origin_validation_allows_native_and_same_origin` (:429) | guards |
| Local API rate limit before auth | `bridge_api.rs:27-32,176-184` | `local_api_rate_limits_per_client_ip` (:447); `idle_rate_limit_entries_are_pruned` (:476); `rate_limit_response_includes_retry_after` (:490) | guards |
| Local API security headers always win | `bridge_api.rs:100-117` | `security_headers_are_set_and_override_the_handler` (:524); `responses_carry_defensive_headers` (:503) | guards |
| Bridge stays off when token unreadable | `bridge_api.rs:34-92` | `controller_stays_off_and_reports_why_when_the_token_is_unavailable` (:361) | guards |
| IPC surface stays in sync (handler = build.rs = capabilities = frontend calls) | `lib.rs:96-152`, `build.rs:140-196`, `capabilities/*` | `app_commands_capabilities_and_frontend_stay_in_sync` (lib.rs:186-335; five-way cross-check incl. scanning every frontend `invoke()`) | guards |
| Sealed credential files (Android): plaintext never on disk, file↔account binding, fail-closed | `credential_file.rs` | `sealed_files_hide_the_plaintext_and_round_trip` (:202); `a_sealed_file_cannot_be_moved_to_another_account` (:244); `a_sealed_file_without_secure_storage_is_an_error_not_garbage` (:254); `plaintext_from_an_earlier_version_loads_and_is_upgraded` (:226); `directory_upgrade_counts_files_it_could_not_seal_and_retries_them` (:320) | guards |
| Chunked Credential Manager secrets survive Windows blob limits and crashes | `store/credentials/chunking.rs` | `large_provider_secret_round_trips_through_chunks` (store/tests.rs:258); `chunk_split_respects_utf16_surrogate_pairs` (:284); `recognizes_legacy_chunked_manifest` (:311) | guards |
| All app files owner-only (Unix modes; Windows SID validation) | `fs_util.rs` | `atomic_write_private_creates_owner_only_files` (fs_util.rs:265); `whoami_output_yields_only_a_well_formed_sid` (:253); `ensure_private_dir_is_owner_only` (:371); `account_metadata_files_are_owner_only` (store/tests.rs:53) | guards |
| Atomic writes never leave a file absent/corrupt | `fs_util.rs:203-245` | `atomic_replace_never_leaves_destination_absent` (fs_util.rs:294); `concurrent_updates_leave_the_latest_state_on_disk` (store/tests.rs:101); `a_failed_write_is_retried_by_the_next_change` (:146) | guards |
| Rotated secrets never lost on failed persist (cache dirty flag) | `store/credentials/cache.rs` | `failed_write_keeps_rotated_secret_and_retries` (store/tests.rs:444); `clean_read_does_not_overwrite_pending_secret` (:481) | guards |
| Account ids are plain tokens (they become filenames) | `store/mod.rs:30-41` | `account_ids_must_be_plain_tokens` (store/tests.rs:492); `invalid_account_ids_never_reach_credential_storage` (:511) | guards |
| Corrupt JSON quarantined, app keeps running | `state.rs:300-349` | `invalid_primary_accounts_fall_back_to_backup` (state.rs:422); `invalid_settings_are_quarantined_and_defaults_load` (:462); `tombstone_list_is_capped_and_a_corrupt_file_is_rebuilt` (store/tests.rs:218) | guards |
| Pairing keys: low-order rejection, AEAD tamper detection, SAS downgrade resistance | `pairing/crypto.rs` | `test_diffie_hellman_rejects_low_order_public_key` (pairing/tests.rs:117); `test_payload_encryption_and_tamper_detection` (:175); `test_confirmation_tags` (:126); `test_confirmation_tag_covers_the_full_code_and_rejects_the_legacy_prefix` (:86); `test_ephemeral_diffie_hellman_and_hkdf` (:41) | guards |
| SAS confirmation gates the transfer; rejection aborts both sides | `pairing/transport.rs:752-802` | `test_end_to_end_sas_rejection_aborts` (pairing/tests.rs:1546); `test_end_to_end_pairing_flow` (:1122) | guards |
| Pairing URIs: private-range IP literals only, size-bounded | `pairing/protocol.rs:44-70` | `test_qr_uri_parsing_and_formatting` (pairing/tests.rs:202); `oversized_pairing_uris_are_rejected_before_parsing` (protocol.rs:368) | guards |
| Imported accounts clamped, hostile ids re-minted, buckets remapped | `pairing/payload.rs`, `limits.rs` | `import_replaces_unsafe_peer_account_ids_with_local_ids` (:397); `import_bounds_peer_supplied_fields` (:461); `ui_state_clamp_bounds_lists_pages_and_text` (:544); `test_bucket_account_remapping_on_import` (:998) | guards |
| Credential replacement needs explicit single-use opt-in | `commands/pairing.rs:105-114` | `test_export_and_import_payload` (pairing/tests.rs:313) — backend only; **frontend has no test** | partial |
| Sender deletions never applied to receiver | `pairing/payload.rs:294-296` | `test_sender_deletion_does_not_remove_receiver_account` (:793); `test_live_retransfer_restores_locally_deleted_account` (:755) | guards |
| Join codes: 6 digits, weak codes rejected | `pairing/discovery.rs:22-61` | `join_code_is_six_digits` (:303); `rejects_simple_and_sequential_codes` (:320); `rejects_invalid_codes` (:329) | guards (lockout itself untested — see gaps) |
| Airgap frames verified, bounds enforced | `pairing/airgap.rs` | `test_airgap_roundtrip` (:351); `oversized_frame_submissions_are_rejected_before_parsing` (:338) | guards |
| OAuth PKCE (S256) + least-privilege scopes | `oauth.rs`, `oauth_common.rs` | `pkce_challenge_matches_the_rfc_7636_example` (oauth_common.rs:235); `anthropic_authorize_url_omits_unused_scopes` (oauth.rs:1331); `openai_authorize_url_identifies_this_app` (:1457) | guards |
| Authorization codes single-use; no replay after poll/abort | `oauth.rs:53,466-468` | `login_status_does_not_restore_authorization_code_after_poll` (:1562); `abort_login_resources_stops_server_and_drops_queued_code` (:1590) | guards |
| Refresh-token rotation + provider replies never echoed | `providers/oauth_refresh.rs` | `a_rotated_refresh_token_replaces_the_old_one_and_otherwise_it_is_kept` (:245); `unauthorized_and_forbidden_always_mean_sign_in_again` (:312); `an_unreadable_success_reply_is_reported_without_its_contents` (:370) | guards |
| Login WebView navigation host-allowlisted, HTTPS-only | `grok_login.rs:798-840`, `opencode_login.rs:618-633` | `login_window_navigation_is_host_allowlisted` (grok_login.rs:969); `xai_signin_host_check_uses_host_not_substring` (:993); `login_window_navigation_is_host_allowlisted` (opencode_login.rs:728); `detects_only_opencode_go_workspace_urls` (:693) | guards |
| OAuth callback pages escape messages (no XSS) | `oauth_common.rs` | `failure_page_escapes_the_message` (oauth_common.rs:254) | guards |
| Diagnostics/log redaction; report omits identity and secrets | `diagnostics.rs:232-470` | 11 tests at diagnostics.rs:499-703, incl. `bearer_tokens_…removed` (:499), `jwts_and_long_opaque_strings_are_removed` (:535), `the_report_lists_status_without_identity_or_secrets` (:632) | guards |
| Provider errors sanitized (no tokens/keys/URLs/bodies) | `usage.rs:356-378`, `providers/mod.rs:43-56` | `sanitize_error_message_keeps_only_plain_prose` (usage.rs:701); `test_sanitize_error_message` (:677); `rate_limit_message_never_echoes_the_raw_header` (providers/mod.rs:141); `grok_rpc_errors_are_sanitized_for_the_ui` (providers/grok.rs:953) | guards |
| Updater picks the right assets; GitHub down ≠ up-to-date | `updater.rs` | `expected_apk_asset_names_match_this_app` (:901); `sha256_digest_parses_common_checksum_files` (:911); `beta_listing_picks_the_newest_release_and_skips_drafts` (:836); `github_inaccessible_statuses_are_not_treated_as_success` (:944) | guards |
| Provider cookies reject header injection; ids validated; 401-only auth classification | `providers/grok.rs:365-461`, `providers/opencode_go.rs`, `providers/anthropic.rs` | `normalizes_cookie_headers_without_accepting_injection` (grok.rs:892); `normalizes_pasted_cookie_header` (opencode_go.rs:307); `validates_opencode_workspace_ids` (:325); `only_401_marks_anthropic_credentials_as_rejected` (anthropic.rs:407) | guards |
| Refresh serialization: no token-rotation/removal race; slots capped | `usage.rs:31-119`, `state.rs:244-287` | `timed_out_refresh_keeps_the_account_locked_until_the_task_finishes` (usage.rs:530); `remove_account_waits_for_an_in_flight_refresh` (state.rs:375); `refresh_slots_are_capped` (usage.rs:665) | guards |
| Auto-refresh backoff exponential, capped, jittered; Retry-After honored | `refresh_backoff.rs` | 5 tests at refresh_backoff.rs:92-133 | guards |
| Usage alerts dedup once per period | `alerts.rs:174-282` | `notifies_once_per_period_below_threshold` (alerts.rs:411) | guards |
| Imported accounts/limits clamped (NaN, ∞, oversized) | `limits.rs:103-121` | `imported_accounts_are_brought_within_bounds` (limits.rs:180); `ui_state_size_is_capped` (:218) | guards |
| Frontend QR decode sandboxed (size/scheme/payload caps) | `src/features/pairing/lib/qr-decoder.ts` | `qr-decoder.test.ts` | guards |
| Frontend QR SVGs sanitized | `src/features/pairing/lib/sanitizeSvg.ts` | `sanitizeSvg.test.ts` | guards |
| Frontend error details redacted before Copy Diagnostics | `src/shared/lib/errors.ts` | `errors.test.ts` | guards |
| Frontend SAS confirmation gates import (web UI) | `src/features/pairing/PairingModal.tsx` | `PairingModal.test.tsx` ("confirming the code" block, lines 330-423; air-gap import only after "Yes, They Match", :646) | guards |
| Frontend opens external URLs only through the allowlisted helper | `src/shared/lib/safeUrl.ts` | `AddAccountModal.test.tsx:92,189,217` assert routing through `openSafeUrl` — **the allowlist itself has no test file** | partial |

## Known coverage gaps

Ranked by how much the gap matters. A Pass 10 run should re-verify this list rather than
rediscover it.

1. **CI never runs `npm test` or the `node --test` suites.** All 52 JS test files are
   local-only; a broken test can merge unnoticed (validate.yml runs `check`/`build` only).
2. **Unguarded invariants** (guard exists, no test would fail if it were removed):
   - `/v1/paseo-usage` response sanitization and `schemaVersion: 1` stability — no handler-level test (bridge_api.rs).
   - Pre-auth pairing frame cap `MAX_PREAUTH_FRAME_SIZE` (protocol.rs:28) — never exercised.
   - Join-code 5-attempt lockout (pairing/mod.rs:520-535) — never exercised.
   - mDNS TXT record contents (only sid/pk/nonce/v, discovery.rs:113-118) — no test inspects what is advertised.
   - OAuth `state` mismatch rejection (oauth.rs:501) — no direct test.
   - Updater fail-closed on missing `.apk.sha256` (updater.rs:695-701) — no test.
   - Android APK max-size/redirect/magic-byte download rules (updater.rs:372,427,482-502) — no test.
   - `safeUrl.ts` host allowlist — no test file (only mocked usage).
   - PairingModal's credential-replace opt-in UI (`setAllowCredentialReplace`) — no frontend test (backend is covered).
   - Airgap decompression limit — the library's `decompress_to_vec_with_limit` is tested directly, but the production wiring (airgap.rs:313-316) is not.
3. **`commands/` has exactly one test** (commands/alerts.rs:117) across 55 command functions.
4. **Frontend screens with no dedicated tests**: `AccountsView`, `SettingsView`,
   `ApiIntegrationWindow`, `GoogleAiStudioUsageModal`, `BucketModal`, `AccountAlertModal`,
   plus `useDashboardData`/`useAppSettings` hooks (only indirectly exercised).
5. **No integration or E2E harness** (no `src-tauri/tests/`, no browser/device tests) and
   **no coverage tooling** on either side.
6. Modules with zero in-file tests (behavior partly covered from outside): `tray.rs`,
   `macos_notifications.rs`, `migrations.rs`, `backend.rs`, `apk_install.rs`,
   `android_keystore.rs`, `android_context.rs`, `camera_permission.rs`, `lan_binding.rs`,
   `store/credentials/{keyring_store,chunking,cache}.rs`, `pairing/{mod,transport}.rs`.
