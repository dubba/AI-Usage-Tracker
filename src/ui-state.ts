import { collectPageUiState, applyPageUiState } from "./dashboard-page-state";
import { requestDashboardResync, UI_EVENTS } from "./events";
import { isStringArray, readJson, storageGet, storageSet, STORAGE_KEYS, writeJson } from "./storage";

type UiState = Record<string, unknown>;

/** Layout state (group/provider order, collapsed cards, page order, sidebar width) to send to a paired device. */
export function collectUiState(): UiState {
  const ui: UiState = {};
  const groupOrder = readJson<string[]>(STORAGE_KEYS.sidebarGroupOrder, [], isStringArray);
  if (groupOrder.length) ui.sidebar_group_order = groupOrder;
  const providerOrder = readJson<string[]>(STORAGE_KEYS.providerOrder, [], isStringArray);
  if (providerOrder.length) ui.provider_order = providerOrder;
  Object.assign(ui, collectPageUiState());
  const width = Number.parseInt(storageGet(STORAGE_KEYS.sidebarWidthDesktop) ?? "", 10);
  if (Number.isFinite(width) && width > 0) ui.sidebar_width = width;
  return ui;
}

/** Applies layout state received from a paired device, then asks the dashboard to re-read it. */
export function applyUiState(payload: UiState): void {
  if (Array.isArray(payload.sidebar_group_order)) {
    writeJson(STORAGE_KEYS.sidebarGroupOrder, payload.sidebar_group_order);
    window.dispatchEvent(new CustomEvent(UI_EVENTS.groupOrderChanged, { detail: payload.sidebar_group_order }));
  }
  if (Array.isArray(payload.provider_order)) {
    writeJson(STORAGE_KEYS.providerOrder, payload.provider_order);
    window.dispatchEvent(new CustomEvent(UI_EVENTS.providerOrderChanged, { detail: payload.provider_order }));
  }
  applyPageUiState(payload);
  if (typeof payload.sidebar_width === "number" && payload.sidebar_width > 0) {
    storageSet(STORAGE_KEYS.sidebarWidthDesktop, String(payload.sidebar_width));
    document.documentElement.style.setProperty("--sidebar-width", `${payload.sidebar_width}px`);
  }
  requestDashboardResync();
}
