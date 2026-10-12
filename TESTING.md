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
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` | 271 `#[test]`/`#[tokio::test]` in 38 files (all lib unit tests; no `src-tauri/tests/` integration dir, no doc tests) |
| Release-script tests | `npm run test:resolve-version`, `test:sidestore-source`, `test:gemini-quota-probe` | 3 `node --test` suites in `scripts/` (30 tests) |
| Type check + lint | `npm run check` | `tsc -b` + `oxlint src` |
| Rust lint/format | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | |

### Local-only vs CI

CI (`validate.yml`, on every push/PR) runs: `npm audit --audit-level=high`, `npm run
check`, `npm test`, the 3 `npm run test:*` script suites, `npm run build`, rustsec
`audit-check` for `src-tauri`, `cargo fmt --check`, `cargo clippy -D warnings` in **both
debug and release**, `cargo test --lib` (which covers all 271 tests), and `cargo check` on
Windows + macOS.

The JavaScript suites run on Linux only (`validate/frontend`). Release scripts escape
`tsc`/`oxlint` (both target `src/` only), so their `node --test` suites are their only
guard.

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
| Local API requires bearer token (constant-time compare, length hidden by hashing) | `bridge_api.rs:337-353` | `local_api_requires_bearer_token` (bridge_api.rs:418); `constant_time_equal_compares_accurately` (:409) | guards / partial (timing not testable) |
| Local API rejects DNS-rebinding hosts | `bridge_api.rs:123-133` | `host_validation_rejects_rebinding_hosts` (:437) | guards |
| Local API origin rules (no browser origins) | `bridge_api.rs:135-170` | `origin_validation_allows_native_and_same_origin` (:455) | guards |
| Local API rate limit, separate lanes for requests with and without the token | `bridge_api.rs:28-33,262-325` | `local_api_rate_limits_per_client_ip` (:473); `bad_requests_cannot_use_up_the_token_holders_budget` (:527, fails with a single shared budget); `idle_rate_limit_entries_are_pruned` (:562); `rate_limit_response_includes_retry_after` (:581) | guards |
| Local API security headers always win | `bridge_api.rs:101-118` | `security_headers_are_set_and_override_the_handler` (:615); `responses_carry_defensive_headers` (:594) | guards |
| Bridge stays off when token unreadable | `bridge_api.rs:35-93` | `controller_stays_off_and_reports_why_when_the_token_is_unavailable` (:387) | guards |
| IPC surface stays in sync (handler = build.rs = capabilities = frontend calls) | `lib.rs:96-152`, `build.rs:140-196`, `capabilities/*` | `app_commands_capabilities_and_frontend_stay_in_sync` (lib.rs:196-392; five-way cross-check incl. scanning every frontend `invoke()`, which must name its command as a double-quoted literal; the opener allowlist must equal `safeUrl.ts`; the bridge window must not call `invoke` directly) | guards |
| Sealed credential files (Android): plaintext never on disk, file↔account binding, fail-closed | `credential_file.rs` | `sealed_files_hide_the_plaintext_and_round_trip` (:202); `a_sealed_file_cannot_be_moved_to_another_account` (:244); `a_sealed_file_without_secure_storage_is_an_error_not_garbage` (:254); `plaintext_from_an_earlier_version_loads_and_is_upgraded` (:226); `directory_upgrade_counts_files_it_could_not_seal_and_retries_them` (:320) | guards |
| Chunked Credential Manager secrets survive Windows blob limits and crashes | `store/credentials/chunking.rs` | `large_provider_secret_round_trips_through_chunks` (store/tests.rs:258); `chunk_split_respects_utf16_surrogate_pairs` (:284); `recognizes_legacy_chunked_manifest` (:311) | guards |
| All app files owner-only (Unix modes; Windows SID validation) | `fs_util.rs` | `atomic_write_private_creates_owner_only_files` (fs_util.rs:265); `whoami_output_yields_only_a_well_formed_sid` (:253); `ensure_private_dir_is_owner_only` (:371); `account_metadata_files_are_owner_only` (store/tests.rs:53) | guards |
| Atomic writes never leave a file absent/corrupt | `fs_util.rs:203-245` | `atomic_replace_never_leaves_destination_absent` (fs_util.rs:294); `concurrent_updates_leave_the_latest_state_on_disk` (store/tests.rs:101); `a_failed_write_is_retried_by_the_next_change` (:146) | guards |
| Rotated secrets never lost on failed persist (cache dirty flag) | `store/credentials/cache.rs` | `failed_write_keeps_rotated_secret_and_retries` (store/tests.rs:444); `clean_read_does_not_overwrite_pending_secret` (:481) | guards |
| Account ids are plain tokens (they become filenames) | `store/mod.rs:30-41` | `account_ids_must_be_plain_tokens` (store/tests.rs:492); `invalid_account_ids_never_reach_credential_storage` (:511) | guards |
| Corrupt JSON quarantined, app keeps running | `state.rs:336-385` | `invalid_primary_accounts_fall_back_to_backup` (state.rs:566); `invalid_settings_are_quarantined_and_defaults_load` (:606); `tombstone_list_is_capped_and_a_corrupt_file_is_rebuilt` (store/tests.rs:218) | guards |
| Pairing keys: low-order rejection, AEAD tamper detection, SAS downgrade resistance | `pairing/crypto.rs` | `test_diffie_hellman_rejects_low_order_public_key` (pairing/tests.rs:117); `test_payload_encryption_and_tamper_detection` (:175); `test_confirmation_tags` (:126); `test_confirmation_tag_covers_the_full_code_and_rejects_the_legacy_prefix` (:86); `test_ephemeral_diffie_hellman_and_hkdf` (:41) | guards |
| SAS confirmation gates the transfer; rejection aborts both sides | `pairing/transport.rs:752-802` | `test_end_to_end_sas_rejection_aborts` (pairing/tests.rs:1546); `test_end_to_end_pairing_flow` (:1122) | guards |
| Pairing host listens only on the advertised address | `pairing/mod.rs:544-555` | `host_listener_binds_only_the_advertised_address` (pairing/tests.rs:1633) | guards (fallback to all interfaces when that address can't be bound) |
| Pairing URIs: private-range IP literals only, size-bounded | `pairing/protocol.rs:44-70` | `test_qr_uri_parsing_and_formatting` (pairing/tests.rs:202); `oversized_pairing_uris_are_rejected_before_parsing` (protocol.rs:368) | guards |
| Imported accounts clamped, hostile ids re-minted, buckets remapped | `pairing/payload.rs`, `limits.rs` | `import_replaces_unsafe_peer_account_ids_with_local_ids` (:397); `import_bounds_peer_supplied_fields` (:461); `ui_state_clamp_bounds_lists_pages_and_text` (:544); `test_bucket_account_remapping_on_import` (:998) | guards |
| Credential replacement needs explicit single-use opt-in | `commands/pairing.rs:105-114` | `test_export_and_import_payload` (pairing/tests.rs:313) — backend only; **frontend has no test** | partial |
| Sender deletions never applied to receiver | `pairing/payload.rs:294-296` | `test_sender_deletion_does_not_remove_receiver_account` (:793); `test_live_retransfer_restores_locally_deleted_account` (:755) | guards |
| Join codes: 6 digits, weak codes rejected | `pairing/discovery.rs:22-61` | `join_code_is_six_digits` (:303); `rejects_simple_and_sequential_codes` (:320); `rejects_invalid_codes` (:329) | guards (lockout itself untested — see gaps) |
| Airgap frames verified, bounds enforced | `pairing/airgap.rs` | `test_airgap_roundtrip` (:351); `oversized_frame_submissions_are_rejected_before_parsing` (:338) | guards |
| OAuth PKCE (S256) + least-privilege scopes | `oauth.rs`, `oauth_common.rs` | `pkce_challenge_matches_the_rfc_7636_example` (oauth_common.rs:231); `anthropic_authorize_url_omits_unused_scopes` (oauth.rs:1295); `openai_authorize_url_identifies_this_app` (:1421) | guards |
| Authorization codes single-use; no replay after poll/abort | `oauth.rs:55,455-457` | `login_status_does_not_restore_authorization_code_after_poll` (:1526); `abort_login_resources_stops_server_and_drops_queued_code` (:1554) | guards |
| Refresh-token rotation + provider replies never echoed | `providers/oauth_refresh.rs` | `a_rotated_refresh_token_replaces_the_old_one_and_otherwise_it_is_kept` (:245); `unauthorized_and_forbidden_always_mean_sign_in_again` (:312); `an_unreadable_success_reply_is_reported_without_its_contents` (:370) | guards |
| Login WebView navigation host-allowlisted, HTTPS-only | `grok_login.rs:779-821`, `opencode_login.rs:600-615` | `login_window_navigation_is_host_allowlisted` (grok_login.rs:914); `xai_signin_host_check_uses_host_not_substring` (:938); `login_window_navigation_is_host_allowlisted` (opencode_login.rs:680); `detects_only_opencode_go_workspace_urls` (:645) | guards |
| Android IPC carries the sending frame's own origin; the origin-blind `ipc` interface is refused and inert; fails closed | `webview_ipc_patch.rs:26-101` (applied by `build.rs`) | `webview_blocks_the_javascript_interface_and_installs_the_listener` (:126); `webview_listener_fails_closed` (:142); `legacy_interface_no_longer_forwards_the_navigation_url` (:111); `webview_ipc_patch_applies_to_generated_kotlin` (:165, fails if a regenerated template no longer matches) | guards the patch text; **behaviour on a device is not covered** |
| Android update downloads stay on this repo's GitHub releases; release tags are URL-safe | `updater.rs:26-87,198-248,409-432,493-520` | `release_asset_urls_must_be_this_repos_github_releases` (updater.rs:1097); `apk_assets_hosted_elsewhere_are_ignored` (:1116); `update_redirects_stay_on_github_download_hosts` (:1133); `update_download_client_refuses_a_redirect_off_github` (:1158, real client against a local redirecting server); `release_tags_are_checked_before_they_go_into_urls` (:1181) | guards (tag check wiring in `fetch_github_latest_release` is not exercised: network) |
| Android update installs only from the installed app's current signer | `UpdateSigners.kt`, `MainActivity.kt:657-680` | `UpdateSignersTest` (JVM; `./gradlew :app:testUniversalDebugUnitTest`) | guards the matching rule; reading `apkContentsSigners` rather than history is verified by reading only; **not run in CI** |
| Release workflows: no `${{ }}` in run scripts; lockfile-locked installs; unsigned desktop releases refused; only release APKs signed | `.github/workflows/*.yml` | `scripts/workflow-guards.test.mjs` (`npm run test:workflows`, in `validate.yml`): runs the real signing-key and APK-signing scripts against fixtures | guards |
| OAuth callback pages escape messages (no XSS) | `oauth_common.rs` | `failure_page_escapes_the_message` (oauth_common.rs:250) | guards |
| Diagnostics/log redaction; report omits identity and secrets; command errors redacted and capped | `diagnostics.rs:232-490` | 13 tests at diagnostics.rs:521-769, incl. `bearer_tokens_and_authorization_headers_are_removed` (:521), `command_errors_hide_home_folders_and_are_capped` (:549), `oauth_callback_code_and_state_are_removed_from_urls` (:567; fails without the query-parameter rule), `jwts_and_long_opaque_strings_are_removed` (:600), `the_report_lists_status_without_identity_or_secrets` (:697) | guards |
| Provider errors sanitized (no tokens/keys/URLs/bodies) | `usage.rs:356-378`, `providers/mod.rs:43-56` | `sanitize_error_message_keeps_only_plain_prose` (usage.rs:701); `test_sanitize_error_message` (:677); `rate_limit_message_never_echoes_the_raw_header` (providers/mod.rs:141); `grok_rpc_errors_are_sanitized_for_the_ui` (providers/grok.rs:953) | guards |
| Updater picks the right assets; GitHub down ≠ up-to-date | `updater.rs` | `expected_apk_asset_names_match_this_app` (:901); `sha256_digest_parses_common_checksum_files` (:911); `beta_listing_picks_the_newest_release_and_skips_drafts` (:836); `github_inaccessible_statuses_are_not_treated_as_success` (:944) | guards |
| Provider cookies reject header injection; ids validated; 401-only auth classification | `providers/grok.rs:365-461`, `providers/opencode_go.rs`, `providers/anthropic.rs` | `normalizes_cookie_headers_without_accepting_injection` (grok.rs:892); `normalizes_pasted_cookie_header` (opencode_go.rs:307); `validates_opencode_workspace_ids` (:325); `only_401_marks_anthropic_credentials_as_rejected` (anthropic.rs:407) | guards |
| Refresh serialization: no token-rotation/removal race; rotated secret saved even after a timeout; slots capped | `usage.rs:31-133`, `state.rs:280-323` | `timed_out_refresh_keeps_the_account_locked_until_the_task_finishes` (usage.rs:572); `timed_out_refresh_still_saves_the_rotated_secret` (:605); `refresh_does_not_resurrect_credentials_of_a_removed_account` (:640); `remove_account_waits_for_an_in_flight_refresh` (state.rs:519); `refresh_slots_are_capped` (usage.rs:746) | guards |
| Login status changes only while the attempt is still waiting (a finished sign-in is never overwritten as failed; check and write share one lock) | `state.rs:220-259`, `model.rs` `LoginState` | `a_racing_finish_and_failure_never_both_win` (state.rs:464); `fail_login_if_waiting_never_overwrites_a_finished_or_other_attempt` (:442); `fail_login_if_waiting_fails_only_the_waiting_attempt` (:425); `login_state_matches_the_frontend_union` (:496) | guards |
| Auto-refresh backoff exponential, capped, jittered; Retry-After honored | `refresh_backoff.rs` | 5 tests at refresh_backoff.rs:92-133 | guards |
| Usage alerts dedup once per period | `alerts.rs:174-282` | `notifies_once_per_period_below_threshold` (alerts.rs:411) | guards |
| Imported accounts/limits clamped (NaN, ∞, oversized) | `limits.rs:103-121` | `imported_accounts_are_brought_within_bounds` (limits.rs:180); `ui_state_size_is_capped` (:218) | guards |
| Frontend QR decode sandboxed (size/scheme/payload caps) | `src/features/pairing/lib/qr-decoder.ts` | `qr-decoder.test.ts` | guards |
| Frontend QR SVGs sanitized | `src/features/pairing/lib/sanitizeSvg.ts` | `sanitizeSvg.test.ts` | guards |
| Frontend error details redacted before Copy Diagnostics | `src/shared/lib/errors.ts` | `errors.test.ts` | guards |
| Frontend SAS confirmation gates import (web UI) | `src/features/pairing/PairingModal.tsx` | `PairingModal.test.tsx` ("confirming the code" block, lines 330-423; air-gap import only after "Yes, They Match", :646) | guards |
| Frontend opens external URLs only through the allowlisted helper | `src/shared/lib/safeUrl.ts` | `safeUrl.test.ts` (allowed sign-in and repo URLs; refused schemes, hosts, repos, traversal, userinfo, ports; no opener call when refused); `AddAccountModal.test.tsx:92,189,217` assert routing through `openSafeUrl` | guards |
| Android update-notice intent accepts only a version | `updater.rs:657-690` | `update_notice_accepts_only_version_shaped_values` (updater.rs:1229) | guards the validator; the JNI wiring is Android-only |
| Sign-in failure messages do not echo provider replies | `oauth.rs`, `google_ai_studio_oauth.rs` | `login_response_parse_errors_do_not_echo_the_reply` (oauth.rs:1693; source scan, fails on a `{error}` in a parse message) | guards |
| Windows start-at-login command quotes the executable path | `autostart.rs:1-55` | `the_windows_autostart_command_quotes_a_path_with_spaces` (autostart.rs:61) | guards the formatting; **the registry rewrite is Windows-only and untested here** |

## Known coverage gaps

Ranked by how much the gap matters. A Pass 10 run should re-verify this list rather than
rediscover it.

1. **Unguarded invariants** (guard exists, no test would fail if it were removed):
   - `/v1/paseo-usage` response sanitization and `schemaVersion: 1` stability — no handler-level test (bridge_api.rs).
   - Pre-auth pairing frame cap `MAX_PREAUTH_FRAME_SIZE` (protocol.rs:28) — never exercised.
   - Join-code 5-attempt lockout (pairing/mod.rs:520-535) — never exercised.
   - mDNS TXT record contents (only sid/pk/nonce/v, discovery.rs:113-118) — no test inspects what is advertised.
   - OAuth `state` mismatch rejection (oauth.rs:486) — no direct test.
   - Updater fail-closed on missing `.apk.sha256` (updater.rs:774-782) — no test.
   - Android APK max-size and magic-byte download rules (updater.rs:448,520-585) — no test. (The host and redirect rules are covered; see the map above.)
   - PairingModal's credential-replace opt-in UI (`setAllowCredentialReplace`) — no frontend test (backend is covered).
   - Airgap decompression limit — the library's `decompress_to_vec_with_limit` is tested directly, but the production wiring (airgap.rs:313-316) is not.
2. **`commands/` has exactly one test** (commands/alerts.rs:117) across 55 command functions.
3. **Frontend screens with no dedicated tests**: `AccountsView`, `SettingsView`,
   `ApiIntegrationWindow`, `GoogleAiStudioUsageModal`, `BucketModal`, `AccountAlertModal`,
   plus `useDashboardData`/`useAppSettings` hooks (only indirectly exercised).
4. **No integration or E2E harness** (no `src-tauri/tests/`, no browser/device tests) and
   **no coverage tooling** on either side.
5. Modules with zero in-file tests (behavior partly covered from outside): `tray.rs`,
   `macos_notifications.rs`, `migrations.rs`, `backend.rs`, `apk_install.rs`,
   `android_keystore.rs`, `android_context.rs`, `camera_permission.rs`, `lan_binding.rs`,
   `store/credentials/{keyring_store,chunking,cache}.rs`, `pairing/{mod,transport}.rs`.
