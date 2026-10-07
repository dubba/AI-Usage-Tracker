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

  it("renders the settings button and triggers onOpenSettings on click", () => {
    const onOpenSettings = vi.fn();
    app = mount(
      <SyncStatusLine
        accounts={[fakeAccount]}
        refreshMinutes={15}
        busy={new Set()}
        onOpenSettings={onOpenSettings}
        settingsActive={false}
      />
    );

    const actions = document.querySelector(".sidebar-sync-status-actions");
    expect(actions).not.toBeNull();
    const settingsBtn = actions?.querySelector<HTMLButtonElement>(".sidebar-settings-btn");
    expect(settingsBtn).not.toBeNull();
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
