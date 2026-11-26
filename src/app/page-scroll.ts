/**
 * In-memory scroll positions for the Usage, Accounts, and Settings pages. The pages stay mounted,
 * and this records where the visible one was just before a switch, then puts that back if hiding
 * the page cleared it. Nothing is stored on disk, so a fresh launch starts at the top.
 */

const positions = new Map<string, number>();

const PAGES = new Set(["activity", "accounts", "settings"]);

function scrollerIn(page: HTMLElement | null): HTMLElement | null {
  if (!page) return null;
  const inner = page.querySelector<HTMLElement>(".dashboard-scroll");
  if (inner && inner.scrollHeight > inner.clientHeight) return inner;
  const outer = page.querySelector<HTMLElement>(".settings-style-content");
  if (outer && outer.scrollHeight > outer.clientHeight) return outer;
  return inner ?? outer;
}

function scrollerFor(page: string): HTMLElement | null {
  return scrollerIn(
    document.querySelector<HTMLElement>(`.main-stage .kept-page[data-page="${CSS.escape(page)}"]`),
  );
}

/** Saves the scroll position of whichever Usage, Accounts, or Settings page is on screen. */
export function rememberVisiblePageScroll(): void {
  const page = document.querySelector<HTMLElement>(".main-stage .kept-page:not([hidden])");
  const key = page?.dataset.page;
  const scroller = scrollerIn(page);
  if (!key || !scroller || !PAGES.has(key)) return;
  positions.set(key, scroller.scrollTop);
}

/**
 * Puts `page` back where {@link rememberVisiblePageScroll} left it.
 * Returns false when the page cannot hold that position yet, so the caller can try again.
 */
export function restorePageScroll(page: string): boolean {
  const saved = positions.get(page);
  if (saved == null || saved <= 0) return true;
  const scroller = scrollerFor(page);
  if (!scroller) return false;
  const max = scroller.scrollHeight - scroller.clientHeight;
  if (max <= 0) return false;
  scroller.scrollTop = Math.min(saved, max);
  return scroller.scrollTop > 0;
}

const MAX_RESTORE_FRAMES = 30;

/** Restores `page` now, and again on the next frames if the scroller could not hold it yet. */
export function watchPageScrollRestore(page: string): () => void {
  if (!PAGES.has(page)) return () => {};
  let frames = 0;
  let cancelled = false;
  const apply = () => {
    if (cancelled) return;
    if (restorePageScroll(page)) return;
    if (frames < MAX_RESTORE_FRAMES) {
      frames += 1;
      requestAnimationFrame(apply);
    }
  };
  apply();
  return () => {
    cancelled = true;
  };
}
