const DESKTOP_STORAGE_KEY = "paseo-usage-bridge:sidebar-width";
const MOBILE_STORAGE_KEY = "paseo-usage-bridge:sidebar-width-mobile";
const MOBILE_OVERLAY_QUERY = "(max-width: 860px)";

const FALLBACK_MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 720;
const MIN_MAIN_WIDTH = 520;
const DEFAULT_DESKTOP_SIDEBAR_WIDTH = 300;
const DEFAULT_MOBILE_SIDEBAR_WIDTH = 268;
const MOBILE_EDGE_GUTTER = 48;
const HEADING_WRAP_BUFFER_PX = 2;
const KEYBOARD_STEP = 16;

function isMobileOverlay(): boolean {
  return window.matchMedia(MOBILE_OVERLAY_QUERY).matches;
}

function defaultSidebarWidth(): number {
  return isMobileOverlay() ? DEFAULT_MOBILE_SIDEBAR_WIDTH : DEFAULT_DESKTOP_SIDEBAR_WIDTH;
}

function horizontalChrome(element: HTMLElement): number {
  const styles = getComputedStyle(element);
  return (
    parseFloat(styles.paddingLeft) +
    parseFloat(styles.paddingRight) +
    parseFloat(styles.borderLeftWidth) +
    parseFloat(styles.borderRightWidth)
  );
}

function measureMinSidebarWidth(sidebar: HTMLElement): number {
  const heading = sidebar.querySelector<HTMLElement>(".provider-sidebar-heading");
  if (!heading) return FALLBACK_MIN_SIDEBAR_WIDTH;

  const clone = heading.cloneNode(true) as HTMLElement;
  clone.setAttribute("aria-hidden", "true");
  clone.style.position = "absolute";
  clone.style.visibility = "hidden";
  clone.style.pointerEvents = "none";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.width = "max-content";
  clone.style.minWidth = "max-content";
  clone.style.maxWidth = "none";
  clone.style.flexWrap = "nowrap";
  clone.style.height = "auto";
  sidebar.append(clone);
  const headingWidth = clone.getBoundingClientRect().width;
  clone.remove();

  if (!Number.isFinite(headingWidth) || headingWidth <= 0) return FALLBACK_MIN_SIDEBAR_WIDTH;
  return Math.ceil(headingWidth + horizontalChrome(sidebar) + HEADING_WRAP_BUFFER_PX);
}

function maximumSidebarWidth(shell: HTMLElement, min: number): number {
  if (isMobileOverlay()) {
    return Math.max(
      min,
      Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MOBILE_EDGE_GUTTER),
    );
  }
  return Math.max(
    min,
    Math.min(MAX_SIDEBAR_WIDTH, shell.clientWidth - MIN_MAIN_WIDTH),
  );
}

function readSavedWidth(key: string): number | null {
  try {
    const value = Number.parseFloat(window.localStorage.getItem(key) ?? "");
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function saveWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // Resizing remains available even when WebView storage is unavailable.
  }
}

function storageKey(): string {
  return isMobileOverlay() ? MOBILE_STORAGE_KEY : DESKTOP_STORAGE_KEY;
}

export function installSidebarResize(): void {
  const attach = (): boolean => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const sidebar = shell?.querySelector<HTMLElement>(":scope > .sidebar");
    const main = shell?.querySelector<HTMLElement>(":scope > .main-stage");
    if (!shell || !sidebar || !main) return false;
    if (sidebar.querySelector(":scope > .sidebar-resize-handle")) return true;

    const handle = document.createElement("div");
    handle.className = "sidebar-resize-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "Resize account sidebar");
    handle.setAttribute("aria-orientation", "vertical");

    const grip = document.createElement("div");
    grip.className = "sidebar-resize-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.setAttribute("data-tooltip", "Drag to resize. Double-click to reset.");
    for (let index = 0; index < 3; index++) {
      grip.appendChild(document.createElement("span"));
    }
    handle.appendChild(grip);

    sidebar.append(handle);

    let desktopWidth = readSavedWidth(DESKTOP_STORAGE_KEY) ?? DEFAULT_DESKTOP_SIDEBAR_WIDTH;
    let mobileWidth = readSavedWidth(MOBILE_STORAGE_KEY) ?? DEFAULT_MOBILE_SIDEBAR_WIDTH;
    let width = isMobileOverlay() ? mobileWidth : desktopWidth;
    let minWidth = FALLBACK_MIN_SIDEBAR_WIDTH;
    let dragging = false;
    let activePointerId: number | null = null;

    const applyWidth = (nextWidth: number, persist = false) => {
      const max = maximumSidebarWidth(shell, minWidth);
      const floor = Math.min(minWidth, max);
      width = Math.round(Math.min(max, Math.max(floor, nextWidth)));
      if (isMobileOverlay()) {
        mobileWidth = width;
      } else {
        desktopWidth = width;
      }
      document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
      handle.setAttribute("aria-valuemin", String(floor));
      handle.setAttribute("aria-valuemax", String(max));
      handle.setAttribute("aria-valuenow", String(width));
      if (persist) saveWidth(storageKey(), width);
    };

    const refreshMinWidth = () => {
      minWidth = measureMinSidebarWidth(sidebar);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== activePointerId) return;
      applyWidth(event.clientX - shell.getBoundingClientRect().left);
    };

    const finishDrag = (event?: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("sidebar-resizing");
      handle.classList.remove("dragging");
      if (activePointerId !== null) {
        try {
          if (handle.hasPointerCapture(activePointerId)) {
            handle.releasePointerCapture(activePointerId);
          }
        } catch {
          // Capture may already have been released by the WebView.
        }
      }
      activePointerId = null;
      saveWidth(storageKey(), width);
      if (event) event.preventDefault();
    };

    refreshMinWidth();
    applyWidth(width);
    requestAnimationFrame(() => {
      refreshMinWidth();
      applyWidth(width);
    });
    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        refreshMinWidth();
        applyWidth(width);
      });
    }

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      activePointerId = event.pointerId;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Some mobile WebViews reject capture; document listeners still track the drag.
      }
      document.body.classList.add("sidebar-resizing");
      handle.classList.add("dragging");
    });

    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", (event) => finishDrag(event));
    handle.addEventListener("pointercancel", (event) => finishDrag(event));
    handle.addEventListener("lostpointercapture", () => finishDrag());
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", (event) => finishDrag(event));
    document.addEventListener("pointercancel", (event) => finishDrag(event));

    handle.addEventListener("dblclick", () => {
      applyWidth(defaultSidebarWidth(), true);
    });

    handle.addEventListener("keydown", (event) => {
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = width - KEYBOARD_STEP;
      if (event.key === "ArrowRight") nextWidth = width + KEYBOARD_STEP;
      if (event.key === "Home") nextWidth = minWidth;
      if (event.key === "End") nextWidth = maximumSidebarWidth(shell, minWidth);
      if (nextWidth === null) return;
      event.preventDefault();
      applyWidth(nextWidth, true);
    });

    const syncToViewport = () => {
      refreshMinWidth();
      width = isMobileOverlay() ? mobileWidth : desktopWidth;
      applyWidth(width);
    };

    window.addEventListener("resize", syncToViewport);
    const overlayQuery = window.matchMedia(MOBILE_OVERLAY_QUERY);
    if (typeof overlayQuery.addEventListener === "function") {
      overlayQuery.addEventListener("change", syncToViewport);
    } else {
      overlayQuery.addListener(syncToViewport);
    }
    return true;
  };

  if (attach()) return;

  const observer = new MutationObserver(() => {
    if (attach()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
