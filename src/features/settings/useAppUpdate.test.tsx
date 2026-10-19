// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  getPendingUpdateNotice: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

const getVersion = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

const events = vi.hoisted(() => ({ handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return () => {
      events.handlers.delete(name);
    };
  },
}));

import { mount, settle, type Mounted } from "../../test-utils/react";
import { FALLBACK_APP_VERSION } from "../../shared/lib/constants";
import type { AppUpdateStatus } from "../../types";
import { useAppUpdate } from "./useAppUpdate";

const MIN_CHECK_MS = 500;
const CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000;
const MESSAGE_MS = 5_000;

function status(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    currentVersion: FALLBACK_APP_VERSION,
    available: false,
    availableVersion: null,
    date: null,
    body: null,
    error: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let latest: ReturnType<typeof useAppUpdate>;

function capture(value: ReturnType<typeof useAppUpdate>) {
  latest = value;
}

function Harness({ automatic }: { automatic: boolean | undefined }) {
  capture(useAppUpdate({ automaticUpdatesEnabled: automatic }));
  return null;
}

let mounted: Mounted | null = null;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function emit(name: string, payload: unknown) {
  await act(async () => {
    events.handlers.get(name)?.({ payload });
  });
}

/** Mounts and lets the launch-time check (which lasts at least 500 ms) finish. */
async function mountSettled(automatic: boolean | undefined = true) {
  mounted = mount(<Harness automatic={automatic} />);
  await settle();
  await advance(MIN_CHECK_MS);
}

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  events.handlers.clear();
  api.checkForUpdate.mockReset().mockResolvedValue(status());
  api.installUpdate.mockReset().mockResolvedValue(undefined);
  api.getPendingUpdateNotice.mockReset().mockResolvedValue(null);
  // Matching the fallback keeps `installedVersion` unchanged, which would otherwise re-create
  // `checkForUpdate` and run a second launch check (see the note in the "version" test).
  getVersion.mockReset().mockResolvedValue(FALLBACK_APP_VERSION);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setVisibility("visible");
  vi.useRealTimers();
});

