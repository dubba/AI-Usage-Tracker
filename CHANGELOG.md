# Changelog

## Unreleased

### Improved

- On mobile, account cards use the same inset from the provider icon and action buttons to the card edges, and that spacing is shared by the rest of the card content.
- On mobile, the navigation sidebar can be resized by dragging its right edge, the same way it can on desktop.
- Desktop and mobile sidebars can be narrowed until just before the Group button would wrap under Accounts.
- On mobile, centered the sidebar 3-dots resize grip with balanced left and right spacing along the edge.
- The "You are on the latest version" update status toast in Settings now automatically dismisses after 5 seconds.
- Added mobile support for automatic startup on device boot with a native Android BootReceiver and unified settings storage.
- Standardized Account Updates dropdown options to 5, 10, 15, 30, 45, and 60 minutes, setting the default interval to 15 minutes.
- Permanently reserved scrollbar gutter space on the dashboard page so account cards do not horizontally shift when scrollbars appear.
- Refined descriptive copy across account removal, alert notifications, group creation, group deletion, and local API integration settings, and aligned the Integration window action button to a "View" button with icon matching Settings.
- Consolidated App Updates in Settings into a unified group card with a top-level automatic updates toggle and an embedded version status card with the Check Now action.
- Added a dedicated close button ("X") on the mobile sidebar positioned at the exact same screen coordinates as the collapsed hamburger menu button for seamless in-place toggling, alongside the purple "AI Usage Tracker" app title.
- Renamed the dashboard "Needs attention" metric card to "Action Needed".
- Reduced horizontal padding on account card status and plan badges (such as LIVE, GROK, and tier labels) for a more compact and balanced appearance.
- Refined the startup toggle descriptions in Settings to "Start app automatically at device startup." on mobile and "Start app automatically at login." on desktop.
- Shortened the App Updates setting description to "Automatically check for updates."
- Refined the Account Updates setting description to "Set how often the app updates your AI usage."
- Removed the excessive bottom spacing beneath account cards on mobile when scrolling to the bottom of the dashboard.

### Fixed

- Eliminated the highlight box flash when tapping the hamburger button on mobile by disabling default tap highlights and suppressing active/focus state flashing during sidebar slide-out.
- Returning to the app after the account-update interval has elapsed now refreshes accounts automatically, including when Android had paused the app in the background.
- Custom groups stay in the sidebar after every account is removed from them. Edit Group can now save with no accounts selected, and the empty group still has Edit and Delete.
- Account card remove, notification, and refresh buttons now sit on the same bottom edge as the provider icon.
- Desktop account cards now use 16px padding above and below the provider icon, with the updated-time label kept inside that header instead of sitting above the icon.
- On mobile, the account name and email are vertically centered with the provider icon instead of sitting above it.
- Fixed an issue where Settings update toasts remained visible indefinitely due to stale component memoization.
- Fixed an issue where toggling startup on mobile threw "plugin autostart not found"; startup behavior is now fully handled across desktop and mobile.
- Red error toasts now render in the page flow directly beneath the settings card in the exact same position as the update toast, and automatically dismiss after 5 seconds.
- Fixed horizontal card width jumping and size discrepancies on mobile between providers by dedicating `.provider-account-cards` as the sole scroll container and preserving invariant gutter room whether scrollbars are displayed or not.

## 0.3.4 - 2026-09-02

### Improved

- On mobile, placed the "Total accounts" and "Needs attention" summary cards side-by-side in the same row with "Next reset" spanning underneath.
- Made the mobile navigation sidebar narrower for a cleaner drawer layout.
- On mobile, tightened the spacing between the dashboard title and account count, and vertically centered both lines with the hamburger menu button.
- Balanced vertical spacing on mobile with equal padding above and below the header separator line.

### Fixed

