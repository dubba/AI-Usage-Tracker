// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { setNarrowWindow } from "../../test-utils/media";
import { click, mount, settle, type Mounted } from "../../test-utils/react";
import type { Account, UsageSnapshot } from "../../types";
import { setCardCollapsedOnPage } from "../layout/dashboard-page-state";
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

  it("uses viewport bounds rather than scroll container bounds so the portaled fixed menu is not clipped", () => {
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
      bottom: 550, // Only 18px below the toggle inside the scroll container
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
      expect(placement.openUpward).toBe(false);
      expect(placement.maxHeight).toBe(window.innerHeight - 532 - 8); // 228 at 768px viewport
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

  it("keeps the menu above the bottom navigation bar, flipping upward when it does not fit", () => {
    const rectOf = (top: number, bottom: number) => () =>
      ({ top, bottom, left: 300, right: 332, width: 32, height: bottom - top, x: 300, y: top, toJSON: () => ({}) }) as DOMRect;
    const nav = document.createElement("nav");
    nav.className = "bottom-nav";
    // The bar covers the last 80px of the 768px viewport.
    nav.getBoundingClientRect = rectOf(window.innerHeight - 80, window.innerHeight);
    document.body.appendChild(nav);
    const menu = document.createElement("div");
    Object.defineProperty(menu, "scrollHeight", { value: 300, configurable: true });
    try {
      // 300px of menu fits between this toggle and the bar, with 5px kept clear of the bar.
      const high = document.createElement("button");
      high.getBoundingClientRect = rectOf(300, 332);
      const below = computeAccountCardMenuPlacement(high, true, menu);
      expect(below.openUpward).toBe(false);
      expect(below.maxHeight).toBe(window.innerHeight - 80 - 5 - 332 - 8);

      // Lower down it would run under the bar (it would still fit the bare viewport), so it flips.
      const low = document.createElement("button");
      low.getBoundingClientRect = rectOf(420, 452);
      const above = computeAccountCardMenuPlacement(low, true, menu);
      expect(above.openUpward).toBe(true);
      expect(above.maxHeight).toBe(420 - 8);
    } finally {
      nav.remove();
    }
  });

  it("is not limited by the card or any other ancestor of the toggle, since the menu is on body", () => {
    const card = document.createElement("article");
    card.style.transform = "translateY(0)";
    card.getBoundingClientRect = () =>
      ({ top: 80, bottom: 200, left: 0, right: 400, width: 400, height: 120, x: 0, y: 80, toJSON: () => ({}) }) as DOMRect;
    const toggle = document.createElement("button");
    toggle.getBoundingClientRect = () =>
      ({ top: 100, bottom: 132, left: 300, right: 332, width: 32, height: 32, x: 300, y: 100, toJSON: () => ({}) }) as DOMRect;
    card.appendChild(toggle);
    document.body.appendChild(card);
    try {
      const placement = computeAccountCardMenuPlacement(toggle, true);
      expect(placement.openUpward).toBe(false);
      expect(placement.maxHeight).toBe(window.innerHeight - 132 - 8);
    } finally {
      card.remove();
    }
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
    expect(app.container.querySelector(".account-metric-track")?.classList.contains("is-hatched")).toBe(true);
    expect(app.container.querySelector(".account-status-chip")?.textContent).toBe("Out of date");
    expect(app.container.querySelector(".refresh-action")?.classList.contains("is-suggested")).toBe(true);
    const notice = app.container.querySelector(".account-card-error")!;
    expect(notice.textContent).toContain("OpenAI rate-limited the usage request.");
    click(notice.querySelector<HTMLButtonElement>('[aria-label="Retry refreshing Claude"]')!);
    expect(rendered.handlers.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("stripes a percent that is out of date and leaves a live percent solid", () => {
    const quotaWindow = {
      id: "5h",
      label: "5-Hour",
      remainingPercent: 70,
      usedPercent: 30,
      resetsAt: null,
      windowSeconds: 5 * 3600,
      kind: "five_hour" as const,
    };
    const usage = {
      plan: "pro",
      email: null,
      windows: [quotaWindow],
      creditsUsd: null,
      unlimitedCredits: false,
      fetchedAt: new Date().toISOString(),
      source: "test",
    };
    const stale = renderDesktopCard({
      account: { ...account, id: "stale-bar", plan: "pro", lastUsage: { ...usage, freshness: "stale" } },
    });
    app = stale.app;
    expect(app.container.querySelector(".account-usage-metric")?.classList.contains("is-stale")).toBe(true);
    expect(app.container.querySelector(".account-metric-track")?.classList.contains("is-hatched")).toBe(false);

    app.unmount();
    const live = renderDesktopCard({
      account: { ...account, id: "live-bar", plan: "pro", lastUsage: { ...usage, freshness: "live" } },
    });
    app = live.app;
    expect(app.container.querySelector(".account-usage-metric")?.classList.contains("is-stale")).toBe(false);
    expect(app.container.querySelector(".account-metric-track")?.classList.contains("is-hatched")).toBe(false);
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

  it("keeps the timestamp and shows the error bar with Retry on the right on a phone", () => {
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

    const updated = app.container.querySelector(".account-card-updated");
    expect(updated?.textContent).toMatch(/^Updated /);
    expect(updated?.classList.contains("is-error")).toBe(false);

    const banner = app.container.querySelector(".account-card-error")!;
    expect(banner.querySelector("span")?.textContent).toBe("Rate limit exceeded. Try again later.");
    const retryBtn = banner.querySelector("button")!;
    expect(retryBtn.textContent).toBe("Retry");
    expect(banner.lastElementChild).toBe(retryBtn);
    click(retryBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows the signed-out message and Sign in again on the right on a phone", () => {
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

    const banner = app.container.querySelector(".account-card-error")!;
    expect(banner.querySelector("span")?.textContent).toBe("Session expired. Sign in again.");
    const signInBtn = banner.querySelector("button")!;
    expect(signInBtn.textContent).toBe("Sign in again");
    expect(banner.lastElementChild).toBe(signInBtn);
    click(signInBtn);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("formats 'authentication is required' to 'Re-authentication required' on mobile", () => {
    setNarrowWindow(true);
    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={{
          ...account,
          id: "mobile-reauth-test",
          authRequired: true,
          lastError: "authentication is required",
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

    expect(app.container.querySelector(".account-card-error span")?.textContent).toBe("Re-authentication required");
  });

  it("shows Reconnect Cloud Usage for a Google AI Studio signed-out account on mobile", () => {
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

    const banner = app.container.querySelector(".account-card-error")!;
    expect(banner.querySelector("span")?.textContent).toBe("This account is signed out.");
    const reconnectBtn = banner.querySelector("button")!;
    expect(reconnectBtn.textContent).toBe("Reconnect Cloud Usage");
    click(reconnectBtn);
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
    expect(document.body.textContent).toContain("You have 1 available Limit Reset");
    expect(document.body.textContent).not.toContain("Clears the 5-hour and weekly limits");
    expect(document.body.textContent).not.toContain("grant-secret-1");
  });

  it("hides the section while the whole card is collapsed", () => {
    renderResets(usageWithResets([resetGrant]), true);
    expect(document.querySelector(".limit-resets-section")).toBeNull();
  });
});

describe("AccountDashboardCard Claude limits", () => {
  let app: Mounted | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T07:59:59Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    app?.unmount();
    app = null;
  });

  it("renders all 3 limits for a Claude account with Fable", () => {
    const claudeUsage: UsageSnapshot = {
      plan: "claude_pro",
      email: "claude@example.com",
      windows: [
        {
          id: "five_hour",
          label: "5 hour",
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: null,
          windowSeconds: 18000,
          kind: "five_hour",
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPercent: 2,
          remainingPercent: 98,
          resetsAt: "2026-11-15T07:59:59Z",
          windowSeconds: 604800,
          kind: "weekly",
        },
        {
          id: "seven_day_fable",
          label: "Fable · Weekly",
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: "2026-11-15T07:59:59Z",
          windowSeconds: 604800,
          kind: "weekly",
        },
      ],
      creditsUsd: null,
      unlimitedCredits: false,
      fetchedAt: "2026-11-11T06:00:00Z",
      freshness: "live",
      source: "anthropic_oauth_usage",
      limitResets: [],
    };

    app = mount(
      <AccountDashboardCard
        pageId="all"
        account={{ ...account, id: "acct-claude-3", lastUsage: claudeUsage }}
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    const metrics = app.container.querySelectorAll(".account-usage-metric");
    expect(metrics).toHaveLength(3);
    expect(app.container.querySelector(".multi-row-metrics")).not.toBeNull();
    const metricSpans = Array.from(app.container.querySelectorAll(".desktop-metric-span")).map((el) => el.textContent);
    const metricNames = Array.from(app.container.querySelectorAll(".desktop-metric-name")).map((el) => el.textContent);
    expect(metricSpans).toEqual(["5-hour", "7-day", "7-day"]);
    expect(metricNames).toEqual(["Claude", "Claude", "Fable"]);
    expect(document.body.textContent).toContain("100%left");
    expect(document.body.textContent).toContain("98%left");
    expect(document.body.textContent).toContain("Resets in 4d");
  });
});

describe("AccountDashboardCard compact mode (L7)", () => {
  let app: Mounted | null = null;

  beforeEach(() => {
    setNarrowWindow(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    app?.unmount();
    app = null;
    setCardCollapsedOnPage("compact-page", "acct-compact", false);
  });

  it("renders a single slim row with identity, compact metric bars, soonest reset, and actions", () => {
    const compactAccount: Account = {
      ...account,
      id: "acct-compact",
      label: "Work Claude",
      plan: "claude_max_200",
      lastUsage: {
        plan: "claude_max_200",
        email: "work@example.com",
        windows: [
          {
            id: "five_hour",
            label: "5 hour",
            usedPercent: 25,
            remainingPercent: 75,
            resetsAt: "2026-11-11T10:30:00Z",
            windowSeconds: 18000,
            kind: "five_hour",
          },
          {
            id: "weekly",
            label: "Weekly",
            usedPercent: 10,
            remainingPercent: 90,
            resetsAt: "2026-11-15T08:00:00Z",
            windowSeconds: 604800,
            kind: "weekly",
          },
        ],
        creditsUsd: null,
        unlimitedCredits: false,
        fetchedAt: "2026-11-11T07:55:00Z",
        freshness: "live",
        source: "anthropic_oauth_usage",
      },
    };

    const onRefresh = vi.fn();
    app = mount(
      <AccountDashboardCard
        pageId="compact-page"
        account={compactAccount}
        compact
        busy={new Set()}
        onRefresh={onRefresh}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    const card = app.container.querySelector(".provider-account-card")!;
    expect(card.classList.contains("is-compact")).toBe(true);
    expect(card.querySelector(".compact-card-row")).not.toBeNull();
    expect(card.querySelector(".compact-card-identity h2")?.textContent).toBe("Work Claude");
    expect(card.querySelector(".account-plan-badge")?.textContent).toBe("Max/$200");

    const metrics = [...card.querySelectorAll(".compact-metric-item")];
    expect(metrics).toHaveLength(2);
    expect(metrics[0].querySelector(".compact-metric-label")?.textContent).toBe("5h · Claude");
    expect(metrics[0].querySelector(".compact-metric-value")?.textContent).toBe("75%");
    expect(metrics[1].querySelector(".compact-metric-label")?.textContent).toBe("7d · Claude");
    expect(metrics[1].querySelector(".compact-metric-value")?.textContent).toBe("90%");
    expect(metrics[0].querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("75");

    expect(card.querySelector(".compact-card-reset")?.textContent).toContain("Resets");
    click(card.querySelector<HTMLButtonElement>(".refresh-action")!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows compact Sign in / Retry actions and collapses cleanly to lowest percent", () => {
    const onReconnect = vi.fn();
    const onRefresh = vi.fn();
    app = mount(
      <AccountDashboardCard
        pageId="compact-page"
        account={{ ...account, id: "acct-compact-auth", authRequired: true }}
        compact
        busy={new Set()}
        onRefresh={onRefresh}
        onReconnect={onReconnect}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    const signInBtn = app.container.querySelector<HTMLButtonElement>(".compact-card-action-btn")!;
    expect(signInBtn.textContent).toBe("Sign in");
    click(signInBtn);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    app.rerender(
      <AccountDashboardCard
        pageId="compact-page"
        account={{ ...account, id: "acct-compact-err", lastError: "Timed out" }}
        compact
        busy={new Set()}
        onRefresh={onRefresh}
        onReconnect={onReconnect}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    const retryBtn = app.container.querySelector<HTMLButtonElement>(".compact-card-action-btn")!;
    expect(retryBtn.textContent).toBe("Retry");
    click(retryBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("switches to the inline rename input when Rename is chosen from the card menu", () => {
    app = mount(
      <AccountDashboardCard
        pageId="compact-page"
        account={{ ...account, id: "acct-compact-rename" }}
        compact
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );

    expect(app.container.querySelector(".compact-card-row")).not.toBeNull();
    click(app.container.querySelector<HTMLButtonElement>('[aria-label="More actions for Claude"]')!);
    const renameBtn = [...document.querySelectorAll<HTMLButtonElement>(".account-card-menu-list .mobile-dropdown-item")].find((b) =>
      b.textContent?.includes("Rename"),
    )!;
    click(renameBtn);
    expect(app.container.querySelector(".account-card-name-input")).not.toBeNull();
  });

  it("uses two-per-row layout (.is-two-col) when compact account has more than 4 windows", () => {
    const fiveWindows = [1, 2, 3, 4, 5].map((n) => ({
      id: `w-${n}`,
      label: `Model ${n} · Weekly`,
      usedPercent: n * 10,
      remainingPercent: 100 - n * 10,
      resetsAt: "2026-11-15T08:00:00Z",
      windowSeconds: 604800,
      kind: "weekly" as const,
    }));
    const manyUsage: UsageSnapshot = {
      plan: "pro",
      email: "antigravity@example.com",
      windows: fiveWindows,
      creditsUsd: null,
      unlimitedCredits: false,
      fetchedAt: "2026-11-11T07:55:00Z",
      freshness: "live",
      source: "antigravity",
    };

    app = mount(
      <AccountDashboardCard
        pageId="compact-page"
        account={{ ...account, id: "acct-compact-4", lastUsage: { ...manyUsage, windows: fiveWindows.slice(0, 4) } }}
        compact
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );
    expect(app.container.querySelector(".compact-card-metrics")?.classList.contains("is-two-col")).toBe(false);

    app.rerender(
      <AccountDashboardCard
        pageId="compact-page"
        account={{ ...account, id: "acct-compact-5", provider: "antigravity", lastUsage: manyUsage }}
        compact
        busy={new Set()}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
      />,
    );
    const metricsContainer = app.container.querySelector(".compact-card-metrics")!;
    expect(metricsContainer.classList.contains("is-two-col")).toBe(true);
    expect(metricsContainer.querySelectorAll(".compact-metric-item")).toHaveLength(5);
  });
});

