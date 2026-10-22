# Changelog

## Unreleased (2 changes)

### Added (1)

- On Android and iPhone/iPad, the "Account connected" screen now has a red X in the top-right corner that returns to the dashboard straight away, like swiping back.

### Improved (1)

- On account cards, each usage limit now has a colored pill-shaped chip with rounded corners (such as `5H LIMIT`, `7D LIMIT`, and `30D LIMIT`) that names the provider or model, such as `7D LIMIT · Claude`, `30D LIMIT · ChatGPT` and `7D LIMIT · GrokBot`. The reset countdown sits above the bar and the percentage to the right of it.

## v0.4.10 - 2026-10-20 (9 changes)

### Added (1)

- A standalone macOS uninstaller script (`scripts/uninstall-macos.sh` or `npm run uninstall:macos`) that completely removes application data, preferences, temporary sign-in profiles, and saved Apple Keychain credentials, and optionally deletes the application bundle.

### Improved (2)

- On Windows and macOS, the Google sign-in window that opens from "Continue with Google" on Claude's sign-in page is now as tall as the Claude window and lines up with its top, instead of opening at a fixed, taller size.
- The sidebar opens wide enough for "Accounts synced just now" to stay on one line, and double-clicking its resize handle returns to that width. Narrower than the Account, Group, and L/U row, the toggle still drops to its own line.

### Fixed (6)

- On Windows, uninstalling the app now deletes all locally stored accounts, preferences, temporary sign-in browser profiles, and Windows Credential Manager sign-ins, so reinstalling the app starts fresh.
- On iPhone and iPad, reinstalling the app after deleting it now automatically purges leftover Apple Keychain credentials from the previous installation, starting the app completely fresh.
- On Android, the "Account connected" screen after signing in to Claude, ChatGPT or Antigravity no longer freezes at 1 second. It counts down to 0 and returns to the dashboard, without having to close and reopen the app.
- On Windows, choosing "Continue with Google" on Claude's sign-in page now opens Google's sign-in window instead of a black one.
- On Windows, macOS and iPhone/iPad, clicking the "update available" notification now opens the What's new window, as it already did on Android. On Windows the click only works while the notification is still on screen, not after it has moved to the Action Center.
- On iPhone and iPad, tapping a notification after the app was fully closed no longer crashes the app. This affected the usage alerts as well as the update notice.

## v0.4.9 - 2026-10-19 (18 changes)

### Added (2)

- Cmd+A (Ctrl+A on Windows and Linux) can now be used alongside Cmd+N (Ctrl+N) to open the Add Account dialog.
- Cmd+S (Ctrl+S on Windows and Linux) can now be used alongside Cmd+, (Ctrl+,) to open the settings page, and pressing either while on Settings returns to the accounts dashboard.

### Improved (6)

- Errors in the Add Account dialog, the Paseo Bridge window, account alerts, the Google AI Studio connection, app updates and the camera scanner now say what failed in plain words, and technical failures no longer show raw text such as "Error: …". They are also included in Copy Diagnostics.
- In Settings, whether the Advanced section is expanded or collapsed is now remembered when switching between views and across app restarts.
- In the keyboard shortcuts card in Settings, the shortcut is now labeled "Switch between Settings and Dashboard page".
- The sidebar now starts wide enough for "Accounts synced 2m ago" to fit on one line until you resize it, and double-clicking its resize handle sets that width again instead of resetting it to a fixed default.
- The sidebar can now be made narrower, down to the width of the Account and Group buttons. The sync line at the bottom wraps onto centered lines ("Accounts synced", then "4m ago"), and the L / U toggle drops below the Account and Group buttons, left-aligned with the Account button, when the sidebar is narrower than its default width.
- On a phone or tablet, a tooltip stays fully visible for 2.3 seconds, then fades out and is gone at 2.5 seconds.

### Fixed (10)

- Usage alerts and the 5h / 7d / 30-day labels no longer mistake a window named "15h" for a 5-hour window or "17d" for a 7-day one, and a window whose name contains "monthly" (such as "credits_monthly") is now recognized as monthly in alerts, as it already was on the dashboard.
- Receiving an air-gap transfer that fits in a single QR code now completes instead of waiting for more codes.
- In the group editor, Grok accounts now list the same usage percentage as their card (the Grok Bot limit) instead of a different limit.
- The dashboard no longer shows older account data when two refreshes overlap and the slower, older one finishes last; it keeps showing the newest data until the next refresh.
- When linking devices, the "Transfer Complete" screen now lists any part of the transfer that couldn't be saved on the receiving device (account groups, settings, account order or usage alerts) instead of reporting a clean success.
- On Windows, opening the app no longer flashes a series of terminal windows while it protects its saved files.
- On mobile and tablet screens, the Action Needed summary card now keeps its full four-sided amber highlight border when filtering instead of having its left border cut off with dark gray.
- On mobile and touch devices, tapping the usage display toggle (L / U) in the sidebar no longer leaves the tapped button stuck in a light-purple hover highlight, keeping it in the solid default purple.
- On Android, the back gesture or back button on the "Account connected" screen now returns straight to the dashboard for every provider, instead of stepping back through the earlier sign-in pages (it only did for some providers).
- On Android, going back from the "Account connected" screen and then signing in to another provider right away no longer lets the first sign-in's countdown reset the page in the middle of the new one.

## v0.4.8 - 2026-10-18 (20 changes)

### Added (1)

- An L / U toggle at the right of the sidebar's Account and Group buttons switches every usage percentage, in the sidebar and on the dashboard, between the quota left (L) and the quota already used (U), and remembers your choice. Transferring settings to another device with Link Devices also carries the choice over.

### Fixed (4)

- Clicking Reveal in the Paseo Bridge window now shows the full bearer token instead of leaving it hidden behind dots, and the revealed token wraps onto a second line instead of being cut off with an ellipsis.
- The Delete Group button stays red while the pointer is over it.
- Remove confirmation buttons, the Clear Filter button, and account action buttons retain their intended red, amber, and green colors through hover and active states without reverting to gray or purple.
- Pressing Cmd+N or Cmd+G while in Settings no longer switches to the dashboard in the background, keeping you on Settings when you exit the modal.

### Improved (15)

- The Paseo Bridge window remembers the size you gave it when you close it or quit, and opens at that size next time. It never opens smaller than its default size, so the connection details stay fully visible.
- The Change Log View button in Settings now says it opens in your web browser.
- The Paseo Bridge window now matches the app and Settings: the same dark and light backgrounds, cards, purple page title, status badge, and text sizes, and its Reveal, Hide, and Regenerate buttons use the same solid purple style as the Link Devices button, and its Copy buttons match the Copy button in Settings.
- The sidebar Grok row now shows the Grok Bot percentage in front of the Grok percentage, instead of a dash.
- On Grok account cards, the Grok Bot limit now appears above the Grok limit.
- The Group label next to a group's title now uses the same uppercase lavender style as the Group label in the sidebar, sized to match the title.
- The pen button next to the group name and pill now shares the same solid purple fill, white icon, and responsive touch styling as the rename button on account cards across desktop and mobile.
- In Settings and the What changed window, the Check Now and Update button icons are swapped: Check Now has a circled up-arrow icon to the left of its label, and Update has a cloud-download icon.
- The Update button in Settings and in the What changed window uses a deeper, richer green background.
- In Settings and the What changed window, the Update and Check Now button padding is optically balanced between the icon and label.
- The icons inside the Link Devices, Update, and Check Now buttons use a bolder stroke matching the visual weight of their bold label text.
- In empty groups, the Edit Group button uses the solid purple primary button styling matching Check Now and Link Devices.
- In the Add Account provider menu, Google Antigravity and Google AI Studio are labeled "(Gemini)", and each provider description starts with "Link".
- In the Add Account dialog, the email hint description clarifies that entering an email allows signing in with that account instead of reusing an existing session.
- The sidebar button is renamed to "Refresh all accounts", and its keyboard shortcut is restored to Cmd+R (Ctrl+R on Windows).

## v0.4.7 - 2026-10-17 (17 changes)

### Improved (15)

- The Update button in Settings and in the What changed window has a circled up-arrow icon to the left of its label.
- The Check Now button in Settings has a cloud-download icon to the left of its label.
- Error banners (such as "Sign-in failed: Sign-in was canceled.") are as tall as their text instead of a fixed tall box, and sit below the page header so they no longer cover the menu button and title.
- On account cards, the provider button icon is now 44px with a 28px inner icon on desktop and 40px with a 26px inner icon on mobile, giving comfortable touch targets with balanced icon spacing.
- The sidebar Refresh All button is now called "Update all accounts", and its keyboard shortcut is Cmd+U (Ctrl+U on Windows) instead of Cmd+R (Ctrl+R).
- On account cards, the account name, rename button, and email sit slightly higher with padded email text, preventing font descenders (such as the "y" in Yahoo) from being cut off.
- On mobile, provider sign-in pages now display below the "Back to AI Usage Tracker" button and status bar with a matching header bar so page content is never overlapped.
- In both the dark and light themes, the active Settings button in the sidebar now has an even lighter purple circle around it.
- The reorder hint banner now displays on both desktop and mobile during the first two app launches (or until dismissed for the session), and is dismissed permanently once an account or group is reordered.
- In the Link Devices air-gap transfer screen, the Play and Pause animation button now uses the same solid purple style and filled icon as the Back button.
- In the Add Account provider menu, the descriptions for ChatGPT, Claude, and Antigravity now say "using Browser OAuth" without repeating the company names.
- Inline utility buttons (such as Select All in the group picker, air-gap playback controls, and camera retry) now use a 32px height for easier tapping.
- Action buttons in dialogs (Cancel, Save, Back, Create Group, Connect, and Delete) now use a comfortable 44px height and rounded corners, matching the Settings controls and mobile touch targets.
- The buttons in Settings (Check Now, Link Devices, View, and Copy) now use the same 44px height and rounded corners as the dropdowns, giving controls consistent touch targets and alignment across the page.
- The Usage Notifications dialog on a computer is as wide as the other dialogs instead of wider, so the threshold dropdown no longer sits far from its window's checkbox.

### Fixed (2)

- The What changed window for an update now shows the release's changes instead of "No detailed release notes were provided", and shows the publish date as a short date instead of raw timestamp text.
- In Settings, the update button stays where Check Now was when it changes to Update and the View what changed link appears. The link now sits on its own line below.

## v0.4.6 - 2026-10-16 (22 changes)

### Improved (18)

- The Account and Group buttons use the same text weight as Check Now, Link Devices, and Settings.
- Antigravity accounts now report the latest Antigravity release version to Google. The app reads the newest release number from Google's public Antigravity changelog once a day and uses it when it asks for usage limits, so new limit groups (such as the separate Gemini 4 Argon limit) appear without waiting for an app update. If the changelog cannot be read, it reports the last known-good release.

- The DASHBOARD title, the sidebar title, the Current Version label, and the email and countdown on the Account connected page now use a lighter purple, so they read clearly on the dark background.
- In the light theme, selected and hovered rows, cards, and buttons use a clean pale lavender instead of a muddy gray-purple.
- In the light theme, the Enter Link Code badge and icon use a darker blue so they are readable on the pale background.
- In the light theme, the close button on dialogs is a quiet outlined button that turns red on hover instead of a solid red block.
- In the light theme, the Action Needed card uses a clean warm tint instead of a tan gradient.
- In the light theme, the account card buttons share one quiet white style with a soft gray outline and a colored icon, instead of a mix of black, green, amber, and red outlines.
- In the dark theme, the main action buttons (Check Now, Account, Group, Create Group, Connect to Device, and the other purple buttons) use the same solid purple with a white label as the light theme.
- The account rename pen and the sidebar Settings button use the same solid purple with a white icon as the other purple buttons, in both themes.
- While it refreshes, the sidebar Refresh All button now looks like the pull-down refresh indicator: a purple icon spinning at the same speed on the raised surface, at full strength instead of dimmed.
- In the Link Devices dialogs, Back is now the solid purple default button wherever it sits next to Cancel or the camera switch, so it looks like the other main buttons.
- The Link Devices button in Settings uses the same solid purple with a white label as Check Now and the Account and Group buttons.
- Buttons, toggles, borders, glows, and links now draw from three shared purples instead of about a dozen, in both the dark and light themes, so they match each other across the app.
- On a phone, the amber Requires action line on the Action Needed card is 11px. All good on that card stays 12px.
- In the Add Account provider menu and the Create Group account list, the gap beside the scrollbar now matches the left inset on macOS too. These lists draw their own scrollbar, because the macOS app laid rows out under the system bar. Both sides still match when there is no scrollbar.
- The Create Group account list shows four accounts without a scrollbar. A fifth account brings in the scrollbar.
- The + Group tooltip in the sidebar breaks onto two lines and shrinks to the longer one, so the gap on the right matches the gap on the left.

### Fixed (4)

- Tabbing from the Settings button to the sidebar resize handle no longer slides the sidebar's account cards to the left.
- On desktop, the sidebar account cards are centered between the window edge and the sidebar divider. The extra gap on the right now appears only while the list is long enough to scroll.
- Keyboard focus now shows a clear purple ring on the sidebar account rows, Refresh All, and Settings buttons, and the selected Settings button is easy to tell apart in the light theme.
- The red Remove button in confirmation dialogs now stays red when you hover it instead of turning gray.

## v0.4.5 - 2026-10-16 (37 changes)

### Added (2)

- Grok accounts that include Grok Bot now show a separate Grok Bot 7-day limit and reset time alongside the SuperGrok weekly limit.
- On a phone, choosing Show Link Code or Enter Link Code while Wi-Fi is off now opens a prompt with a Turn On Wi-Fi button that takes you to the system Wi-Fi settings.

### Improved (12)

- The email and countdown on the Account connected page now use the same purple as the status bar and scrollbar.
- The "Account connected" page and sign-in status screens now use a pure black background and center their content vertically in the middle of the screen instead of sticking to the top of the window.
- The Link Devices button in Settings now shows the same devices icon as the empty dashboard, so both entry points look the same.
- The OpenCode email field in the Add Account dialog is now labeled "Account email (optional)" to match the other providers.
- The empty All Accounts heading now says "Connect an AI Provider Account", and the Add Account, Link Devices, and usage-alert dialogs now use title-case headings: "Add AI Provider Account", "Send or Receive Accounts", "How to Connect Devices", and "Usage Notifications".
- The Action Needed card now says "Requires action" instead of "Requires attention".
- The sidebar + Account and + Group buttons now have the same space above and below, so they sit centered between the app title and the account list.
- The sidebar + Group button tooltip now says "Group accounts to track usage in one place, like “Work” or “Personal”".
- The Update button in Settings and in the What's Changed dialog, shown when a new version is available, now uses a green background with white text.
- The Create Group dialog now always opens with the provider filter on All Providers, even if you were viewing a single provider in the sidebar.
- The sidebar All row now says "All Accounts".
- In Link Devices, the Back button now matches the Cancel button instead of using a red fill.

