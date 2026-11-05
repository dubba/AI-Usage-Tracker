import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import {
  clampSidebarWidth,
  DEFAULT_DESKTOP_SIDEBAR_WIDTH,
  DEFAULT_MOBILE_SIDEBAR_WIDTH,
  defaultSidebarWidth,
  FALLBACK_MIN_SIDEBAR_WIDTH,
  KEYBOARD_STEP,
  maxSidebarWidth,
  measureMainMinWidth,
  measureMeterFitWidth,
  measureMinSidebarWidth,
  measureNavAlignedWidth,
  measureSyncLineFitWidth,
  measureToggleLineWidth,
  MOBILE_OVERLAY_QUERY,
  sidebarFitWidth,
  sidebarToggleStacks,
} from "./sidebar-width";
import { storageGet, storageSet, STORAGE_KEYS } from "../../shared/lib/storage";
import { keepWindowWideEnough } from "./window-min-width";

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
  // What the main area needs so account card headers stay on one line. The last measured value is
  // kept while no card is on screen (Usage or Settings), so coming back to Accounts does not wrap.
  const mainMinWidth = useRef<number | null>(null);
  const toggleLineWidth = useRef<number | null>(null);
  const fitWidth = useRef<number | null>(null);
  const currentWidth = useRef(isOverlay() ? widths.current.mobile : widths.current.desktop);
  const activePointer = useRef<number | null>(null);

  /**
   * `keepCardsOnOneLine`: the user is resizing the sidebar, so it also stops where the account
   * cards would run out of room, but never pulls in from where this resize started (`from`). A
   * window resize leaves that out, so a narrow window does not crush the sidebar to its minimum.
   */
  const limits = useCallback((keepCardsOnOneLine?: { from: number }) => {
    const shell = shellRef.current;
    const input = {
      overlay: isOverlay(),
      viewportWidth: window.innerWidth,
      shellWidth: shell?.clientWidth ?? window.innerWidth,
      min: minWidth.current,
    };
    const roomMax = maxSidebarWidth(input);
    const max = keepCardsOnOneLine
      ? Math.max(maxSidebarWidth({ ...input, mainMin: mainMinWidth.current }), Math.min(keepCardsOnOneLine.from, roomMax))
      : roomMax;
    return { max, floor: Math.min(minWidth.current, max) };
  }, [shellRef]);

  const applyWidth = useCallback((next: number, persist = false, keepCardsOnOneLine?: { from: number }) => {
    const { max, floor } = limits(keepCardsOnOneLine);
    const width = clampSidebarWidth(next, minWidth.current, max);
    currentWidth.current = width;
    if (isOverlay()) widths.current.mobile = width;
    else widths.current.desktop = width;
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    if (!isOverlay()) keepWindowWideEnough(width, mainMinWidth.current);
    document.documentElement.toggleAttribute("data-sidebar-toggle-stacked", sidebarToggleStacks(width, toggleLineWidth.current));
    setRange({ min: floor, max, now: width });
    if (persist) storageSet(storageKey(), String(width));
  }, [limits]);

  const refreshMeasurements = useCallback(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    minWidth.current = measureMinSidebarWidth(sidebar);
    const shell = shellRef.current;
    const mainMin = shell ? measureMainMinWidth(shell) : null;
    if (mainMin !== null) mainMinWidth.current = mainMin;
    toggleLineWidth.current = measureToggleLineWidth(sidebar);
    // On a wide window the default lines the cards up with the top bar's page switch; on the phone
    // overlay it fits the sync line and the L / U row. Both also leave the meters room.
    const lineWidth =
      (shell ? measureNavAlignedWidth(shell, sidebar) : null) ??
      sidebarFitWidth(measureSyncLineFitWidth(sidebar), toggleLineWidth.current);
    // Never narrower than the meters need, so "GROKBOT 100%" does not wrap.
    const meterWidth = measureMeterFitWidth(sidebar);
    fitWidth.current = lineWidth === null ? meterWidth : meterWidth === null ? lineWidth : Math.max(lineWidth, meterWidth);
  }, [sidebarRef, shellRef]);

  // Until the user picks a width, the sidebar uses the default width (`fitWidth`). The fixed
  // default is only a fallback.
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
    // A font used for the first time loads after `ready` has resolved; the measurements depend on it.
    document.fonts?.addEventListener?.("loadingdone", syncToViewport);
    const overlayQuery = window.matchMedia(MOBILE_OVERLAY_QUERY);
    window.addEventListener("resize", syncToViewport);
    overlayQuery.addEventListener("change", syncToViewport);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", syncToViewport);
      overlayQuery.removeEventListener("change", syncToViewport);
      document.fonts?.removeEventListener?.("loadingdone", syncToViewport);
    };
  }, [syncToViewport]);

  // The rows load, and change, after the handle mounts, and a font used for the first time loads after
  // `document.fonts.ready` has resolved, which changes how wide a label and its percentage are (on the
  // phone nothing else re-measures). While the sidebar is on its default width, measure again when the
  // rows change or their meters change size, so the default keeps room for them.
  useEffect(() => {
    const list = sidebarRef.current?.querySelector(".provider-list");
    if (!list) return;
    let timer: number | undefined;
    const remeasure = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (useFitAsDefault.current[isOverlay() ? "mobile" : "desktop"]) syncToViewport();
      }, 50);
    };
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(remeasure);
    const watchMeters = () => {
      sizes?.disconnect();
      list.querySelectorAll(".sidebar-meter").forEach((meter) => sizes?.observe(meter));
    };
    watchMeters();
    const rows = new MutationObserver(() => {
      watchMeters();
      remeasure();
    });
    rows.observe(list, { childList: true, subtree: true, characterData: true });
    // The phone overlay is laid out differently once it is open, so measure again then.
    const sidebar = sidebarRef.current;
    const opening = new MutationObserver(remeasure);
    if (sidebar) opening.observe(sidebar, { attributes: true, attributeFilter: ["class"] });
    return () => {
      window.clearTimeout(timer);
      sizes?.disconnect();
      rows.disconnect();
      opening.disconnect();
    };
  }, [sidebarRef, syncToViewport]);

  // The account cards load, and change, after the handle mounts. Measure again when the page
  // changes, so the window's minimum width follows the cards actually on screen.
  useEffect(() => {
    const main = shellRef.current?.querySelector(".main-stage");
    if (!main) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (isOverlay()) return;
        refreshMeasurements();
        keepWindowWideEnough(currentWidth.current, mainMinWidth.current);
      });
    });
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [shellRef, refreshMeasurements]);

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
    // The cards may have loaded or changed since the last measurement.
    refreshMeasurements();
    const dragFrom = { from: currentWidth.current };
    activePointer.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some mobile WebViews reject capture; the document listeners below still track the drag.
    }
    // Attached right away (not from an effect) so the first pointermove is never missed.
    const onMove = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== activePointer.current) return;
      applyWidth(move.clientX - (shellRef.current?.getBoundingClientRect().left ?? 0), false, dragFrom);
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

  // Double-click: back to the default width (see `fitWidth`). If that cannot be measured yet, the
  // fixed default.
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
    if (next === null && event.key !== "End") return;
    event.preventDefault();
    refreshMeasurements();
    const keyFrom = { from: currentWidth.current };
    if (event.key === "End") next = limits(keyFrom).max;
    useFitAsDefault.current[isOverlay() ? "mobile" : "desktop"] = false;
    applyWidth(next ?? currentWidth.current, true, keyFrom);
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
