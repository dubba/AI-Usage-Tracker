// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { setNarrowWindow } from "../../test-utils/media";
import { click, mount, settle, type Mounted } from "../../test-utils/react";
import type { Account, UsageSnapshot } from "../../types";
import { setCardCollapsedOnPage } from "../dashboard/dashboard-page-state";
import { CREDENTIAL_PROTECTION_ACCOUNT_NOTE } from "../dashboard/credential-protection";
import { computeAccountCardMenuPlacement } from "./AccountCardMenu";
import { AccountDashboardCard } from "./AccountDashboardCard";

const account = {
  id: "acct-1",
  label: "Claude",
  provider: "anthropic",
  email: "ada@example.com",
  providerAccountId: null,
  chatgptAccountId: null,
  plan: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastUsage: null,
  lastError: null,
  authRequired: false,
} as Account;

function renderCard(signInUnprotected: boolean): Mounted {
  return mount(
    <AccountDashboardCard
      pageId="all"
      account={account}
      busy={new Set()}
      onRefresh={() => undefined}
      onReconnect={() => undefined}
      onConnectGoogleUsage={() => undefined}
      onRename={async () => undefined}
      onRemove={() => undefined}
      onNotifications={() => undefined}
      signInUnprotected={signInUnprotected}
    />,
  );
}

describe("AccountDashboardCard credential protection", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("says so on the account when that sign-in could not be locked", () => {
    app = renderCard(true);
    expect(document.body.textContent).toContain("Claude");
    expect(document.body.textContent).toContain(CREDENTIAL_PROTECTION_ACCOUNT_NOTE);
    expect(document.querySelector(".account-card-protection-note")).not.toBeNull();
  });

  it("stays quiet when the sign-in is locked", () => {
    app = renderCard(false);
    expect(document.body.textContent).toContain("Claude");
    expect(document.body.textContent).not.toContain("isn't encrypted yet");
    expect(document.querySelector(".account-card-protection-note")).toBeNull();
  });
});

