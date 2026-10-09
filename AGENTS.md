# Repository guidance

This is a standalone Windows/macOS Tauri application. Keep account authentication, token refresh, quota retrieval, and secure storage inside the Rust backend. The React frontend must receive only sanitized account and usage data.

Before changing behavior:

1. Identify whether the change affects OAuth, credential storage, usage normalization, local API compatibility, or desktop packaging.
2. Keep the versioned local API backward-compatible whenever possible.
3. Never log or expose OAuth access tokens, refresh tokens, ID tokens, authorization codes, or raw OpenAI responses.
4. Do not add a secondary usage endpoint without an explicit product decision.
5. Do not introduce dependencies on external coding CLIs.

Changelog:

- Read `docs/CHANGELOG_WORKFLOW.md` before completing a pull request.
- Every user-visible change must update `CHANGELOG.md` under `## Unreleased` in the same pull request.
- Always keep item counts up to date in parentheses next to each category header (e.g. `### Security (4)`) and total items next to the release header (e.g. `## Unreleased (111 items)`).
- When there is no user-facing change, leave `CHANGELOG.md` unchanged and state `No user-facing change` in the pull request description.

Android APK & iOS SideStore builds:

- Do not build a new APK or iOS build automatically; only build when explicitly instructed by the user.
- When asked to build an APK containing code for an unreleased version, increment the latest release version by `0.0.1` and append `-unrel` to the version number (e.g. if the latest release on GitHub is `0.3.5`, name the APK `AI Usage Tracker_0.3.6-unrel.apk`).
- This machine is disk-constrained. Android builds must target aarch64 only: use `npm run android:build` (APK) or `npm run android:dev` (emulator). Never run `cargo tauri android build` without `--target aarch64`, and do not suggest `cargo clean` casually (~8G build cache; full recompile is very slow).
- iOS builds require Xcode which is not installed locally to save disk (~21G available). Build unsigned IPAs via GitHub Actions (`.github/workflows/build-ios.yml`).
- Automated multi-platform releases run via `.github/workflows/build-installers.yml`: Windows and Android build on both Thursdays and Sundays @ 11:59 PM EST (04:59 UTC), while expensive Apple builds (macOS desktop and iOS SideStore IPA) build only once a week on Sundays @ 11:59 PM EST. A pre-flight `check-changes` job checks whether new commits exist since the last release tag and skips execution if no changes were committed, preserving GitHub runner quota.
- `src-tauri/gen/apple` is generated on a macOS runner by the manual "Generate iOS project" workflow (`.github/workflows/init-ios-project.yml`), which commits it. Re-run it after a Tauri CLI upgrade or a bundle ID / `Info.ios.plist` change and review the diff. `tauri ios init` cannot run on this machine (no Xcode), so do not run it locally.
- SideStore source manifest is at `sidestore-source.json`. Use `npm run update:sidestore` (`node scripts/update-sidestore-source.mjs`) to refresh release asset sizes and URLs.
- Gradle needs the Homebrew JDK. `npm run android:dev` / `android:build` already set `JAVA_HOME` to `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`. If you invoke Gradle or `tauri android` directly, export that same `JAVA_HOME` first.

Security audits:

- Follow `docs/AUDIT_PROTOCOL.md` when asked to audit or review the app. Audits are read-only, every claim needs `file:line` evidence, and reports go in the gitignored `.audits/` directory, never into the repository.
- `docs/THREAT_MODEL.md` is the Pass 0 inventory of assets, entry points, and the code that guards them. Update it whenever you add an entry point (a new command, listener, WebView, deep link, provider endpoint, or file the app writes).
- For every change, identify which trust boundary it touches (see Pass 0 of the protocol), validate arguments on the Rust side, and add a negative test for each security check you add.

Validation:

```bash
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The full test inventory and the security-invariant → test map live in `TESTING.md`. CI does not run the JavaScript test suites — run `npm test` and the `npm run test:*` scripts locally before pushing.
