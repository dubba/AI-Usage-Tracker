import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onDashboardResync, requestDashboardResync } from "./events";
import { installFakeWindow } from "./test-utils/fakeWindow";

let env: ReturnType<typeof installFakeWindow>;

beforeEach(() => {
  env = installFakeWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onDashboardResync", () => {
  it("runs for an explicit resync request and for window focus", () => {
    const handler = vi.fn();
    onDashboardResync(handler);
    requestDashboardResync();
    env.window.dispatchEvent(new Event("focus"));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("stops after unsubscribing", () => {
    const handler = vi.fn();
    const unsubscribe = onDashboardResync(handler);
    unsubscribe();
    requestDashboardResync();
    env.window.dispatchEvent(new Event("focus"));
    expect(handler).not.toHaveBeenCalled();
  });
});