describe("AccountDashboardCard actions dropdown placement", () => {
  let app: Mounted | null = null;

  // The chevron menu is the phone layout's.
  beforeEach(() => setNarrowWindow(true));

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
  });

  it("opens downward when there is ample space below the toggle button", () => {
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={account}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    const toggle = app.container.querySelector<HTMLButtonElement>(".mobile-dropdown-toggle")!;
    toggle.getBoundingClientRect = () => ({
      top: 100,
      bottom: 132,
      left: 300,
      right: 332,
      width: 32,
      height: 32,
      x: 300,
      y: 100,
      toJSON: () => ({}),
    });

    click(toggle);

    const menu = document.querySelector<HTMLElement>(".mobile-dropdown-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.classList.contains("upward")).toBe(false);
  });

  it("opens upward when the card is near the bottom of the viewport", () => {
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={account}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    const toggle = app.container.querySelector<HTMLButtonElement>(".mobile-dropdown-toggle")!;
    // Set viewport height to 800 and toggle near bottom at y=730
    toggle.getBoundingClientRect = () => ({
      top: 730,
      bottom: 762,
      left: 300,
      right: 332,
      width: 32,
      height: 32,
      x: 300,
      y: 730,
      toJSON: () => ({}),
    });

    click(toggle);

    const menu = document.querySelector<HTMLElement>(".mobile-dropdown-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.classList.contains("upward")).toBe(true);
    expect(menu.style.maxHeight).toBeDefined();
    expect(parseInt(menu.style.maxHeight, 10)).toBeGreaterThanOrEqual(80);
  });

  it("calculates placement taking scroll container bounds into account", () => {
    const fakeToggle = document.createElement("button");
    fakeToggle.getBoundingClientRect = () => ({
      top: 500,
      bottom: 532,
      left: 300,
      right: 332,
      width: 32,
      height: 32,
      x: 300,
      y: 500,
      toJSON: () => ({}),
    });

    const scrollContainer = document.createElement("div");
    scrollContainer.className = "dashboard-scroll";
    scrollContainer.getBoundingClientRect = () => ({
      top: 80,
      bottom: 550, // Only 18px below the toggle
      left: 0,
      right: 400,
      width: 400,
      height: 470,
      x: 0,
      y: 80,
      toJSON: () => ({}),
    });

    scrollContainer.appendChild(fakeToggle);
    document.body.appendChild(scrollContainer);

    try {
      const placement = computeAccountCardMenuPlacement(fakeToggle, true);
      expect(placement.openUpward).toBe(true);
      expect(placement.maxHeight).toBe(412); // 500 - 80 - 8 = 412
    } finally {
      document.body.removeChild(scrollContainer);
    }
  });

  it("flips a 5-item move menu upward when space below is 200px (exceeding old 195px threshold)", () => {
    const fakeToggle = document.createElement("button");
    // Viewport height 800. Toggle bottom at 592 -> spaceBelow = 800 - 592 - 8 = 200px.
    fakeToggle.getBoundingClientRect = () => ({
      top: 560,
      bottom: 592,
      left: 300,
      right: 332,
      width: 32,
      height: 32,
      x: 300,
      y: 560,
      toJSON: () => ({}),
    });

    // With hasMoveMenu = true, estimated height is 220px.
    // 200px space below cannot fit 220px, so it must flip upward!
    const placement = computeAccountCardMenuPlacement(fakeToggle, true);
    expect(placement.openUpward).toBe(true);
    expect(placement.maxHeight).toBe(560 - 0 - 8); // 552
  });

  it("uses measured menu element height to flip upward when rendered height exceeds space below", () => {
    const fakeToggle = document.createElement("button");
    // Space below is 800 - 592 - 8 = 200px
    fakeToggle.getBoundingClientRect = () => ({
      top: 560,
      bottom: 592,
      left: 300,
      right: 332,
      width: 32,
      height: 32,
      x: 300,
      y: 560,
      toJSON: () => ({}),
    });

    const menu = document.createElement("div");
    Object.defineProperty(menu, "scrollHeight", { value: 215, configurable: true });

    const placement = computeAccountCardMenuPlacement(fakeToggle, false, menu);
    expect(placement.openUpward).toBe(true);
  });

  it("restores focus to toggle button when mobile menu closes on Escape", async () => {
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={account}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );
    const toggle = app.container.querySelector<HTMLButtonElement>(".mobile-dropdown-toggle")!;
    toggle.focus();
    click(toggle);
    expect(document.querySelector(".mobile-dropdown-menu")).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(document.querySelector(".mobile-dropdown-menu")).toBeNull();
    // closeMobileMenu uses setTimeout to restore focus after unmount
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(toggle);
  });

  it("allows collapsing and renaming from the mobile dropdown menu", async () => {
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={{ ...account, id: "mobile-collapse-test" }}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );
    const toggle = app.container.querySelector<HTMLButtonElement>(".mobile-dropdown-toggle")!;
    click(toggle);

    const items = [...document.querySelectorAll<HTMLButtonElement>(".mobile-dropdown-menu .mobile-dropdown-item")].map((b) => b.textContent?.trim());
    expect(items).toEqual(["Collapse card", "Rename", "Refresh", "Notifications", "Remove"]);
    expect(document.querySelector(".mobile-dropdown-menu .account-card-menu-separator")).not.toBeNull();

    const collapseBtn = [...document.querySelectorAll<HTMLButtonElement>(".mobile-dropdown-menu .mobile-dropdown-item")].find((b) => b.textContent?.includes("Collapse card"))!;
    click(collapseBtn);
    expect(app.container.querySelector(".provider-account-card")?.classList.contains("is-collapsed")).toBe(true);
  });

  it("does not render the percentage pill when collapsed on mobile", () => {
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={{
          ...account,
          id: "mobile-collapse-pill-test",
          plan: "pro",
          lastUsage: {
            plan: "pro",
            email: null,
            windows: [
              {
                id: "5h",
                label: "5-Hour",
                remainingPercent: 70,
                usedPercent: 30,
                resetsAt: new Date(Date.now() + 3600000).toISOString(),
                windowSeconds: 5 * 3600,
                kind: "five_hour",
              },
            ],
            creditsUsd: null,
            unlimitedCredits: false,
            fetchedAt: new Date().toISOString(),
            freshness: "live",
            source: "test",
          },
        }}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );
    const toggle = app.container.querySelector<HTMLButtonElement>(".mobile-dropdown-toggle")!;
    click(toggle);

    const collapseBtn = [...document.querySelectorAll<HTMLButtonElement>(".mobile-dropdown-menu .mobile-dropdown-item")].find((b) => b.textContent?.includes("Collapse card"))!;
    click(collapseBtn);
    expect(app.container.querySelector(".provider-account-card")?.classList.contains("is-collapsed")).toBe(true);
    expect(app.container.querySelector(".collapsed-summary")).toBeNull();
  });
});


