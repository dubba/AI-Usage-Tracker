// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginStatus } from "../../types";

const api = vi.hoisted(() => ({
  bridgeApi: {
    loginStatus: vi.fn(),
    currentLoginStatus: vi.fn(),
    cancelLogin: vi.fn(),
  },
  stored: { attempt: null as string | null },
  rememberLoginAttempt: vi.fn(),
  clearLoginAttempt: vi.fn(),
  readLoginAttempt: vi.fn(),
}));
vi.mock("./api", () => ({
  bridgeApi: api.bridgeApi,
  rememberLoginAttempt: api.rememberLoginAttempt,
  clearLoginAttempt: api.clearLoginAttempt,
  readLoginAttempt: api.readLoginAttempt,
}));

const POLL_MS = 900;

type LoginStatusModule = typeof import("./login-status");
let mod: LoginStatusModule;
let seen: LoginStatus[];
let unsubscribe: () => void;

function status(attemptId: string, state: LoginStatus["status"], extra: Partial<LoginStatus> = {}): LoginStatus {
  return { attemptId, status: state, message: null, account: null, projects: null, selectedProjectId: null, ...extra };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  api.stored.attempt = null;
  api.bridgeApi.loginStatus.mockReset();
  api.bridgeApi.currentLoginStatus.mockReset();
  api.bridgeApi.cancelLogin.mockReset().mockResolvedValue(undefined);
  api.rememberLoginAttempt.mockReset().mockImplementation((id: string) => {
    api.stored.attempt = id;
  });
  api.clearLoginAttempt.mockReset().mockImplementation(() => {
    api.stored.attempt = null;
  });
  api.readLoginAttempt.mockReset().mockImplementation(() => api.stored.attempt);
  mod = await import("./login-status");
  seen = [];
  unsubscribe = mod.subscribeLoginStatus((next) => seen.push(next));
});

afterEach(() => {
  mod.stopWatchingLoginAttempt();
  unsubscribe();
  vi.useRealTimers();
});

describe("watching a login attempt", () => {
  it("remembers the attempt, checks at once, then polls every 900 ms", async () => {
    api.bridgeApi.loginStatus.mockResolvedValue(status("a1", "waiting"));
    mod.watchLoginAttempt("a1");
    expect(api.rememberLoginAttempt).toHaveBeenCalledWith("a1");
    await flush();
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(1);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledWith("a1");
    expect(seen).toHaveLength(1);

    await advance(POLL_MS);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(2);
    await advance(POLL_MS);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(3);
    expect(mod.getLastLoginStatus()?.status).toBe("waiting");
  });

  it("watching the same attempt again does not start a second poll", async () => {
    api.bridgeApi.loginStatus.mockResolvedValue(status("a1", "waiting"));
    mod.watchLoginAttempt("a1");
    await flush();
    mod.watchLoginAttempt("a1");
    await flush();
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(1);
    await advance(POLL_MS);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(2);
  });

  it.each(["complete", "failed"] as const)("stops polling and forgets the attempt once it is %s", async (final) => {
    api.bridgeApi.loginStatus.mockResolvedValueOnce(status("a1", "waiting")).mockResolvedValue(status("a1", final));
    mod.watchLoginAttempt("a1");
    await flush();
    await advance(POLL_MS);
    expect(seen.map((s) => s.status)).toEqual(["waiting", final]);
    expect(api.clearLoginAttempt).toHaveBeenCalled();
    const calls = api.bridgeApi.loginStatus.mock.calls.length;
    await advance(POLL_MS * 5);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(calls);
    expect(mod.canResumeLoginAttempt("a1")).toBe(false);
  });

  it("keeps polling while a project must be chosen", async () => {
    api.bridgeApi.loginStatus.mockResolvedValue(status("a1", "choose_project"));
    mod.watchLoginAttempt("a1");
    await flush();
    await advance(POLL_MS);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(2);
    expect(api.clearLoginAttempt).not.toHaveBeenCalled();
  });

  it("does not start a new check while one is still in flight", async () => {
    let finish!: (value: LoginStatus) => void;
    api.bridgeApi.loginStatus.mockReturnValue(new Promise<LoginStatus>((resolve) => (finish = resolve)));
    mod.watchLoginAttempt("a1");
    await advance(POLL_MS * 3);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(1);
    finish(status("a1", "waiting"));
    await flush();
    await advance(POLL_MS);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(2);
  });

  it("ignores an answer for an attempt that is no longer watched", async () => {
    let finishOld!: (value: LoginStatus) => void;
    api.bridgeApi.loginStatus.mockReturnValueOnce(new Promise<LoginStatus>((resolve) => (finishOld = resolve)));
    mod.watchLoginAttempt("old");
    mod.stopWatchingLoginAttempt();
    finishOld(status("old", "complete"));
    await flush();
    expect(seen).toEqual([]);
    expect(api.clearLoginAttempt).not.toHaveBeenCalled();
  });
});

