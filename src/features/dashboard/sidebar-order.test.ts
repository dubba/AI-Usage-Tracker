import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWN_PROVIDERS, readDashboardProviderOrder, readSidebarGroupOrder, storeSidebarGroupOrder, uniqueStrings } from "./sidebar-order";
import { STORAGE_KEYS } from "../../shared/lib/storage";
import { captureEvents, installFakeWindow } from "../../test-utils/fakeWindow";
import { UI_EVENTS } from "../../shared/lib/events";

let env: ReturnType<typeof installFakeWindow>;

beforeEach(() => {
  env = installFakeWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uniqueStrings", () => {
  it("drops duplicates and empty values, keeping first-seen order", () => {
    expect(uniqueStrings(["a", "", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});

describe("sidebar group order", () => {
  it("reads nothing when unset or malformed", () => {
    expect(readSidebarGroupOrder()).toEqual([]);
    env.localStorage.setItem(STORAGE_KEYS.sidebarGroupOrder, "{oops");
    expect(readSidebarGroupOrder()).toEqual([]);
  });

  it("ignores non-string entries", () => {
    env.localStorage.setItem(STORAGE_KEYS.sidebarGroupOrder, JSON.stringify(["a", 1, "", "b"]));
    expect(readSidebarGroupOrder()).toEqual(["a", "b"]);
  });

  it("stores the order without 'all' and derives the provider order from it", () => {
    const groups = captureEvents(env.window, UI_EVENTS.groupOrderChanged);
    const providers = captureEvents(env.window, UI_EVENTS.providerOrderChanged);
    storeSidebarGroupOrder(["all", "bucket:b1", "provider:grok", "provider:openai"]);
    expect(readSidebarGroupOrder()).toEqual(["bucket:b1", "provider:grok", "provider:openai"]);
    const derived = JSON.parse(env.localStorage.getItem(STORAGE_KEYS.providerOrder)!);
    expect(derived.slice(0, 2)).toEqual(["grok", "openai"]);
    expect(new Set(derived)).toEqual(new Set(KNOWN_PROVIDERS));
    expect(groups).toHaveLength(1);
    expect(providers).toHaveLength(1);
  });
});

describe("readDashboardProviderOrder", () => {
  it("returns every known provider when nothing is saved", () => {
    expect(readDashboardProviderOrder()).toEqual(KNOWN_PROVIDERS);
  });

  it("keeps the saved order and appends providers that are missing", () => {
    env.localStorage.setItem(STORAGE_KEYS.providerOrder, JSON.stringify(["grok", "openai"]));
    const order = readDashboardProviderOrder();
    expect(order.slice(0, 2)).toEqual(["grok", "openai"]);
    expect(new Set(order)).toEqual(new Set(KNOWN_PROVIDERS));
  });

  it("drops unknown and duplicate entries and repairs the stored value", () => {
    env.localStorage.setItem(STORAGE_KEYS.providerOrder, JSON.stringify(["grok", "nope", "grok", "openai"]));
    const order = readDashboardProviderOrder();
    expect(order.slice(0, 2)).toEqual(["grok", "openai"]);
    expect(JSON.parse(env.localStorage.getItem(STORAGE_KEYS.providerOrder)!)).toEqual(order);
  });

  it("falls back to the defaults for malformed JSON", () => {
    env.localStorage.setItem(STORAGE_KEYS.providerOrder, "{oops");
    expect(readDashboardProviderOrder()).toEqual(KNOWN_PROVIDERS);
  });
});