function renderDesktopCard(overrides: Partial<Parameters<typeof AccountDashboardCard>[0]> = {}) {
  const handlers = {
    onRefresh: vi.fn(),
    onRemove: vi.fn(),
    onNotifications: vi.fn(),
    onMove: vi.fn(),
  };
  const app = mount(
    <AccountDashboardCard
      pageId="all"
      account={{ ...account, plan: "pro", lastUsage: { plan: "pro", email: null, windows: [], creditsUsd: null, unlimitedCredits: false, fetchedAt: new Date().toISOString(), freshness: "live", source: "test" } }}
      busy={new Set()}
      onReconnect={() => undefined}
      onConnectGoogleUsage={() => undefined}
      onRename={async () => undefined}
      canMoveUp
      canMoveDown
      {...handlers}
      {...overrides}
    />,
  );
  return { app, handlers };
}

describe("AccountDashboardCard on a wide window", () => {
  let app: Mounted | null = null;

  beforeEach(() => setNarrowWindow(false));

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
  });

  it("shows the plan chip, the updated time, then Refresh, Alerts and a more-actions menu", () => {
    const rendered = renderDesktopCard();
    app = rendered.app;
    const actions = app.container.querySelector(".account-card-desktop-actions")!;
    // A live account needs no status chip.
    expect(actions.querySelector(".account-status-chip")).toBeNull();
    expect(actions.querySelector(".account-plan-badge")?.textContent).toBe("Pro/$20");
    expect(actions.querySelector(".account-card-updated")?.textContent).toMatch(/^Updated /);
    const buttons = [...actions.querySelectorAll<HTMLButtonElement>(":scope > button, .account-card-menu > button")].map((b) => b.getAttribute("aria-label"));
    expect(buttons).toEqual(["Refresh Claude", "Configure usage notifications for Claude", "More actions for Claude"]);
    // The phone layout's chevron menu and the old row of move / remove buttons are gone.
    expect(app.container.querySelector(".mobile-dropdown-toggle")).toBeNull();
    expect(app.container.querySelector('[aria-label="Remove Claude"]')).toBeNull();
    expect(app.container.querySelector(".provider-account-card")?.classList.contains("desktop-card")).toBe(true);
  });

  it("runs Refresh and Alerts from their buttons", () => {
    const rendered = renderDesktopCard();
    app = rendered.app;
    click(app.container.querySelector<HTMLButtonElement>('[aria-label="Refresh Claude"]')!);
    click(app.container.querySelector<HTMLButtonElement>('[aria-label="Configure usage notifications for Claude"]')!);
    expect(rendered.handlers.onRefresh).toHaveBeenCalledTimes(1);
    expect(rendered.handlers.onNotifications).toHaveBeenCalledTimes(1);
  });

  it("collapses the card and starts renaming from the menu", async () => {
    const rendered = renderDesktopCard();
    app = rendered.app;
    const toggle = () => app!.container.querySelector<HTMLButtonElement>('[aria-label="More actions for Claude"]')!;
    const item = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".account-card-menu-list .mobile-dropdown-item")].find((b) => b.textContent?.includes(text))!;

    click(toggle());
    click(item("Collapse card"));
    expect(app.container.querySelector(".provider-account-card")?.classList.contains("is-collapsed")).toBe(true);

    click(toggle());
    expect(item("Expand card")).toBeDefined();
    click(item("Rename"));
    await settle();
    expect(app.container.querySelector<HTMLInputElement>(".account-card-name-input")).not.toBeNull();
  });

  it("moves and removes from the menu", () => {
    const rendered = renderDesktopCard();
    app = rendered.app;
    const toggle = () => app!.container.querySelector<HTMLButtonElement>('[aria-label="More actions for Claude"]')!;
    const item = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".account-card-menu-list .mobile-dropdown-item")].find((b) => b.textContent?.includes(text))!;

    click(toggle());
    click(item("Move down"));
    expect(rendered.handlers.onMove).toHaveBeenCalledWith(1);
    click(toggle());
    click(item("Remove account"));
    expect(rendered.handlers.onRemove).toHaveBeenCalledTimes(1);
  });

  it("names a status that is not live in the chip", () => {
    const rendered = renderDesktopCard({ account: { ...account, authRequired: true } });
    app = rendered.app;
    const chip = app.container.querySelector(".account-status-chip")!;
    expect(chip.textContent).toBe("Signed out");
    expect(chip.classList.contains("danger")).toBe(true);
  });

  it("asks a signed-out account for one thing: sign in again", () => {
    const onReconnect = vi.fn();
    const onConnectGoogleUsage = vi.fn();
    const rendered = renderDesktopCard({
      account: { ...account, id: "signed-out-google", provider: "google_ai_studio", authRequired: true, lastError: "Google authorization expired. Sign in again." },
      onReconnect,
      onConnectGoogleUsage,
    });
    app = rendered.app;
    const notices = app.container.querySelectorAll(".account-card-error");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain("Google authorization expired. Sign in again.");
    // Change Cloud Project opens the same dialog as the notice's button, so it steps aside.
    expect(app.container.querySelector(".google-cloud-connect-action")).toBeNull();
    expect(app.container.querySelector(".metric-reset")?.textContent).toBe("Usage appears after you sign in.");
    const signIn = notices[0].querySelector<HTMLButtonElement>("button")!;
    expect(signIn.textContent).toBe("Reconnect Cloud Usage");
    expect(signIn.classList.contains("primary")).toBe(true);
    click(signIn);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onConnectGoogleUsage).not.toHaveBeenCalled();
  });

  it("offers Sign in again even when the provider sent no message", () => {
    const rendered = renderDesktopCard({ account: { ...account, id: "signed-out-silent", authRequired: true } });
    app = rendered.app;
    const notice = app.container.querySelector(".account-card-error")!;
    expect(notice.textContent).toBe("This account is signed out.Sign in again");
  });

  it("calls out-of-date usage that, and points at Refresh", () => {
    const rendered = renderDesktopCard({
      account: {
        ...account,
        id: "out-of-date",
        lastError: "OpenAI rate-limited the usage request.",
        lastUsage: { plan: null, email: null, windows: [], creditsUsd: null, unlimitedCredits: false, fetchedAt: new Date().toISOString(), freshness: "stale", source: "test" },
      },
    });
    app = rendered.app;
    expect(app.container.querySelector(".account-status-chip")?.textContent).toBe("Out of date");
    expect(app.container.querySelector(".refresh-action")?.classList.contains("is-suggested")).toBe(true);
    const notice = app.container.querySelector(".account-card-error")!;
    expect(notice.textContent).toContain("OpenAI rate-limited the usage request.");
    click(notice.querySelector<HTMLButtonElement>('[aria-label="Retry refreshing Claude"]')!);
    expect(rendered.handlers.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not point at Refresh for a live account", () => {
    const rendered = renderDesktopCard({ account: { ...account, id: "live-expanded" } });
    app = rendered.app;
    expect(app.container.querySelector(".refresh-action")?.classList.contains("is-suggested")).toBe(false);
    expect(app.container.querySelector(".account-card-error")).toBeNull();
  });

  it("shows the percentage pill when collapsed on desktop", () => {
    const rendered = renderDesktopCard({
      account: {
        ...account,
        id: "desktop-collapse-pill-test",
        plan: "pro",
        lastUsage: {
          plan: "pro",
          email: null,
          windows: [
            {
              id: "5h",
              label: "5-Hour",
              remainingPercent: 70,
              usedPercent: 30,
              resetsAt: new Date(Date.now() + 3600000).toISOString(),
              windowSeconds: 5 * 3600,
              kind: "five_hour",
            },
          ],
          creditsUsd: null,
          unlimitedCredits: false,
          fetchedAt: new Date().toISOString(),
          freshness: "live",
          source: "test",
        },
      },
    });
    app = rendered.app;
    expect(app.container.querySelector(".collapsed-summary")).toBeNull();

    const toggle = app.container.querySelector<HTMLButtonElement>('[aria-label="More actions for Claude"]')!;
    click(toggle);
    const collapseBtn = [...document.querySelectorAll<HTMLButtonElement>(".account-card-menu-list .mobile-dropdown-item")].find((b) => b.textContent?.includes("Collapse card"))!;
    click(collapseBtn);

    expect(app.container.querySelector(".provider-account-card")?.classList.contains("is-collapsed")).toBe(true);
    const pill = app.container.querySelector(".collapsed-summary");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("70% left");
  });
});

