// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { click, mount, settle, type Mounted } from "../../test-utils/react";
import type { Account } from "../../types";
import { CREDENTIAL_PROTECTION_ACCOUNT_NOTE } from "../dashboard/credential-protection";
import { AccountDashboardCard, computeAccountCardMenuPlacement } from "./AccountDashboardCard";

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

  afterEach(() => {
    app?.unmount();
    app = null;
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
});

