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

  it("renders the settings button to the right of refresh all and triggers onOpenSettings on click", () => {
    const onRefreshAll = vi.fn();
    const onOpenSettings = vi.fn();
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set()}
        onRefreshAll={onRefreshAll}
        onOpenSettings={onOpenSettings}
        settingsActive={false}
      />
    );

    const actions = document.querySelector(".sidebar-sync-status-actions");
    expect(actions).not.toBeNull();
    const refreshBtn = actions?.querySelector(".sidebar-refresh-all-btn");
    const settingsBtn = actions?.querySelector<HTMLButtonElement>(".sidebar-settings-btn");
    expect(refreshBtn).not.toBeNull();
    expect(settingsBtn).not.toBeNull();
    // Settings button is to the right of refresh all (second child)
    expect(refreshBtn?.nextElementSibling).toBe(settingsBtn);
    expect(settingsBtn?.getAttribute("aria-label")).toBe("Open settings");
    expect(settingsBtn?.getAttribute("data-tooltip")).toBe("Settings");
    expect(settingsBtn?.getAttribute("aria-current")).toBeNull();
    expect(settingsBtn?.classList.contains("active")).toBe(false);

    click(settingsBtn!);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("reflects active state when settingsActive is true", () => {
    const onOpenSettings = vi.fn();
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set()}
        onOpenSettings={onOpenSettings}
        settingsActive={true}
      />
    );

    const settingsBtn = document.querySelector<HTMLButtonElement>(".sidebar-settings-btn");
    expect(settingsBtn).not.toBeNull();
    expect(settingsBtn?.getAttribute("aria-current")).toBe("page");
    expect(settingsBtn?.classList.contains("active")).toBe(true);
  });
});
