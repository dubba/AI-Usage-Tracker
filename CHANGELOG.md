# Changelog

## Unreleased

### Fixed

- Fixed "Open Grok login" button crashing the Android app by guarding the desktop WebView window creation with a compile-time platform check; on Android the manual cookie-paste path is now shown automatically.
- Fixed Antigravity (Google), OpenAI, and Anthropic OAuth sign-in permanently hanging on Android; the loopback TCP callback server is desktop-only and cannot receive redirects from the Android system browser. These providers now show a clear message directing Android users to link accounts on the desktop app.

## 0.3.1 - 2026-08-31

### Improved

- Standardized "5 hour", "Weekly", and rolling window metric labels to "Remaining Limit" across all provider account cards while preserving clean model categories for Antigravity (e.g. `Gemini · Remaining Limit`, `Claude & GPT · Remaining Limit`) and Claude.
- Styled `5h window` (Warm Amber), `7d window` (Obsidian Mint), and `Monthly` (Obsidian Lavender) duration badges with dark-mode theme colors for visual differentiation and contrast.
- Updated the in-app private Grok login window to open `https://accounts.x.ai/` directly for signing in.
- On mobile and small screens, account quota and usage metrics now render one per line with full-width progress bars for easier reading.
- Account card headers now display provider icons, account titles, status/plan badges, and action buttons in a single inline row across desktop and mobile screens, with status and plan badges neatly stacked and uniform 6px spacing between badges and action buttons across mobile and desktop screens.
- Renamed provider display names across sidebar navigation, dashboard headers, account cards, and modals: "OpenAI Codex" to "Codex/GPT", "Anthropic Claude" to "Claude", "Google Antigravity" to "Antigravity", "Google AI Studio" to "AI Studio", and "Grok / SuperGrok" to "Grok".
- Renamed "Check for App Updates" buttons to "Check for Updates" across the sidebar footer and Settings view.

### Fixed

- Fixed installed version display in Settings to always show the active application build version (`v0.3.1`) regardless of remote update status.
- Enabled updater artifacts generation and updater manifest uploads in GitHub release automation.
- Fixed stale cached web views on Android after installing updated APKs by automatically invalidating and clearing the internal WebView cache upon version change.
- Fixed mobile touch scrolling flickering and jitter by ignoring touch events in card drag-and-drop reordering and enabling GPU compositing acceleration on dashboard cards.
- Configured light status bar text and icons (dark-theme system bar styling) on Android and refined mobile top spacing to eliminate status bar overlap and excessive gaps.
- Fixed duplicate account title rendering for Grok and added automatic email and user identity discovery from Grok session tokens and user profile endpoints.
- Fixed Grok and OpenCode in-app private login windows not closing automatically on Android by ensuring proper WebviewWindow closure and expanding multi-domain session polling across `accounts.x.ai` and `grok.com`.
- Resolved an Android initialization issue where invoking the desktop updater plugin or missing notification capabilities caused the mobile WebView to show a blank screen.
- Resolved Google / Antigravity OAuth login `Unregistered scope(s)` errors by standardizing the Cloud Code OAuth scope to `https://www.googleapis.com/auth/cloud-platform`.
- Fixed Android OAuth token exchange network failures caused by OS background connectivity restrictions by deferring and resuming token exchange when the app returns to the foreground.
- Fixed Android credential persistence and startup crash by using sandboxed private app storage permissions and early storage initialization.
- Fixed an Android crash when opening the Grok login window caused by a null pointer exception when reading empty webview cookie sessions.
- Added safe-area padding and a responsive slide-out mobile drawer navigation for Android and small touch screens.

## 0.3.0 - 2026-08-31

### Added

- Added support for building and sideloading on **Android**. Releases now provide an `.apk` package (`AI-Usage-Tracker.apk`) that can be installed directly onto Android phones.
- Added responsive **Mobile Navigation Drawer** with smooth slide-out transitions and safe-area padding for Android status bars and gesture bars.
- You can now create custom **Bucket Groups** to combine accounts (e.g. splitting multiple Antigravity or Grok accounts into separate work vs personal buckets). Each bucket shows as an independent row in the sidebar with its own usage calculations and filters the dashboard when selected.
- Settings now includes a toggle for automatic app updates. Manual update checks still work when the toggle is off.

