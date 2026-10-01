// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginReordering,
  DROP_COOLDOWN_MS,
  droppedWithin,
  endReordering,
  isReordering,
  resetReorderingForTests,
  subscribeReordering,
} from "./reorder-activity";

beforeEach(() => {
  vi.useFakeTimers();
  resetReorderingForTests();
});
afterEach(() => {
  resetReorderingForTests();
  vi.useRealTimers();
});

describe("reordering activity", () => {
  it("is idle until a drag begins", () => {
    expect(isReordering()).toBe(false);
    beginReordering();
    expect(isReordering()).toBe(true);
  });

  it("stays active through the cooldown after a drop, then goes idle", () => {
    beginReordering();
    endReordering();
    expect(isReordering()).toBe(true);
    vi.advanceTimersByTime(DROP_COOLDOWN_MS - 1);
    expect(isReordering()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isReordering()).toBe(false);
  });

  it("tells subscribers once when it starts and once when it has fully ended", () => {
    const seen: boolean[] = [];
    subscribeReordering((active) => seen.push(active));
    beginReordering();
    endReordering();
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(DROP_COOLDOWN_MS + 5);
    expect(seen).toEqual([true, false]);
  });

  it("does not report the end while a new drag started during the cooldown", () => {
    const seen: boolean[] = [];
    subscribeReordering((active) => seen.push(active));
    beginReordering();
    endReordering();
    vi.advanceTimersByTime(200);
    beginReordering();
    vi.advanceTimersByTime(DROP_COOLDOWN_MS + 5);
    expect(seen).toEqual([true]);
    expect(isReordering()).toBe(true);
  });

  it("stops notifying an unsubscribed listener", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReordering(listener);
    unsubscribe();
    beginReordering();
    expect(listener).not.toHaveBeenCalled();
  });

  it("reports whether a drop happened recently", () => {
    expect(droppedWithin(500)).toBe(false);
    beginReordering();
    endReordering();
    expect(droppedWithin(500)).toBe(true);
    vi.advanceTimersByTime(501);
    expect(droppedWithin(500)).toBe(false);
  });
});