describe("AccountDashboardCard menu on a wide window", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists the actions without keyboard shortcut hints", () => {
    setNarrowWindow(false);
    const { app } = renderDesktopCard();
    click(app.container.querySelector<HTMLButtonElement>('[aria-label="More actions for Claude"]')!);
    const items = [...document.querySelectorAll(".account-card-menu-list .mobile-dropdown-item")].map((item) => item.textContent?.trim());
    // The card's collapsed state is remembered between tests, so the third item may say Expand.
    expect(items).toEqual(["Move up", "Move down", expect.stringMatching(/^(Collapse|Expand) card$/), "Rename", "Remove account"]);
    app.unmount();
  });
});

describe("AccountDashboardCard error display on mobile vs desktop", () => {
  let app: Mounted | null = null;
  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("replaces the timestamp with the error message and retry button on mobile without rendering a separate banner", () => {
    setNarrowWindow(true);
    const onRefresh = vi.fn();
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={{
          ...account,
          id: "mobile-error-test",
          lastError: "Rate limit exceeded. Try again later.",
          lastUsage: {
            plan: "pro",
            email: null,
            windows: [],
            creditsUsd: null,
            unlimitedCredits: false,
            fetchedAt: new Date().toISOString(),
            freshness: "stale",
            source: "test",
          },
        }}
        busy={new Set()}
        onRefresh={onRefresh}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    // The timestamp is replaced by the error message in the header
    const inlineError = app.container.querySelector(".account-card-updated.is-error");
    expect(inlineError).not.toBeNull();
    expect(inlineError?.textContent).toBe("Rate limit exceeded. Try again later.");
    expect(inlineError?.getAttribute("title")).toBe("Rate limit exceeded. Try again later.");

    // A compact Retry button is rendered beside it
    const retryBtn = app.container.querySelector<HTMLButtonElement>(".account-card-error-btn");
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.textContent).toBe("Retry");
    click(retryBtn!);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // The separate error box below the header is NOT rendered on mobile
    expect(app.container.querySelector(".account-card-error")).toBeNull();
  });

  it("replaces the timestamp with signed-out message and sign-in button on mobile", () => {
    setNarrowWindow(true);
    const onReconnect = vi.fn();
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={{
          ...account,
          id: "mobile-signed-out-test",
          authRequired: true,
          lastError: "Session expired. Sign in again.",
        }}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={onReconnect}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    const inlineError = app.container.querySelector(".account-card-updated.is-error");
    expect(inlineError).not.toBeNull();
    expect(inlineError?.textContent).toBe("Session expired. Sign in again.");

    const signInBtn = app.container.querySelector<HTMLButtonElement>(".account-card-error-btn");
    expect(signInBtn).not.toBeNull();
    expect(signInBtn?.textContent).toBe("Sign in");
    click(signInBtn!);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    expect(app.container.querySelector(".account-card-error")).toBeNull();
  });

  it("shows Reconnect button for Google AI Studio signed-out account on mobile", () => {
    setNarrowWindow(true);
    const onReconnect = vi.fn();
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={{
          ...account,
          id: "mobile-google-signed-out-test",
          provider: "google_ai_studio",
          authRequired: true,
          lastError: null,
        }}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={onReconnect}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    const inlineError = app.container.querySelector(".account-card-updated.is-error");
    expect(inlineError?.textContent).toBe("This account is signed out.");

    const reconnectBtn = app.container.querySelector<HTMLButtonElement>(".account-card-error-btn");
    expect(reconnectBtn?.textContent).toBe("Reconnect");
    click(reconnectBtn!);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps timestamp and renders error banner below header on desktop", () => {
    setNarrowWindow(false);
    const onRefresh = vi.fn();
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={{
          ...account,
          id: "desktop-error-test",
          lastError: "Server temporarily unavailable.",
          lastUsage: {
            plan: "pro",
            email: null,
            windows: [],
            creditsUsd: null,
            unlimitedCredits: false,
            fetchedAt: new Date().toISOString(),
            freshness: "stale",
            source: "test",
          },
        }}
        busy={new Set()}
        onRefresh={onRefresh}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    // Desktop header keeps the timestamp
    const updated = app.container.querySelector(".account-card-updated");
    expect(updated).not.toBeNull();
    expect(updated?.classList.contains("is-error")).toBe(false);
    expect(updated?.textContent).toMatch(/^Updated /);

    // Desktop renders the error banner below the header
    const errorBanner = app.container.querySelector(".account-card-error");
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain("Server temporarily unavailable.");
  });
});

