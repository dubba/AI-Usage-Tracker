import { useLayoutEffect, type RefObject } from "react";

/**
 * On a phone, a custom group's title row holds the title, the Group pill, the edit pen and the add
 * buttons. When the title is too long for all of them it would end in an ellipsis; instead, drop the
 * Group pill (`data-pill-hidden` on the row, styled in sidebar-list.css) to give the title its space.
 * While the title still ends in an ellipsis without the pill, its box is shrunk to end right after the
 * ellipsis (the ellipsis follows the last letter that fits, which leaves blank space inside the box),
 * so the pen sits as far from the title's visible end as from the add buttons (`data-title-cut` also
 * nudges it for the blank space the dots carry on their right).
 *
 * The pill comes back once the title fits with it again, so the decision uses the pill's last
 * measured width (a hidden pill has none), the title's full text width (`scrollWidth`) and the free
 * space left between the title, the pen and the add buttons.
 */
export function useHidePillWhenCramped(rowRef: RefObject<HTMLElement | null>, enabled: boolean, titleKey: string): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !enabled) return;
    const title = row.querySelector<HTMLElement>("h1");
    const pill = row.querySelector<HTMLElement>(".dashboard-bucket-pill");
    const pen = row.querySelector<HTMLElement>(".edit-bucket-title-btn");
    const actions = row.querySelector<HTMLElement>(".dashboard-header-actions");
    if (!title || !pill || !pen || !actions) return;

    const isCut = () => title.scrollWidth > title.clientWidth + 0.5;
    const hide = () => row.setAttribute("data-pill-hidden", "");
    let pillSpace = 0;

    /** Blank space between the title, the pen and the add buttons beyond the row's own gaps (5px each when the pill is hidden). */
    const freeSpace = () => {
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const left = pen.getBoundingClientRect().left - title.getBoundingClientRect().right;
      const right = actions.getBoundingClientRect().left - pen.getBoundingClientRect().right;
      return Math.max(0, left + right - 2 * gap);
    };

    /** Width from the title's left edge to the end of its ellipsis (the last letter that fits, then the dots). */
    const ellipsisEnd = () => {
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

    const update = () => {
      title.style.maxWidth = "";
      row.removeAttribute("data-title-cut");
      if (!row.hasAttribute("data-pill-hidden")) {
        if (pill.offsetWidth > 0) {
          // The pill's width, plus the row's gap and the pill's negative margin between it and the title.
          const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
          const margin = parseFloat(getComputedStyle(pill).marginLeft) || 0;
          pillSpace = pill.offsetWidth + gap + margin;
        }
        if (isCut()) hide();
      } else if (title.scrollWidth + pillSpace <= title.clientWidth + freeSpace()) {
        row.removeAttribute("data-pill-hidden");
        if (isCut()) hide();
      }
      if (row.hasAttribute("data-pill-hidden") && isCut()) {
        const end = ellipsisEnd();
        // One extra px so rounding never drops a letter.
        if (end != null) title.style.maxWidth = `${Math.ceil(end) + 1}px`;
        // The dots also have blank space on their right; the CSS nudges the pen to even it out.
        row.setAttribute("data-title-cut", "");
      }
    };

    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => observer.disconnect();
  }, [rowRef, enabled, titleKey]);
}