- Fixed baseline alignment in the sidebar so group titles and account counts are horizontally aligned with provider entries like Grok and Antigravity.
- Standardized header typography and vertical baseline alignment across all provider and custom group views.
- On mobile, the Custom Group badge now stays to the right of the group name instead of wrapping under the menu button.
- Checking for updates no longer reports that you’re up to date when the check actually failed (for example a network error or a missing package for this computer).
- The sidebar Check for Updates control is now a real button that stays in sync with Settings.
- Signing in to a provider no longer gets stuck or misses the result when the dashboard and the sign-in window both check login progress at the same time.
- Refreshing, renaming, or removing one account no longer freezes the action buttons on every other account card; only the affected card's controls are disabled.
- The “Next reset” summary now shows a larger plain countdown value (e.g. “45m”) instead of “… remaining”.
- Deleting an account group now opens a confirmation dialog (“Are you sure you want to delete this group?”) instead of deleting immediately, and account removal can no longer be triggered twice by rapid clicks.
- Dialogs (Add Account, Account Grouping, Usage Notifications, Google Cloud Usage, Remove Account) now trap keyboard focus, close with Escape unless a dropdown is open, restore focus to the button that opened them, and stop the background from scrolling while open.
- Restored the Settings Change Log row, which disappeared after the Settings title was removed.
 - Clicking outside the Add Account dialog no longer cancels an in-progress provider sign-in; use Cancel to stop it deliberately.
 - Accounts renamed to the same text as an old provider name (for example “OpenAI Codex”) keep the exact name the user typed; only accounts still carrying the original auto-generated legacy name display the modern provider name.
- Provider sign-in no longer stays on “Waiting for the browser callback…” if the app loses contact with the login. The dialog shows an error and a Retry button that resumes the same attempt.
- Reordering accounts in a mixed group now moves those cards only, instead of applying another provider’s order to them.
- AI Studio accounts added with only an API key now show KEY ONLY instead of CONNECTED, and the Cloud Usage connection opens immediately so quota setup is not skipped.
 - Quota reset countdowns on account cards now show minutes when less than an hour remains (for example `8m` instead of `1h`).
- Empty custom groups stay in the sidebar after their last account is removed, with Edit and Delete on the empty dashboard.
 - Paseo Bridge copy buttons now show a transient “Copied!” label and announce the result to screen readers.
 - Provider and account dropdowns now expose listbox roles and active-descendant tracking so keyboard and screen reader navigation works.
 - The global error banner and the empty loading state now use alert semantics, focus the Retry button, and show skeleton placeholders while accounts load.

### Added

- The sidebar now has an All row as the default dashboard view, with provider and custom groups remaining as filters.
- Account cards now show when usage was last fetched, as relative time such as “Updated 2m ago”, above the remove, notification, and refresh buttons.

### Improved

- The sidebar + Group button now uses the same purple background as Add Account.
- The Next reset pill now shows days and hours when more than a day remains (for example `1d 9h`).
- Renamed the sidebar navigation item from “Accounts” to “Dashboard.”
- Renamed the Settings heading from “Application Settings” to “App Settings.”

- The Settings update button is now labeled Check Now and stays compact on mobile, with a narrower Account Updates dropdown.
- Clarified the Automatic updates description: the app checks GitHub Releases for updates at startup and every hour.
- The Settings Change Log action is now a compact View button with a new-window icon, and the description reads “View full history of app changes.”
- The accounts page title now uses the same purple uppercase heading style as Settings and Integrations, including Accounts Dashboard when empty and the connected account/group name when accounts exist.
- Aligned the accounts page heading with the Settings and Integrations headings so they sit at the same height on desktop.
- Matched the accounts page “N accounts” subtitle to the Settings and Integrations description size and spacing.
- Settings now uses a single purple Application Settings heading instead of a separate Settings title.
- Integrations now uses a single purple API Integration heading instead of Local API plus Paseo Integration.
- Renamed the sidebar section from Usage accounts to Accounts, and kept the Group / H / W header visible on Android instead of clipping it off the narrow drawer.

## 0.3.3 - 2026-09-01

### Improved

- Reduced account card email subtitle font size and compacted header action padding on mobile screens so badges and action buttons fit cleanly within narrow viewports.
- Styled scrollbars across desktop and mobile with a custom Obsidian purple theme, adding a slim purple scrollbar along the right side of the account cards list on mobile when multiple cards overflow the screen.
- Replaced default OS select elements across all dialogs (Add Account provider picker, Google Cloud project selector, Bucket filters, Usage Alert thresholds, and Settings refresh intervals) with a custom theme-styled dropdown component featuring obsidian dark styling, smooth purple animations, multiline text wrapping for long provider descriptions on mobile, full keyboard navigation, and checkmark indicators, with Grok listed directly above Antigravity.
- Reorganized the mobile layout of the Usage Notifications dialog so window toggles and threshold labels stack vertically above their dropdowns with full width, preventing squishing on small screens.
- Enhanced modal containers and dropdown menus to float completely above dialog boundaries with elevated z-indexing and dynamic upward opening when near the bottom of the screen to prevent cutoff.
- Formatted Android release package names as `AI Usage Tracker_<version>.apk` to include the version number and match macOS and Windows release asset conventions.
- Replaced raw manifest error banners with a clean informational message ("You are on the latest version") when checking for updates and no newer release is found.
- Added mobile update checking for Android: queries GitHub for new releases, displays update notifications, and automatically opens the latest APK release page in the mobile browser when tapped.
- Updated Settings descriptions for Automatic updates, App updates, and Account updates, and resolved dropdown clipping in Settings by enabling visible card overflow.

