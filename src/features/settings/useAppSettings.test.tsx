// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAppSettings: vi.fn(),
  getAutostart: vi.fn(),
  setAccountRefreshMinutes: vi.fn(),
  setAutomaticUpdatesEnabled: vi.fn(),
  setIncludeBetaUpdates: vi.fn(),
  setAutostart: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

import { mount, settle, type Mounted } from "../../test-utils/react";
import type { AppSettings } from "../../types";
import { useAppSettings } from "./useAppSettings";

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    accountRefreshMinutes: 15,
    paseoBridgeEnabled: false,
    automaticUpdatesEnabled: true,
    includeBetaUpdates: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const reportError = vi.fn();
const clearError = vi.fn();
let latest: ReturnType<typeof useAppSettings>;

function capture(value: ReturnType<typeof useAppSettings>) {
  latest = value;
}

function Probe() {
  capture(useAppSettings({ reportError, clearError }));
  return null;
}

let mounted: Mounted | null = null;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getAppSettings.mockResolvedValue(settings());
  api.getAutostart.mockResolvedValue(false);
  reportError.mockReset();
  clearError.mockReset();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function open() {
  mounted = mount(<Probe />);
  await settle();
}

describe("useAppSettings", () => {
  it("loads the settings and the start-at-login state", async () => {
    api.getAutostart.mockResolvedValue(true);
    await open();
    expect(latest.appSettings?.accountRefreshMinutes).toBe(15);
    expect(latest.autostart).toBe(true);
  });

  it("reports settings that cannot be loaded and shows start-at-login as off when unknown", async () => {
    api.getAppSettings.mockRejectedValue(new Error("no file"));
    api.getAutostart.mockRejectedValue(new Error("no plugin"));
    await open();
    expect(reportError).toHaveBeenCalledWith("settings", expect.any(Error), "Couldn't load app settings");
    expect(latest.autostart).toBe(false);
  });

  type SaverCase = {
    saver: "saveAccountRefreshMinutes" | "saveAutomaticUpdatesEnabled" | "saveIncludeBetaUpdates";
    apiName: "setAccountRefreshMinutes" | "setAutomaticUpdatesEnabled" | "setIncludeBetaUpdates";
    value: number | boolean;
    busyFlag: "refreshIntervalBusy" | "automaticUpdatesBusy" | "includeBetaUpdatesBusy";
    patch: Partial<AppSettings>;
    errorText: string;
  };
  const cases: SaverCase[] = [
    { saver: "saveAccountRefreshMinutes", apiName: "setAccountRefreshMinutes", value: 30, busyFlag: "refreshIntervalBusy", patch: { accountRefreshMinutes: 30 }, errorText: "Couldn't save the refresh interval" },
    { saver: "saveAutomaticUpdatesEnabled", apiName: "setAutomaticUpdatesEnabled", value: false, busyFlag: "automaticUpdatesBusy", patch: { automaticUpdatesEnabled: false }, errorText: "Couldn't save the automatic updates setting" },
    { saver: "saveIncludeBetaUpdates", apiName: "setIncludeBetaUpdates", value: true, busyFlag: "includeBetaUpdatesBusy", patch: { includeBetaUpdates: true }, errorText: "Couldn't save the beta updates setting" },
  ];
  const call = (saver: SaverCase["saver"], value: SaverCase["value"]) =>
    (latest[saver] as (v: SaverCase["value"]) => Promise<void>)(value);

  it.each(cases)("$saver marks only its own control busy, stores the result and clears the error", async ({ saver, apiName, value, busyFlag, patch }) => {
    await open();
    const pending = deferred<AppSettings>();
    api[apiName].mockReturnValue(pending.promise);

    let done!: Promise<void>;
    await act(async () => {
      done = call(saver, value);
    });
    expect(api[apiName]).toHaveBeenCalledWith(value);
    expect(latest[busyFlag]).toBe(true);
    for (const other of ["refreshIntervalBusy", "automaticUpdatesBusy", "includeBetaUpdatesBusy"] as const) {
      if (other !== busyFlag) expect(latest[other]).toBe(false);
    }

    pending.resolve(settings(patch));
    await act(async () => {
      await done;
    });
    expect(latest[busyFlag]).toBe(false);
    expect(latest.appSettings).toMatchObject(patch);
    expect(clearError).toHaveBeenCalledWith("settings");
  });

  it.each(cases)("$saver reports a failure under its own message and releases the busy flag", async ({ saver, apiName, value, errorText }) => {
    await open();
    const cause = new Error("disk full");
    api[apiName].mockRejectedValue(cause);
    await act(async () => {
      await call(saver, value);
    });
    expect(reportError).toHaveBeenCalledWith("settings", cause, errorText);
    expect(latest.refreshIntervalBusy || latest.automaticUpdatesBusy || latest.includeBetaUpdatesBusy).toBe(false);
    expect(latest.appSettings?.accountRefreshMinutes).toBe(15);
  });

  it("keeps the same save functions between renders", async () => {
    await open();
    const first = latest.saveAccountRefreshMinutes;
    mounted?.rerender(<Probe />);
    expect(latest.saveAccountRefreshMinutes).toBe(first);
  });

  it("toggles start-at-login and reports a failure", async () => {
    await open();
    api.setAutostart.mockResolvedValue(true);
    await act(async () => {
      await latest.toggleAutostart();
    });
    expect(api.setAutostart).toHaveBeenCalledWith(true);
    expect(latest.autostart).toBe(true);

    api.setAutostart.mockRejectedValue(new Error("denied"));
    await act(async () => {
      await latest.toggleAutostart();
    });
    expect(reportError).toHaveBeenCalledWith("autostart", expect.any(Error), "Couldn't change the start-at-login setting");
  });
});