describe("a failing status check", () => {
  it("publishes a retryable failure that keeps the last known account and project choice", async () => {
    const account = { id: "acc" } as LoginStatus["account"];
    const projects = [{ projectId: "p", projectNumber: "1", displayName: "P" }] as unknown as LoginStatus["projects"];
    api.bridgeApi.loginStatus
      .mockResolvedValueOnce(status("a1", "choose_project", { account, projects, selectedProjectId: "p" }))
      .mockRejectedValue(new Error("network down"));
    mod.watchLoginAttempt("a1");
    await flush();
    await advance(POLL_MS);

    const failure = seen.at(-1)!;
    expect(failure.status).toBe("failed");
    expect(failure.message).toMatch(/Lost connection/);
    expect(failure.account).toBe(account);
    expect(failure.projects).toBe(projects);
    expect(failure.selectedProjectId).toBe("p");

    // Polling stopped, but the attempt is kept so Retry can resume it.
    const calls = api.bridgeApi.loginStatus.mock.calls.length;
    await advance(POLL_MS * 4);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(calls);
    expect(mod.canResumeLoginAttempt("a1")).toBe(true);

    api.bridgeApi.loginStatus.mockResolvedValue(status("a1", "waiting"));
    expect(mod.retryLoginAttempt("a1")).toBe(true);
    await flush();
    expect(seen.at(-1)?.status).toBe("waiting");
  });

  it("drops the attempt silently when the backend no longer knows it", async () => {
    api.bridgeApi.loginStatus.mockRejectedValue(new Error("No login attempt is available for this id."));
    mod.watchLoginAttempt("a1");
    await flush();
    expect(seen).toEqual([]);
    expect(api.clearLoginAttempt).toHaveBeenCalled();
    expect(mod.canResumeLoginAttempt("a1")).toBe(false);
    const calls = api.bridgeApi.loginStatus.mock.calls.length;
    await advance(POLL_MS * 3);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(calls);
  });

  it("refuses to retry an attempt it does not know", () => {
    expect(mod.retryLoginAttempt("unknown")).toBe(false);
    expect(mod.retryLoginAttempt("")).toBe(false);
    expect(api.bridgeApi.loginStatus).not.toHaveBeenCalled();
  });
});

describe("subscribeLoginStatus", () => {
  it("stops delivering after unsubscribe", async () => {
    api.bridgeApi.loginStatus.mockResolvedValue(status("a1", "waiting"));
    const extra: LoginStatus[] = [];
    const off = mod.subscribeLoginStatus((next) => extra.push(next));
    mod.watchLoginAttempt("a1");
    await flush();
    off();
    await advance(POLL_MS);
    expect(extra).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(1);
  });
});

describe("abandonLoginAttempt", () => {
  it("stops watching, forgets the attempt and cancels it in the backend", async () => {
    api.bridgeApi.loginStatus.mockResolvedValue(status("a1", "waiting"));
    mod.watchLoginAttempt("a1");
    await flush();
    mod.abandonLoginAttempt("a1");
    expect(api.bridgeApi.cancelLogin).toHaveBeenCalledWith("a1");
    expect(api.clearLoginAttempt).toHaveBeenCalled();
    const calls = api.bridgeApi.loginStatus.mock.calls.length;
    await advance(POLL_MS * 3);
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledTimes(calls);
  });

  it("only cancels an old attempt while a different one is being watched", async () => {
    api.bridgeApi.loginStatus.mockResolvedValue(status("new", "waiting"));
    mod.watchLoginAttempt("new");
    await flush();
    api.clearLoginAttempt.mockClear();
    mod.abandonLoginAttempt("old");
    expect(api.bridgeApi.cancelLogin).toHaveBeenCalledWith("old");
    expect(api.clearLoginAttempt).not.toHaveBeenCalled();
    expect(mod.canResumeLoginAttempt("new")).toBe(true);
  });
});