### Fixed

- Adding multiple Grok accounts now isolates the sign-in session in a clean, ephemeral profile so opening the sign-in window always displays a fresh login prompt instead of prematurely capturing an existing account, and distinct Grok accounts are now saved independently.
- Fixed Antigravity (Google) OAuth sign-in hanging on Android after selecting an email address by routing authentication through the in-app WebView interceptor, preventing OS background process freezing.
- Quota reset countdown badges now format as `Resets in: Xh` for windows under 24 hours and `Resets in: Xd Yh` (e.g. `1d 12h`, `6d 10h`) for windows over 24 hours, and are calculated directly in React across all models and windows.
- The mobile sidebar drawer now sits flush against the bottom of the status bar instead of leaving a gap below it.
- Replaced the Android launcher icon with the full-bleed purple design matching macOS and Windows, resolving the white background border and shrunken icon issue on Android devices.
- The mobile sidebar’s Check for Updates button now sits above the home indicator, with the same 12px gap below it as above Accounts.

## 0.3.2 - 2026-09-01

### Security

- Local account metadata, settings, and Android credential files are now created with owner-only permissions so they are never briefly readable by other users on the same machine.
- Grok connections now store and send only grok.com / accounts.x.ai session cookies. Existing saved Grok cookie bundles are trimmed on the next refresh, and a reconnect is required if no Grok session remains.
- Provider sign-in pages loaded inside the app are now restricted to each provider's own domains, so pop-ups and malicious links can no longer navigate the sign-in window to unrelated or script-based (javascript:, intent:) addresses.
- On Android, Google, Anthropic, and OpenAI sign-in now opens in the system browser instead of inside the app, so those sign-in pages can't reach the app's internal functions. In-app Grok sign-in on mobile still opens in the app so session cookies can be captured without pasting them. OpenCode Go on mobile still uses manual cookie entry.
- Switched Antigravity and Google AI Studio OAuth callback listeners to dynamic ephemeral loopback ports (`127.0.0.1:0`), eliminating loopback port contention and local pre-binding denial-of-service risks.
- Reduced Google AI Studio default connection scopes from broad administrative `cloud-platform` to least-privilege read-only monitoring and project inspection scopes, requesting service management only when Cloud Monitoring is explicitly enabled.
- OAuth sign-in success and error pages now send `no-store` caching and strict content security headers so those one-time callback pages are never cached or framed.
- The local bridge now verifies its bearer token with a standard constant-time comparison.

### Improved

- Sidebar cards (both custom groups/buckets and provider summaries) and dashboard account cards can now be dragged or long-pressed on touch screens to swap and customize their order, preserving natural scrolling and syncing backend account ordering.
- Active card selection is preserved when dragging or swapping cards, preventing the displayed account view from unexpectedly switching.
- The Paseo Bridge token in the integration window is now hidden by default and can be revealed with a single click, keeping the masked value in the copied environment block as well.
- Updated the in-app Grok login window to open `https://accounts.x.ai/sign-in` directly.
- If accounts fail to load, the dashboard now shows the error and a Retry button instead of staying on “Loading accounts…”.

### Fixed

- Fixed Open Grok login crashing the Android app immediately after tapping the button by keeping WebView cookie JNI methods through release minification.
- Fixed "Open Grok login" button crashing the Android app by guarding the desktop WebView window creation with a compile-time platform check; on Android the manual cookie-paste path is now shown automatically.
- Fixed Antigravity (Google), OpenAI, and Anthropic OAuth sign-in permanently hanging on Android; the loopback TCP callback server is desktop-only and cannot receive redirects from the Android system browser. These providers now show a clear message directing Android users to link accounts on the desktop app.
- Fixed `getCurrentWindow()` crash at startup on Android caused by missing window plugin metadata; the Paseo Bridge window check now falls back safely to `false` on mobile.
- Positioned the expanded mobile sidebar drawer flush directly below the mobile status bar with square corners, eliminating the top gap and preventing the drawer from covering status bar indicators.
- Expanded account usage progress bar tracks to span the full available width of the card, aligning flush with window badges and reset countdown timestamps.
- Styled the account rename pen button with a compact 22px badge and obsidian violet font, border, and background colors matching the visual style of the header action buttons.

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