### Removed (2)

- The Add Account dialog no longer shows the "What happens next" walkthrough panels for OpenCode and Grok sign-ins, so the dialog is shorter.
- The Add Account dialog no longer shows the explanatory note under the OpenCode email field.

### Fixed (21)

- Antigravity accounts now show their Gemini models' weekly and 5-hour limits again. Google had stopped sending them to this app, so only the Claude & GPT limits appeared. A separate Gemini 4 Argon limit will show as its own row when Google reports one.
- On desktop, the window now opens on a black background instead of a full-window purple flash before the UI appears. The title bar stays purple.
- Scrollable lists keep a small gap from the purple scrollbar so cards and rows do not sit under it, including Settings, All Accounts, the group account picker, and dropdown menus that scroll. Short dropdowns keep the checkmark spaced from the label instead of reserving room for a scrollbar.
- Link Devices with a link code now works between an iPhone and an Android phone in both directions. The iPhone now finds and announces link codes through the system's Bonjour service, which iOS permits, instead of a network method iOS blocks for sideloaded apps.
- On a phone with mobile data on, showing a link code or QR code now offers the Wi-Fi connection instead of sometimes the mobile data connection, which the other device on the Wi-Fi could not reach.
- Error messages across all dialogs now appear at the bottom of the modal below the back button and other action buttons, disappear immediately when pressing Back or Escape, and never follow into other views when connection attempts fail. In Scan QR Code, the switch camera button is centered in the controls row aligned with the viewfinder.
- Error banners in dialogs now auto-dismiss after a few seconds instead of remaining on screen, including pairing failures that previously stayed until you left the dialog.
- On Android, using the system back gesture in the app no longer navigates back into the "Account connected" page or completed OAuth sign-in screens after the confirmation has closed.
- Transferring settings to another device with Link Devices now also carries over the Include Beta Releases update setting and the Appearance theme, so the new device matches the old one.
- In Link Devices, failure messages now explain in plain language what went wrong and what to try next instead of showing internal error text, and error messages in all dialogs have centered text with the same spacing to the bottom of the dialog.
- On desktop, provider sign-in windows now open at the full width of the main window so they cover it.
- On Android, starting a Grok sign-in when already logged into an account now clears the existing browser session so the standard sign-in screen appears instead of immediately reconnecting the previous account.
- On desktop, remembered window positions and sizes now track only the main window, preventing temporary sign-in popups from altering saved window state.
- The plus icon on the empty dashboard's Other button no longer shrinks to a dot when the button is short on space; the icon keeps its size and the label truncates instead.
- The empty dashboard's Other Provider button is now labeled Other so it fits next to Link Devices on narrow screens.
- The empty dashboard's Other and Link Devices buttons now use the same bright text color as the provider names above them instead of a dimmer gray.
- The empty dashboard's Other and Link Devices buttons now use slightly smaller text than the provider names so the buttons sit visually below the provider cards.
- The provider dropdown in the Add Account dialog no longer opens misaligned from its button inside the modal.
- On Android, dropdown menus inside dialogs (such as the provider filter in Create Group, the provider list in Add Account, and the alert threshold in Usage Notifications) now open exactly under their button instead of shifted slightly to the right.
- Dropdown lists now end flush after the last fully visible option instead of cutting off the next one, so the space below the last option matches the space above the first.
- The chevron on the Settings dropdowns (Appearance, Account Updates) now rotates smoothly when opening, matching the dropdowns in dialogs, instead of snapping between up and down.

## v0.4.4 - 2026-10-14 (28 changes)

### Improved (6)

- In Link Devices, technical failure details are replaced by plain-language messages that say what the app was doing and what to try next, and screen readers now announce each step (connecting, confirming, transferring, success) and speak failures as alerts, moving focus to the Try Again button. The send/receive choice cards no longer pretend to be page headings to assistive technology.
- Deleting an account group and discarding unsaved edits now use the same confirmation dialog as removing an account: it says exactly what is lost and what stays, and cancelling it returns to the form with your edits untouched. Focus now reliably returns to the button that opened a dialog when the dialog closes.
- Keyboard focus is now clearly visible across both themes on custom dropdowns, account cards, alert checkboxes, and summary cards.
- Custom dropdowns now announce their purpose to screen readers (such as "Theme", "Refresh interval", "Alert threshold", or "Provider") rather than only their current value, support Home and End keys to jump to the first and last options, and reliably return focus to the trigger button when closed.
- Navigating between views or selecting a different group in the sidebar now moves focus to the view's primary heading so screen readers announce the new page title and keyboard navigation begins at the main content.
- On mobile devices, compact buttons including the account card actions menu, rename buttons, group edit button, and toast and error dismiss buttons now provide comfortable touch hit areas meeting accessibility guidelines.

### Fixed (23)

- The Sign in with Google window is now taller, so the 2-step verification page fits without scrolling.
- The Paseo Bridge window now opens tall enough to show its connection details without scrolling.
- In Link Devices, a failure notice now has space above and below it, so it no longer sits on the buttons underneath.
- In Link Devices, Back is on the left when a transfer could not be prepared. Try Again is on the right.
- In Link Devices, Show Link Code, Enter Link Code, Show QR Code, and Scan QR Code now leave the same space under their description as Send, Receive, and the transfer-settings choice.
- The Advanced heading in Settings now shows its full keyboard focus ring. The left side was cut off.
- In Link Devices, the Send and Receive choices now leave the same space between their description and the bottom of the card as the transfer-settings choice.
- Settings switches, such as Launch at Startup, now show a purple focus ring when you reach them with the keyboard, matching the dropdowns and buttons on that page.
- In the light theme, usage reminder toasts, the error banner at the top, and the startup screen now use theme-aware colors, so their text is readable instead of dark-on-dark, and hovering the air-gap playback buttons no longer turns the text white on a light background.
- Clicking outside the Link Devices dialog no longer closes it while a transfer is running; previously the backdrop bypassed the busy guard that the close button and Cancel already used.
- Notification settings and the other dialogs now block every dismissal path (Escape, backdrop, close button, Cancel) while a save is in progress, instead of only some of them.
- When preparing an animated air-gap transfer fails, the dialog no longer spins "Preparing animated transfer…" forever; it now shows what went wrong with Try Again and Back options.
- On iPhone, usage reminder toasts no longer sit under the home indicator; they now respect the screen's bottom safe area like on Android.
- The camera error screen in Link Devices no longer sweeps the scan beam as if it were still scanning, and it now offers a Retry Camera button that restarts the camera.
- After a failed pairing link and other failed joins, Try Again now repeats the connection that failed instead of just returning to the connection choices.
- When the shown link code's countdown reaches zero, Link Devices now says the code expired and offers Generate New Code instead of leaving a dead code on screen.
- The Add Account dialog's backdrop now behaves like its close button: clicking outside during sign-in closes the dialog and cancels the sign-in, instead of doing nothing.
- Closing the group editor or the Add Account dialog with Escape, the backdrop, the close button, or Cancel no longer silently throws away unsaved changes; the dialog first asks whether to discard them.
- The account summary strip now shows the total account count on the Accounts card, and the Action Needed card is now a native interactive button that avoids repeating the account count in its helper text.
- The link code entry input in Link Devices is now properly named for screen readers.
- In Link Devices, the Retry Camera button in the camera permission error now leaves the same space above it as below it.
- In Settings, the Advanced keyboard focus ring now lines up with the edge of the settings cards, its label stays aligned with the other section titles, and the chevron sits as close to the ring on the right as the label does on the left, whether it points right or down.

## v0.4.3 - 2026-10-14 (20 changes)

### Added (1)

- The empty dashboard now includes a Link Devices option next to Other Provider, aligned with the provider cards, so you can sync accounts from another device without signing in again.

### Improved (10)

- On a computer, sign-in windows for Claude, ChatGPT, Grok, Antigravity, and OpenCode now open centered directly on the main AI Usage Tracker window and cover 96% of its area, and the Google sign-in popup opens centered directly on its opener instead of jumping to arbitrary positions.
- On desktop, the "Sign in with Google" window is now larger (640×800) and resizable, so all account details, terms, and action buttons fit comfortably without vertical scrolling or an overlapping scroll prompt.
- When an account is connected, usage data is now pre-fetched in the background during the five-second countdown, so account percentages and gauges appear immediately on the dashboard when returning instead of waiting for a separate refresh.
- Connecting a Grok or OpenCode account now ends on the same "Account connected" page as the other providers, with the account's email and a five-second countdown back to the app.
- In the Add Account modal, OpenCode now appears above Google AI Studio and below xAI Grok in the provider dropdown.
- Clicking Other Provider on the empty dashboard now defaults to OpenCode Go in the Add Account modal dropdown.
- The sidebar AI Usage Tracker title uses the same purple as the All Accounts title.
- On Android, the app icon fits the launcher's icon shape, whether circle or rounded square, with the whole gauge visible instead of its outer ring being cut off at the edges.
- On macOS, the app icon has the same margin as other Mac app icons, so it is no longer larger than its neighbors in the Dock, and it stays sharp on Retina displays.
- On a computer, the window title bar uses the same purple as the Android status bar, and the window title is white so it stands out.

### Fixed (8)

- On desktop, the "Sign in with Google" popup window now closes automatically when sign-in finishes, revealing the Claude authorization prompt instead of remaining open on top of it.
- The "Account connected" page now stays up for its full five-second countdown, on a computer and on a phone. It had sometimes closed with one or two seconds left, most often for Antigravity, because the app started timing before the page had appeared.
- The iPhone app opens again instead of showing only a black screen. Since v0.4.1, the app was blocking its own start page from loading on iOS.
- The iPhone app's home screen icon is the AI Usage Tracker gauge instead of the Tauri logo.
- On iPhone, signing in to Claude, ChatGPT, Antigravity, Grok, or OpenCode no longer closes the app when the sign-in page opens or when the app reads the finished sign-in.
- On a computer, the dashboard scrollbar is purple again, matching Android. A recent WebKit change had been drawing it in native gray.
- Signing in with a Google account for Claude, ChatGPT, Antigravity, or Grok no longer fails at the last step (Claude showed "There was an error logging you in"). The sign-in window was blocking the step where Google also signs the account in to YouTube.
- "Continue with Google" on the Claude sign-in page works again. On a computer, Google's sign-in opens in its own small window that closes when Claude has the result; on iPhone it opens over the app with a Close button, instead of ending on a black screen. On iPhone it also closes on its own once Claude moves to the Authorize page, instead of staying on a black screen that hides it.

### Security (1)

- On Android, a saved sign-in that the phone's secure storage couldn't encrypt is no longer used. Its account is paused, and the app asks you to retry or to remove the account and sign in again, so the new sign-in is stored encrypted. Before, such a sign-in kept working unencrypted.

## v0.4.2 - 2026-10-12 (3 changes)

### Improved (1)

- Custom groups in the sidebar now show a combined icon made from the providers of the group's first four accounts, in its order — side by side for two accounts, two stacked beside one for three, and a two-by-two grid for four or more — instead of only the first account's provider icon.

### Fixed (2)

- The update window's "What changed" list now shows the full list of changes as plain text, without the "Show more" fold markup or the "Which download should I use?" section.
- Editing a group always opens with the account filter on All Providers; a group whose accounts belong to one provider no longer hides the other providers from the picker.

## v0.4.1 - 2026-10-12 (38 changes)

### Improved (10)

- OpenCode Go account setup no longer requires entering an email address; the field is optional and the address is automatically extracted from your session when available.
- The Back button on in-app sign-in sits closer to the status bar, and its chevron is as bold as the label.
- The "Account connected" page now shows the account email in purple and includes a prominent 5-second countdown number before closing automatically, and mobile in-app sign-in views remain on the connected screen for 5 seconds before returning to the dashboard.
- The All Accounts and App Settings titles, the installed version in Settings, and the sidebar edge while you resize it now use the same purple as the usage bars.

- In Settings, the Appearance dropdown keeps a consistent width across Dark, Light, and System themes, and the dropdown menu aligns flush with the button.
- When the current version has already been released, the next scheduled release is now published as the next full version (for example 0.4.2) instead of a beta pre-release.
- Every scheduled release now includes the Windows, Android, macOS, and iOS builds, so a Thursday release is no longer missing the macOS and iOS downloads.
- Dragging a sidebar group now rearranges the account cards on the All page immediately, instead of after a short pause while the new order is saved.
- On Android, Wi-Fi only stays in its battery-hungry multicast mode while device sync is running, instead of the whole time the app is open.
- Each release's download notes now explain the security warning Windows and macOS show the first time you open the app, and how to continue.

### Fixed (12)

- The Back button now stays on Grok and OpenCode when those sign-ins continue with Google, including on the Android Google account page.
- The Back button now stays on the Antigravity sign-in page.
- In Settings, the space between the Automatic Updates title and its description matches Change Log and the other settings rows.
- Dropdown menus anywhere in the app, including the actions menu on account cards, open upward instead of downward near the bottom of the window, so no item is ever cut off.
- A usage refresh that times out while the provider is renewing an account's sign-in no longer loses the renewed sign-in, so the account no longer asks you to sign in again afterwards.
- A sign-in that finishes at the same moment it times out, is canceled, or hits an error is no longer reported as failed even though the account was added.
- Moving an account card on the All page now moves its sidebar group to match, the same way dragging a sidebar group already rearranged the All page.
- Dragging a sidebar group no longer pulls accounts that belong to a custom group out of it on the All page; they stay with their custom group.
- Links in update notes and update error messages that the app cannot open are now shown as plain text instead of links that do nothing.
- Removing an account and adding it back no longer leaves the sidebar and the All Accounts page in different orders; both now follow the same account order.
- Signing in now offers the account chooser even when you are already signed in elsewhere, so adding a second or third account signs in the intended one instead of reusing the first session. Entering the account's email address in Add Account selects it directly.
- Provider sign-in pages, including the Google account chooser, now have a Back button at the top left that returns you to the app.

