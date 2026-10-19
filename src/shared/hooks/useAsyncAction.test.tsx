// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, settle, type Mounted } from "../../test-utils/react";
import { clearRecordedErrorDetails, recentErrorDetails } from "../lib/errors";
import { useAsyncAction } from "./useAsyncAction";

let latest: ReturnType<typeof useAsyncAction>;
const setError = vi.fn();

function capture(value: ReturnType<typeof useAsyncAction>) {
  latest = value;
}

function Probe() {
  capture(useAsyncAction({ source: "test", setError }));
  return null;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let mounted: Mounted | null = null;

beforeEach(() => {
  setError.mockReset();
  clearRecordedErrorDetails();
  mounted = mount(<Probe />);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("useAsyncAction", () => {
  it("is busy while the action runs and clears the error when it starts", async () => {
    const pending = deferred();
    let result!: Promise<boolean>;
    await act(async () => {
      result = latest.run(() => pending.promise, "Couldn't do it");
    });
    expect(latest.busy).toBe(true);
    expect(setError).toHaveBeenCalledWith(null);
    pending.resolve();
    await result;
    await settle();
    expect(latest.busy).toBe(false);
    expect(setError).toHaveBeenCalledTimes(1);
  });

  it("resolves true on success", async () => {
    let ok: boolean | undefined;
    await act(async () => {
      ok = await latest.run(async () => {}, "x");
    });
    expect(ok).toBe(true);
  });

  it("shows a friendly message, records the raw detail, and stops being busy on failure", async () => {
    let ok: boolean | undefined;
    await act(async () => {
      ok = await latest.run(() => Promise.reject(new Error("disk full")), "Couldn't save");
    });
    expect(ok).toBe(false);
    expect(latest.busy).toBe(false);
    expect(setError).toHaveBeenLastCalledWith("Couldn't save: disk full");
    expect(recentErrorDetails()).toEqual([expect.stringContaining("[test] Couldn't save: disk full")]);
  });

  it("replaces technical detail with a plain sentence", async () => {
    await act(async () => {
      await latest.run(() => Promise.reject(new TypeError("TypeError: x is not a function")), "Couldn't load");
    });
    expect(setError).toHaveBeenLastCalledWith(expect.stringMatching(/^Couldn't load\. .*background service/));
  });

  it("stays busy after success when asked to", async () => {
    await act(async () => {
      await latest.run(async () => {}, "x", { keepBusyOnSuccess: true });
    });
    expect(latest.busy).toBe(true);
    // A failure still ends it.
    await act(async () => {
      await latest.run(() => Promise.reject(new Error("no")), "x", { keepBusyOnSuccess: true });
    });
    expect(latest.busy).toBe(false);
  });

  it("calls onError before the message is shown", async () => {
    const order: string[] = [];
    setError.mockImplementation((message) => order.push(`error:${message}`));
    await act(async () => {
      await latest.run(() => Promise.reject(new Error("no")), "ctx", { onError: () => order.push("onError") });
    });
    expect(order).toEqual(["error:null", "onError", "error:ctx: no"]);
  });

  it("ignores a failure that no longer matters", async () => {
    const onError = vi.fn();
    await act(async () => {
      await latest.run(() => Promise.reject(new Error("no")), "ctx", { isCurrent: () => false, onError });
    });
    expect(onError).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith(null);
    expect(latest.busy).toBe(true);
    expect(recentErrorDetails()).toEqual([]);
  });
});
