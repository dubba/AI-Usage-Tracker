const STORAGE_KEY = "paseo-usage-bridge:sidebar-width";
const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 720;
const MIN_MAIN_WIDTH = 520;
const KEYBOARD_STEP = 16;

function defaultSidebarWidth(): number {
  return 300;
}

function maximumSidebarWidth(shell: HTMLElement): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, shell.clientWidth - MIN_MAIN_WIDTH),
  );
}

function readSavedWidth(): number | null {
  try {
    const value = Number.parseFloat(window.localStorage.getItem(STORAGE_KEY) ?? "");
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function saveWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Resizing remains available even when WebView storage is unavailable.
  }
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
    handle.title = "Drag to resize. Double-click to reset.";
    sidebar.append(handle);

    let width = readSavedWidth() ?? defaultSidebarWidth();
    let dragging = false;
    let activePointerId: number | null = null;

    const applyWidth = (nextWidth: number, persist = false) => {
      const max = maximumSidebarWidth(shell);
      width = Math.round(Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, nextWidth)));
      document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
      handle.setAttribute("aria-valuemin", String(MIN_SIDEBAR_WIDTH));
      handle.setAttribute("aria-valuemax", String(max));
      handle.setAttribute("aria-valuenow", String(width));
      if (persist) saveWidth(width);
    };

    const finishDrag = (event?: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("sidebar-resizing");
      handle.classList.remove("dragging");
      if (event && activePointerId !== null && handle.hasPointerCapture(activePointerId)) {
        handle.releasePointerCapture(activePointerId);
      }
      activePointerId = null;
      saveWidth(width);
    };

    applyWidth(width);

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      activePointerId = event.pointerId;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("sidebar-resizing");
      handle.classList.add("dragging");
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerId !== activePointerId) return;
      const shellLeft = shell.getBoundingClientRect().left;
      applyWidth(event.clientX - shellLeft);
    });

    handle.addEventListener("pointerup", (event) => finishDrag(event));
    handle.addEventListener("pointercancel", (event) => finishDrag(event));
    handle.addEventListener("lostpointercapture", () => finishDrag());

    handle.addEventListener("dblclick", () => {
      applyWidth(defaultSidebarWidth(), true);
    });

    handle.addEventListener("keydown", (event) => {
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = width - KEYBOARD_STEP;
      if (event.key === "ArrowRight") nextWidth = width + KEYBOARD_STEP;
      if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
      if (event.key === "End") nextWidth = maximumSidebarWidth(shell);
      if (nextWidth === null) return;
      event.preventDefault();
      applyWidth(nextWidth, true);
    });

    window.addEventListener("resize", () => applyWidth(width));
    return true;
  };

  if (attach()) return;

  const observer = new MutationObserver(() => {
    if (attach()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