const resetGrant = {
  id: "grant-secret-1",
  label: "Full reset",
  detail: "Clears the 5-hour and weekly limits",
  expiresAt: "2026-12-10T16:00:00Z",
};

function usageWithResets(limitResets?: UsageSnapshot["limitResets"]): UsageSnapshot {
  return {
    plan: "pro",
    email: null,
    windows: [],
    creditsUsd: null,
    unlimitedCredits: false,
    fetchedAt: "2026-11-10T16:00:00Z",
    freshness: "live",
    source: "anthropic_oauth_usage",
    limitResets,
  };
}

describe("AccountDashboardCard limit resets", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    setCardCollapsedOnPage("resets", "acct-resets", false);
  });

  function renderResets(lastUsage: UsageSnapshot | null, collapsed = false) {
    if (collapsed) setCardCollapsedOnPage("resets", "acct-resets", true);
    app = mount(
      <AccountDashboardCard
        pageId="resets"
        account={{ ...account, id: "acct-resets", lastUsage }}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
        onUseLimitReset={() => undefined}
      />,
    );
  }

  it("hides the section when the account has no limit resets", () => {
    renderResets(null);
    expect(document.querySelector(".limit-resets-section")).toBeNull();
    app?.unmount();
    renderResets(usageWithResets([]));
    expect(document.querySelector(".limit-resets-section")).toBeNull();
    app?.unmount();
    renderResets(usageWithResets(undefined));
    expect(document.querySelector(".limit-resets-section")).toBeNull();
  });

  it("shows a closed section only when a reset is available", () => {
    renderResets(usageWithResets([resetGrant]));
    const toggle = document.querySelector(".limit-resets-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).toContain("Limit resets");
    expect(document.body.textContent).not.toContain("Clears the 5-hour and weekly limits");
    expect(document.body.textContent).not.toContain("grant-secret-1");
  });

  it("hides the section while the whole card is collapsed", () => {
    renderResets(usageWithResets([resetGrant]), true);
    expect(document.querySelector(".limit-resets-section")).toBeNull();
  });
});

