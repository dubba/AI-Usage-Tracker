import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_EVENTS } from "../../shared/lib/events";
import { STORAGE_KEYS, storageGet } from "../../shared/lib/storage";
import { captureEvents, installFakeWindow } from "../../test-utils/fakeWindow";
import { applyUiState, collectUiState } from "./ui-state";

let env: ReturnType<typeof installFakeWindow>;

beforeEach(() => {
  env = installFakeWindow();
});

afterEach(() => {
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

  it("ignores invalid values", () => {
    applyUiState({ sidebar_width: -5, sidebar_group_order: "nope" });
    expect(storageGet(STORAGE_KEYS.sidebarWidthDesktop)).toBeNull();
    expect(storageGet(STORAGE_KEYS.sidebarGroupOrder)).toBeNull();
  });

  it("asks the dashboard to resync afterwards", () => {
    const resyncs = captureEvents(env.window, UI_EVENTS.dashboardResync);
    applyUiState({});
    expect(resyncs).toHaveLength(1);
  });
});

describe("collectUiState", () => {
  it("is empty when nothing has been customized", () => {
    expect(collectUiState()).toEqual({});
  });

  it("round-trips through applyUiState", () => {
    applyUiState({
      sidebar_group_order: ["provider:grok"],
      provider_order: ["grok"],
      sidebar_width: 300,
      page_account_order: { "bucket:b1": ["a", "b"] },
    });
    expect(collectUiState()).toEqual({
      sidebar_group_order: ["provider:grok"],
      provider_order: ["grok"],
      sidebar_width: 300,
      page_account_order: { "bucket:b1": ["a", "b"] },
    });
  });
});
