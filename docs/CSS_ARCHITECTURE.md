# CSS architecture

The app has dark and light themes (plus a "system" option that follows the device) and is styled with plain CSS files. Theme colors are defined in `src/styles/tokens.css`. There is no CSS-in-JS and no build-time CSS tooling beyond Vite.

## Files and load order

The order below **is the cascade**. Later files override earlier ones, so do not reorder imports.

| # | File | Loaded from | What it holds |
|---|------|-------------|---------------|
| 1 | `styles/tokens.css` | `app/main.tsx` (first import) | Custom properties (colors, text sizes, safe-area insets) and the `@layer` order |
| 2 | `features/pairing/pairing.css` | `app/App.tsx` | Link Devices dialog. It loads early on purpose and wins by specificity, not order |
| 3 | `features/startup/startup-gate.css` | `features/startup/StartupGate.tsx` | Startup/retry screen |
| 4 | `styles/base.css` | `app/main.tsx` | Reset, app shell grid, base buttons |
| 5 | `styles/shell-patches.css` | `app/main.tsx` | Eleven earlier patch files concatenated in their original order (see the banners inside) |
| 6 | `styles/api-integration.css` | `app/main.tsx` | The separate API integration window |
| 7 | `styles/obsidian-dashboard.css` | `app/main.tsx` | The main stylesheet. Most visible styling lives here |
| 8 | `styles/ui-refinements.css` | `app/main.tsx` | Tooltips, toasts, error banners, sync status, ordering controls |
| 9 | `styles/dashboard-reorder.css` | `app/main.tsx` | Drag-to-reorder visuals |
| 10 | `styles/modal-close.css` | `app/main.tsx` | The close button and removal-confirm button |
| 11 | `styles/account-card-responsive.css` | `app/main.tsx` | Account card layout at every width |
| 12 | `styles/sidebar-list.css` | `app/main.tsx` | The sidebar list: flat rows, two labeled meters, Accounts and Groups headers. Overrides the older `.provider-summary-row` rules by repeating the class; must not depend on ancestors, because a drag clones the row onto `body` |

`app/App.tsx` pulls in `pairing.css` while `app/main.tsx` is still resolving its imports, which is why it sits before `base.css`. Check the real order in the browser (`document.querySelectorAll('style[data-vite-dev-id]')` in `npm run dev`) after changing any import.

## Layered component files

The newer component stylesheets are the first rules in `@layer components`: `features/activity/activity.css` (the Usage page), `app/bottom-nav.css` (the bottom navigation bar) and `app/top-bar.css` (the desktop top bar with the Accounts, Usage and Settings pages and the add buttons, which also puts the shell in two rows while it shows). Each is imported by its component, so it loads with the component and not in the order of the table above; that does not matter, because a layered rule loses to every unlayered one whatever the order.

The element defaults those components override are in `@layer base`, which comes before `components`, so a layered component overrides them with an ordinary rule:

- `button, input { font: inherit }` and `button { color: inherit }` (`base.css`, and the copy in `obsidian-dashboard.css`);
- `svg { width: 18px; height: 18px }` (`base.css`);
- `:focus-visible { outline-offset: 2px }` (`base.css`);
- the tooltip bubble, `[data-tooltip]::after { ... }` (`ui-refinements.css`).

Two things next to them are deliberately still unlayered:

- `:focus-visible { outline: 2px solid ... }`. A few single-class rules written before `base.css` (`.pairing-code-input { outline: none }`) lose to it today by source order; in a layer they would win and hide the focus ring.
- `[data-tooltip]:not(...) { position: relative }`. It is specific enough to beat most `position` declarations in the unlayered files, and elements rely on that. A layered rule that needs another `position` on an element with a tooltip sets it with `!important`, which inverts the order (a layered `!important` beats an unlayered one).

So a layered file needs `!important` only where an unlayered rule sets the same property on the same element: that `position`, the Usage page's top padding, the shared `.button` radius, and the segment indicator's transparent fill. Each says so in a comment.

`--bottom-nav-height` is how the bar and the page shell agree. The bar is a neutral pill that floats over the page, centered, `--bottom-nav-offset` above the bottom edge: 6px above the system area (`--safe-area-bottom`: navigation buttons, a gesture handle or a home indicator), and never under 12px. `--bottom-nav-height` is the bar plus that offset, the room it takes up from the bottom edge, and `.app-shell.has-bottom-nav` sets both while the bar shows. With Menu Bar Labels off (`.bottom-nav.is-icon-only`) the items are 40px, not 48px, and a `:has()` rule on the shell lowers the variable by the same 8px. The page runs under the bar: `.main-stage` keeps `height: 100%`, and the `.has-bottom-nav` rule in `ui-refinements.css` pads `.dashboard-scroll` by the variable so the last row can be scrolled clear. The toasts there sit above the variable too, with a `0px` fallback. The current page sits on a `--purple-fill` pill with the `--purple-on-fill` label, as in the desktop top bar; the bar's other colours are the `--bottom-nav-*` tokens in `tokens.css`, hex in both themes so `src/styles/bottom-nav.test.ts` can check their contrast. `--android-nav-buttons`, which `MainActivity.kt` still reports, is no longer read by any stylesheet.

## Breakpoints

Width breakpoints belong to individual components, so they are not collapsed into a few shared ones: moving one changes the layout at the widths in between. `src/styles/breakpoints.test.ts` fails when a width is added or removed, so update this table and that list together.

