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
| Release-script tests | `npm run test:resolve-version`, `test:release-notes`, `test:sidestore-source`, `test:updater-manifest`, `test:gemini-quota-probe` | 5 `node --test` suites in `scripts/` |
| Type check + lint | `npm run check` | `tsc -b` + `oxlint src` |
| Rust lint/format | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | |

### Local-only vs CI

CI (`validate.yml`, on every PR and as the gate at the start of each release; not on push, where `npm run preflight` is the local equivalent) runs: `npm audit --audit-level=high`, `npm run
check`, `npm test`, the 5 `npm run test:*` script suites, `npm run build`, rustsec
`audit-check` for `src-tauri`, `cargo fmt --check`, `cargo clippy -D warnings` in **both
debug and release**, `cargo test --lib` (which covers all 271 tests) on Windows + macOS, and `cargo check` on
Windows (macOS's non-test build is already compiled by the clippy job). Two further jobs only **compile** the library for the mobile targets
(`validate/ios-compile` on macOS, `validate/android-compile` on Linux with the release
build's NDK); no tests run there, since no device or emulator is available.

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
| Local API requires bearer token (constant-time compare, length hidden by hashing) | `bridge_api.rs:370-385` | `local_api_requires_bearer_token` (bridge_api/tests.rs:66); `constant_time_equal_compares_accurately` (bridge_api/tests.rs:57) | guards / partial (timing not testable) |
| Local API rejects DNS-rebinding hosts | `bridge_api.rs:129-130` | `host_validation_rejects_rebinding_hosts` (bridge_api/tests.rs:85) | guards |
| Local API origin rules (no browser origins) | `bridge_api.rs:171-198` | `origin_validation_allows_native_and_same_origin` (bridge_api/tests.rs:236) | guards |
| Local API rate limit, separate lanes for requests with and without the token | `bridge_api.rs:34-39,295-353` | `local_api_rate_limits_per_client_ip` (bridge_api/tests.rs:254); `bad_requests_cannot_use_up_the_token_holders_budget` (:527, fails with a single shared budget); `idle_rate_limit_entries_are_pruned` (bridge_api/tests.rs:343); `rate_limit_response_includes_retry_after` (bridge_api/tests.rs:362) | guards |
| Local API security headers always win | `bridge_api.rs:107-121` | `security_headers_are_set_and_override_the_handler` (bridge_api/tests.rs:396); `responses_carry_defensive_headers` (bridge_api/tests.rs:375) | guards |
| Bridge stays off when token unreadable | `bridge_api.rs:41-94` | `controller_stays_off_and_reports_why_when_the_token_is_unavailable` (bridge_api/tests.rs:35) | guards |
| IPC surface stays in sync (handler = build.rs = capabilities = frontend calls) | `lib.rs:93-143`, `build.rs:25-79`, `capabilities/*` | `app_commands_capabilities_and_frontend_stay_in_sync` (lib.rs:185-478; five-way cross-check incl. scanning every frontend `invoke()`, which must name its command as a double-quoted literal, and a check that every registered command has a frontend caller; the opener allowlist must equal `safeUrl.ts`; the bridge window must not call `invoke` directly) | guards |
| Backend JSON matches the frontend types (no missing, extra or wrongly nullable field) | `type_contract.rs`, `types.ts` | `backend_samples_fixture_is_current` (type_contract.rs); every sample in `types-contract.test.ts` (tsc checks it against its interface; rewrite the samples with `UPDATE_FIXTURES=1`) | guards |
| Sealed credential files (Android): plaintext never on disk, file↔account binding, fail-closed | `store/credential_file.rs` | `sealed_files_hide_the_plaintext_and_round_trip` (store/credential_file.rs:209); `a_sealed_file_cannot_be_moved_to_another_account` (store/credential_file.rs:251); `a_sealed_file_without_secure_storage_is_an_error_not_garbage` (store/credential_file.rs:261); `plaintext_from_an_earlier_version_loads_and_is_upgraded` (store/credential_file.rs:233); `directory_upgrade_counts_files_it_could_not_seal_and_retries_them` (store/credential_file.rs:329) | guards |
| Chunked Credential Manager secrets survive Windows blob limits and crashes | `store/credentials/chunking.rs` | `large_provider_secret_round_trips_through_chunks` (store/tests.rs:305); `chunk_split_respects_utf16_surrogate_pairs` (store/tests.rs:331); `recognizes_legacy_chunked_manifest` (store/tests.rs:358) | guards |
| All app files owner-only (Unix modes; Windows SID validation) | `platform/fs_util.rs` | `atomic_write_private_creates_owner_only_files` (platform/fs_util.rs:297); `whoami_output_yields_only_a_well_formed_sid` (platform/fs_util.rs:285); `hidden_command_still_returns_whoami_output` (:271, Windows); `ensure_private_dir_is_owner_only` (platform/fs_util.rs:403); `account_metadata_files_are_owner_only` (store/tests.rs:53) | guards |
| Atomic writes never leave a file absent/corrupt | `platform/fs_util.rs:193-259` | `atomic_replace_never_leaves_destination_absent` (platform/fs_util.rs:326); `concurrent_updates_leave_the_latest_state_on_disk` (store/tests.rs:101); `a_failed_write_is_retried_by_the_next_change` (store/tests.rs:146) | guards |
| Rotated secrets never lost on failed persist (cache dirty flag) | `store/credentials/cache.rs` | `failed_write_keeps_rotated_secret_and_retries` (store/tests.rs:491); `clean_read_does_not_overwrite_pending_secret` (store/tests.rs:528) | guards |
| Account ids are plain tokens (they become filenames) | `store/mod.rs:38-47` | `account_ids_must_be_plain_tokens` (store/tests.rs:539); `invalid_account_ids_never_reach_credential_storage` (store/tests.rs:558) | guards |
| Corrupt JSON quarantined, app keeps running | `state.rs:355-399` | `invalid_primary_accounts_fall_back_to_backup` (state/tests.rs:247); `invalid_settings_are_quarantined_and_defaults_load` (state/tests.rs:287); `tombstone_list_is_capped_and_a_corrupt_file_is_rebuilt` (store/tests.rs:218) | guards |
| Pairing keys: low-order rejection, AEAD tamper detection, SAS downgrade resistance | `pairing/crypto.rs` | `test_diffie_hellman_rejects_low_order_public_key` (pairing/tests.rs:117); `test_payload_encryption_and_tamper_detection` (pairing/tests.rs:175); `test_confirmation_tags` (pairing/tests.rs:126); `test_confirmation_tag_covers_the_full_code_and_rejects_the_legacy_prefix` (pairing/tests.rs:86); `test_ephemeral_diffie_hellman_and_hkdf` (pairing/tests.rs:41) | guards |
| SAS confirmation gates the transfer; rejection aborts both sides | `pairing/transport.rs:752-802` | `test_end_to_end_sas_rejection_aborts` (pairing/tests.rs:1609); `test_end_to_end_pairing_flow` (pairing/tests.rs:1185) | guards |
| Pairing host listens only on the advertised address, and only if it is a local-network address | `pairing/mod.rs` (`bind_pairing_listener`), `pairing/protocol.rs` (`is_allowed_pairing_host`) | `host_listener_binds_only_the_advertised_address` (pairing/tests.rs; refuses unparsable, unspecified, public, and unbindable addresses; fails with the old all-interfaces fallback) | guards |
| Pairing URIs: private-range IP literals only, size-bounded | `pairing/protocol.rs:44-70` | `test_qr_uri_parsing_and_formatting` (pairing/tests.rs:202); `oversized_pairing_uris_are_rejected_before_parsing` (pairing/protocol.rs:368) | guards |
| Imported accounts clamped, hostile ids re-minted, buckets remapped | `pairing/payload.rs`, `limits.rs` | `import_replaces_unsafe_peer_account_ids_with_local_ids` (pairing/tests.rs:391); `import_bounds_peer_supplied_fields` (pairing/tests.rs:455); `ui_state_clamp_bounds_lists_pages_and_text` (pairing/tests.rs:538); `test_bucket_account_remapping_on_import` (pairing/tests.rs:1060) | guards |
| Pairing never replaces an existing account's credentials | `pairing/payload.rs` (`apply_import`) | `import_never_overwrites_an_existing_accounts_local_credentials`, `import_keeps_credentials_when_only_the_account_id_matches`, `test_export_and_import_payload` (pairing/tests.rs) | guards |
| Sender deletions never applied to receiver | `pairing/payload.rs:305` | `test_sender_deletion_does_not_remove_receiver_account` (pairing/tests.rs:848); `test_live_retransfer_restores_locally_deleted_account` (pairing/tests.rs:810) | guards |
| Join codes: 6 digits, weak codes rejected | `pairing/discovery.rs:22-61` | `join_code_is_six_digits` (pairing/discovery.rs:398); `rejects_simple_and_sequential_codes` (pairing/discovery.rs:415); `rejects_invalid_codes` (pairing/discovery.rs:424) | guards (lockout itself untested — see gaps) |
| Pairing host picks its Wi-Fi/Ethernet address over cellular, VPN, and virtual interfaces | `pairing/transport.rs` (`select_lan_ipv4`) | `host_address_prefers_wifi_over_cellular_and_vpn` (pairing/tests.rs; iPhone `pdp_ip0` before `en0`, Android `rmnet`/`tun0` before `wlan0`) | guards |
| Link-code discovery interoperates between iOS (DNS-SD) and Android/desktop (mdns-sd) in all four host/joiner pairings, and the resolved address reaches the bound listener | `pairing/dnssd.rs`, `pairing/discovery.rs` | `link_code_interop::*` (pairing/tests.rs, macOS only, `#[ignore]`: needs a LAN address and mDNSResponder; run with `cargo test --lib pairing::tests::link_code -- --ignored --test-threads=1`); DNS-SD TXT bounds: `txt_decoding_tolerates_truncated_and_malformed_entries` (pairing/dnssd.rs) | guards (manual run) |
| Airgap frames verified, bounds enforced | `pairing/airgap.rs` | `test_airgap_roundtrip` (pairing/airgap.rs:377); `oversized_frame_submissions_are_rejected_before_parsing` (pairing/airgap.rs:364) | guards |
| OAuth PKCE (S256) + least-privilege scopes | `auth/oauth/`, `auth/oauth_common.rs` | `pkce_challenge_matches_the_rfc_7636_example` (auth/oauth_common.rs:596); `anthropic_authorize_url_omits_unused_scopes` (auth/oauth/tests.rs:198); `openai_authorize_url_identifies_this_app` (auth/oauth/tests.rs:348) | guards |
| Authorization codes single-use; no replay after poll/abort | `auth/oauth/` | `login_status_does_not_restore_authorization_code_after_poll` (auth/oauth/tests.rs:602); `abort_login_resources_stops_server_and_drops_queued_code` (auth/oauth/tests.rs:630) | guards |
| Refresh-token rotation + provider replies never echoed | `providers/oauth_refresh.rs` | `a_rotated_refresh_token_replaces_the_old_one_and_otherwise_it_is_kept` (providers/oauth_refresh.rs:279); `unauthorized_and_forbidden_always_mean_sign_in_again` (providers/oauth_refresh.rs:346); `an_unreadable_success_reply_is_reported_without_its_contents` (providers/oauth_refresh.rs:404) | guards |
| Login WebView navigation host-allowlisted, HTTPS-only | `auth/grok_login.rs:550-605`, `auth/opencode_login.rs:394-407` | `login_window_navigation_is_host_allowlisted` (auth/grok_login.rs:759); `xai_signin_host_check_uses_host_not_substring` (auth/grok_login.rs:789); `login_window_navigation_is_host_allowlisted` (auth/opencode_login.rs:690); `detects_only_opencode_go_workspace_urls` (auth/opencode_login.rs:655) | guards |
| Android IPC carries the sending frame's own origin; the origin-blind `ipc` interface is refused and inert; fails closed | `webview_ipc_patch.rs:26-101` (applied by `build.rs`) | `webview_blocks_the_javascript_interface_and_installs_the_listener` (webview_ipc_patch.rs:126); `webview_listener_fails_closed` (webview_ipc_patch.rs:142); `legacy_interface_no_longer_forwards_the_navigation_url` (webview_ipc_patch.rs:111); `webview_ipc_patch_applies_to_generated_kotlin` (:165, fails if a regenerated template no longer matches) | guards the patch text; **behaviour on a device is not covered** |
| Android update downloads stay on this repo's GitHub releases; release tags are URL-safe | `updater/github.rs:18-44,78-160, updater/android.rs:60-81,111-135` | `release_asset_urls_must_be_this_repos_github_releases` (updater/tests.rs:268); `apk_assets_hosted_elsewhere_are_ignored` (updater/tests.rs:287); `update_redirects_stay_on_github_download_hosts` (updater/tests.rs:304); `update_download_client_refuses_a_redirect_off_github` (:1158, real client against a local redirecting server); `release_tags_are_checked_before_they_go_into_urls` (updater/tests.rs:352) | guards (tag check wiring in `fetch_github_latest_release` is not exercised: network) |
| Android update installs only from the installed app's current signer | `UpdateSigners.kt`, `MainActivity.kt:657-680` | `UpdateSignersTest` (JVM; `./gradlew :app:testUniversalDebugUnitTest`) | guards the matching rule; reading `apkContentsSigners` rather than history is verified by reading only; **not run in CI** |
| Android back on the sign-in "Account connected" page returns to the dashboard, never to earlier login pages (loopback redirects with no "callback" in the path included) | `SignInPages.kt`, `MainActivity.kt` back callback, `set_android_sign_in_result_showing` in `mobile_auth.rs` | `SignInPagesTest` (JVM; `./gradlew :app:testUniversalDebugUnitTest`) | guards the page-recognition rule; the back gesture itself is verified by hand on a device; **not run in CI** |
| Release workflows: no `${{ }}` in run scripts; lockfile-locked installs; unsigned desktop releases refused; macOS signing is all-or-nothing (full Apple secret set signs and notarizes, none falls back to ad-hoc, partial fails); only release APKs signed | `.github/workflows/*.yml` | `scripts/workflow-guards.test.mjs` (`npm run test:workflows`, in `validate.yml`): runs the real signing-key, macOS signing, and APK-signing scripts against fixtures | guards |
| Bridge token reveal and air-gapped export need a native confirmation first | `confirm.rs`, `commands/bridge.rs:92-108`, `commands/pairing.rs:109-138` | `a_declined_confirmation_never_runs_the_action` (confirm.rs:78); `a_confirmed_action_runs_once` (confirm.rs:90); `both_secret_commands_ask_before_returning_secrets` (:104; source check, fails if either command reaches its secret before `confirm::ask`) | guards the ordering; **the dialog itself is not exercised in tests** |
| Mobile main window stays on the app and sign-in pages | `auth/signin_navigation.rs` | `the_app_itself_is_always_allowed`; `nothing_else_loads_in_the_app_window_outside_sign_in`; `during_sign_in_only_sign_in_pages_and_the_callback_load` | guards the rule; **the hook's wiring and real provider sign-ins are not exercised in tests** |
| OAuth callbacks ignore requests without the attempt's state | `auth/oauth/` (`handle_callback`), `auth/google_ai_studio_oauth.rs` (`callback`) | `a_callback_without_this_attempts_state_changes_nothing` (auth/oauth/; fails without the early state check); `a_callback_without_this_attempts_state_leaves_the_sign_in_running` (auth/google_ai_studio_oauth.rs) | guards |
| OAuth callback pages escape messages (no XSS) | `auth/oauth_common.rs` | `failure_page_escapes_the_message` (auth/oauth_common.rs:615) | guards |
| Diagnostics/log redaction; report omits identity and secrets; command errors redacted and capped | `diagnostics.rs:232-490` | 13 tests at diagnostics/tests.rs:5-253, incl. `bearer_tokens_and_authorization_headers_are_removed` (diagnostics/tests.rs:5), `command_errors_hide_home_folders_and_are_capped` (diagnostics/tests.rs:33), `oauth_callback_code_and_state_are_removed_from_urls` (:567; fails without the query-parameter rule), `jwts_and_long_opaque_strings_are_removed` (diagnostics/tests.rs:84), `the_report_lists_status_without_identity_or_secrets` (diagnostics/tests.rs:181) | guards |
| Provider errors sanitized (no tokens/keys/URLs/bodies) | `usage.rs:358-379`, `providers/mod.rs:45-56` | `sanitize_error_message_keeps_only_plain_prose` (usage/tests.rs:347); `test_sanitize_error_message` (usage/tests.rs:323); `rate_limit_message_never_echoes_the_raw_header` (providers/mod.rs:265); `grok_rpc_errors_are_sanitized_for_the_ui` (providers/grok/tests.rs:119) | guards |
| Updater picks the right assets; GitHub down ≠ up-to-date | `updater/` | `expected_apk_asset_names_match_this_app` (updater/tests.rs:151); `sha256_digest_parses_common_checksum_files` (updater/tests.rs:161); `beta_listing_picks_the_newest_release_and_skips_drafts` (updater/tests.rs:86); `github_inaccessible_statuses_are_not_treated_as_success` (updater/tests.rs:194) | guards |
| Provider cookies reject header injection; ids validated; 401-only auth classification | `providers/grok/mod.rs:229-380`, `providers/opencode_go.rs`, `providers/anthropic.rs` | `normalizes_cookie_headers_without_accepting_injection` (providers/grok/tests.rs:58); `bot_usage_validates_relay_host_cookies_and_bounds` (providers/grok/tests.rs:294); `normalizes_pasted_cookie_header` (providers/opencode_go.rs:444); `validates_opencode_workspace_ids` (providers/opencode_go.rs:462); `only_401_marks_anthropic_credentials_as_rejected` (providers/anthropic.rs:400) | guards |
| Refresh serialization: no token-rotation/removal race; rotated secret saved even after a timeout; slots capped | `usage.rs:31-133`, `state.rs:264-340` | `timed_out_refresh_keeps_the_account_locked_until_the_task_finishes` (usage/tests.rs:139); `timed_out_refresh_still_saves_the_rotated_secret` (usage/tests.rs:172); `refresh_does_not_resurrect_credentials_of_a_removed_account` (usage/tests.rs:207); `remove_account_waits_for_an_in_flight_refresh` (state/tests.rs:200); `refresh_slots_are_capped` (usage/tests.rs:311) | guards |
| Login status changes only while the attempt is still waiting (a finished sign-in is never overwritten as failed; check and write share one lock) | `state.rs:214-278`, `model.rs` `LoginState` | `a_racing_finish_and_failure_never_both_win` (state/tests.rs:145); `fail_login_if_waiting_never_overwrites_a_finished_or_other_attempt` (state/tests.rs:123); `fail_login_if_waiting_fails_only_the_waiting_attempt` (state/tests.rs:106); `login_state_matches_the_frontend_union` (state/tests.rs:177) | guards |
| Auto-refresh backoff exponential, capped, jittered; Retry-After honored | `refresh_backoff.rs` | 5 tests at refresh_backoff.rs:92-133 | guards |
| Usage alerts dedup once per period | `store/alerts.rs:148-279` | `notifies_once_per_period_below_threshold` (store/alerts/tests.rs:41) | guards |
| Imported accounts/limits clamped (NaN, ∞, oversized) | `limits.rs:103-121` | `imported_accounts_are_brought_within_bounds` (limits.rs:181); `ui_state_size_is_capped` (limits.rs:219) | guards |
| Frontend QR decode sandboxed (size/scheme/payload caps) | `src/features/pairing/lib/qr-decoder.ts` | `qr-decoder.test.ts` | guards |
| Frontend QR SVGs sanitized | `src/features/pairing/lib/sanitizeSvg.ts` | `sanitizeSvg.test.ts` | guards |
| Frontend error details redacted before Copy Diagnostics | `src/shared/lib/errors.ts` | `errors.test.ts` | guards |
| Frontend SAS confirmation gates import (web UI) | `src/features/pairing/PairingModal.tsx` | `PairingModal.test.tsx` ("confirming the code" block, lines 330-423; air-gap import only after "Yes, They Match", :646) | guards |
| Frontend opens external URLs only through the allowlisted helper | `src/shared/lib/safeUrl.ts` | `safeUrl.test.ts` (allowed sign-in and repo URLs; refused schemes, hosts, repos, traversal, userinfo, ports; no opener call when refused); `AddAccountModal.test.tsx:92,189,217` assert routing through `openSafeUrl` | guards |
| Android update-notice intent accepts only a version | `updater/mod.rs:114-146` | `update_notice_accepts_only_version_shaped_values` (updater/tests.rs:373) | guards the validator; the JNI wiring is Android-only |
| Sign-in failure messages do not echo provider replies | `auth/oauth/`, `auth/google_ai_studio_oauth.rs` | `login_response_parse_errors_do_not_echo_the_reply` (auth/oauth/tests.rs:769; source scan, fails on a `{error}` in a parse message) | guards |
| Windows start-at-login command quotes the executable path | `platform/autostart.rs:1-54` | `the_windows_autostart_command_quotes_a_path_with_spaces` (platform/autostart.rs:61) | guards the formatting; **the registry rewrite is Windows-only and untested here** |

## Known coverage gaps

Ranked by how much the gap matters. A Pass 10 run should re-verify this list rather than
rediscover it.

1. **Unguarded invariants** (guard exists, no test would fail if it were removed):
   - `/v1/paseo-usage` response sanitization and `schemaVersion: 1` stability — no handler-level test (bridge_api.rs).
   - Pre-auth pairing frame cap `MAX_PREAUTH_FRAME_SIZE` (pairing/protocol.rs:28) — never exercised.
   - Join-code 5-attempt lockout (pairing/mod.rs:520-535) — never exercised.
   - mDNS TXT record contents (only sid/pk/nonce/v, pairing/discovery.rs:113-118) — no test inspects what is advertised.
   - OAuth `state` mismatch rejection (auth/oauth/desktop_window.rs:195) — no direct test.
   - Updater fail-closed on missing `.apk.sha256` (updater/mod.rs:180-186) — no test.
   - Android APK max-size and magic-byte download rules (updater/) — no test. (The host and redirect rules are covered; see the map above.)
   - Airgap decompression limit — the library's `decompress_to_vec_with_limit` is tested directly, but the production wiring (pairing/airgap.rs:313-316) is not.
2. **`commands/` has exactly one test** (commands/alerts.rs:117) across 55 command functions.
3. **Frontend screens with no dedicated tests**: `SettingsView`,
   `ApiIntegrationWindow`, `GoogleAiStudioUsageModal`, `BucketModal`, `AccountAlertModal`,
   plus the `useAppSettings` hook (only indirectly exercised; `useDashboardData`, `useAppUpdate` and `useAccountActions` now have direct tests).
   `AccountsView` covers the empty-dashboard Link Devices / Other Provider actions.
4. **No integration or E2E harness** (no `src-tauri/tests/`, no browser/device tests) and
   **no coverage tooling** on either side.
5. Modules with zero in-file tests (behavior partly covered from outside): `platform/tray.rs`,
   `platform/macos_notifications.rs`, `migrations.rs`, `backend.rs`, `platform/apk_install.rs`,
   `platform/android_keystore.rs`, `platform/android_context.rs`, `platform/camera_permission.rs`, `platform/lan_binding.rs`,
   `store/credentials/{keyring_store,chunking,cache}.rs`, `pairing/{mod,transport}.rs`.
