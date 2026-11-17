import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_EVENTS } from "../../shared/lib/events";
import { STORAGE_KEYS, storageGet } from "../../shared/lib/storage";
import { captureEvents, installFakeWindow } from "../../test-utils/fakeWindow";
import { getBottomNavLabels, setBottomNavLabels } from "../../shared/lib/bottom-nav-labels";
import { getCompactDashboardMode, setCompactDashboardMode } from "../../shared/lib/compact-dashboard";
import { getUsageDisplayMode, setUsageDisplayMode } from "../../shared/lib/usage-display";
import { applyUiState, collectUiState } from "./ui-state";

let env: ReturnType<typeof installFakeWindow>;

beforeEach(() => {
  env = installFakeWindow();
});

afterEach(() => {
  setUsageDisplayMode("left");
  setBottomNavLabels("on");
  setCompactDashboardMode("off");
  vi.unstubAllGlobals();
});

describe("applyUiState", () => {
  it("saves group and provider order and announces both", () => {
    const groups = captureEvents(env.window, UI_EVENTS.groupOrderChanged);
    const providers = captureEvents(env.window, UI_EVENTS.providerOrderChanged);
    applyUiState({ sidebar_group_order: ["bucket:b1"], provider_order: ["grok", "openai"] });
    expect(JSON.parse(storageGet(STORAGE_KEYS.sidebarGroupOrder)!)).toEqual(["bucket:b1"]);
    expect(JSON.parse(storageGet(STORAGE_KEYS.providerOrder)!)).toEqual(["grok", "openai"]);
    expect(groups).toEqual([["bucket:b1"]]);
    expect(providers).toEqual([["grok", "openai"]]);
  });

  it("applies the sidebar width to storage and the page", () => {
    applyUiState({ sidebar_width: 320 });
    expect(storageGet(STORAGE_KEYS.sidebarWidthDesktop)).toBe("320");
    expect(env.cssVars.get("--sidebar-width")).toBe("320px");
  });

  it("applies the appearance theme to storage and the page", () => {
    applyUiState({ theme: "light" });
    expect(storageGet(STORAGE_KEYS.theme)).toBe("light");
    expect(env.attrs.get("data-theme")).toBe("light");
  });

  it("applies the usage display mode to storage and the running app", () => {
    applyUiState({ usage_display_mode: "used" });
    expect(storageGet(STORAGE_KEYS.usageDisplayMode)).toBe("used");
    expect(getUsageDisplayMode()).toBe("used");
  });

  it("applies menu bar labels to storage and the running app", () => {
    applyUiState({ bottom_nav_labels: "off" });
    expect(storageGet(STORAGE_KEYS.bottomNavLabels)).toBe("off");
    expect(getBottomNavLabels()).toBe("off");
  });

  it("applies compact dashboard mode to storage and the running app", () => {
    applyUiState({ compact_dashboard: "on" });
    expect(storageGet(STORAGE_KEYS.compactDashboard)).toBe("on");
    expect(getCompactDashboardMode()).toBe("on");
  });

  it("leaves menu bar labels alone when an older transfer omits them", () => {
    setBottomNavLabels("off");
    applyUiState({});
    expect(storageGet(STORAGE_KEYS.bottomNavLabels)).toBe("off");
    expect(getBottomNavLabels()).toBe("off");
  });

  it("ignores invalid values", () => {
    applyUiState({
      sidebar_width: -5,
      sidebar_group_order: "nope",
      theme: "sepia",
      usage_display_mode: "remaining",
      bottom_nav_labels: "maybe<script>",
      compact_dashboard: "huge",
    });
    expect(storageGet(STORAGE_KEYS.sidebarWidthDesktop)).toBeNull();
    expect(storageGet(STORAGE_KEYS.sidebarGroupOrder)).toBeNull();
    expect(storageGet(STORAGE_KEYS.theme)).toBeNull();
    expect(storageGet(STORAGE_KEYS.usageDisplayMode)).toBeNull();
    expect(storageGet(STORAGE_KEYS.bottomNavLabels)).toBeNull();
    expect(storageGet(STORAGE_KEYS.compactDashboard)).toBeNull();
  });

  it("asks the dashboard to resync afterwards", () => {
    const resyncs = captureEvents(env.window, UI_EVENTS.dashboardResync);
    applyUiState({});
    expect(resyncs).toHaveLength(1);
  });
});

describe("collectUiState", () => {
  it("reports the default theme and display mode when nothing has been customized", () => {
    expect(collectUiState()).toEqual({
      theme: "dark",
      usage_display_mode: "left",
      bottom_nav_labels: "on",
      compact_dashboard: "off",
    });
  });

  it("round-trips through applyUiState", () => {
    applyUiState({
      sidebar_group_order: ["provider:grok"],
      provider_order: ["grok"],
      sidebar_width: 300,
      page_account_order: { "bucket:b1": ["a", "b"] },
      theme: "light",
      usage_display_mode: "used",
      bottom_nav_labels: "off",
      compact_dashboard: "on",
    });
    expect(collectUiState()).toEqual({
      sidebar_group_order: ["provider:grok"],
      provider_order: ["grok"],
      sidebar_width: 300,
      page_account_order: { "bucket:b1": ["a", "b"] },
      theme: "light",
      usage_display_mode: "used",
      bottom_nav_labels: "off",
      compact_dashboard: "on",
    });
  });
});
