import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * On a phone, a custom group's header row tries to keep the title, the Group pill, the edit pen,
 * and the right-hand add buttons on a single line. When the title would truncate to fit the pill
 * alongside it, this hook moves the Group pill onto a second line directly under the title so the
 * full title has room, and moves it back inline if the window widens or the title shrinks enough
 * for both to fit again.
 *
 * When a title still truncates even after wrapping the pill, `title.style.maxWidth` is tightened to
 * the visible end of the ellipsis so the edit pen stays close to the truncated text.
 */
export function useWrapPillWhenCramped(
  rowRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  titleKey: string,
): boolean {
  const [wrapped, setWrapped] = useState(false);
  const pillSpaceRef = useRef(0);

  // Reset to inline when switching groups, leaving mobile, or renaming the group.
  useLayoutEffect(() => {
    setWrapped(false);
  }, [enabled, titleKey]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !enabled) return;
    const title = row.querySelector<HTMLElement>("h1");
    const stack = row.querySelector<HTMLElement>(".dashboard-bucket-title-stack");
    const main = row.querySelector<HTMLElement>(".dashboard-bucket-title-main");
    const pill = row.querySelector<HTMLElement>(".dashboard-bucket-pill");
    const actions = row.querySelector<HTMLElement>(".dashboard-header-actions");
    if (!title || !stack || !main || !pill || !actions) return;

    const labelEl = title.querySelector<HTMLElement>(".mobile-sidebar-toggle-label");
    const isCut = () =>
      title.scrollWidth > title.clientWidth + 0.5 ||
      (labelEl ? labelEl.scrollWidth > labelEl.clientWidth + 0.5 : false);

    const freeSpace = () => {
      const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const stackMarginRight = parseFloat(getComputedStyle(stack).marginRight) || 0;
      const gap = actions.getBoundingClientRect().left - main.getBoundingClientRect().right;
      return Math.max(0, gap - (rowGap + stackMarginRight));
    };

    const ellipsisEnd = () => {
      if (labelEl) return null;
      const text = title.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) return null;
      const probe = document.createElement("span");
      probe.textContent = "\u2026";
      title.appendChild(probe);
      const ellipsis = probe.getBoundingClientRect().width;
      probe.remove();
      const box = title.getBoundingClientRect();
      const range = document.createRange();
      const length = (text as Text).length;
      for (let end = length; end > 0; end -= 1) {
        range.setStart(text, 0);
        range.setEnd(text, end);
        const used = range.getBoundingClientRect().right - box.left;
        if (used + ellipsis <= title.clientWidth + 0.01) return used + ellipsis;
      }
      return null;
    };

    const measure = () => {
      title.style.maxWidth = "";
      if (!wrapped) {
        if (pill.offsetWidth > 0) {
          const mainGap = parseFloat(getComputedStyle(main).columnGap) || 0;
          pillSpaceRef.current = pill.offsetWidth + mainGap;
        }
        if (isCut()) {
          setWrapped(true);
          return;
        }
      } else {
        const needed = pillSpaceRef.current || pill.offsetWidth || 64;
        if (!isCut() && freeSpace() >= needed + 1) {
          setWrapped(false);
          return;
        }
        if (isCut()) {
          const end = ellipsisEnd();
          if (end != null) title.style.maxWidth = `${Math.ceil(end) + 1}px`;
        }
      }
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        title.style.maxWidth = "";
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => {
      observer.disconnect();
      title.style.maxWidth = "";
    };
  }, [rowRef, enabled, titleKey, wrapped]);

  return enabled && wrapped;
}