describe("useAppUpdate", () => {
  describe("version and launch check", () => {
    it("reads the installed version, falling back when it cannot be read", async () => {
      // Note: a changed version re-creates `checkForUpdate`, so the launch check runs twice.
      getVersion.mockResolvedValue("9.9.9");
      await mountSettled();
      expect(latest.installedVersion).toBe("9.9.9");
      mounted?.unmount();

      getVersion.mockRejectedValue(new Error("no version"));
      await mountSettled();
      expect(latest.installedVersion).toBe(FALLBACK_APP_VERSION);
    });

    it("checks once at launch even when automatic updates are off, and is busy while it runs", async () => {
      const pending = deferred<AppUpdateStatus>();
      api.checkForUpdate.mockReturnValue(pending.promise);
      mounted = mount(<Harness automatic={false} />);
      await settle();
      expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
      // A background check keeps the OS notification on.
      expect(api.checkForUpdate).toHaveBeenCalledWith(true);
      expect(latest.updateBusy).toBe("checking");

      pending.resolve(status({ available: true, availableVersion: "1.1.0" }));
      await settle();
      // The check always lasts at least half a second so the button does not flicker.
      expect(latest.updateBusy).toBe("checking");
      await advance(MIN_CHECK_MS);
      expect(latest.updateBusy).toBeNull();
      expect(latest.appUpdate?.availableVersion).toBe("1.1.0");
    });

    it("checks again every 8 hours only when automatic updates are on", async () => {
      await mountSettled(true);
      expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
      await advance(CHECK_INTERVAL_MS);
      expect(api.checkForUpdate).toHaveBeenCalledTimes(2);
      mounted?.unmount();

      api.checkForUpdate.mockClear();
      await mountSettled(false);
      expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
      await advance(CHECK_INTERVAL_MS * 2);
      expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("manual check", () => {
    it("says so when the app is up to date and clears the message after 5 seconds", async () => {
      await mountSettled();
      await act(async () => {
        const check = latest.checkForUpdate(true);
        await vi.advanceTimersByTimeAsync(MIN_CHECK_MS);
        await check;
      });
      expect(api.checkForUpdate).toHaveBeenLastCalledWith(false);
      expect(latest.updateMessage).toBe(`You are on the latest version (v${FALLBACK_APP_VERSION}).`);
      await advance(MESSAGE_MS);
      expect(latest.updateMessage).toBeNull();
    });

    it("shows a backend error from a manual check but not from a background one", async () => {
      api.checkForUpdate.mockResolvedValue(status({ error: "GitHub unreachable" }));
      await mountSettled();
      expect(latest.updateError).toBeNull();

      await act(async () => {
        const check = latest.checkForUpdate(true);
        await vi.advanceTimersByTimeAsync(MIN_CHECK_MS);
        await check;
      });
      expect(latest.updateError).toBe("GitHub unreachable");
    });

    it("keeps an already-found update when a background check fails", async () => {
      api.checkForUpdate.mockResolvedValueOnce(status({ available: true, availableVersion: "1.1.0" }));
      await mountSettled();
      expect(latest.appUpdate?.available).toBe(true);

      api.checkForUpdate.mockResolvedValueOnce(status({ error: "offline" }));
      await act(async () => {
        const check = latest.checkForUpdate(false);
        await vi.advanceTimersByTimeAsync(MIN_CHECK_MS);
        await check;
      });
      expect(latest.appUpdate?.availableVersion).toBe("1.1.0");
      expect(latest.updateError).toBeNull();
    });

    it("shows a thrown error from a manual check and ends the busy state", async () => {
      await mountSettled();
      api.checkForUpdate.mockRejectedValueOnce(new Error("boom"));
      await act(async () => {
        const check = latest.checkForUpdate(true);
        await vi.advanceTimersByTimeAsync(MIN_CHECK_MS);
        await check;
      });
      expect(latest.updateError).toBe("Couldn't check for updates: boom");
      expect(latest.updateBusy).toBeNull();
    });
  });

  describe("install", () => {
    it("follows progress events and ends with the installer message", async () => {
      await mountSettled();
      const install = deferred<void>();
      api.installUpdate.mockReturnValue(install.promise);

      let done!: Promise<void>;
      await act(async () => {
        done = latest.installUpdate();
      });
      expect(latest.updateBusy).toBe("downloading");
      expect(latest.updateProgress).toEqual({ phase: "downloading", downloaded: 0, total: null, percent: 0 });

      await emit("app-update-progress", { phase: "verifying", downloaded: 10, total: 10, percent: 100 });
      expect(latest.updateBusy).toBe("verifying");
      expect(latest.updateProgress?.phase).toBe("verifying");

      install.resolve();
      await act(async () => {
        await done;
      });
      expect(latest.updateBusy).toBeNull();
      expect(latest.updateProgress).toBeNull();
      expect(latest.updateMessage).toBe("The installer should be open. Confirm the update on the next screen.");
    });

    it("ignores a progress event that arrives after the install returned", async () => {
      await mountSettled();
      await act(async () => {
        await latest.installUpdate();
      });
      await emit("app-update-progress", { phase: "installing", downloaded: 1, total: 1, percent: 100 });
      expect(latest.updateBusy).toBeNull();
      expect(latest.updateProgress).toBeNull();
    });

    it("does not start a second install or let a check overwrite a running one", async () => {
      await mountSettled();
      const install = deferred<void>();
      api.installUpdate.mockReturnValue(install.promise);
      let done!: Promise<void>;
      await act(async () => {
        done = latest.installUpdate();
      });
      await act(async () => {
        await latest.installUpdate();
      });
      expect(api.installUpdate).toHaveBeenCalledTimes(1);

      api.checkForUpdate.mockClear();
      await act(async () => {
        await latest.checkForUpdate(true);
      });
      expect(api.checkForUpdate).not.toHaveBeenCalled();
      expect(latest.updateBusy).toBe("downloading");

      install.resolve();
      await act(async () => {
        await done;
      });
    });

    it("shows the failure and resets the busy state", async () => {
      await mountSettled();
      api.installUpdate.mockRejectedValue(new Error("disk full"));
      await act(async () => {
        await latest.installUpdate();
      });
      expect(latest.updateError).toBe("Couldn't install the update: disk full");
      expect(latest.updateBusy).toBeNull();
      expect(latest.updateProgress).toBeNull();
      expect(latest.updateMessage).toBeNull();
    });
  });

  describe("pending update notice", () => {
    it("opens the release notes on mount when a notice is waiting, and re-checks", async () => {
      api.getPendingUpdateNotice.mockResolvedValue("1.2.3");
      mounted = mount(<Harness automatic={true} />);
      await settle();
      expect(latest.pendingUpdateVersion).toBe("1.2.3");
      expect(latest.updateNotesOpen).toBe(true);
      // One launch check plus one from the notice.
      expect(api.checkForUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
      await advance(MIN_CHECK_MS);
    });

    it("stays closed when there is no notice, and survives a failing lookup", async () => {
      api.getPendingUpdateNotice.mockRejectedValue(new Error("no store"));
      await mountSettled();
      expect(latest.updateNotesOpen).toBe(false);
      expect(latest.pendingUpdateVersion).toBeNull();
    });

    it("looks again when the window regains focus or becomes visible", async () => {
      await mountSettled();
      api.getPendingUpdateNotice.mockClear();

      api.getPendingUpdateNotice.mockResolvedValue("2.0.0");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await settle();
      expect(api.getPendingUpdateNotice).toHaveBeenCalledTimes(1);
      expect(latest.pendingUpdateVersion).toBe("2.0.0");
      expect(latest.updateNotesOpen).toBe(true);
      await advance(MIN_CHECK_MS);

      api.getPendingUpdateNotice.mockClear();
      await act(async () => {
        setVisibility("hidden");
      });
      expect(api.getPendingUpdateNotice).not.toHaveBeenCalled();
      await act(async () => {
        setVisibility("visible");
      });
      expect(api.getPendingUpdateNotice).toHaveBeenCalledTimes(1);
      await advance(MIN_CHECK_MS);
    });

    it("opens the notes when the backend sends open-update-notes", async () => {
      await mountSettled();
      await emit("open-update-notes", "3.0.0");
      expect(latest.pendingUpdateVersion).toBe("3.0.0");
      expect(latest.updateNotesOpen).toBe(true);
      await advance(MIN_CHECK_MS);
    });

    it("ignores an empty open-update-notes event", async () => {
      await mountSettled();
      await emit("open-update-notes", null);
      expect(latest.updateNotesOpen).toBe(false);
    });
  });
});
