// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginStatus } from "../../types";

const api = vi.hoisted(() => ({ cancelLogin: vi.fn(async () => {}) }));
vi.mock("../lib/api", () => ({ bridgeApi: api }));

const login = vi.hoisted(() => ({
  listeners: new Set<(status: LoginStatus) => void>(),
  watchLoginAttempt: vi.fn(),
  retryLoginAttempt: vi.fn(() => true),
  abandonLoginAttempt: vi.fn(),
}));
vi.mock("../lib/login-status", () => ({
  subscribeLoginStatus: (listener: (status: LoginStatus) => void) => {
    login.listeners.add(listener);
    return () => login.listeners.delete(listener);
  },
  watchLoginAttempt: login.watchLoginAttempt,
  retryLoginAttempt: login.retryLoginAttempt,
  abandonLoginAttempt: login.abandonLoginAttempt,
}));

import { mount, settle, type Mounted } from "../../test-utils/react";
import { useLoginAttempt, waitingStatus } from "./useLoginAttempt";

let latest: ReturnType<typeof useLoginAttempt>;
const onStatus = vi.fn();

function capture(value: ReturnType<typeof useLoginAttempt>) {
  latest = value;
}

function Probe({ active }: { active: boolean }) {
  capture(useLoginAttempt({ active, onStatus }));
  return null;
}

function emit(status: Partial<LoginStatus> & { attemptId: string; status: LoginStatus["status"] }) {
  const full = { message: null, account: null, projects: null, selectedProjectId: null, ...status } as LoginStatus;
  act(() => {
    for (const listener of [...login.listeners]) listener(full);
  });
}

let mounted: Mounted | null = null;

beforeEach(() => {
  login.listeners.clear();
  login.watchLoginAttempt.mockClear();
  login.retryLoginAttempt.mockReset().mockReturnValue(true);
  login.abandonLoginAttempt.mockClear();
  api.cancelLogin.mockClear();
  onStatus.mockClear();
  mounted = mount(<Probe active />);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("waitingStatus", () => {
  it("builds a waiting status, optionally keeping the project choices", () => {
    expect(waitingStatus("a", "Hi")).toEqual({
      attemptId: "a", status: "waiting", message: "Hi", account: null, projects: null, selectedProjectId: null,
    });
    const projects = [{ projectId: "p", projectNumber: "1", displayName: "P" }] as unknown as LoginStatus["projects"];
    expect(waitingStatus("a", null, { projects, selectedProjectId: "p" })).toMatchObject({ projects, selectedProjectId: "p" });
  });
});

describe("useLoginAttempt", () => {
  it("adopts a started attempt: tracks it, shows the waiting status and starts watching", async () => {
    let ok = false;
    await act(async () => {
      ok = await latest.adopt("a1", waitingStatus("a1", "Sign in"));
    });
    expect(ok).toBe(true);
    expect(latest.attemptIdRef.current).toBe("a1");
    expect(latest.status?.message).toBe("Sign in");
    expect(login.watchLoginAttempt).toHaveBeenCalledWith("a1");
  });

  it("passes statuses of the tracked attempt to the handler, and ignores every other attempt", async () => {
    await act(async () => {
      await latest.adopt("a1", waitingStatus("a1", null));
    });
    emit({ attemptId: "other", status: "complete" });
    expect(onStatus).not.toHaveBeenCalled();
    emit({ attemptId: "a1", status: "failed", message: "nope" });
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "a1", status: "failed" }));
    expect(latest.status?.status).toBe("failed");
  });

  it("ignores statuses before any attempt is adopted", () => {
    emit({ attemptId: "a1", status: "complete" });
    expect(onStatus).not.toHaveBeenCalled();
    expect(latest.status).toBeNull();
  });

  it("cancels an attempt that started after the dialog was closed", async () => {
    mounted?.rerender(<Probe active={false} />);
    await settle();
    let ok = true;
    await act(async () => {
      ok = await latest.adopt("late", waitingStatus("late", null));
    });
    expect(ok).toBe(false);
    expect(api.cancelLogin).toHaveBeenCalledWith("late");
    expect(login.watchLoginAttempt).not.toHaveBeenCalled();
    expect(latest.attemptIdRef.current).toBeNull();
  });

  it("forgets the attempt and its status when the dialog closes, and tracks again when it reopens", async () => {
    await act(async () => {
      await latest.adopt("a1", waitingStatus("a1", null));
    });
    mounted?.rerender(<Probe active={false} />);
    await settle();
    expect(latest.attemptIdRef.current).toBeNull();
    expect(latest.status).toBeNull();
    expect(latest.closeRequestedRef.current).toBe(true);
    mounted?.rerender(<Probe active />);
    await settle();
    expect(latest.closeRequestedRef.current).toBe(false);
    await act(async () => {
      await latest.adopt("a2", waitingStatus("a2", null));
    });
    emit({ attemptId: "a2", status: "complete" });
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("abandons the tracked attempt at the backend and stops following it", async () => {
    await act(async () => {
      await latest.adopt("a1", waitingStatus("a1", null));
    });
    act(() => latest.abandon());
    expect(login.abandonLoginAttempt).toHaveBeenCalledWith("a1");
    expect(latest.attemptIdRef.current).toBeNull();
    expect(latest.status).toBeNull();
    emit({ attemptId: "a1", status: "complete" });
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("abandon with nothing tracked cancels nothing", () => {
    act(() => latest.abandon());
    expect(login.abandonLoginAttempt).not.toHaveBeenCalled();
  });

  it("retries the tracked attempt and shows the reconnecting status", async () => {
    await act(async () => {
      await latest.adopt("a1", waitingStatus("a1", null));
    });
    let resumed = false;
    act(() => {
      resumed = latest.retry((id) => waitingStatus(id, "Reconnecting…"));
    });
    expect(resumed).toBe(true);
    expect(login.retryLoginAttempt).toHaveBeenCalledWith("a1");
    expect(latest.status?.message).toBe("Reconnecting…");
  });

  it("does not retry when there is nothing to resume", async () => {
    let resumed = true;
    act(() => {
      resumed = latest.retry((id) => waitingStatus(id, "x"));
    });
    expect(resumed).toBe(false);
    login.retryLoginAttempt.mockReturnValue(false);
    await act(async () => {
      await latest.adopt("a1", waitingStatus("a1", null));
    });
    act(() => {
      resumed = latest.retry((id) => waitingStatus(id, "x"));
    });
    expect(resumed).toBe(false);
  });
});
