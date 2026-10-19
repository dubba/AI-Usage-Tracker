// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreferenceStore } from "./preference-store";

type Size = "small" | "large";
const isSize = (value: unknown): value is Size => value === "small" || value === "large";
const KEY = "test:size";

const stores: Array<() => void> = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const stop of stores.splice(0)) stop();
});

describe("createPreferenceStore", () => {
  it("starts as the fallback until the saved value is loaded", () => {
    localStorage.setItem(KEY, "large");
    const store = createPreferenceStore<Size>(KEY, "small", isSize);
    expect(store.get()).toBe("small");
    store.refresh();
    expect(store.get()).toBe("large");
  });

  it("ignores a saved value that is not valid", () => {
    localStorage.setItem(KEY, "gigantic");
    const store = createPreferenceStore<Size>(KEY, "small", isSize);
    store.refresh();
    expect(store.get()).toBe("small");
    expect(store.readStored()).toBe("small");
  });

  it("saves what is set, and tells subscribers only when the value changed", () => {
    const store = createPreferenceStore<Size>(KEY, "small", isSize);
    const heard = vi.fn();
    store.subscribe(heard);
    store.set("large");
    expect(localStorage.getItem(KEY)).toBe("large");
    expect(store.get()).toBe("large");
    expect(heard).toHaveBeenCalledTimes(1);
    store.set("large");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stops telling a subscriber that unsubscribed", () => {
    const store = createPreferenceStore<Size>(KEY, "small", isSize);
    const heard = vi.fn();
    const unsubscribe = store.subscribe(heard);
    unsubscribe();
    store.set("large");
    expect(heard).not.toHaveBeenCalled();
  });

  it("refresh notifies when the saved value differs from the current one", () => {
    const store = createPreferenceStore<Size>(KEY, "small", isSize);
    const heard = vi.fn();
    store.subscribe(heard);
    store.refresh(); // nothing saved: still the fallback
    expect(heard).not.toHaveBeenCalled();
    localStorage.setItem(KEY, "large");
    store.refresh();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("follows another window changing the same key, and no other key", () => {
    const store = createPreferenceStore<Size>(KEY, "small", isSize);
    stores.push(store.followOtherWindows());
    localStorage.setItem(KEY, "large");
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    expect(store.get()).toBe("small");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.get()).toBe("large");
  });

  it("stops following when asked", () => {
    const store = createPreferenceStore<Size>(KEY, "small", isSize);
    const stop = store.followOtherWindows();
    stop();
    localStorage.setItem(KEY, "large");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.get()).toBe("small");
  });
});