### Improved

- Sidebar provider and bucket rows now display the count of connected accounts in brackets next to their name (e.g. Antigravity (3), Grok (1)).
- The app now uses the name **AI Usage Tracker** in the installer, Dock, menu bar, window title, and GitHub releases.
- Account cards keep the rename control beside the account name, with Live/plan badges above the notification, remove, and refresh icons.
- Account notification, remove, and refresh controls are matched-size bordered buttons, colored amber, red, and green.
- Account cards, summary cards, settings cards, action buttons, and sidebar navigation controls use the app purple for their border on hover.
- Account-card actions are ordered remove, notifications, then refresh.
- Long account lists now scroll in the dashboard instead of compressing cards to fit the window.
- Background account quota refreshes now run concurrently rather than sequentially, reducing refresh latency when monitoring multiple accounts.
- Legacy account data migrations now execute once during application startup instead of running on every snapshot polling cycle.
- The Settings screen now retrieves the installed application version dynamically from the application runtime.
- The main window now reopens at its last size and position after Quit.
- The sidebar resize divider now features a 3-dot grip handle to indicate where the sidebar can be dragged to resize.
- Account passwords and the local API token are now stored in the Keychain as **AI Usage Tracker**. Existing **Paseo Usage Bridge** items are copied on first use.

### Security

- Google authorization flows (Google AI Studio usage and legacy Antigravity) now use PKCE, so an intercepted authorization code cannot be exchanged without the verifier.
- The tracker no longer reads the Grok CLI's `~/.grok/auth.json`; Grok accounts rely solely on the browser session captured during guided sign-in. Reconnect a Grok account if its details were missing.
- OpenCode Go account emails are stored only in the backend account store; the app no longer writes them to browser storage and deletes the old entries on launch.
- Google Cloud project choices during AI Studio usage setup now use typed login-status fields instead of JSON embedded in the status message, and enabling Cloud Monitoring uses an explicit flag instead of a magic `enable:` prefix.
- Grok and OpenCode login windows now only navigate to `https://` pages; plain `http://` pages are blocked.
- The OpenCode manual-connection auth cookie field is now a masked password input.
- CI now audits frontend (`npm audit`) and Rust (`cargo audit`) dependencies for known vulnerabilities on every change.
- OpenAI and Anthropic login callbacks now use `127.0.0.1` instead of `localhost`, matching the loopback listener.
- Anthropic sign-in no longer requests API-key creation, Claude Code sessions, MCP servers, or file-upload access. Reconnect an Anthropic account to drop previously granted extra scopes.
- After credentials are copied into the current Keychain name, leftover **Paseo Usage Bridge** Keychain items are deleted.
- OpenAI account identity now comes from the authenticated userinfo and usage APIs instead of unverified JWT payload fields.
- OpenAI sign-in identifies this app instead of Codex CLI.
- The local health endpoint now requires the same bearer token as the usage endpoint.
- The local API allows at most one authenticated request per second. Extra requests return `429` with `Retry-After: 1`.
- Google Antigravity and Google AI Studio sign-in no longer request previously granted extra OAuth scopes.
- Google Antigravity sign-in no longer requests Cloud Platform write access, client logging, or experiment-config scopes. Reconnect an Antigravity account to drop previously granted extra scopes.
- Removing an account now fails if saved credentials cannot be deleted, so tokens are not left behind.
- Google AI Studio authorization now opens backend-defined least-privilege OAuth scopes directly without frontend scope escalation.
- Credential operations across all providers and login workflows now consistently use unified macOS Keychain single-item storage with automatic legacy chunk cleanup.
- Grok quota tracking now communicates exclusively via standard HTTPS API requests, eliminating external CLI subprocess execution and unsafe relative home directory fallbacks.
- OpenCode workspace identifiers are strictly validated to alphanumeric slugs, preventing path traversal and URL parameter injection.
- Local bridge API bearer token validation now hashes inputs with fixed-length digests before constant-time comparison to prevent timing side-channel length leaks.
- App settings, alert thresholds, and account ordering are written atomically via unique temporary files to prevent data corruption.
- The dashboard snapshot no longer includes the local API bearer token. The token is available only in the Integration details window.
- Grok account errors no longer show raw provider RPC text on the dashboard.
- Settings, alert, account-order, and account files are restricted to owner access. Existing world-readable copies are tightened on startup.
- Connecting or reconnecting an account no longer overwrites newer usage data and uses the same account lock as refresh.