| Width | Used for |
|-------|----------|
| 860 / 861 | The main mobile/desktop split (sidebar overlay, card actions, mobile menu). The JS constant `MOBILE_OVERLAY_QUERY` must stay `(max-width: 860px)` |
| 1220, 1180 | Summary cards: 4 columns, then 2 columns, then the Next Reset card spans a full row. |
| 768 | The Link Devices dialog becomes a full-screen sheet |
| 760, 720 | Stacked rows in the remove-account confirmation and the API window |
| 640, 600 | Release-notes dialog and alert toasts fill the width; summary grid spacing |
| 480, 400, 360 | Small-phone tweaks (card text, camera button and tooltip, security note) |

Keep one `@media` block per width and file where you can, and check that a later unconditional rule on the same selector does not override it: an earlier media rule loses to a later plain rule of the same specificity.

The L / U toggle is not on a width breakpoint. On desktop it is in the top bar. In the phone overlay it shares a row with the Account and Group buttons, and drops below them when `html` has `data-sidebar-toggle-stacked`. The resize handle sets that attribute while the sidebar is narrower than the measured one-line width of those controls.

The desktop account card (`desktop-card`, from 861px) is a separate set of rules in `account-card-responsive.css`. The card's header renders different markup on desktop (`useMediaQuery(MOBILE_OVERLAY_QUERY)`), so those rules never reach the phone layout, which has its own block at the end of the file (the same look, with the actions in the menu). The usage rows (`.desktop-metric`) are the same markup and styles at every width.

## Tokens

Add new colors and shared sizes to `styles/tokens.css` and use `var(--name)`; do not repeat a hex value that already has a token. A fallback such as `var(--token, #hex)` is not needed, because the token is always defined.

Most tokens follow the theme. A few are fixed, the same in both themes: `--white` and `--black`, the destructive-button reds (`--danger-fill`, `--danger-line` and their `-hover` and `-active` shades), the solid green button (`--success-*`, same pattern), and the tint triplets `--tint-green-rgb`, `--tint-amber-rgb` and `--tint-red-rgb`, used with an alpha as `rgb(var(--tint-green-rgb) / 0.14)`. Do not swap a fixed token for a themed one of the same dark value (`--white` for `--c-ffffff`, a tint for `--obsidian-green`): the light theme would change.

`src/styles/css-debt.test.ts` holds a per-file count of the color literals still written outside the token files (mostly black and white shadows and overlays with an alpha). The count may only go down; lower the number in that test when you remove one.

`--sidebar-width` is deliberately **not** in `tokens.css`: its value depends on source order and media queries (and the app also sets it from JavaScript).

## Layers

`tokens.css` declares `@layer tokens, base, components, utilities;`. The tokens, the element defaults listed under "Layered component files" and the newer component stylesheets are in layers. Everything else is unlayered, and **an unlayered rule beats a layered one however specific it is**.

Do not wrap an existing file in a layer to "tidy up". It changes how the file cascades:

- Rules that win today by specificity (for example `pairing.css`) start losing to later, less specific rules.
- For `!important`, layer order inverts, so a layered `!important` beats an unlayered one.

When adding new CSS, put it in a layer. To migrate an existing file, first resolve its specificity conflicts, then move it and check the result visually at several widths.

Moving a rule into a layer changes two things, and both need checking. Every unlayered declaration of the same property that the rule beats today (lower specificity, or the same and earlier in the load order) starts to win. Every layered declaration that loses to it today starts to apply.

## `!important`

About two thirds of the old `!important` flags were removed because nothing relied on them, and the number has grown again since. The ones that remain are either needed (they beat a higher-specificity rule or an inline style) or sit on selectors that matched nothing in the views that were checked (error banners, update dialogs, the scanner and air-gap views). Do not add `!important` to win a specificity fight; raise or restructure the selector instead.

`src/styles/css-debt.test.ts` pins the number of `!important` flags in each stylesheet, and a stylesheet it does not list gets none. The test fails when a count rises, and also when one falls, so the number there is lowered in the same change. The layered component files are listed with the flags described under "Layered component files" above.

## Checking a CSS change

Static screenshots miss most regressions here. A change is only safe once computed styles are compared against the old CSS across the app's views, at widths either side of every breakpoint (360, 400, 480, 600, 640, 720, 760, 768, 860, 1180, 1220), and with `:hover`, `:focus-visible` and `:active` applied. Note that below 768px the browser pane emulates a touch device, which also exercises the `(pointer: coarse)` rules.

`scripts/css-check/` holds the tool for that comparison. It loads the real app with fake accounts in headless Chrome and records the computed styles of every element at 12 widths, in both themes, on the Dashboard, Usage and Settings pages, with hover, focus and pressed states forced and a card menu open.

1. Start the dev server: `npx vite --port 1437 --strictPort`
2. Start Chrome: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9444 --user-data-dir=<a temporary folder> about:blank`
3. With the old CSS in place, record: `node scripts/css-check/dump.mjs <temporary folder>/before.json`
4. Make the CSS change, then record again to `after.json`.
5. Compare: `node scripts/css-check/diff.mjs <temporary folder>/before.json <temporary folder>/after.json`

A full recording takes a few minutes and is over 100 MB, so keep recordings outside the repository. `WIDTHS=400,1400` (also `THEMES`, `SCENARIOS`) gives a quick partial run. Before trusting a result of zero differences, record the unchanged CSS twice and confirm those two match, and confirm that a deliberate small change is reported.

The tool does not cover dialogs (pairing, add account, alerts) or the inline rename box; check those by hand. The fake data in `css-check.html` answers the app's backend calls, so it needs updating when a command's response shape changes.
