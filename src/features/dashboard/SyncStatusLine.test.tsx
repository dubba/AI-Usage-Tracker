// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { SyncStatusLine } from "./SyncStatusLine";
import { REFRESH_ALL_KEY } from "../../shared/lib/busy";
import type { Account, UsageSnapshot } from "../../types";

const NOW = Date.now();
const fakeAccount = {
  id: "acc1",
  label: "Test Account",
  provider: "openai",
  lastUsage: {
    fetchedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    freshness: "live",
    source: "test",
    windows: [],
  } as unknown as UsageSnapshot,
  lastError: null,
  authRequired: false,
} as Account;

describe("SyncStatusLine", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("renders status label", () => {
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set()}
      />
    );

    expect(document.body.textContent).toContain("Accounts synced");
  });

  it("keeps Accounts synced whole and puts the elapsed time in its own element so it can wrap", () => {
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set()}
      />
    );

    expect(document.querySelector(".sidebar-sync-status-title")?.textContent).toBe("Accounts synced");
    expect(document.querySelector(".sidebar-sync-status-elapsed")?.textContent).toBe("5m ago");
    expect(document.querySelector(".sidebar-sync-status-label")?.textContent).toBe("Accounts synced 5m ago");
  });

  it("shows syncing state when a refresh is in progress", () => {
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set([REFRESH_ALL_KEY])}
      />
    );

    expect(document.body.textContent).toContain("Syncing…");
  });

  it("has the refresh button, and no Settings button (Settings is a page link in the sidebar and the bottom bar)", () => {
    const onRefreshAll = vi.fn();
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set()}
        onRefreshAll={onRefreshAll}
      />
    );

    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".sidebar-sync-status-actions button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Refresh all accounts"]);
    expect(document.querySelector('[aria-label="Open settings"]')).toBeNull();

    click(buttons[0]);
    expect(onRefreshAll).toHaveBeenCalledTimes(1);
  });

  it("disables the refresh button while a refresh is in progress", () => {
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set([REFRESH_ALL_KEY])}
        onRefreshAll={vi.fn()}
      />
    );

    expect(document.querySelector<HTMLButtonElement>(".sidebar-refresh-btn")?.disabled).toBe(true);
  });
});
