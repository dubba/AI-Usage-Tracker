// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, UsageAlertSetting } from "../../types";

const api = vi.hoisted(() => ({
  getAccountAlerts: vi.fn(async (_id: string): Promise<UsageAlertSetting[]> => [
    { windowId: "five_hour", enabled: true, thresholdPercent: 20 },
    { windowId: "weekly", enabled: true, thresholdPercent: 20 },
  ]),
  saveAccountAlerts: vi.fn(async (_id: string, _settings: UsageAlertSetting[]): Promise<void> => {}),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

import { mount, settle, type Mounted } from "../../test-utils/react";
import { AccountAlertModal } from "./AccountAlertModal";

const ACCOUNT: Account = {
  id: "acc-1",
  label: "Claude123",
  provider: "anthropic",
  lastUsage: {
    windows: [
      { id: "5h", kind: "five_hour", label: "5-Hour", usedPercent: 10, resetsAt: null, windowSeconds: 18000 },
      { id: "7d", kind: "weekly", label: "7-Day", usedPercent: 20, resetsAt: null, windowSeconds: 604800 },
    ],
  },
} as unknown as Account;

let mounted: Mounted | null = null;

describe("AccountAlertModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  it("renders structured name and limit suffix labels for each window", async () => {
    mounted = mount(<AccountAlertModal account={ACCOUNT} onClose={vi.fn()} onSaved={vi.fn()} />);
    await settle();

    const rows = mounted.container.querySelectorAll(".alert-window-row");
    expect(rows).toHaveLength(2);

    const labels = Array.from(rows).map((row) => {
      const name = row.querySelector(".alert-window-name")?.textContent;
      const suffix = row.querySelector(".alert-window-suffix")?.textContent;
      const full = row.querySelector(".alert-window-label")?.textContent;
      return { name, suffix, full };
    });

    expect(labels).toEqual([
      { name: "5-Hour", suffix: "Limit", full: "5-HourLimit" },
      { name: "7-Day", suffix: "Limit", full: "7-DayLimit" },
    ]);
  });
});
