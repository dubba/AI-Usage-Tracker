# CSS architecture

The app is dark-only and styled with plain CSS files. There is no CSS-in-JS and no build-time CSS tooling beyond Vite.

## Files and load order

The order below **is the cascade**. Later files override earlier ones, so do not reorder imports.

| # | File | Loaded from | What it holds |
|---|------|-------------|---------------|
| 1 | `styles/tokens.css` | `app/main.tsx` (first import) | Custom properties (colours, text sizes, safe-area insets) and the `@layer` order |
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

`app/App.tsx` pulls in `pairing.css` while `app/main.tsx` is still resolving its imports, which is why it sits before `base.css`. Check the real order in the browser (`document.querySelectorAll('style[data-vite-dev-id]')` in `npm run dev`) after changing any import.

## Tokens

Add new colours and shared sizes to `styles/tokens.css` and use `var(--name)`; do not repeat a hex value that already has a token. A fallback such as `var(--token, #hex)` is not needed, because the token is always defined.

`--sidebar-width` is deliberately **not** in `tokens.css`: its value depends on source order and media queries (and the app also sets it from JavaScript).

## Layers

`tokens.css` declares `@layer tokens, base, components, utilities;`, and only the tokens are in a layer today. Everything else is unlayered, and **an unlayered rule beats a layered one however specific it is**.

Do not wrap an existing file in a layer to "tidy up". It changes how the file cascades:

- Rules that win today by specificity (for example `pairing.css`) start losing to later, less specific rules.
- For `!important`, layer order inverts, so a layered `!important` beats an unlayered one.

When adding new CSS, put it in a layer. To migrate an existing file, first resolve its specificity conflicts, then move it and check the result visually at several widths.

## `!important`

About two thirds of the old `!important` flags were removed because nothing relied on them. The ~300 that remain are either needed (they beat a higher-specificity rule or an inline style) or sit on selectors that matched nothing in the views that were checked (error banners, update dialogs, the scanner and air-gap views). Do not add `!important` to win a specificity fight; raise or restructure the selector instead.

## Checking a CSS change

Static screenshots miss most regressions here. A change is only safe once computed styles are compared against the old CSS across the app's views, at widths either side of every breakpoint (360, 400, 480, 600, 640, 720, 760, 768, 860, 1180, 1220), and with `:hover`, `:focus-visible` and `:active` applied. Note that below 768px the browser pane emulates a touch device, which also exercises the `(pointer: coarse)` rules.
