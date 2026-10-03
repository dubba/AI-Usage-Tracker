import { describe, expect, it, vi } from "vitest";
import { busyKey, createBusyTracker, isRefreshKey, REFRESH_ALL_KEY } from "./busy";

describe("createBusyTracker", () => {
  it("tracks operations independently", () => {
    const onChange = vi.fn();
    const tracker = createBusyTracker(onChange);

    expect(tracker.begin("refresh:a")).toBe(true);
    expect(tracker.begin("refresh:b")).toBe(true);
    tracker.end("refresh:a");

    // Finishing A must not clear B's busy state.
    expect(tracker.has("refresh:a")).toBe(false);
    expect(tracker.has("refresh:b")).toBe(true);
    expect([...onChange.mock.lastCall![0]]).toEqual(["refresh:b"]);
  });

  it("rejects a second begin for the same key without notifying", () => {
    const onChange = vi.fn();
    const tracker = createBusyTracker(onChange);
    expect(tracker.begin("refresh-all")).toBe(true);
    expect(tracker.begin("refresh-all")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores end for a key that is not busy", () => {
    const onChange = vi.fn();
    createBusyTracker(onChange).end("nothing");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits a fresh set each time so React sees a change", () => {
    const seen: ReadonlySet<string>[] = [];
    const tracker = createBusyTracker((keys) => seen.push(keys));
    tracker.begin("a");
    tracker.begin("b");
    expect(seen[0]).not.toBe(seen[1]);
    expect([...seen[0]]).toEqual(["a"]);
    expect([...seen[1]]).toEqual(["a", "b"]);
  });

  it("allows the same key again after it ends", () => {
    const tracker = createBusyTracker(() => {});
    tracker.begin("remove:a");
    tracker.end("remove:a");
    expect(tracker.begin("remove:a")).toBe(true);
  });
});

describe("busy keys", () => {
  it("builds per-item and global keys", () => {
    expect(busyKey("refresh", "a1")).toBe("refresh:a1");
    expect(busyKey("refresh-all")).toBe("refresh-all");
    expect(REFRESH_ALL_KEY).toBe("refresh-all");
  });

  it("recognizes refresh keys but not other operations", () => {
    expect(isRefreshKey("refresh-all")).toBe(true);
    expect(isRefreshKey(busyKey("refresh", "a1"))).toBe(true);
    expect(isRefreshKey(busyKey("rename", "a1"))).toBe(false);
    expect(isRefreshKey(busyKey("remove", "a1"))).toBe(false);
  });
});
