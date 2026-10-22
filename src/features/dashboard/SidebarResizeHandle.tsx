import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import {
  clampSidebarWidth,
  DEFAULT_DESKTOP_SIDEBAR_WIDTH,
  DEFAULT_MOBILE_SIDEBAR_WIDTH,
  defaultSidebarWidth,
  FALLBACK_MIN_SIDEBAR_WIDTH,
  KEYBOARD_STEP,
  maxSidebarWidth,
  measureMinSidebarWidth,
  measureSyncLineFitWidth,
  measureToggleLineWidth,
  MOBILE_OVERLAY_QUERY,
  sidebarFitWidth,
  sidebarToggleStacks,
} from "./sidebar-width";
import { storageGet, storageSet, STORAGE_KEYS } from "../../shared/lib/storage";

function readSavedWidth(key: string): number | null {
  const value = Number.parseFloat(storageGet(key) ?? "");
  return Number.isFinite(value) ? value : null;
}

const isOverlay = () => window.matchMedia(MOBILE_OVERLAY_QUERY).matches;
const storageKey = () => (isOverlay() ? STORAGE_KEYS.sidebarWidthMobile : STORAGE_KEYS.sidebarWidthDesktop);

/**
 * Drag / keyboard handle on the sidebar's right edge. Sets `--sidebar-width` on
 * the document and remembers the width separately for desktop and the phone overlay.
 */
