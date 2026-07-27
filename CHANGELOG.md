# Changelog

This file tracks notable user-facing changes to AI Subscription Tracker.

## Unreleased

### Fixed

- Opening Google AI Studio OAuth no longer triggers a self-repeating popup observer loop that can crash the app or leave it running invisibly in the system tray.
- Popup close buttons now update their disabled state without recursively retriggering the shared dialog observer.
- Invalid startup metadata is now preserved in a quarantine file while the app recovers from `accounts.json.bak` or safe defaults instead of closing immediately after launch.

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