describe("recoverFromStaleLogin", () => {
  it("cancels the backend's current attempt in preference to the stored one", async () => {
    api.stored.attempt = "stored";
    api.bridgeApi.currentLoginStatus.mockResolvedValue(status("current", "waiting"));
    await mod.recoverFromStaleLogin();
    expect(api.bridgeApi.cancelLogin).toHaveBeenCalledWith("current");
    expect(api.clearLoginAttempt).toHaveBeenCalled();
  });

  it("falls back to the stored attempt when the backend cannot say", async () => {
    api.stored.attempt = "stored";
    api.bridgeApi.currentLoginStatus.mockRejectedValue(new Error("nope"));
    await mod.recoverFromStaleLogin();
    expect(api.bridgeApi.cancelLogin).toHaveBeenCalledWith("stored");
  });

  it("does nothing when no attempt exists anywhere", async () => {
    api.bridgeApi.currentLoginStatus.mockResolvedValue(null);
    await mod.recoverFromStaleLogin();
    expect(api.bridgeApi.cancelLogin).not.toHaveBeenCalled();
  });

  it("survives a failing cancel", async () => {
    api.stored.attempt = "stored";
    api.bridgeApi.currentLoginStatus.mockResolvedValue(null);
    api.bridgeApi.cancelLogin.mockRejectedValue(new Error("gone"));
    await expect(mod.recoverFromStaleLogin()).resolves.toBeUndefined();
  });
});

describe("resumeLoginAttemptWatch", () => {
  it("resumes the attempt remembered in this session", async () => {
    api.stored.attempt = "stored";
    api.bridgeApi.loginStatus.mockResolvedValue(status("stored", "waiting"));
    await mod.resumeLoginAttemptWatch();
    await flush();
    expect(api.bridgeApi.loginStatus).toHaveBeenCalledWith("stored");
  });

  it.each(["waiting", "choose_project", "monitoring_disabled"] as const)(
    "watches a backend attempt that is still %s",
    async (state) => {
      api.bridgeApi.currentLoginStatus.mockResolvedValue(status("live", state));
      api.bridgeApi.loginStatus.mockResolvedValue(status("live", state));
      await mod.resumeLoginAttemptWatch();
      await flush();
      expect(api.bridgeApi.loginStatus).toHaveBeenCalledWith("live");
    },
  );

  it("publishes a finished attempt once instead of watching it", async () => {
    api.bridgeApi.currentLoginStatus.mockResolvedValue(status("done", "complete"));
    await mod.resumeLoginAttemptWatch();
    await flush();
    expect(seen.map((s) => s.attemptId)).toEqual(["done"]);
    expect(api.bridgeApi.loginStatus).not.toHaveBeenCalled();
    expect(api.clearLoginAttempt).toHaveBeenCalled();
  });

  it("clears the stored attempt when the backend cannot be asked", async () => {
    api.bridgeApi.currentLoginStatus.mockRejectedValue(new Error("no"));
    await mod.resumeLoginAttemptWatch();
    expect(api.clearLoginAttempt).toHaveBeenCalled();
    expect(api.bridgeApi.loginStatus).not.toHaveBeenCalled();
  });

  it("does nothing while an attempt is already being watched", async () => {
    api.bridgeApi.loginStatus.mockResolvedValue(status("a1", "waiting"));
    mod.watchLoginAttempt("a1");
    await flush();
    await mod.resumeLoginAttemptWatch();
    expect(api.bridgeApi.currentLoginStatus).not.toHaveBeenCalled();
  });
});