### Fixed

- OpenCode account connection now persists email addresses directly into backend storage and includes them in local API usage responses.
- The app no longer asks for Keychain access on every usage refresh. It asks when credentials are first unlocked or when they actually change.
- Account usage refresh now stops after 45 seconds if a provider does not finish responding.

- Login and callback pages no longer still refer to the former **Paseo Usage Bridge** name.
- Provider connection flows now atomically synchronize pending authentication state across all active setup stages, preventing concurrent connection attempts from colliding.
- Removing an account now synchronizes with background refresh tasks so in-flight refreshes cannot modify or resurrect deleted accounts.
- The remove-account control now opens a confirmation dialog and actually removes the account.
- The remove confirmation uses a red Remove button. Dialog close controls stay muted until hover, then use a red background and white X.
- Escape now closes add-account, notification, Google Cloud, and remove-account dialogs.
- Hovering account rename, remove, notification, and refresh controls now shows a tooltip.

## 0.2.47 - 2026-07-31

### Fixed

- Credits are no longer shown on Google Antigravity or OpenCode Go accounts, which do not report a credit balance.
- OpenAI usage-window badges now stay in the same top-row position used by other providers.

### Improved

- Usage percentages now omit the redundant word **remaining**.
- Narrower account cards retain the exact same content, element positions, icon sizes, and typography; only flexible widths such as account names and usage bars contract.

## 0.2.46 - 2026-07-31

### Fixed

- OpenAI account cards now grow to fit all quota content instead of clipping shorter than their metrics.

### Improved

- Provider-reported credits now appear inline with the percentage and usage bar instead of occupying a separate quota tile.
- Narrow account cards preserve the same information and visual structure while progressively tightening spacing, icons, and typography instead of switching to a different compact design.

## 0.2.45 - 2026-07-31

### Improved

- OpenCode Go's monthly quota now shows a **Monthly** usage-window badge alongside its percentage.
- Account-card notification, remove, and refresh controls move beside the email only when the title row would otherwise become crowded.
- Detailed account usage remains visible while the card can still contain its real text; compact percentages activate only after measured content overflow instead of at a fixed card width.

## 0.2.44 - 2026-07-30

### Improved

- Detailed two-column account usage stays visible until an account card is genuinely narrow; compact mode now begins at 760px and the one-column fallback begins at 520px.

## 0.2.43 - 2026-07-30

### Improved

- Compact account cards now keep notification, remove, and refresh controls beside the account name and use the lower row for concise percentage and usage-window summaries based on each card's actual width.
- Provider and account dragging now follows the Trello-style interaction reference: the floating card tracks the pointer while a transparent full-size gap moves through the list and neighboring items animate into the exact pending order.

### Fixed

- Accounts with multiple rows of usage limits no longer indent later rows with a misplaced vertical separator.

## 0.2.42 - 2026-07-30

### Fixed

- Cancel and close controls now remain available while account authentication is waiting, immediately stop the active login attempt, and close private provider windows without waiting for a timeout.

## 0.2.41 - 2026-07-28

### Improved

- Provider groups and account cards now move through the list while dragging, with a full-size destination preview showing the exact order before release.

## 0.2.40 - 2026-07-28