export function SidebarResizeHandle({
  shellRef,
  sidebarRef,
}: {
  shellRef: RefObject<HTMLElement | null>;
  sidebarRef: RefObject<HTMLElement | null>;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ min: FALLBACK_MIN_SIDEBAR_WIDTH, max: 720, now: DEFAULT_DESKTOP_SIDEBAR_WIDTH });
  const [dragging, setDragging] = useState(false);
  // Width per layout, and the sidebar's measured minimum. Refs: they change without needing a render.
  const savedDesktop = useRef(readSavedWidth(STORAGE_KEYS.sidebarWidthDesktop));
  const savedMobile = useRef(readSavedWidth(STORAGE_KEYS.sidebarWidthMobile));
  const widths = useRef({
    desktop: savedDesktop.current ?? DEFAULT_DESKTOP_SIDEBAR_WIDTH,
    mobile: savedMobile.current ?? DEFAULT_MOBILE_SIDEBAR_WIDTH,
  });
  const minWidth = useRef(FALLBACK_MIN_SIDEBAR_WIDTH);
  const toggleLineWidth = useRef<number | null>(null);
  const fitWidth = useRef<number | null>(null);
  const currentWidth = useRef(isOverlay() ? widths.current.mobile : widths.current.desktop);
  const activePointer = useRef<number | null>(null);

  const limits = useCallback(() => {
    const shell = shellRef.current;
    const max = maxSidebarWidth({
      overlay: isOverlay(),
      viewportWidth: window.innerWidth,
      shellWidth: shell?.clientWidth ?? window.innerWidth,
      min: minWidth.current,
    });
    return { max, floor: Math.min(minWidth.current, max) };
  }, [shellRef]);

  const applyWidth = useCallback((next: number, persist = false) => {
    const { max, floor } = limits();
    const width = clampSidebarWidth(next, minWidth.current, max);
    currentWidth.current = width;
    if (isOverlay()) widths.current.mobile = width;
    else widths.current.desktop = width;
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    document.documentElement.toggleAttribute("data-sidebar-toggle-stacked", sidebarToggleStacks(width, toggleLineWidth.current));
    setRange({ min: floor, max, now: width });
    if (persist) storageSet(storageKey(), String(width));
  }, [limits]);

  const refreshMeasurements = useCallback(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    minWidth.current = measureMinSidebarWidth(sidebar);
    toggleLineWidth.current = measureToggleLineWidth(sidebar);
    fitWidth.current = sidebarFitWidth(measureSyncLineFitWidth(sidebar), toggleLineWidth.current);
  }, [sidebarRef]);

  // Until the user picks a width, the sidebar fits "Accounts synced just now" on one
  // line. The fixed default is only a fallback.
  const useFitAsDefault = useRef({
    desktop: savedDesktop.current === null,
    mobile: savedMobile.current === null,
  });

  const syncToViewport = useCallback(() => {
    refreshMeasurements();
    const overlay = isOverlay();
    if (useFitAsDefault.current[overlay ? "mobile" : "desktop"] && fitWidth.current !== null) {
      if (overlay) widths.current.mobile = fitWidth.current;
      else widths.current.desktop = fitWidth.current;
    }
    applyWidth(overlay ? widths.current.mobile : widths.current.desktop);
  }, [applyWidth, refreshMeasurements]);

  useEffect(() => {
    syncToViewport();
    const frame = requestAnimationFrame(syncToViewport);
    // The sync line and the heading depend on the web font, which may load after first paint.
    void document.fonts?.ready.then(syncToViewport);
    const overlayQuery = window.matchMedia(MOBILE_OVERLAY_QUERY);
    window.addEventListener("resize", syncToViewport);
    overlayQuery.addEventListener("change", syncToViewport);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", syncToViewport);
      overlayQuery.removeEventListener("change", syncToViewport);
    };
  }, [syncToViewport]);

  const stopFollowing = useRef<(() => void) | null>(null);

  const finishDrag = useCallback(() => {
    if (activePointer.current === null) return;
    const handle = handleRef.current;
    const pointerId = activePointer.current;
    activePointer.current = null;
    stopFollowing.current?.();
    stopFollowing.current = null;
    setDragging(false);
    document.body.classList.remove("sidebar-resizing");
    try {
      if (handle?.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    } catch {
      // Capture may already have been released by the WebView.
    }
    storageSet(storageKey(), String(currentWidth.current));
  }, []);

  // Never leave the page stuck in its "resizing" state if the sidebar unmounts mid-drag.
  useEffect(() => () => {
    stopFollowing.current?.();
    document.body.classList.remove("sidebar-resizing");
    document.documentElement.removeAttribute("data-sidebar-toggle-stacked");
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    useFitAsDefault.current[isOverlay() ? "mobile" : "desktop"] = false;
    activePointer.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some mobile WebViews reject capture; the document listeners below still track the drag.
    }
    // Attached right away (not from an effect) so the first pointermove is never missed.
    const onMove = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== activePointer.current) return;
      applyWidth(move.clientX - (shellRef.current?.getBoundingClientRect().left ?? 0));
    };
    const onEnd = (end: globalThis.PointerEvent) => {
      if (end.pointerId !== activePointer.current) return;
      end.preventDefault();
      finishDrag();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
    stopFollowing.current = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
    };
    document.body.classList.add("sidebar-resizing");
    setDragging(true);
  };

  // Double-click: wide enough for "Accounts synced just now" on one line. If that row cannot
  // be measured yet, go back to the fixed default.
  const fitToSyncLine = () => {
    refreshMeasurements();
    const overlay = isOverlay();
    useFitAsDefault.current[overlay ? "mobile" : "desktop"] = false;
    applyWidth(fitWidth.current ?? defaultSidebarWidth(overlay), true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = currentWidth.current - KEYBOARD_STEP;
    if (event.key === "ArrowRight") next = currentWidth.current + KEYBOARD_STEP;
    if (event.key === "Home") next = minWidth.current;
    if (event.key === "End") next = limits().max;
    if (next === null) return;
    event.preventDefault();
    useFitAsDefault.current[isOverlay() ? "mobile" : "desktop"] = false;
    applyWidth(next, true);
  };

  return (
    <div
      ref={handleRef}
      className={`sidebar-resize-handle${dragging ? " dragging" : ""}`}
      tabIndex={0}
      role="separator"
      aria-label="Resize account sidebar"
      aria-orientation="vertical"
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={range.now}
      onPointerDown={onPointerDown}
      onLostPointerCapture={finishDrag}
      onDoubleClick={fitToSyncLine}
      onKeyDown={onKeyDown}
    >
      <div className="sidebar-resize-grip" aria-hidden="true" data-tooltip="Drag to resize, double-click to fit">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
