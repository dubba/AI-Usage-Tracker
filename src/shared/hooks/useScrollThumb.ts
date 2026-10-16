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
    const height = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight);
    const range = scrollHeight - clientHeight;
    const top = range > 0 ? ((clientHeight - height) * scrollTop) / range : 0;
    // The thumb is absolutely positioned inside the scroller, so it scrolls
    // with the content; offsetting by scrollTop keeps it in view.
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${scrollTop + top}px)`;
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