### Security (16)

- The local usage API's access token check takes the same time no matter how long the presented token is, so timing cannot reveal the token's length.
- While device sync is waiting for another device, it accepts connections only on the network address shown in its QR code and join code, not on every network the computer is connected to, such as a VPN.
- On Android, a web page opened inside the app during sign-in can no longer be mistaken for the app itself when it sends requests to the app's backend.
- Android in-app updates now download only from this app's GitHub releases and install only when the update is signed by the same certificate as the installed app.
- During an Android in-app update, the downloaded installer file is no longer readable by other apps that can open APK files.
- On Android, other apps can no longer open the update dialog with text of their choosing.
- Other programs on your computer can no longer lock Paseo out of the local usage API by flooding it with requests that lack the access token.
- On Android, other apps can no longer start AI Usage Tracker by pretending the phone has just started up; on phones that used the vendor "quick boot" signal, start at boot now only follows a normal boot.
- The Android app no longer declares the "nearby Wi-Fi devices" permission, which it never used.
- Error messages no longer show file paths that include your user name.
- Sign-in error messages no longer include parts of the provider's reply.
- On Windows, start at login now runs the app by its full quoted path, so a program placed at a shorter path cannot be started in its place.
- Showing or copying the Paseo Bridge token, and starting an air-gapped transfer, now ask for confirmation in a system dialog that web content inside the app cannot answer.
- On Android and iOS, while you sign in inside the app, the app window only opens the provider's sign-in pages, so a link on those pages cannot load another site inside the app.
- Another program on your computer, or a web page, can no longer cancel a sign-in in progress or change its error message by sending a request to the app's sign-in callback.
- Device sync only waits for another device on a local network address; on a device with no local network address it now says to connect to Wi-Fi, instead of listening on a public or every available address.

## v0.4.0 - 2026-10-07 (27 changes)

### Changed (15)

- In the device sync air-gap confirmation view, the captured frame count sits above the verification heading with balanced spacing.
- On an empty dashboard, the description reads "Add an account to begin monitoring its usage limits."
- In Create Group and Edit Group, the provider filter lists providers in alphabetical order. All Providers stays at the top.
- On an empty dashboard, the space below Other Provider is half as tall, so the panel ends closer to that button.
- On a computer, the add-account window is narrower, and the create-group window is narrower still. The provider lines in those menus still stay on one line.
- The "Account connected" page shown in the browser after signing in now shows the provider's icon and name side by side, with the signed-in email on the next line. It was a bare email or just "ChatGPT", and it now looks the same for ChatGPT, Claude, Antigravity and AI Studio.
- In Settings, the space above the General, Updates, Devices and Advanced headings is a uniform 18px, including above General on mobile.
- An empty group keeps its own page, with Edit Group and Delete Group and no "Account" button. Any other empty page shows the same provider cards as the empty All page instead of an "Account" button.
- The sidebar + Account button's tooltip says "Add new account" and the + Group button's says "Combine accounts into a group to easily track usage", wrapping onto more than one line.
- The bell button on an account card says "Update account alerts" when hovered.
- Hovering the drag handle on a sidebar row or an account card says "Drag to reorder".
- SideStore can install the app on iOS 16 and later.
- On desktop, when the window is narrow enough that the Next reset card drops to its own row, the empty dashboard's OpenAI and xAI cards drop to the next row with it.
- On an empty dashboard, the button under the provider cards says "Other Provider".
- On an empty dashboard, the space above the provider icon is half as tall, so the heading and provider cards sit higher.

### Fixed (12)

- The dropdown menu button on account cards now centers its arrow inside the square on mobile and desktop.
- The Create Group provider menu stays the same width when it opens, and the selected checkmark sits apart from the provider name.
- Opening a dropdown menu no longer jumps the window it sits in.

- On iPhone, every sign-in page now has a "Back to AI Usage Tracker" button in the top-left corner, so you can leave without finishing the sign-in.
- On iPhone, "Continue with Google" on the Claude, Antigravity and OpenAI sign-in pages opens in the same screen instead of doing nothing, and the sign-in pages now see an iPhone browser.
- Signing in to ChatGPT on iPhone no longer ends with "OpenAI token exchange failed (400 Bad Request)". The sign-in result was being used twice, and a code only works once.
- Connecting Grok on iPhone no longer crashes the app on the second and later attempts. The app now reads the sign-in cookies once per check instead of four times.
- Antigravity sign-in on iPhone no longer fails the first time for the same reason as the ChatGPT error.
- When an Android update is for a different app, Settings now explains that and links to the GitHub releases page instead of saying "The update is for a different app."
- The drag handle (three dots) on a desktop account card lines up with the middle of the provider icon again, instead of sitting off to the side of it.
- Connecting Grok no longer gets stuck on "Completing sign-in" after you sign in. The sign-in window was blocking a device-verification page, which is now allowed. Blocked pages are also noted in the diagnostics log.
- Hovering Other Provider on the empty dashboard uses the same light purple as the Claude, Google, OpenAI and xAI cards, instead of a dark grey.

## v0.3.18 - 2026-10-07 (2 changes)

### Added (1)

- On iOS, turning on a usage alert asks for notification permission the first time, so alerts can be shown.

### Changed (1)

- The app now installs as com.dubba.ai.usage.tracker. An existing Android, Mac, or Windows install stays as it is, and the new copy starts without those accounts or settings.

## v0.3.17 - 2026-10-07 (15 changes)

### Changed (9)

- On desktop, the Accounts, Action Needed and Next reset summary tiles are three separate cards again, instead of one joined strip.
- The sidebar no longer shows an "Accounts" title above the account list. Its narrowest width now comes from the sync line at the bottom, so "Accounts synced" is never cut off by the refresh or settings buttons.
- On desktop account cards, the plan badge and its status dot line up with the middle of the action buttons, and the bell and remove icons sit centered in their buttons.
- On desktop, Move up and Move down are arrow buttons beside the refresh button instead of items in the card's dropdown menu. The dropdown remains on mobile.
- On desktop account cards, the refresh, notification, and remove buttons use the same green, amber, and red as those actions in the mobile dropdown menu.
- On desktop, the Move up and Move down arrow buttons use the same neutral color as the Move up and Move down items in the mobile dropdown menu, and their border matches that text color.
- The sidebar's sync line now reads "Accounts synced 9m ago" instead of "Synced all accounts 9m ago", and the time is when every account was last synced rather than when the most recent one was.
- On mobile, the sidebar's refresh and settings buttons stay pinned to the drawer's right edge, and the sidebar can shrink until the sync text meets them. Its minimum was measuring the text twice, so it stopped short and left a gap.
- On mobile, the settings button lines up with the right edge of the account cards, and the refresh and settings buttons stay on the drawer's right edge as it resizes. The gap between them is 8px.

### Added (4)

- A Refresh all button in the sidebar, next to Settings, refreshes every account without needing the keyboard shortcut. It spins while a refresh is running, and the sidebar will not shrink narrow enough to cut off the sync text beside it.
- iOS support via SideStore: added SideStore community source manifest, release workflow for unsigned IPAs, and in-app update prompts tailored for iOS sideloading. The release workflow records the IPA's exact size in the stable source on `main` and leaves pre-releases out of it.
- Automated scheduled releases with GitHub credit protection: Windows and Android publish on Thursdays and Sundays @ 11:59 PM EST, while macOS and iOS (SideStore) publish once a week on Sundays @ 11:59 PM EST. A pre-flight commit check skips execution entirely when no new code has landed.
- Automatic beta version fallback in release workflow: scheduled builds with unbumped versions automatically calculate and publish the next patch beta pre-release (e.g. `v0.3.17-beta.1`) across Windows, Android, macOS, and iOS.

### Fixed (2)

- Reconnecting an account that needs attention now updates that account instead of adding a second one beside it. This was most visible with ChatGPT, whose sign-in sometimes reports an identity that differs from the one saved earlier.
- On mobile, the sidebar's minimum width counted its side padding twice, so it stopped resizing while there was still a wide gap between the sync text and the refresh button. It now resizes until the gap left of the refresh button matches the gap between the refresh and settings buttons.


## v0.3.16 - 2026-10-06 (8 changes)

### Improved (4)

- Usage bars above 30% on the sidebar and account cards are purple again.
- The sidebar + Account and + Group buttons are 32px tall.
- In the sidebar, + Group lines up with the right edge of the cards. Shrinking the sidebar stops at that row, with a little padding, and it can still be widened.
- Settings descriptions are shorter for appearance, launch at startup, account updates, the change log, and diagnostics.

### Security (4)

- Show QR Code now warns that a photo or screen recording of the animated frames can decrypt the accounts in that transfer.
- Wi-Fi pairing now asks you to compare all three groups of the verification code, and the connection is refused unless both devices confirm that full code. An older version of the app can no longer finish pairing.
- On a phone, an account whose saved sign-in could not be locked says so on that account. The app keeps trying to lock it, and the sign-in still works.
- Android sign-in only treats a reply as local when its host is exactly localhost or 127.0.0.1.


## v0.3.15 - 2026-10-06 (10 changes)

### Added (2)

- The empty dashboard now features one-click setup cards for popular providers (Anthropic Claude, Google Antigravity, OpenAI ChatGPT, and xAI Grok) with a quick fallback for custom or other providers.
- Settings is now organized into dedicated sections (Display, Updates, Devices) with Diagnostics, Paseo Bridge, and Keyboard Shortcuts tucked into a collapsible Advanced section.

### Changed (4)

- Add Account now lists Anthropic Claude first in the provider dropdown and defaults to Claude when opened without a preselected provider.
- Header "+ Account" and "+ Group" buttons are taller with larger icons and bolder text for easier clicking and tapping.
- Healthy usage bars and progress tracks now display green instead of purple, keeping purple focused on interactive chrome and badges.
- Dashboard summary cards now form a continuous strip, and the accounts metric is labeled "Healthy" instead of "Active".

### Improved (3)

- Screen readers now announce quota progress bars with their remaining percentage and label via accessible progressbar roles.
- The mobile account card action menu now supports full keyboard navigation (Escape to close with focus returned to the trigger, Arrow keys to navigate, Home/End).
- Transitions and animations are now disabled when your system prefers reduced motion.

### Fixed (1)

- The Action Needed summary card now displays a warning icon instead of a checkmark when accounts require attention.


## v0.3.14 - 2026-10-05 (10 changes)

### Improved (7)

- Wording is now consistent: the account menu says "Remove" (as on desktop), the collapse control says "Collapse", and "Show all" buttons use sentence case.
- The menu button now tells screen readers whether the navigation menu is open and which panel it controls.
- Account cards now show a small chevron on the provider icon so it is clear the icon expands and collapses the card. A collapsed card shows its lowest remaining percentage (colored by how low it is) beside the plan badge.
- The two percentages beside each sidebar group now have a tooltip ("Average left: 5-hour | 7-day"), and a missing 5-hour value shows "—" like the 7-day one instead of "NA".
- Secondary gray text (such as small labels in the sidebar footer and window pills) is a little brighter in Dark theme and darker in Light theme, so it is easier to read.
- On desktop, the account card header is less crowded: Move up and Move down are now in a "More actions" menu next to Refresh, Notifications and Remove, instead of two extra icons. Dragging and Alt+Arrow still reorder. The menu button now names the account for screen readers.
- The dashboard subtitle now describes the page you are on (all accounts, a provider, or a group) with its account count, instead of the same sentence everywhere.

### Fixed (3)

- Group save/delete and rename failures now show a readable message with the reason, instead of raw text such as "Error: …" or a generic "Unable to rename".
- Account Updates in Settings no longer shows "15 minutes" when the real interval is something else (for example after a device transfer from another version). Unusual intervals are now rounded to the closest option (such as 35 minutes to 30).
- The "Accounts / Active" card on the dashboard now counts only accounts that are live, instead of every account. Accounts that need attention are counted in the Action Needed card.


## v0.3.13 - 2026-10-05 (21 changes)

### Added (1)

- Light and dark themes. Choose Dark, Light, or System under "Appearance" in Settings; the choice applies immediately, is remembered, and also themes the window title bar and the Paseo Bridge window. Dark stays the default.

### Changed (6)

- Settings rows have less space above the titles and below the descriptions.
- In Settings, Auto-Start is now "Launch at Startup" with the description "Automatically start the app when your device starts.", Automatic Updates now has the description "Automatically check for new versions.", and Beta Releases is now "Include Beta Releases".
- Tapping Check Now in Settings no longer shows a separate "update available" notification, because the Settings page already shows the new version next to the button.
- In Light theme, the hamburger, account-name pen, account-card menu, Settings sidebar button, and account-card provider icon square use a white fill (icons and text black where they were already restyled). Those chrome buttons, plus Link Devices, Appearance, Account Updates, View, and Copy, use a darker purple outline so it reads on white. Opening the account-card menu or Account Updates dropdown uses a purple fill; closing them (second tap or choosing an item) returns the trigger to white. The pull-to-refresh chip is white in Light.
- In Light theme, purple-filled action buttons (Check Now, + Account, + Group, Connect to Device, Open ChatGPT Login, Open Claude Login, and the other primary buttons) now use white text. Dark theme keeps the original dark indigo on the light purple fill.
- The empty dashboard CTA is now "+ Account", matching the sidebar button.

### Fixed (14)

