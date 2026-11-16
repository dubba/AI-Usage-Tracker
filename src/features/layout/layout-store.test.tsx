// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { UI_EVENTS } from "../../shared/lib/events";
import { STORAGE_KEYS, writeJson } from "../../shared/lib/storage";
import { clearPendingAllOrder, storePageAccountOrder } from "./dashboard-page-state";
import { getLayout, resetLayoutForTests, subscribeLayout, useLayout, type Layout } from "./layout-store";
import { resetSidebarOrderLeadsAllPageForTests, storeSidebarGroupOrder } from "../sidebar/sidebar-order";

beforeEach(() => {
  localStorage.clear();
  clearPendingAllOrder();
  resetSidebarOrderLeadsAllPageForTests();
  resetLayoutForTests();
});
afterEach(() => resetLayoutForTests());

const fire = (name: string) => window.dispatchEvent(new Event(name));

describe("layout store", () => {
  it("starts from the saved orders, with every known provider present", () => {
    writeJson(STORAGE_KEYS.providerOrder, ["grok", "openai"]);
    writeJson(STORAGE_KEYS.sidebarGroupOrder, ["provider:grok", "bucket:b1"]);
    const layout = getLayout();
    expect(layout.providerOrder.slice(0, 2)).toEqual(["grok", "openai"]);
    expect(new Set(layout.providerOrder).size).toBe(layout.providerOrder.length);
    expect(layout.groupOrder).toEqual(["provider:grok", "bucket:b1"]);
    expect(layout.pageOrders).toEqual({});
    expect(layout.sidebarOrderLeadsAllPage).toBe(false);
  });

  it("starts with the page orders that were saved", () => {
    storePageAccountOrder("bucket:b1", ["b", "a"]);
    resetLayoutForTests();
    expect(getLayout().pageOrders).toEqual({ "bucket:b1": ["b", "a"] });
  });

  it("gives the same snapshot until something changes", () => {
    const first = getLayout();
    expect(getLayout()).toBe(first);
  });

  it("follows a saved group or provider order and tells subscribers once for a pair of events", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeLayout(heard);
    const before = getLayout();
    writeJson(STORAGE_KEYS.sidebarGroupOrder, ["provider:openai"]);
    writeJson(STORAGE_KEYS.providerOrder, ["anthropic", "openai"]);
    act(() => {
      fire(UI_EVENTS.groupOrderChanged);
      fire(UI_EVENTS.providerOrderChanged);
    });
    const after = getLayout();
    expect(after).not.toBe(before);
    expect(after.groupOrder).toEqual(["provider:openai"]);
    expect(after.providerOrder[0]).toBe("anthropic");
    // The second event found nothing new.
    expect(heard).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps the snapshot when an event arrives but the orders are the same", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeLayout(heard);
    const before = getLayout();
    act(() => fire(UI_EVENTS.groupOrderChanged));
    expect(getLayout()).toBe(before);
    expect(heard).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("holds each page's account order, and the dragged All order until a snapshot clears it", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeLayout(heard);
    act(() => storePageAccountOrder("bucket:b1", ["b", "a"]));
    act(() => storePageAccountOrder("all", ["c", "a", "b"]));
    expect(getLayout().pageOrders).toEqual({ "bucket:b1": ["b", "a"], all: ["c", "a", "b"] });
    expect(heard).toHaveBeenCalledTimes(2);
    act(() => clearPendingAllOrder());
    expect(getLayout().pageOrders).toEqual({ "bucket:b1": ["b", "a"] });
    expect(heard).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("keeps the snapshot when a page order is stored again unchanged", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeLayout(heard);
    act(() => storePageAccountOrder("bucket:b1", ["b", "a"]));
    const before = getLayout();
    act(() => storePageAccountOrder("bucket:b1", ["b", "a"]));
    expect(getLayout()).toBe(before);
    expect(heard).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("says the All page follows the sidebar once a sidebar order was saved, even an unchanged one", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeLayout(heard);
    expect(getLayout().sidebarOrderLeadsAllPage).toBe(false);
    act(() => storeSidebarGroupOrder([]));
    expect(getLayout().sidebarOrderLeadsAllPage).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("catches up on a page order stored while nothing subscribed", () => {
    getLayout();
    storePageAccountOrder("bucket:b1", ["b", "a"]);
    expect(getLayout().pageOrders).toEqual({});
    const unsubscribe = subscribeLayout(vi.fn());
    expect(getLayout().pageOrders).toEqual({ "bucket:b1": ["b", "a"] });
    unsubscribe();
  });

  it("listens only while something subscribes, and catches up when it starts again", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeLayout(heard);
    unsubscribe();
    writeJson(STORAGE_KEYS.sidebarGroupOrder, ["provider:grok"]);
    act(() => fire(UI_EVENTS.groupOrderChanged));
    expect(heard).not.toHaveBeenCalled();
    const again = subscribeLayout(heard);
    expect(getLayout().groupOrder).toEqual(["provider:grok"]);
    again();
  });

  it("re-renders a component that uses it", () => {
    let seen!: Layout;
    const capture = (value: Layout) => {
      seen = value;
    };
    function Probe() {
      capture(useLayout());
      return null;
    }
    const mounted: Mounted = mount(<Probe />);
    try {
      expect(seen.groupOrder).toEqual([]);
      writeJson(STORAGE_KEYS.sidebarGroupOrder, ["provider:openai"]);
      act(() => fire(UI_EVENTS.groupOrderChanged));
      expect(seen.groupOrder).toEqual(["provider:openai"]);
      act(() => storePageAccountOrder("all", ["b", "a"]));
      expect(seen.pageOrders.all).toEqual(["b", "a"]);
    } finally {
      mounted.unmount();
    }
  });
});