### Added

- Grok / SuperGrok accounts can now sign in through xAI's official Grok Build CLI and display provider-reported included-usage percentage and reset timing when xAI exposes that billing data.

### Fixed

- Provider groups and account cards now use pointer-based reordering that works reliably in the desktop WebView and persists the resulting order.
- React now renders provider groups from the saved provider order instead of restoring the old fixed order after a drag.

## 0.2.39 - 2026-07-27

### Fixed

- Interrupted Google AI Studio OAuth setup can no longer leave the app stuck closing during startup refresh.
- Automatic account refreshes are isolated so one provider failure cannot take down the refresh controller or the desktop app.
- Google AI Studio accounts that have not completed Cloud setup, plus accounts already requiring reconnection, are skipped during automatic startup refresh.
- Provider credential read failures now suspend only the affected account and require reconnection instead of being retried as an application-wide startup failure.
- Opening Google AI Studio OAuth no longer triggers a self-repeating popup observer loop that can crash the app or leave it running invisibly in the system tray.
- Popup close buttons now update their disabled state without recursively retriggering the shared dialog observer.
- Invalid startup metadata is preserved in a quarantine file while the app recovers from `accounts.json.bak` or safe defaults instead of closing immediately after launch.

## 0.2.38 - 2026-07-27

### Fixed

- Google AI Studio Cloud setup no longer opens a Google 403 page caused by OAuth scopes that the current Google client does not accept.
- Every popup dialog now includes a visible top-right **X** close button.

### Improved

- Google AI Studio setup now accurately explains that Google grants Cloud access while the app limits its own actions to project discovery, Cloud Monitoring usage, and an explicitly approved Monitoring enable action.

## 0.2.37 - 2026-07-27

### Added

- Google AI Studio usage setup now signs in with Google once, automatically identifies the Cloud project that owns the API key when Google permits it, and falls back to a project picker only when automatic discovery is unavailable.
- When Cloud Monitoring is disabled, setup now offers a separate **Enable Cloud Monitoring** approval instead of sending users through manual Google Cloud Console steps.

### Improved

- Google AI Studio setup no longer asks users to find and paste a Cloud project ID.
- The initial Google authorization remains read-only; broader Cloud permission is requested only for the explicit one-time action of enabling Cloud Monitoring.

## 0.2.36 - 2026-07-27

### Added

- Google AI Studio accounts can connect the Google Cloud project that owns their API key with read-only Cloud Monitoring access and display provider-reported RPM, TPM, RPD, and TPD quota usage when Google publishes those metrics.
- Google AI Studio now appears as its own provider group instead of being mixed with Google Antigravity accounts.

### Improved

- API-key-only Google AI Studio accounts now show **Connected** instead of **Live**, and project connections waiting for delayed Google metrics show **Waiting** instead of an unexplained unavailable value.
- Existing Google AI Studio testing accounts are migrated automatically without requiring the API key to be added again.

## 0.2.35 - 2026-07-27

### Added

- **Add Account** now includes a testing option for Google AI Studio API keys that validates the key, loads the model list directly from Google, and lets you choose which returned models to track.

### Improved

- Google AI Studio testing accounts leave usage values unavailable when Google does not report them instead of estimating or calculating quota usage.

## 0.2.34 - 2026-07-26

### Fixed

- The global **Add Account** button now opens an unlocked provider-selection window so you can choose which account type to add.
- Reconnect actions still remain locked to the existing account’s provider.

## 0.2.33 - 2026-07-26

### Added

- Provider groups in the sidebar and account cards within each provider can once again be reordered by dragging, with the saved order restored after relaunch.
- Dragging near the top or bottom edge automatically scrolls long provider and account lists.

### Improved

- The notification, trash, and refresh icons in account cards are now 50% larger while keeping transparent action buttons.
- Long provider and account lists now scroll independently within the available sidebar and dashboard space.

## 0.2.32 - 2026-07-26

### Fixed

