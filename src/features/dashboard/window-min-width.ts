import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { isMobileDevice } from "../../shared/lib/platform";

/** The window's own minimum size in `tauri.conf.json` (`minWidth`, `minHeight`); keep them in step. */
export const CONFIG_MIN_WINDOW_WIDTH = 960;
export const CONFIG_MIN_WINDOW_HEIGHT = 680;

/** The window's minimum width: room for the sidebar and the account cards, never under the configured one. */
export function windowMinWidth(sidebarWidth: number, mainMin: number | null): number {
  if (mainMin === null) return CONFIG_MIN_WINDOW_WIDTH;
  return Math.max(CONFIG_MIN_WINDOW_WIDTH, Math.ceil(sidebarWidth + mainMin));
}

let applied: number | null = null;

/**
 * Stops the desktop window from being made narrower than the sidebar plus the room the account
 * cards need on one line (`measureMainMinWidth`), so narrowing the window never wraps a card's
 * header. Phones and tablets have no window to resize.
 */
export function keepWindowWideEnough(sidebarWidth: number, mainMin: number | null) {
  if (isMobileDevice()) return;
  const width = windowMinWidth(sidebarWidth, mainMin);
  if (width === applied) return;
  applied = width;
  try {
    void getCurrentWindow()
      .setMinSize(new LogicalSize(width, CONFIG_MIN_WINDOW_HEIGHT))
      .catch(() => {
        applied = null;
      });
  } catch {
    // Not running inside the app window (tests, a browser preview).
    applied = null;
  }
}