- On mobile, the hamburger, page title, and the sidebar's close button now sit vertically centered in their header, with an equal 10px of space above and below.
- The mobile status bar is now the same purple in Dark theme as in Light theme, so the clock and battery stay readable.
- Scroll bars now use the same purple as the mobile status bar in both themes.
- Sidebar and account-card usage bars, and the plan badge (Pro/$20, Free, ...), now use the same purple as the status bar and scroll bars. Amber and red low-usage bars are unchanged.
- In Light theme, the text inside plan badges (Pro/$20, Free, ...) is white, matching Dark theme, instead of black.
- The selected Settings button in the sidebar no longer has a thick left-edge bar; it uses the same uniform 1px purple outline and fill as the buttons on the Settings page.
- In Light theme on mobile, the status bar is now actually painted the same purple as Check Now. The earlier background strip sat behind the page, so the clock and battery were still hard to see.
- In Settings, the Automatic Updates toggle lines up with the title, matching Launch at Startup and Include Beta Releases, instead of sitting lower against the description.
- In Light theme on mobile, the Android status bar uses the same purple as Check Now so the clock, battery, and other system icons stay visible.
- Account-card error messages no longer touch the provider icon row above or the first usage-limit pill below; they have 10px of space on both sides.
- Account-card error messages are vertically centered between the provider icon and the first usage-limit pill, with equal spacing above and below.
- If an in-app update fails (for example because the APK is not signed with this app's certificate), the error now shows inside the App Update modal as well as on the Settings page.
- In Light theme, the Local Device Sync link code, code-entry field, and confirmation code are readable instead of white-on-white, and the Confirm step's Back button is the same red as the other pairing Back buttons.
- In Light theme, the mobile hamburger menu icon is readable instead of white-on-white.


## v0.3.12 - 2026-10-02 (24 changes)

### Added (1)

- Desktop keyboard shortcuts: Cmd/Ctrl+R refreshes all accounts, Cmd/Ctrl+N opens Add Account, Cmd/Ctrl+G opens Add Group, and Cmd/Ctrl+, opens Settings. They are listed under "Keyboard Shortcuts" in Settings (desktop layout only), and do nothing while a dialog is open.

### Improved (12)

- On mobile and touch devices, tapping the Settings button in the sidebar no longer shows a tooltip.
- Scroll bars are now a slightly more visible purple (#A078FF at 65% opacity, up from 45%), and the plan badge on account cards uses the same purple at 65% opacity.
- On account cards, the remaining percentage text now turns amber at 30% or less and red at 15% or less to match the progress bar.
- Unified the red accent color across the app: the Delete action in the account dropdown menu, and critical progress bars and percentages (<= 15%) now all use the signature red (`#c53131`).
- Updated the mobile hamburger menu button icon color to bright white to match the active state of the sidebar Settings button.
- In the sidebar, left-aligned the out-of-date accounts detail text with the sync status label above it instead of aligning to the status dot.
- Updated the sidebar Settings button, Settings action buttons (Link Devices, View, Copy), and the Account Updates dropdown to use crisp white for their inactive and active states.
- In the sidebar, increased the sync status text font size to 14px for better legibility.
- Tapping an Android update notification now opens the app directly to the "App Update" dialog showing release notes and the update action instead of the dashboard.
- Error banners now say what went wrong in plain words and what to do next (for example "Check your internet connection and try again") instead of showing technical text. The technical detail is added to the report from Copy Diagnostics, with email addresses and token-like text removed.
- Numbers now use equal-width digits throughout the app, so percentages, countdowns and counters no longer shift sideways as they change.
- Better screen reader and keyboard support: the Settings toggles are now announced as switches with their setting name (including Auto-Start, which had no name), every button has an explicit type, and the camera scanner area can be activated from the keyboard.

### Changed (9)

- The window limit labels on account cards (5h, 7d, 30d) now sit in a rounded pill with an orange, sky blue, or violet outline and tint, and the text inside is the same white as the percentage.
- The plan badge on account cards (Pro/$200, Free, and so on) now has a violet background with the same white text as the percentage.
- In the sidebar, shortened the sync status label from "Last synced all accounts" to "Synced all accounts".
- In the sidebar, resized the circular Settings button to 40×40px to match the pull-to-refresh circle size.
- In the sidebar, Settings is now a circular button placed on the right of the sync status bar, and inactive group cards and the settings button share a clean neutral black surface with purple selection styling.
- In Settings, updated the buttons (Link Devices, View, Copy) and the Account Updates dropdown to match the dark surface, purple border, and purple highlight styling.
- On desktop, the account card buttons now run in the same order as the mobile menu (Move up, Move down, Refresh, Notifications, Delete), and the Delete button is drawn quieter with extra space before it, turning solid red only on hover or keyboard focus.
- Usage bars and percentages now turn red at 15% remaining or less (previously 10%); the amber warning stage at 30% is unchanged.
- On mobile, the plan badge on account cards (Pro/$20, Free, and so on) is now 22px tall, the same height as the dropdown button beside it.

### Removed (1)

- In the sidebar, removed the Refresh All button from the sync status bar.

### Fixed (1)

- Progress bars and percentage numbers in the sidebar now properly turn amber at 30% or less and red at 15% or less to match the dashboard, instead of remaining purple.


## v0.3.11 - 2026-10-01 (25 changes)

### Added (3)

- In the sidebar, added an "+ Account" button beside the "+ Group" button to open the Add Account dialog directly from the sidebar.
- In the sidebar, added a circular purple "Refresh All" button beside the sync status line to trigger a refresh of all accounts.
- On mobile, added a Chrome-style pull-down-to-refresh gesture when the dashboard is at the top, displaying a floating circular refresh indicator that triggers "Refresh All" on a long pull.

### Improved (12)

- In account cards, balanced the vertical spacing around the progress bar and matched the gap above subsequent usage limit panes to the distance above the first limit pane.
- In Settings, capitalized all main words in section headings including "Start on Device Boot", "Include Beta Releases", "Enable Paseo Bridge", and "Integration Window".
- In Settings, updated the Diagnostics Copy button to use the primary purple button style matching Link Devices and Check Now.
- In the sidebar, repositioned the Settings button above the Refresh All and account sync status line.
- In the sidebar, styled the Settings button to match the primary purple look and feel of the "+ Account" and "+ Group" buttons.
- In the sidebar, updated the Refresh All button to match the dark elevated surface, purple border, and styling of the pull-to-refresh indicator.
- In the sidebar, repositioned the Refresh All button to the right of the sync status text in a balanced space-between toolbar layout and adjusted its tooltip alignment.
- In Settings, updated the Change Log and Integration Window "View" buttons to match the background, border color, and crisp white font color of the Account Updates dropdown menu.
- In the expanded mobile sidebar, styled the close button with a red background, red border, and crisp white X matching modal close buttons, and increased the size of the X across all modal close buttons.
- Matched the border color around the mobile header hamburger menu button to the exact color of its three icon lines.
- In the sidebar and model cards, removed the glow from the Refresh All button and matched the hamburger, card dropdown, and card edit pen buttons to its look and feel.
- In the dashboard summary cards, unified the stroke thickness, size, and styling of the Accounts, Action Needed, and Next Reset icons with an SVG alert icon and a brighter white color.

### Changed (9)

- Button labels now consistently use Title Case (for example "Open ChatGPT Login", "Select All", "Try Again", "Copy Diagnostics").
- Settings toggle labels now name the setting instead of giving an instruction: "Paseo Bridge", "Automatic Updates", "Beta Releases", and "Auto-Start on Device Boot" / "Auto-Start at Login".
- The usage bar on account cards now changes color with how much is left: purple normally, amber at 30% or less, and red at 10% or less.
- On mobile, the account card's "More actions" button is now the same size as the rename button, and the Settings toggles are slightly larger (48×24).
- Account cards now show each usage window's label on its divider line, with the progress bar below it and the remaining percentage (for example "57% left") and reset time under the bar.
- On mobile screens, reduced the bottom padding of account cards from 14px to 12px to match the card's horizontal padding.
- In the device pairing modal, the option to transfer settings and layout configuration is now checked by default.
- In Settings, simplified the Diagnostics description to note that bug reports have tokens, cookies, and emails removed.
- In the device pairing modal, shortened the settings toggle label to "Transfer settings & layout config:".

### Removed (1)

- Removed the redundant "Add Account" and "Refresh All" buttons from the main dashboard header and the mobile bottom actions footer.


## v0.3.10 - 2026-10-01 (53 changes)

### Added (1)

- Settings now has a Copy diagnostics button (also on the start-up error screen) that copies a report for bug reports: versions, settings, each account's status, and recent activity. Tokens, cookies, email addresses, and your user name are removed, and the app now keeps a small activity log to make problems easier to trace.

### Improved (16)

- On narrow screens the navigation menu now behaves like a proper dialog: Escape closes it, Tab stays inside it while it is open, focus returns to the menu button when it closes, and its buttons can no longer be reached while it is hidden.
- The Action Needed card is now announced with its count and a short instruction for screen readers, and its hint no longer says "Click", which did not fit touch screens.
- Dragging, reordering, and other layout changes no longer trigger extra background account lookups.
- Account card 5h/7d pills now include the model name for every provider, for example `7d limit · GPT`, `7d limit · Claude`, and `7d limit · Grok`.
- Settings now has an Include beta releases switch (off by default). When on, Check Now also offers beta pre-releases on Android, Mac, and Windows. On Mac and Windows a beta installs in the app like any other update.
- Refreshing a long list of accounts now happens a few at a time instead of all at once, which is gentler on your network and on the providers.
- Accounts that keep failing, or that a provider asks to slow down, are now retried less often (honoring the provider's requested wait) instead of on every update. Refresh and Refresh all still try immediately.
- Saving account updates is now lighter, especially on Windows, so the app stays responsive while many accounts refresh.
- Bucket group names are now limited to 80 characters, a group can hold at most 64 accounts, and you can have at most 64 groups, with a clear message when a limit is reached.
- The dashboard now shows when your data was last refreshed ("Last synced 5m ago"), says "Syncing…" while a refresh is running, and warns when some accounts have been left out of date.
- Countdowns and "Updated … ago" labels now update without redrawing the whole dashboard every second, so the app uses less CPU while it sits open.
- Tools that read the local API together (for example Paseo and a script) can now each make a short burst of requests without slowing each other down.
- A Claude usage bar that is untouched and has no reset time yet now says "Starts on first use" instead of "Rolling window".
- Copy diagnostics now lists each account's usage bars with their remaining percentage and whether a reset time was reported, to help explain cards without a countdown.
- The “Last synced all accounts” status now sits at the bottom of the sidebar, just above Settings, instead of under the dashboard title.
- Simplified the update toggles in Settings by renaming "App Updates" to "Automatically Update App" and removing the subtitle text under both update toggles.

### Changed (1)

- The update progress is now consistent: the release-notes dialog shows the download percentage like the settings page, the settings page no longer repeats "Downloading…" or "Verifying…" above the progress bar, and the red update button just says "Downloading…" while the percentage stays on the progress bar.

### Fixed (20)

- If a link cannot be opened (the change log or a link in the release notes), an error now appears instead of failing silently or only showing in a tooltip.
- If your settings cannot be reloaded after linking devices, an error now appears instead of showing stale settings.
- If the first refresh after adding an account fails, you are now told, rather than seeing the account with no data and no explanation.
- Claude accounts no longer stop updating after a temporary "access denied" response from Anthropic; the last known usage is kept and the account keeps refreshing.
- A locked or briefly unavailable system credential store, or a slow refresh, no longer leaves an account needing to sign in again after its sign-in was renewed.
- Changing how often accounts update no longer refreshes every account immediately; the new interval simply applies to the next refresh.
- Removing an account while it is being refreshed no longer leaves its saved sign-in behind in the system credential store.
- If the app cannot load its saved data when it starts, it now opens with an explanation and a Try again button instead of closing without any message.
- If the system credential store is locked or unavailable at startup, the app now still starts; only the local API stays off, and Settings shows why.
- An account you removed can no longer come back after linking devices when the removal and the transfer happen at the same time.
- Dragging the same account card a second time no longer makes it vanish. Before, the first drag of a card worked, but dropping that card again left it hidden until you switched to another view and back.
- On Android, tapping Update no longer leaves the button grayed out on "Downloading…" forever; the update now downloads and opens the Android installer, or shows what went wrong.
- On Android, encrypting saved sign-ins with the Android Keystore, update and usage alert notifications, and keeping device linking on Wi-Fi now work instead of failing because the app could not reach Android.
- The update button no longer gets stuck or re-enables itself mid-download when an automatic update check runs during a download.
- Dragging a tall account card (one with many model rows) no longer seems to make it vanish: the card is now dragged as a compact preview so the rest of the list stays in view, and dropping it between cards or in the gap above Next Reset puts it where your finger is instead of sending it back down the list.
- On Android, a card drag that Android interrupts (for example right after a long-press) no longer leaves the card hidden until you switch views. The drag now finishes by itself, or when you touch the screen again.
- On Android, updating from Settings now ends with Android's own "App updated" screen with Done and Open buttons, so you can reopen the app right away instead of finding it closed.
- The All page now follows the order you set by dragging sidebar groups, instead of keeping an older order from an earlier card drag.
- The dashboard now catches up right after you finish dragging a card, instead of waiting for the next automatic refresh.
- Connecting Google Cloud usage no longer tells you to sign in again when Google is only temporarily unavailable; it now says the refresh failed and why, and only asks you to sign in again when the authorization has really expired.

### Security (14)

- Linking devices now ignores unsafe account identifiers sent by the other device and assigns a local one, so a modified transfer cannot write outside the app's credential storage.
- The verification code shown when linking devices is now longer (three groups of four characters), which makes it much harder for someone on the same network to get both devices to show a matching code. When linking with an older version, the first two groups still match.
- Linking devices now limits the size of names, groups, and layout data received from the other device, so an oversized or malformed transfer cannot bloat your saved data.
- On Android, saved sign-ins are now encrypted with a key held in the Android Keystore instead of being stored as readable files. Existing sign-ins are upgraded automatically the first time the app starts.
- The Paseo bridge window can now only view bridge details and manage its token; it can no longer use the app's other actions.
- On Android, the app now shares only the downloaded update and camera photos with other apps, instead of its whole storage folders.
- On Windows, the app's private files are now locked to your account by its security identifier, using system tools from fixed locations, so a look-alike program or a changed user name can no longer weaken that protection.
- The app's page security rules are stricter, and the macOS app no longer requests USB or microphone access it never used.
- Account error messages no longer include raw connection details or text copied from a provider's reply; only short, plain messages are kept and shown.
- On Android, if a saved sign-in cannot be encrypted, the app now keeps retrying automatically and shows a warning until it succeeds.
- The local API now also slows down requests that present a wrong token, so a tool on your computer cannot keep guessing at the access token without being throttled.
- On Android, an update is no longer installed unless its published checksum is available and matches the download; a release without a checksum is rejected with a clear message instead of being installed unverified.
- An OpenCode sign-in cookie that contains line breaks or other invalid characters is now rejected instead of being sent to the provider.
- The Grok sign-in window now recognizes x.ai sign-in pages by their exact address, so a look-alike page cannot impersonate the sign-in step.

### Removed (1)

- Copy diagnostics no longer appends a drag gesture trace to the report.


## v0.3.9 - 2026-09-30 (19 changes)

### Improved (6)

- Account cards no longer show a Remaining Limit heading. The 5h/7d window pill sits on the left of the reset line, with the countdown and date together, for example `Resets in: 6d 6h (Oct 6 @ 2:34 AM)`.
- Antigravity reset rows now place the model group inside the window pill, for example `7d limit · Gemini` or `5h limit · Other`.
- Account cards now show the window and reset line above the percent bar, using `Reset:` and a compact time such as `2:34a`.
- Account card 5h/7d pills now say `5h limit` and `7d limit` instead of `window`.
- Accounts and sidebar groups can now be reordered without dragging: each account card has Move up and Move down buttons (in the More actions menu on small screens), and Alt+Up / Alt+Down moves the focused account card or sidebar group. Screen readers announce the new position.
- Reset times now follow your system's 12- or 24-hour setting, and dates follow your region's order. English 12-hour times keep the compact style, for example `2:34a`.

### Fixed (13)

- Claude account cards now show only the 5-hour and 7-day limits, and no longer add extra rows named after Anthropic’s internal quota codes such as Nimbus Quill.
- Claude account cards now show the signed-in email address instead of “Connected account.”
- Android now shows a status-bar notification when a newer GitHub release is available, and keeps trying until notifications are actually allowed instead of treating a silent drop as success.
- Tapping Update on Android downloads the GitHub APK first, then opens the system installer. If Android still needs permission to install apps, that screen opens and the installer continues when you return.
- Desktop development and tests no longer ask for the macOS Keychain password. Production desktop builds still store credentials in Keychain.
- Error messages now stay on screen until you dismiss them (or the failing action succeeds), appear at the top of the window, and say what failed, instead of vanishing after five seconds at the bottom of the page.
- Refreshing, renaming, or removing several accounts at once no longer clears another account's spinner or lets the same action start twice.
- Usage-limit alerts now show at most five at a time and are announced politely by screen readers instead of each one interrupting.
- The hidden "Loading accounts…" text no longer shows on desktop while the dashboard loads.
- If the first account refresh at start-up fails, an error now appears instead of nothing happening.
- Claude accounts on a paid plan (Pro, Max, Team) no longer show as Free. The plan is now re-read from Claude on every refresh, so upgrades and changes appear without reconnecting.
- Accounts now refresh on schedule again after the device sleeps or the app is in the background. On Android, returning to the app triggers a refresh if one is due. On Mac and Windows, a refresh that came due during sleep now runs within about 30 seconds of waking instead of waiting out a full interval.


## v0.3.8 - 2026-09-29 (6 changes)

### Fixed (4)

- Claude Google sign-in on Android no longer stops on a black screen after “You’re signing back in to Claude.” The Google popup now returns to the Claude login page so the account can finish connecting.
- Rearranging account cards on Android no longer leaves a card stuck overlapping the Next Reset summary, especially when dragging a card to the top of the list.
- Clicking Update in Settings no longer gets stuck on “Downloading…” when the update check or download stalls: the update fetch now times out and falls back to the releases download page, and a stalled download reports an error instead of spinning forever.
- After an Android in-app update downloads, the system installer now opens. The APK is saved in a folder Android is allowed to share with the package installer.

### Improved (2)

- Desktop releases now publish signed automatic-update artifacts, so clicking Update in Settings downloads and installs the new version in the app instead of opening the releases page. Note: installs from before this change still carry the old update key, so they need one manual download to pick up automatic updates.
- When a newer GitHub release is available, Android shows a system notification that an update is ready to download. Tapping it opens the app.

## v0.3.7 - 2026-09-18 (41 changes)

## v0.3.7 - 2026-09-18 (41 changes)

### Security (16)

- Android backups are disabled so account credentials are not copied to cloud or device-to-device backup.
- Android in-app updates now verify the APK’s signing certificate against this app, and the published SHA-256 checksum when GitHub includes one, before prompting to install.
- Account token refresh now loads, refreshes, and saves credentials under a per-account lock, and a timeout cannot discard a token the provider already rotated.
- Google AI Studio no longer puts API keys in request URLs, and network failures show a generic message instead of raw request errors.
- Android cleartext HTTP is limited to loopback (`localhost` / `127.0.0.1`); other HTTP is blocked.
- In-memory credential caches now enforce bounded lifetimes with automatic expiration, securely zeroizing secrets from memory when forgotten or evicted.
- Link Devices QR code SVGs are structurally validated and strictly sanitized with tag and attribute allowlists prior to DOM injection, preventing script injection.
- External links, OAuth authorization flows, and update release note links now strictly enforce HTTPS and trusted host allowlists, preventing opening untrusted URLs.
- Offline camera transfer decompression enforces a strict 16 MB output limit before memory allocation to prevent decompression bomb denial-of-service attacks.
- Provider response and parsing errors are sanitized to fixed status messages, preventing raw error fragments or sensitive response data from leaking into account error state.
- Removed unused auth file path configuration from Grok credentials to eliminate potential arbitrary file read primitives.
- Development certificate trust is strictly scoped to code signing on macOS and confined to debug overrides on Android, preventing development certificate exceptions from affecting production builds or acting as root authorities.
- Sign-in now shuts down the local callback server as soon as you cancel, time out, or finish, and does not reuse a one-time authorization code if a later status poll retries the connection.
- Loopback sign-in advertises the address the app actually bound, including IPv6 (`http://[::1]:port`), so the provider callback matches the listening socket.
- Google Antigravity account identity comes from Google’s signed-in userinfo response, not from unverified ID-token contents.
- Camera access is limited to this app (`camera=(self)`) instead of allowing any origin.

### Improved (12)

- Styled the Settings button in the sidebar to match the All Accounts and group cards with consistent white font coloring, a purple highlight border, inset left accent bar, and gradient background when active.
- Account name editing now cancels and preserves the original name when clicking outside the input or pressing Escape, saving changes only when confirming with the checkmark button or Enter key.
- Renamed the header title badge when viewing a custom bucket from "Custom Group" to "Group".
- The What’s Changed update sheet no longer includes a Full Change Log button, and its Update button matches the red Update control in Settings.
- The Device Transfer setting now describes syncing accounts and credentials securely across devices, without implying it only works over local Wi-Fi.
- Refined the Integration window setting description to "View local bridge status, auth tokens and connection URL."
- Aligned dashboard and settings spacing across mobile and desktop: standardized desktop bottom padding to 24px, fixed the desktop settings header title gap to exactly 18px, set desktop settings card gaps to 16px, aligned the mobile header top padding to match the sidebar drawer's top padding, balanced header and drawer bottom padding to 12px, set mobile footer action bar padding to 12px above and 8px below buttons (vertically aligning with the sidebar Settings button), and unified mobile settings card gaps and bottom padding to 10px.
- The Settings header now matches All Accounts: no subtitle, the same gray bar and bottom border, and the same gap down to the first card.
- Android in-app updates now show download progress from 0–100% in Settings and a system notification, then switch to installing when the package is ready.
- Moved the Paseo Bridge integration controls to a dedicated section on the Settings page beneath Change Log, making bridge status and settings accessible alongside app preferences.
- Removed the redundant Dashboard navigation item from the sidebar since the All accounts view provides the same dashboard overview.
- The Active Accounts summary card is now display-only, removing redundant click-to-reset behavior now that clicking the Action Needed card directly toggles between filtered accounts and all accounts.

### Fixed (13)

- Fixed mobile header jumping and changing height after opening modals on Android by removing hardcoded status bar fallback insets and relying on real system window insets.
- Fixed the mobile summary cards text wrapping unexpectedly onto multiple lines when the vertical scrollbar is visible.
- Fixed the mobile All Accounts layout shifting horizontally when the scrollbar appeared by resetting asymmetrical inner card padding and gutter reservations.
- The sidebar menu header now uses the same space under the menu button as the All Accounts header.
- The Settings header now keeps the same space under the menu button as All Accounts, so the title is no longer tight against the header’s bottom edge.
- Settings no longer leaves an empty footer bar on mobile. That bar is only for All Accounts actions such as Refresh All and Add Account.
- Tapping Update on Android no longer jumps straight to a stuck “Installing…” state. The app downloads first, reports errors if the installer cannot open, and asks you to allow unknown-app installs before downloading when that permission is missing.
- Removed the debug readout box that followed the mouse pointer and listed the element under the cursor.
- Clicking and holding an account card on the dashboard now keeps the grabbing cursor instead of snapping back to the default arrow. Trash, notification, refresh, and other card buttons still show the pointing hand.
- Restored the required client secret on Google OAuth token refresh and authorization code exchange, fixing the "google token refresh returned 400 bad request" error when refreshing Antigravity and Google AI Studio accounts.
- Fixed the sidebar hover cursor so hovering over the "All" accounts card shows the standard click pointer and every reorderable group card (including the card directly below "All") consistently shows the grab hand.
- Check for updates now supports full SemVer 2.0 prerelease precedence (including numeric token ordering like `-unrel.10` vs `-unrel.2`) and correctly treats prerelease installs like `0.3.6-unrel` as older than the matching release (`0.3.6`), so Android can offer the release APK instead of reporting that you are already on the latest version.
- Fixed the missing "Opens in a new window" hover tooltip and accessible description on the Integration window View button in Settings, matching the Change Log button.

## v0.3.6 - 2026-09-18 (133 changes)

### Security (4)

- Hardened Link Devices pairing against low-order key attacks: the Elliptic-curve Diffie-Hellman step now rejects non-contributory (low-order) peer public keys on both devices, preventing a malicious pairing link from forcing a predictable session key.
- Restricted Link Devices pairing links to local network addresses only (private, loopback, link-local, or Tailscale CGNAT IP literals); pairing links pointing at public internet hosts or DNS names are now refused instead of connecting.
- Link Devices sessions can no longer be crashed by another device on the local network sending garbage handshakes: rejected connections are throttled and the session keeps listening instead of shutting down after 5 failures. A device that connects but disconnects or misbehaves before picking a transfer direction no longer blocks the pairing; the sharing device returns to waiting so the intended device can still join.
- Hardened Link Devices peer-to-peer authentication by rejecting low-order (non-contributory) Diffie-Hellman public keys that could produce predictable shared secrets, and requiring pairing connection hosts to be local network IP addresses (private LAN, loopback, link-local, or Tailscale CGNAT) to prevent accidental connection or exfiltration over the public internet.

### Fixed (51)

- After scanning animated transfer codes, the verification code now appears instead of getting stuck on “Checking captured frames…”.
- Transferring accounts to a device again now restores accounts you deleted on that device, instead of skipping them.
- Link Devices transfers no longer remove accounts on the receiving device when those accounts were deleted on the sending device. Transfers only add or update.
- Tightened Link Devices spacing: halved the gaps around the air-gap “compare this code” line, and matched the space above and below the “Keep this screen visible” instruction on Show code.
- Choosing Receive in Link Devices no longer offers Show QR code in step 2, since that path exports this device’s accounts.
- The “Receive accounts on this device” label wraps instead of using an ellipsis.
- The Scan the code camera-switch button sits in the gap to the right of the viewfinder instead of overlapping it.
- Show code plus “No, use camera transfer” now always displays the animated QR codes, including after choosing Receive in step 1, instead of opening the camera viewfinder.
- Opening Link Devices no longer blanks the window after choosing Send or Receive first; a hook ran only while the modal was open and crashed the screen.
- Confirm & Import after an offline camera transfer now stays on Transfer Complete instead of flashing that screen and returning to the Transfer PIN prompt.
- Fixed account card header layout on mobile so the plan tier badge (e.g. Pro/$20) is positioned directly next to the actions drop-down toggle.
- In the Link Devices modal on mobile devices, kept the "Transfer accounts & credentials securely over Wi-Fi." subtitle on a single line across all views by normalizing the modal's horizontal padding during virtual keyboard mode, adjusting mobile subtitle sizing, and preventing awkward hyphen breaks in "Wi-Fi".
- Restored in-app browser sign-in for OpenCode Go on mobile, matching the Grok login flow, and prevented desktop OpenCode sign-in from opening an extra window in the system's default browser.
- Renaming a Grok/Cursor account to "Grok" now keeps that name on the dashboard instead of snapping back to Grok/Cursor.
- Sidebar provider rows now use the same name as the account cards, including after you rename an account.
- Sidebar provider rows now follow the same oldest-to-newest order as the dashboard cards when you add accounts.
- Link Devices Scan QR on macOS desktops (such as a Mac mini with a USB webcam) opens the attached camera in the viewfinder again, including during `tauri dev`, instead of showing an error after the system permission check.
- On mobile, dashboard account cards can now scroll fully above the Refresh All / Add Account bar, and expanding or collapsing the last card no longer briefly covers that bar.
- Desktop Scan QR in Link Devices now asks macOS for camera permission so the system prompt can appear, instead of failing immediately with a denied-camera error.
- Fixed Link Devices transfers merging multiple distinct accounts on the receiving device when the provider supplied a shared project id instead of unique account identities (most visible with several Antigravity accounts, where only one survived the transfer while the summary counted the merged ones as "updated"), and hardened account matching so accounts with different emails are never merged.
- Fixed Link Devices resurrecting accounts you had previously deleted: deletions now leave tombstones that travel with transfers, so the receiving device removes its copy and never re-adds the deleted account.
- Fixed Link Devices join codes timing out on Android ("No device found with that pairing code") when the phone was any side of a code-based connection, by acquiring the system multicast lock Android requires for mDNS traffic.
- Fixed Link Devices failing to connect on the phone while a VPN-based ad blocker (or any VPN/DNS filter) is active on Android: the app now tells Android to route pairing traffic over the Wi-Fi network directly for the duration of the pairing session, so LAN connections bypass the VPN tunnel and reach the other device.
- Fixed the "Current Version" label in Settings wrapping to two lines with longer prerelease version names (e.g. `0.3.6-unrel`) by reducing its font size and keeping it on a single line on mobile, and kept the "Check Now" button label on one line.
- Restored the app title above the navigation menu in the desktop sidebar, styled to match the size and color of the "All Accounts" label with spacing that mirrors the gap below the Integrations item.
- Fixed the Create / Edit Group modal remaining pinned to the top ceiling or stuck in compact sizing after the mobile virtual keyboard closes by decoupling keyboard styling from lingering text input focus and ensuring smooth animated transitions back to centered positioning and standard spacing.
- Fixed a flicker and gray "play button" media placeholder briefly appearing in the QR camera viewfinder when switching cameras on Android; the viewfinder now stays dark and smoothly fades in once the new camera stream is ready.
- Fixed the usage notification and remove account modals jumping to the top of the screen on mobile by removing overly broad keyboard ceiling pinning rules and eliminating false-positive keyboard detection when focusing checkboxes, buttons, or non-text controls.
- Fixed a regression where dropdown menus (such as provider selection, alert thresholds, and group filters) were clipped and could no longer display above or outside the modal when extended or opened upward.
- Fixed inconsistent header font sizes in Link Devices by ensuring the "Link Devices" title, kicker, and subtitle retain identical font styling between the 6-digit code entry view and all other Link Devices views.
- Fixed the modal close ("×") button automatically displaying its tooltip immediately upon opening a modal by excluding close buttons from initial programmatic auto-focus and restricting touch/focus tooltip triggers to visible user interaction.
- Fixed a pairing failure where a joining device silently ignored the host's rejection message and continued against a peer that had already aborted, producing confusing follow-up errors instead of a clear "host rejected the connection" message.
- Fixed the transfer-direction (send/receive) choice silently defaulting to "receive" when an unexpected value was sent; invalid choices are now rejected with an error on both devices.
- Fixed a race where rapidly starting or canceling Link Devices sessions could leave the sharing device showing a QR code for a session with no listener behind it; the interrupted start now reports an error asking you to retry.
- Fixed the modal "×" close button automatically displaying its tooltip upon opening a dialog by directing initial dialog focus to interactive content rather than the close control, restricting tooltip displays to genuine user interactions or keyboard navigation, and ignoring programmatic focus events on touch devices.
- Fixed regression where modal "×" close buttons and the Link Devices switch-camera button lost their absolute positioning due to universal tooltip styling rules, restoring the close button to the top-right corner of all modals and keeping the switch-camera button docked directly to the right of the QR viewfinder.
- Fixed sidebar window toggle evaluation: selecting 'H' (hourly / 5-hour) now strictly includes providers that actually have an hourly rate, correctly displaying a dash ('—') for Grok (7-day limit) and free ChatGPT (30-day limit), while selecting 'W' (weekly) displays the 30-day limit for free ChatGPT alongside 7-day and weekly provider limits.
- Fixed the 3-dot sidebar resize grip positioning at the bottom of the screen on mobile devices by enforcing absolute positioning and normalizing the resize handle layout to maintain vertical centering matching the desktop layout.
- Fixed saving alert thresholds for OpenAI / ChatGPT accounts on free plans by correctly recognizing the primary rate limit as a 30-day (`monthly`) window, ensuring fallback window duration detection, and permitting alert configuration saves even when cached usage data lacks duration metadata.
- Fixed account cards hiding metric labels for OpenAI / ChatGPT accounts, restoring the standard `[Model] · Remaining Limit` layout (`GPT · REMAINING LIMIT` on the left, `30d window` pill on the right) matching Antigravity and other provider cards.
- Fixed quota limit notifications (such as 5-hour and 7-day limits) not firing on Android and macOS: declared the missing `POST_NOTIFICATIONS` permission in `AndroidManifest.xml` and requested runtime authorization on Android 13+, configured a custom macOS notification center delegate so system alert banners are presented even when the application window is active and frontmost, expanded Antigravity quota evaluation to iterate through all model windows rather than stopping at the first window, broadened window ID matching to recognize `5h`, `5-hour`, `7d`, and `7-day` aliases, and added real-time in-app alert toasts so limit warnings are always immediately visible while using the application.
- Fixed accounts transferred via Link Devices causing repeated dashboard flickering and a continuously looping "Refreshing" state by ensuring pairing completion callbacks fire only once and memoizing the completion handler.
- Fixed account removal taking up to 10 seconds and keeping the confirmation modal open by making backend account deletion non-blocking on in-flight refresh requests, closing the removal modal immediately upon confirmation, and preventing in-flight network refreshes from resurrecting or writing data for deleted accounts.
- Fixed camera QR code scanning across Windows laptops, macOS desktops (such as Mac mini with USB webcams), and MacBooks by declaring macOS `NSCameraUsageDescription` and `Entitlements.plist` permissions, configuring device constraint adaptation (`facingMode: "user"` on laptops/desktops vs. `"environment"` on mobile), adding natural mirrored preview on front-facing webcams, serving dev through a secure `localhost` origin, adding graceful fallback constraints for external USB webcams and built-in cameras, and integrating cross-platform dual-inversion QR decoding via `jsQR` for platforms where native `BarcodeDetector` is unsupported in WebKit or Windows WebView2.
- Fixed buttons in Link Devices (such as "Back to My QR" and the "×" close button) requiring a double tap/click on touch screens and mobile WebViews by guarding CSS `:hover` states with pointer media queries, setting immediate touch-action manipulation, managing view focus transitions, and preventing DOM recreation conflicts.
- Fixed the top-right "×" modal close button being unresponsive in certain Link Devices views (camera scanner, manual code entry, and completed screen) by providing explicit modal close triggers and resolving close targets across all dialog sub-views.
- Fixed the Next Reset countdown on the dashboard intermittently flickering back and forth between "4h 59m" and "5h 0m" by ensuring current timestamps during render cycles, capping rolling-window countdowns to window boundaries, and omitting synthetic reset timers for accounts with unused quota.
- Fixed custom bucket groups and group-assigned provider accounts failing to transfer during device linking by properly mapping remote account IDs to local receiver IDs, upserting groups without duplicates, and automatically reloading the dashboard upon transfer completion.
- In desktop development mode, fixed accounts skipping export during device linking if their credentials were stored in macOS Keychain prior to private file storage.
- Fixed device linking failing when pairing with devices that have multiple network interfaces or VPNs (such as Tailscale) by directly discovering the local Wi-Fi subnet and prioritizing private LAN IPv4 addresses over VPN or loopback interfaces.
- Fixed scanning a device-link QR code with an external camera or QR scanner on Android opening the app without launching the pairing flow; the app now immediately opens Link Devices and connects as a client.
- Fixed Link Devices getting stuck on "Starting pairing session..." on Android caused by an uninitialized `ndk-context` panic when checking for pending pairing intents.
- Link Devices on Android now shows the join code, QR code, and copy-link row instead of hanging on local-network advertisement before the pairing screen can render.
- Choosing Send or Receive during device linking now continues to verification instead of appearing to do nothing after a short wait.
- The session fingerprint on mobile Link Devices is labeled Session, matching desktop.
- Reset countdowns under 24 hours now show hours and minutes (for example 1h 3m) instead of rounding up to the next whole hour.
- Dragging a dashboard card now keeps a grabbing-hand cursor everywhere — including over buttons, links, and empty space — until the card is dropped.
- The provider icon tooltip on dashboard cards now sits fully below the pointing-hand cursor so the label is not covered.

### Added (5)

- Added air-gapped animated QR code transfer to Link Devices, enabling direct account and settings synchronization between nearby devices that are not on the same Wi-Fi network (such as mobile cellular vs. laptop Wi-Fi or guest Wi-Fi client isolation) without third-party servers or hotspot configuration. The sender displays an animated looping sequence of encrypted QR frames alongside a 6-digit PIN, while the receiver automatically captures the frames via camera, verifies the PIN, and imports the credentials.
- Clicking the Action Needed summary card now filters the dashboard to only display accounts requiring attention, with a quick action to restore all accounts.

- Link Devices can now optionally transfer app settings and layout when sending accounts: enable "Also send settings & layout" on the verification screen to include App Updates and Start at Login toggles, account refresh interval, notification thresholds per account, backend card order, and sidebar layout (group order, provider order, 5h/weekly toggle, collapsed cards, and sidebar width). The receiver applies them automatically; older app versions ignore the extra data so transfers remain compatible.
- Added support for 30-day (`30d` / monthly) quota limits in the account notification modal and backend alert evaluation, allowing notifications to be configured for free ChatGPT / OpenAI accounts with monthly limit windows.
- Added secure, direct device-to-device credential transfer ("Link Devices") over local Wi-Fi, allowing you to synchronize your AI provider accounts and groups to another device without re-entering tokens or passwords. Pairing supports symmetric role selection ("Send accounts from this device" or "Receive accounts on this device") so either device can initiate. The sharing device shows a QR code and a 6-digit local-network join code; the joining device can scan the QR code or type the code. Security uses end-to-end authenticated encryption with visual fingerprint/SAS verification. The long pairing-link paste field has been removed.

### Improved (73)

- Show Link code, Show QR code, Enter Link code, and Scan QR code each use a distinct icon and badge color.
- The Link Devices step 2 screen uses the same title and subtitle after Send or Receive; Receive omits Show QR code (3 cards instead of 4).
- Link Devices copy: send/receive descriptions now say “another device”, the step 2 heading “How should this device connect?” is removed, and the Show QR continue line is a full underlined link: “After all frames are scanned, click here to continue.”
- Increased the space between “click here after scan complete” and the Back/Cancel buttons on the Show QR code screen.
- Tweaked the Link Devices settings-transfer note to use “alerts & card order”.
- Renamed the first Link Devices screen to “Send or receive accounts”, removed the chevrons from those role cards, and set the Enter Link code card description to “Type Link code shown on other device.”
- Link Devices step 2 now has separate Enter Link Code and Scan QR code cards, each opening the matching screen.
- Link Devices now starts with Send or Receive, then Show a code vs Scan or enter, then confirm the matching code. Only the device that shows a code hosts the session; the camera device can still scan. Choosing Show a code asks whether both devices are on the same Wi-Fi, then shows a static QR and link code or animated camera-transfer codes.
- The Link Devices step bar (Connect, Send or receive, Confirm) now draws connecting lines between the steps so progress from one to the next is visible.
- Aligned Link Devices Back actions: left on Scan / Enter code / Show this code, with Or Enter Code centered on Scan and Connect to Device on the right of Enter code, and a matching Back style next to Cancel on Show this code.
- Replaced the inline release notes section in Settings with a "View what changed in v<version>" link directly below the update available status indicator, opening a dedicated modal displaying formatted release notes with Markdown rendering.
- Account cards on the dashboard now display a pulsing red glowing dot centered with the plan badge (e.g. Go/$10) whenever an account requires attention or is disconnected, and the warning status badge now reads "ACTION NEEDED" instead of "ATTENTION".
- Renamed the primary connection buttons in the Add Account modal to "Open ChatGPT login", "Open Claude login", and "Open Antigravity login" (matching "Open Grok login" and "Open OpenCode login").
- Provider labels in the sidebar, cards, and related UI now use ChatGPT and Grok instead of GPT/Codex and Grok/Cursor.
- The Add Account name field now defaults to ChatGPT, Claude, Antigravity, AI Studio, Grok, and OpenCode Go, while the provider dropdown keeps its full names.
- Editing an account name now shows a red X and a green checkmark inside the field to cancel or confirm the new name.
- On mobile, the top header (hamburger menu and page title) now uses the same visible edge line as the bottom action bar, drawn along the header's bottom edge.
- Aligned the desktop dashboard "All accounts" title and subtitle with the API Integration header so they sit at the same vertical position.
- Matched the dashboard subtitle font size and style to the API Integration and Settings pages.
- Account card collapsed/expanded state and card order are now remembered separately on each dashboard page (All accounts, each provider, and each custom group), so collapsing Grok on All does not collapse it on the Grok page.
- Matched the desktop dashboard gap between the "All accounts" title and its subtitle to the API Integration page title-to-subtitle spacing.
- Moved the mobile sidebar's top content up to match the main pages, so the sidebar's close button horizontally aligns with the hamburger menu when the menu opens.
- The selected Dashboard and Integrations entries now use the exact same active highlight as the Settings footer entry: a full-height purple left edge inset into the button (replacing the previous shorter floating accent bar), along with the faded purple gradient and light border.
- Moved the mobile hamburger menu and page title closer to the status bar by reducing the top safe-area offset, tightening the previously large gap below the status bar on tall-cutout devices.
- The sidebar footer button now opens Settings instead of triggering an update check; update availability, manual checks, and installing updates remain available in Settings under App Updates.
- The app now always checks for a new version once at launch, even when the "Automatic updates" setting is turned off, so you are still informed about available updates; with the setting enabled, background checks now run every 8 hours instead of every hour.
- Enhanced all modal dialogs (including Account Alerts, Remove Account, Group Editor, and Usage details) to be fully vertically scrollable with touch-momentum scrolling and custom compact scrollbars when the on-screen mobile keyboard appears or when modal content exceeds the viewport height, ensuring all inputs, guidance text, and action buttons remain reachable.
- On mobile devices, the Create Group / Edit Group modal now pins against the top ceiling when the on-screen keyboard is displayed, maximizing vertical visibility so the group name input, account selection picker, and action buttons remain visible and operable above the keyboard.
- On mobile devices, the Add Account modal now positions with a 20px clearance directly above the on-screen keyboard when entering account names, API keys, or connection credentials instead of pinning against the top status bar, featuring responsive header compression, compact field spacing, and internal scrolling so fields and action buttons remain visible and easily reachable.

- Adjusted the tooltip offset for the "+ Group" button to sit 24px below the button, matching the provider icon tooltip distance to prevent the pointing-hand cursor from obscuring the tooltip text, and enabled full tooltip display for the "H" (5-hour) and "W" (weekly) average usage window toggle buttons with container overflow clearance and clean sidebar alignment.
- Positioned the 3-dot sidebar resize grip directly in the center between the sidebar card border and the sidebar edge, and broadened the purple hover accent line from 4.5px to 6.5px with an enhanced glow for a bolder, more responsive resizing indicator across desktop and mobile.
- Enhanced in-app notification toasts to display timestamps (e.g. `3:22 AM`), remain visible for 15 seconds, stack up to 5 concurrent alerts, and automatically reveal older queued alerts as alerts are dismissed.
- Configured active/foreground system notification delivery on macOS via a custom `UNUserNotificationCenterDelegate` implementation and on Android via a high-importance `NotificationChannel`, ensuring system banners and notification center entries are posted even when the app is active and focused.
- Optimized QR code scanning on mobile devices with multiple rear cameras by automatically prioritizing the primary wide camera sensor over auxiliary or ultra-wide lenses, applying continuous autofocus constraints with standard 1x zoom, supporting viewfinder tap-to-focus, and providing a camera switch option when multiple lenses are available.
- Enhanced camera enumeration and switching logic in Link Devices on multi-lens mobile devices (such as the Samsung Galaxy S26 Ultra with four rear cameras) to detect and cycle through all available rear cameras in logical focal order without skipping lenses, deduplicate auxiliary front-facing camera HAL entries to ensure the front camera only appears once per cycle, and redesigned the Switch Camera control into an obsidian purple circular button positioned directly to the right of and vertically centered with the camera viewfinder.
- On mobile devices, the Link Devices modal now positions with a comfortable 20px clearance directly above the on-screen keyboard during code entry rather than pinning to the top ceiling, and standardizes 24px vertical spacing between the subtitle, instructions, digits input box, Wi-Fi guidance note, security badge, and action buttons.
- Refined mobile safe-area spacing and status bar clearance, connecting native Android WindowInsets listeners to CSS variables and establishing a 60px minimum top offset so the hamburger menu and Dashboard title maintain ample breathing room below the status bar on devices with tall cutouts like the Google Pixel 7.
- Standardized all tooltips throughout the application to use the custom obsidian dark tooltip theme with prompt display timing and 3-second mobile auto-dismissal, including the purple circular Switch Camera button, modal close controls, sidebar toggles, and bucket header buttons, replacing OS-native delayed tooltips.
- The sidebar resize-handle tooltip now uses the same dark in-app tooltip as the account card trash, notification, and refresh buttons.
- Clickable controls now consistently use a pointing-hand cursor. The open-hand cursor is reserved for surfaces you can drag to reorder.
- The account card refresh button tooltip no longer repeats the last-updated time already shown on the card.
- Renamed device pairing action and modal title to "Link Devices" in Settings.
- Refined the Device Transfer setting description to "Sync accounts & credentials across devices securely over local Wi-Fi." and the Link Devices dialog subtitle to "Transfer accounts & credentials securely over Wi-Fi."
- Standardized modal header spacing and hierarchy across all dialogs (Link Devices, Edit Group, Account Alerts, and Add Account) so the vertical gap between the purple kicker and white heading is uniformly aligned.
- Redesigned the application icon to "Neural Orbit", featuring concentric telemetry quota rings and a central luminous AI spark on a modern dark squircle canvas across macOS, Windows, and Android.
- Enabled the grab hand cursor when hovering over account cards in the desktop dashboard, keeping pointer cursors on buttons and inputs.
- Fixed tooltips on action buttons (trash, notifications, refresh) being hidden behind adjacent cards when a card is collapsed; tooltips now always render above all other elements.
- Added a tooltip on the provider icon button in the dashboard showing "Click to expand card" or "Click to shrink card" to indicate the card can be collapsed or expanded.
- When quota reset countdowns are under 1 minute, the remaining time now steps down through 45s, 30s, 15s, and 5s instead of staying fixed at 1m.
- Configured application windows, Android launch themes, and the root document shell with a black background to eliminate the initial white flash during startup.
- In Link Devices, clicking "Confirm Transfer" during verification code confirmation now immediately shows a waiting spinner and status note ("Confirmed on this device. Waiting for the other device to confirm...") with the button disabled while waiting for the other device.
- In Link Devices, entering the 6-digit join code no longer auto-connects immediately upon typing the sixth digit, waiting until you click the "Connect to Device" button.
- Balanced the desktop sidebar "Check for Updates" button spacing so the gap below it matches the gap to its left and right.
- Redesigned the Link Devices dialog for maximum space efficiency and visual clarity by renaming "Join Code" to "Link Code" across the linking flow, adding clear instructions to enter the link code or scan the QR code from the other device, styling the "Back to My QR" button with a red background positioned consistently as the first button on the left across sub-views, removing the redundant "Copy Link" row, converting the code display into a clean static card without the unnecessary click-to-copy pill, combining session fingerprint and expiration countdown into a compact horizontal metadata row, balancing the Scan QR and Enter Code action buttons into a sleek two-button grid, optimizing QR code and camera scanner dimensions, and removing duplicate Cancel and Close buttons across all pairing steps.
- Positioned Device Transfer as its own dedicated section card in Settings, placed directly above the Start at login / device boot section.
- In the Link Devices code entry screen, styled the end-to-end encryption badge with a green shield icon, optimized horizontal spacing and font sizing so the security note fits on a single line without wrapping on mobile screens, flattened internal container nesting, reset conflicting inherited paragraph margins, and calibrated all vertical gaps between consecutive elements to a uniform 24px.
- On mobile and touch devices, tooltips (such as account card action buttons, provider icons, and sidebar resize grips) now automatically dismiss after 3 seconds so they do not remain permanently visible on screen after a tap.
- Desktop development builds now store credentials using private user-only file storage, eliminating macOS Keychain password prompts during `tauri dev`.
- Fixed custom bucket groups and group-assigned provider accounts failing to transfer during device linking by properly mapping remote account IDs to local receiver IDs, upserting groups without duplicates, and automatically reloading the dashboard upon transfer completion.
- In desktop development mode, fixed accounts skipping export during device linking if their credentials were stored in macOS Keychain prior to private file storage.
- Fixed device linking failing when pairing with devices that have multiple network interfaces or VPNs (such as Tailscale) by directly discovering the local Wi-Fi subnet and prioritizing private LAN IPv4 addresses over VPN or loopback interfaces.
- Fixed scanning a device-link QR code with an external camera or QR scanner on Android opening the app without launching the pairing flow; the app now immediately opens Link Devices and connects as a client.

- Fixed Link Devices getting stuck on "Starting pairing session..." on Android caused by an uninitialized `ndk-context` panic when checking for pending pairing intents.
- Link Devices on Android now shows the join code, QR code, and copy-link row instead of hanging on local-network advertisement before the pairing screen can render.
- Choosing Send or Receive during device linking now continues to verification instead of appearing to do nothing after a short wait.
- The session fingerprint on mobile Link Devices is labeled Session, matching desktop.
- Reset countdowns under 24 hours now show hours and minutes (for example 1h 3m) instead of rounding up to the next whole hour.
- Dragging a dashboard card now keeps a grabbing-hand cursor everywhere — including over buttons, links, and empty space — until the card is dropped.
- The provider icon tooltip on dashboard cards now sits fully below the pointing-hand cursor so the label is not covered.
- Camera transfers in Link Devices no longer ask you to type a 6-digit PIN: after the receiving device scans the animated codes, both devices show the same verification code, and you confirm the codes match before anything is imported — mirroring the Wi-Fi confirmation step.
- The Link Devices connection screen now offers three explicit choices — Show link code (same Wi-Fi), Show QR code (different networks), and Scan or Enter code — instead of asking a follow-up Wi-Fi question after tapping Show code.
 - Camera transfers in Link Devices now finish faster: larger QR frames cut a typical transfer from 23 animated frames to 16 with no change to the scanning process.
- Renamed the Link Devices card "Scan or enter code" to "Scan or Enter code".
- In the Link Devices “Show or scan a code” screen, the Enter Link code card now appears above Show QR code.
- Renamed the Link Devices step 2 screen from “Show or scan a code” to “How to connect devices”.

## v0.3.5 - 2026-09-03 (49 changes)

### Improved (28)

- On Android, tapping Update downloads the APK in the app and opens the system installer instead of sending you to GitHub in a browser.
- When an app update is available, the Settings action button now says Update instead of including the version number.
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
- Aligned the dashboard 5h window badge to the red tone of the card trash button and the 7d window badge to the yellow/amber tone of the notification button.
- Aligned the dashboard Next Reset summary time badge to the green color, border, and background tone of the card refresh button.
- Standardized spacing in the mobile sidebar with 18px gaps between the close button and Dashboard, 18px above and below the navigation divider, and a 36px bottom clearance beneath the update button.
- Redesigned the installed version display in Settings to show "Current Version: 0.3.5" on the first line, with the update status on the next line accompanied by a green status indicator dot when up to date, and a red status indicator dot with a red action button when an update is available. Checking for updates now overwrites "Up to date" and remains visible for a minimum of 0.5s.
- Renamed provider display names: "Codex/GPT" to "GPT/Codex", and "Grok" to "Grok/Cursor" across sidebar navigation, dashboard headers, account cards, modals, and backend defaults.
- Standardized gaps between account cards on mobile to 10px, matching the uniform spacing between the summary cards and the card list.
- Clicking a provider icon on an account card collapses the card down to its header and divider, hiding the metrics section. Clicking the icon again expands the card back out, with collapsed state remembered per account.
- Increased the vertical spacing between the account email and the card divider line on mobile for improved readability and balance.
- Enabled long-press card dragging across the entire account card (including the provider icon, header, and action buttons), while preserving quick click/tap actions for collapsing cards and header buttons.

### Fixed (21)

- Checking for app updates no longer reports that you’re up to date when GitHub hides the latest release (for example a private repository returning HTTP 404). Check Now now falls back to the GitHub Releases API so a newer tag such as 0.3.5 is detected even without `latest.json`.
- Removed the inner divider line along the bottom border of collapsed account cards while keeping header text position stationary.
- Eliminated text shifting and jumping when collapsing and expanding account cards by preserving exact header padding and divider line dimensions in both states.
- Standardized full vertical scrolling across all dialog boxes in the app (Provider Connection, Create/Edit Group, Group Delete Confirmation, Usage Notifications, Remove Account, and Google Cloud Quotas) so modal content and focused input fields remain fully accessible on small screens and when the virtual keyboard is open.
- Prevented dragged account cards from expanding wider than their original bounds or scaling up during reordering.
- Fixed the GPT icon scaling in the Create/Edit Group account picker modal by constraining provider images to the icon container bounds.
- Backing out of a provider sign-in page on Android no longer blocks adding an account with “Another provider login is already in progress.”
- On Android, tapping Continue with Google on Claude (and other provider sign-in pages) no longer hangs on a spinner. Google sign-in now opens in a real in-app window so it can finish.
- Claude sign-in now uses the same localhost callback Claude Code uses, so Anthropic does not reject the redirect the way OpenAI did for Codex/GPT.
- Signing in to Codex/GPT no longer fails on OpenAI’s generic Authentication Error page. The app now uses the same localhost callback OpenAI allows for Codex.
- Optically aligned the account card timestamp on the right side with the rounded top corner and boundary of the refresh button.
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

## v0.3.4 - 2026-09-02 (40 changes)

### Improved (4)

- On mobile, placed the "Total accounts" and "Needs attention" summary cards side-by-side in the same row with "Next reset" spanning underneath.
- Made the mobile navigation sidebar narrower for a cleaner drawer layout.
- On mobile, tightened the spacing between the dashboard title and account count, and vertically centered both lines with the hamburger menu button.
- Balanced vertical spacing on mobile with equal padding above and below the header separator line.

### Fixed (21)

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

### Added (2)

- The sidebar now has an All row as the default dashboard view, with provider and custom groups remaining as filters.
- Account cards now show when usage was last fetched, as relative time such as “Updated 2m ago”, above the remove, notification, and refresh buttons.

### Improved (13)

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

## v0.3.3 - 2026-09-01 (15 changes)

### Improved (9)

- Reduced account card email subtitle font size and compacted header action padding on mobile screens so badges and action buttons fit cleanly within narrow viewports.
- Styled scrollbars across desktop and mobile with a custom Obsidian purple theme, adding a slim purple scrollbar along the right side of the account cards list on mobile when multiple cards overflow the screen.
- Replaced default OS select elements across all dialogs (Add Account provider picker, Google Cloud project selector, Bucket filters, Usage Alert thresholds, and Settings refresh intervals) with a custom theme-styled dropdown component featuring obsidian dark styling, smooth purple animations, multiline text wrapping for long provider descriptions on mobile, full keyboard navigation, and checkmark indicators, with Grok listed directly above Antigravity.
- Reorganized the mobile layout of the Usage Notifications dialog so window toggles and threshold labels stack vertically above their dropdowns with full width, preventing squishing on small screens.
- Enhanced modal containers and dropdown menus to float completely above dialog boundaries with elevated z-indexing and dynamic upward opening when near the bottom of the screen to prevent cutoff.
- Formatted Android release package names as `AI Usage Tracker_<version>.apk` to include the version number and match macOS and Windows release asset conventions.
- Replaced raw manifest error banners with a clean informational message ("You are on the latest version") when checking for updates and no newer release is found.
- Added mobile update checking for Android: queries GitHub for new releases, displays update notifications, and automatically opens the latest APK release page in the mobile browser when tapped.
- Updated Settings descriptions for Automatic updates, App updates, and Account updates, and resolved dropdown clipping in Settings by enabling visible card overflow.

### Fixed (6)

- Adding multiple Grok accounts now isolates the sign-in session in a clean, ephemeral profile so opening the sign-in window always displays a fresh login prompt instead of prematurely capturing an existing account, and distinct Grok accounts are now saved independently.
- Fixed Antigravity (Google) OAuth sign-in hanging on Android after selecting an email address by routing authentication through the in-app WebView interceptor, preventing OS background process freezing.
- Quota reset countdown badges now format as `Resets in: Xh` for windows under 24 hours and `Resets in: Xd Yh` (e.g. `1d 12h`, `6d 10h`) for windows over 24 hours, and are calculated directly in React across all models and windows.
- The mobile sidebar drawer now sits flush against the bottom of the status bar instead of leaving a gap below it.
- Replaced the Android launcher icon with the full-bleed purple design matching macOS and Windows, resolving the white background border and shrunken icon issue on Android devices.
- The mobile sidebar’s Check for Updates button now sits above the home indicator, with the same 12px gap below it as above Accounts.

## v0.3.2 - 2026-09-01 (20 changes)

### Security (8)

- Local account metadata, settings, and Android credential files are now created with owner-only permissions so they are never briefly readable by other users on the same machine.
- Grok connections now store and send only grok.com / accounts.x.ai session cookies. Existing saved Grok cookie bundles are trimmed on the next refresh, and a reconnect is required if no Grok session remains.
- Provider sign-in pages loaded inside the app are now restricted to each provider's own domains, so pop-ups and malicious links can no longer navigate the sign-in window to unrelated or script-based (javascript:, intent:) addresses.
- On Android, Google, Anthropic, and OpenAI sign-in now opens in the system browser instead of inside the app, so those sign-in pages can't reach the app's internal functions. In-app Grok sign-in on mobile still opens in the app so session cookies can be captured without pasting them. OpenCode Go on mobile still uses manual cookie entry.
- Switched Antigravity and Google AI Studio OAuth callback listeners to dynamic ephemeral loopback ports (`127.0.0.1:0`), eliminating loopback port contention and local pre-binding denial-of-service risks.
- Reduced Google AI Studio default connection scopes from broad administrative `cloud-platform` to least-privilege read-only monitoring and project inspection scopes, requesting service management only when Cloud Monitoring is explicitly enabled.
- OAuth sign-in success and error pages now send `no-store` caching and strict content security headers so those one-time callback pages are never cached or framed.
- The local bridge now verifies its bearer token with a standard constant-time comparison.

### Improved (5)

- Sidebar cards (both custom groups/buckets and provider summaries) and dashboard account cards can now be dragged or long-pressed on touch screens to swap and customize their order, preserving natural scrolling and syncing backend account ordering.
- Active card selection is preserved when dragging or swapping cards, preventing the displayed account view from unexpectedly switching.
- The Paseo Bridge token in the integration window is now hidden by default and can be revealed with a single click, keeping the masked value in the copied environment block as well.
- Updated the in-app Grok login window to open `https://accounts.x.ai/sign-in` directly.
- If accounts fail to load, the dashboard now shows the error and a Retry button instead of staying on “Loading accounts…”.

### Fixed (7)

- Fixed Open Grok login crashing the Android app immediately after tapping the button by keeping WebView cookie JNI methods through release minification.
- Fixed "Open Grok login" button crashing the Android app by guarding the desktop WebView window creation with a compile-time platform check; on Android the manual cookie-paste path is now shown automatically.
- Fixed Antigravity (Google), OpenAI, and Anthropic OAuth sign-in permanently hanging on Android; the loopback TCP callback server is desktop-only and cannot receive redirects from the Android system browser. These providers now show a clear message directing Android users to link accounts on the desktop app.
- Fixed `getCurrentWindow()` crash at startup on Android caused by missing window plugin metadata; the Paseo Bridge window check now falls back safely to `false` on mobile.
- Positioned the expanded mobile sidebar drawer flush directly below the mobile status bar with square corners, eliminating the top gap and preventing the drawer from covering status bar indicators.
- Expanded account usage progress bar tracks to span the full available width of the card, aligning flush with window badges and reset countdown timestamps.
- Styled the account rename pen button with a compact 22px badge and obsidian violet font, border, and background colors matching the visual style of the header action buttons.

## v0.3.1 - 2026-08-31 (20 changes)

### Improved (7)

- Standardized "5 hour", "Weekly", and rolling window metric labels to "Remaining Limit" across all provider account cards while preserving clean model categories for Antigravity (e.g. `Gemini · Remaining Limit`, `Claude & GPT · Remaining Limit`) and Claude.
- Styled `5h window` (Warm Amber), `7d window` (Obsidian Mint), and `Monthly` (Obsidian Lavender) duration badges with dark-mode theme colors for visual differentiation and contrast.
- Updated the in-app private Grok login window to open `https://accounts.x.ai/` directly for signing in.
- On mobile and small screens, account quota and usage metrics now render one per line with full-width progress bars for easier reading.
- Account card headers now display provider icons, account titles, status/plan badges, and action buttons in a single inline row across desktop and mobile screens, with status and plan badges neatly stacked and uniform 6px spacing between badges and action buttons across mobile and desktop screens.
- Renamed provider display names across sidebar navigation, dashboard headers, account cards, and modals: "OpenAI Codex" to "Codex/GPT", "Anthropic Claude" to "Claude", "Google Antigravity" to "Antigravity", "Google AI Studio" to "AI Studio", and "Grok / SuperGrok" to "Grok".
- Renamed "Check for App Updates" buttons to "Check for Updates" across the sidebar footer and Settings view.

### Fixed (13)

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

## v0.3.0 - 2026-08-31 (54 changes)

### Added (4)

- Added support for building and sideloading on **Android**. Releases now provide an `.apk` package (`AI-Usage-Tracker.apk`) that can be installed directly onto Android phones.
- Added responsive **Mobile Navigation Drawer** with smooth slide-out transitions and safe-area padding for Android status bars and gesture bars.
- You can now create custom **Bucket Groups** to combine accounts (e.g. splitting multiple Antigravity or Grok accounts into separate work vs personal buckets). Each bucket shows as an independent row in the sidebar with its own usage calculations and filters the dashboard when selected.
- Settings now includes a toggle for automatic app updates. Manual update checks still work when the toggle is off.

### Improved (13)

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

### Security (27)

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

### Fixed (10)

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

## v0.2.47 - 2026-07-31 (4 changes)

### Fixed (2)

- Credits are no longer shown on Google Antigravity or OpenCode Go accounts, which do not report a credit balance.
- OpenAI usage-window badges now stay in the same top-row position used by other providers.

### Improved (2)

- Usage percentages now omit the redundant word **remaining**.
- Narrower account cards retain the exact same content, element positions, icon sizes, and typography; only flexible widths such as account names and usage bars contract.

## v0.2.46 - 2026-07-31 (3 changes)

### Fixed (1)

- OpenAI account cards now grow to fit all quota content instead of clipping shorter than their metrics.

### Improved (2)

- Provider-reported credits now appear inline with the percentage and usage bar instead of occupying a separate quota tile.
- Narrow account cards preserve the same information and visual structure while progressively tightening spacing, icons, and typography instead of switching to a different compact design.

## v0.2.45 - 2026-07-31 (3 changes)

### Improved (3)

- OpenCode Go's monthly quota now shows a **Monthly** usage-window badge alongside its percentage.
- Account-card notification, remove, and refresh controls move beside the email only when the title row would otherwise become crowded.
- Detailed account usage remains visible while the card can still contain its real text; compact percentages activate only after measured content overflow instead of at a fixed card width.

## v0.2.44 - 2026-07-30 (1 change)

### Improved (1)

- Detailed two-column account usage stays visible until an account card is genuinely narrow; compact mode now begins at 760px and the one-column fallback begins at 520px.

## v0.2.43 - 2026-07-30 (3 changes)

### Improved (2)

- Compact account cards now keep notification, remove, and refresh controls beside the account name and use the lower row for concise percentage and usage-window summaries based on each card's actual width.
- Provider and account dragging now follows the Trello-style interaction reference: the floating card tracks the pointer while a transparent full-size gap moves through the list and neighboring items animate into the exact pending order.

### Fixed (1)

- Accounts with multiple rows of usage limits no longer indent later rows with a misplaced vertical separator.

## v0.2.42 - 2026-07-30 (1 change)

### Fixed (1)

- Cancel and close controls now remain available while account authentication is waiting, immediately stop the active login attempt, and close private provider windows without waiting for a timeout.

## v0.2.41 - 2026-07-28 (1 change)

### Improved (1)

- Provider groups and account cards now move through the list while dragging, with a full-size destination preview showing the exact order before release.

## v0.2.40 - 2026-07-28 (3 changes)

### Added (1)

- Grok / SuperGrok accounts can now sign in through xAI's official Grok Build CLI and display provider-reported included-usage percentage and reset timing when xAI exposes that billing data.

### Fixed (2)

- Provider groups and account cards now use pointer-based reordering that works reliably in the desktop WebView and persists the resulting order.
- React now renders provider groups from the saved provider order instead of restoring the old fixed order after a drag.

## v0.2.39 - 2026-07-27 (7 changes)

### Fixed (7)

- Interrupted Google AI Studio OAuth setup can no longer leave the app stuck closing during startup refresh.
- Automatic account refreshes are isolated so one provider failure cannot take down the refresh controller or the desktop app.
- Google AI Studio accounts that have not completed Cloud setup, plus accounts already requiring reconnection, are skipped during automatic startup refresh.
- Provider credential read failures now suspend only the affected account and require reconnection instead of being retried as an application-wide startup failure.
- Opening Google AI Studio OAuth no longer triggers a self-repeating popup observer loop that can crash the app or leave it running invisibly in the system tray.
- Popup close buttons now update their disabled state without recursively retriggering the shared dialog observer.
- Invalid startup metadata is preserved in a quarantine file while the app recovers from `accounts.json.bak` or safe defaults instead of closing immediately after launch.

## v0.2.38 - 2026-07-27 (3 changes)

### Fixed (2)

- Google AI Studio Cloud setup no longer opens a Google 403 page caused by OAuth scopes that the current Google client does not accept.
- Every popup dialog now includes a visible top-right **X** close button.

### Improved (1)

- Google AI Studio setup now accurately explains that Google grants Cloud access while the app limits its own actions to project discovery, Cloud Monitoring usage, and an explicitly approved Monitoring enable action.

## v0.2.37 - 2026-07-27 (4 changes)

### Added (2)

- Google AI Studio usage setup now signs in with Google once, automatically identifies the Cloud project that owns the API key when Google permits it, and falls back to a project picker only when automatic discovery is unavailable.
- When Cloud Monitoring is disabled, setup now offers a separate **Enable Cloud Monitoring** approval instead of sending users through manual Google Cloud Console steps.

### Improved (2)

- Google AI Studio setup no longer asks users to find and paste a Cloud project ID.
- The initial Google authorization remains read-only; broader Cloud permission is requested only for the explicit one-time action of enabling Cloud Monitoring.

## v0.2.36 - 2026-07-27 (4 changes)

### Added (2)

- Google AI Studio accounts can connect the Google Cloud project that owns their API key with read-only Cloud Monitoring access and display provider-reported RPM, TPM, RPD, and TPD quota usage when Google publishes those metrics.
- Google AI Studio now appears as its own provider group instead of being mixed with Google Antigravity accounts.

### Improved (2)

- API-key-only Google AI Studio accounts now show **Connected** instead of **Live**, and project connections waiting for delayed Google metrics show **Waiting** instead of an unexplained unavailable value.
- Existing Google AI Studio testing accounts are migrated automatically without requiring the API key to be added again.

## v0.2.35 - 2026-07-27 (2 changes)

### Added (1)

- **Add Account** now includes a testing option for Google AI Studio API keys that validates the key, loads the model list directly from Google, and lets you choose which returned models to track.

### Improved (1)

- Google AI Studio testing accounts leave usage values unavailable when Google does not report them instead of estimating or calculating quota usage.

## v0.2.34 - 2026-07-26 (2 changes)

### Fixed (2)

- The global **Add Account** button now opens an unlocked provider-selection window so you can choose which account type to add.
- Reconnect actions still remain locked to the existing account’s provider.

## v0.2.33 - 2026-07-26 (4 changes)

### Added (2)

- Provider groups in the sidebar and account cards within each provider can once again be reordered by dragging, with the saved order restored after relaunch.
- Dragging near the top or bottom edge automatically scrolls long provider and account lists.

### Improved (2)

- The notification, trash, and refresh icons in account cards are now 50% larger while keeping transparent action buttons.
- Long provider and account lists now scroll independently within the available sidebar and dashboard space.

## v0.2.32 - 2026-07-26 (2 changes)

### Fixed (1)

- Replaced the clipped-looking refresh symbol with a complete circular two-arrow icon that renders cleanly at the account-card action size.

### Improved (1)

- Account usage metrics now show the reset date on the left and a right-aligned **Resets in: _Xh_** countdown calculated from the provider’s reset timestamp.

## v0.2.31 - 2026-07-26 (2 changes)

### Fixed (1)

- The bottom-left update control now displays **Check for App Updates** only once in every update state.

### Improved (1)

- Usage-window badges such as **7d window** now share the percentage row and are right-aligned within each account metric.

## v0.2.30 - 2026-07-26 (2 changes)

### Fixed (2)

- Restored the OpenAI quota details that were accidentally hidden in v0.2.29. OpenAI cards again show the remaining percentage, usage-window badge, purple usage bar, and reset time while omitting only the redundant **Session** heading.
- The sidebar update control now uses one real text label instead of displaying both its label and a generated duplicate.

## v0.2.29 - 2026-07-26 (11 changes)

### Added (1)

- OpenCode Go accounts now require an email address during setup so the connected email can be shown under the account name.

### Improved (10)

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

## v0.2.28 - 2026-07-26 (6 changes)

### Added (3)

- The account sidebar now groups accounts by provider and shows the provider’s average remaining 5-hour or weekly usage.
- **H** and **W** controls beside **Usage Accounts** switch the provider averages between the 5-hour and weekly limits.
- Each account card now has dedicated refresh, remove, and notification controls, plus inline account-name editing.

### Improved (3)

- The Accounts dashboard has been rebuilt to closely follow the new Obsidian utility mockup, including its colors, typography, navigation, summary cards, spacing, and account-card layout.
- Selecting a provider in the sidebar now displays all accounts connected to that provider in the main dashboard.
- Account notification settings now focus on the 5-hour and weekly limits.

## v0.2.27 - 2026-07-26 (4 changes)

### Added (2)

- Integrations now includes a toggle for enabling or disabling the Paseo Bridge.
- When the bridge is enabled, a **View** link opens a separate window with its status, endpoints, bearer token, environment configuration, token rotation control, and connection details.

### Improved (2)

- The Paseo Bridge is now disabled by default and no longer opens its localhost listener until explicitly enabled.
- Disabling the bridge now shuts down its local listener while preserving its configuration for later use.

## v0.2.26 - 2026-07-26 (2 changes)

### Improved (2)

- The sidebar update button now says **Update to v…** when a new version is available.
- The duplicate update banner and restart button in the main dashboard have been removed.

## v0.2.25 - 2026-07-26 (3 changes)

### Improved (3)

- Dashboard summary cards now use compact single-line layouts for connected accounts, accounts needing attention, and the next reset.
- The **Next Reset** card now shows only the countdown and account name.
- Accounts that need attention are now highlighted with a transparent red warning outline in the sidebar.

## v0.2.24 - 2026-07-26 (1 change)

### Added (1)

- Settings now includes a **View Change Log** button that opens the repository changelog.

## v0.2.23 - 2026-07-26 (4 changes)

### Added (2)

- Account update timing can now be selected from 5 to 60 minutes in 5-minute increments.
- A system notification now appears when a new app update is detected.

### Improved (2)

- The app now checks for updates every hour instead of every six hours.
- Settings now describes account refresh timing as **Account Updates** and focuses on the controls users need.

## v0.2.22 - 2026-07-26 (2 changes)

### Improved (2)

- The sidebar update button now says **Check for App Updates** and changes to a purple install button when a new version is available.
- A **View Change Log** link now appears below available updates and opens this repository changelog.
