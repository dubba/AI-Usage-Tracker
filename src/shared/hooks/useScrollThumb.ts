import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const MIN_THUMB = 24;

/**
 * Drives a drawn scroll thumb for a list whose native scrollbar is hidden
 * (see .scroll-thumb). The macOS app's WebView lays rows out as if its 6px
 * custom bar took no width, then paints it over them, so the native bar cannot
 * be relied on for spacing. With the thumb drawn inside the right padding the
 * layout is the same on every platform: the list only widens that padding
 * while it overflows.
 *
 * `contentKey` should change whenever the list content changes.
 */
export function useScrollThumb<T extends HTMLElement>(scrollRef: RefObject<T | null>, active: boolean, contentKey: unknown) {
  const thumbRef = useRef<HTMLElement | null>(null);
  const [overflows, setOverflows] = useState(false);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollHeight, clientHeight, scrollTop } = el;
    const next = scrollHeight > clientHeight + 1;
    setOverflows(next);
    const thumb = thumbRef.current;
    if (!thumb || !next) return;
    const height = Math.min(clientHeight, Math.max(MIN_THUMB, Math.floor((clientHeight * clientHeight) / scrollHeight)));
    const range = Math.max(0, scrollHeight - clientHeight);
    const clampedScroll = Math.max(0, Math.min(range, scrollTop));
    const top = range > 0 ? Math.floor(((clientHeight - height) * clampedScroll) / range) : 0;
    // Prefer rendering the thumb as a sibling inside a non-scrolling frame
    // (BucketModal, CustomDropdown) so `top` alone positions it without
    // fighting compositor scrolling or contributing to scrollHeight. If a
    // caller ever places it inside the scroller, subtract padding-bottom as
    // well because CSS adds padding-bottom below positioned children when
    // computing scrollable overflow.
    const insideScroller = el.contains(thumb);
    let translateY = top;
    if (insideScroller) {
      const paddingBottom =
        typeof window !== "undefined" && window.getComputedStyle
          ? parseFloat(window.getComputedStyle(el).paddingBottom) || 0
          : 0;
      translateY = Math.min(Math.floor(clampedScroll) + top, Math.max(0, scrollHeight - paddingBottom - height));
    }
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${translateY}px)`;
  }, [scrollRef]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!active || !el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [active, update, scrollRef, contentKey]);

  // Thumb visibility toggles with `overflows`, so position it once rendered.
  useLayoutEffect(() => {
    if (overflows) update();
  }, [overflows, update]);

  const onThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const el = scrollRef.current;
    const thumb = event.currentTarget;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startScroll = el.scrollTop;
    const range = el.scrollHeight - el.clientHeight;
    const track = el.clientHeight - thumb.offsetHeight;
    thumb.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      if (track > 0) el.scrollTop = startScroll + ((e.clientY - startY) * range) / track;
    };
    const up = () => {
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", up);
      thumb.removeEventListener("pointercancel", up);
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", up);
    thumb.addEventListener("pointercancel", up);
  }, [scrollRef]);

  return { thumbRef, overflows, onThumbPointerDown, update };
}
