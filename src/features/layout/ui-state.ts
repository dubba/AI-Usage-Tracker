import { collectPageUiState, applyPageUiState } from "./dashboard-page-state";
import { requestDashboardResync, UI_EVENTS } from "../../shared/lib/events";
import { isStringArray, readJson, storageGet, storageSet, STORAGE_KEYS, writeJson } from "../../shared/lib/storage";
import { normalizeAccentColor, readAccentColor, setAccentColor } from "../../shared/lib/accent-color";
import { isThemePreference, readThemePreference, setThemePreference } from "../../shared/lib/theme";
import { getBottomNavLabels, isBottomNavLabels, setBottomNavLabels } from "../../shared/lib/bottom-nav-labels";
import { getCompactDashboardMode, isCompactDashboardMode, setCompactDashboardMode } from "../../shared/lib/compact-dashboard";
import { getUsageDisplayMode, isUsageDisplayMode, setUsageDisplayMode } from "../../shared/lib/usage-display";

type UiState = Record<string, unknown>;

/** Layout state (group/provider order, collapsed cards, page order, sidebar width, theme, accent color, usage display mode, menu bar labels, compact dashboard) to send to a paired device. */
export function collectUiState(): UiState {
  const ui: UiState = {};
  const groupOrder = readJson<string[]>(STORAGE_KEYS.sidebarGroupOrder, [], isStringArray);
  if (groupOrder.length) ui.sidebar_group_order = groupOrder;
  const providerOrder = readJson<string[]>(STORAGE_KEYS.providerOrder, [], isStringArray);
  if (providerOrder.length) ui.provider_order = providerOrder;
  Object.assign(ui, collectPageUiState());
  const width = Number.parseInt(storageGet(STORAGE_KEYS.sidebarWidthDesktop) ?? "", 10);
  if (Number.isFinite(width) && width > 0) ui.sidebar_width = width;
  ui.theme = readThemePreference();
  ui.accent_color = readAccentColor();
  ui.usage_display_mode = getUsageDisplayMode();
  ui.bottom_nav_labels = getBottomNavLabels();
  ui.compact_dashboard = getCompactDashboardMode();
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
  if (isThemePreference(payload.theme)) {
    setThemePreference(payload.theme);
  }
  const accentColor = normalizeAccentColor(payload.accent_color);
  if (accentColor) {
    setAccentColor(accentColor);
  }
  if (isUsageDisplayMode(payload.usage_display_mode)) {
    setUsageDisplayMode(payload.usage_display_mode);
  }
  // Absent on a transfer from an older app, which leaves this device's own choice alone.
  if (isBottomNavLabels(payload.bottom_nav_labels)) {
    setBottomNavLabels(payload.bottom_nav_labels);
  }
  if (isCompactDashboardMode(payload.compact_dashboard)) {
    setCompactDashboardMode(payload.compact_dashboard);
  }
  requestDashboardResync();
}
