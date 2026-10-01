import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./async-utils";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves with the result and leaves no timer running", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "slow")).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the original rejection through and clears the timer", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000, "slow")).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the message once the time is up", async () => {
    const pending = new Promise<string>(() => {});
    const result = withTimeout(pending, 1_000, "Timed out loading");
    const assertion = expect(result).rejects.toThrow("Timed out loading");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
