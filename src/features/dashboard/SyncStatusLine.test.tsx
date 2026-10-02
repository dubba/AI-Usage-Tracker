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

  it("renders status label and the refresh all button", () => {
    const onRefreshAll = vi.fn();
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set()}
        onRefreshAll={onRefreshAll}
      />
    );

    const button = document.querySelector<HTMLButtonElement>(".sidebar-refresh-all-btn");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Refresh all accounts");
    expect(document.body.textContent).toContain("Last synced all accounts");

    click(button!);
    expect(onRefreshAll).toHaveBeenCalledTimes(1);
  });

  it("disables the button and shows spinning when global refresh is in progress", () => {
    const onRefreshAll = vi.fn();
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set([REFRESH_ALL_KEY])}
        onRefreshAll={onRefreshAll}
      />
    );

    const button = document.querySelector<HTMLButtonElement>(".sidebar-refresh-all-btn");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.classList.contains("spinning")).toBe(true);
    expect(document.body.textContent).toContain("Syncing…");
  });
});