- Replaced the clipped-looking refresh symbol with a complete circular two-arrow icon that renders cleanly at the account-card action size.

### Improved

- Account usage metrics now show the reset date on the left and a right-aligned **Resets in: _Xh_** countdown calculated from the provider’s reset timestamp.

## 0.2.31 - 2026-07-26

### Fixed

- The bottom-left update control now displays **Check for App Updates** only once in every update state.

### Improved

- Usage-window badges such as **7d window** now share the percentage row and are right-aligned within each account metric.

## 0.2.30 - 2026-07-26

### Fixed

- Restored the OpenAI quota details that were accidentally hidden in v0.2.29. OpenAI cards again show the remaining percentage, usage-window badge, purple usage bar, and reset time while omitting only the redundant **Session** heading.
- The sidebar update control now uses one real text label instead of displaying both its label and a generated duplicate.

## 0.2.29 - 2026-07-26

### Added

- OpenCode Go accounts now require an email address during setup so the connected email can be shown under the account name.

### Improved

- OpenAI now uses a high-contrast white Blossom icon throughout the dark dashboard.
- All provider and account usage bars now use the dashboard’s purple accent color.
- Account plan badges now sit beside the account status badge.
- Account card actions are now unboxed and ordered as notifications, remove, and refresh, with a trash icon used for removal.
- Usage-window badges now sit directly above their usage bars and use white text and outlines.
- OpenAI account cards no longer show the Session metric or the provider-reported credit helper text.
- Google account cards no longer repeat Five Hour Limit or Weekly Limit in metric names and no longer show an empty credits metric.
- OpenCode Go account cards no longer show an empty credits metric.
- The sidebar update control now displays its label only once.
- The Account alerts label now has clearer spacing above the notification heading.

## 0.2.28 - 2026-07-26

### Added

- The account sidebar now groups accounts by provider and shows the provider’s average remaining 5-hour or weekly usage.
- **H** and **W** controls beside **Usage Accounts** switch the provider averages between the 5-hour and weekly limits.
- Each account card now has dedicated refresh, remove, and notification controls, plus inline account-name editing.

### Improved

- The Accounts dashboard has been rebuilt to closely follow the new Obsidian utility mockup, including its colors, typography, navigation, summary cards, spacing, and account-card layout.
- Selecting a provider in the sidebar now displays all accounts connected to that provider in the main dashboard.
- Account notification settings now focus on the 5-hour and weekly limits.

## 0.2.27 - 2026-07-26

### Added

- Integrations now includes a toggle for enabling or disabling the Paseo Bridge.
- When the bridge is enabled, a **View** link opens a separate window with its status, endpoints, bearer token, environment configuration, token rotation control, and connection details.

### Improved

- The Paseo Bridge is now disabled by default and no longer opens its localhost listener until explicitly enabled.
- Disabling the bridge now shuts down its local listener while preserving its configuration for later use.

## 0.2.26 - 2026-07-26

### Improved

- The sidebar update button now says **Update to v…** when a new version is available.
- The duplicate update banner and restart button in the main dashboard have been removed.

## 0.2.25 - 2026-07-26

### Improved

- Dashboard summary cards now use compact single-line layouts for connected accounts, accounts needing attention, and the next reset.
- The **Next Reset** card now shows only the countdown and account name.
- Accounts that need attention are now highlighted with a transparent red warning outline in the sidebar.

## 0.2.24 - 2026-07-26

### Added

- Settings now includes a **View Change Log** button that opens the repository changelog.

## 0.2.23 - 2026-07-26

### Added

- Account update timing can now be selected from 5 to 60 minutes in 5-minute increments.
- A system notification now appears when a new app update is detected.

### Improved

- The app now checks for updates every hour instead of every six hours.
- Settings now describes account refresh timing as **Account Updates** and focuses on the controls users need.

## 0.2.22 - 2026-07-26

### Improved

- The sidebar update button now says **Check for App Updates** and changes to a purple install button when a new version is available.
- A **View Change Log** link now appears below available updates and opens this repository changelog.
