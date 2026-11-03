import { vi } from "vitest";
import { MOBILE_OVERLAY_QUERY } from "../features/dashboard/sidebar-width";

/**
 * Makes `matchMedia` report a phone-width window (`narrow`) or a wide one, for components that lay
 * themselves out by `MOBILE_OVERLAY_QUERY`. happy-dom matches no query, so without this they render
 * their wide-window layout. Undo it with `vi.restoreAllMocks()`.
 */
export function setNarrowWindow(narrow: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === MOBILE_OVERLAY_QUERY ? narrow : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}
