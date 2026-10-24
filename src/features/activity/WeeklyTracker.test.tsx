// @vitest-environment happy-dom
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { makeAccount, makeTracker, measured } from "../../test-utils/activity-fixtures";
import { displayPlan } from "../../shared/lib/display";
import { formatResetAtShort } from "../../shared/lib/format";
import type { Account } from "../../types";
import { NoWeeklyLimitCard } from "./NoWeeklyLimitCard";
import { WeeklyTracker } from "./WeeklyTracker";

const originalZone = process.env.TZ;
let mounted: Mounted | null = null;

beforeEach(() => {
  process.env.TZ = "UTC";
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

const dayStarts = Array.from({ length: 8 }, (_, index) => new Date(Date.UTC(2026, 9, 9 + index)));

function render(account: Account, tracker = makeTracker({ accountId: account.id }), onReconnect?: (account: Account) => void) {
  mounted = mount(<WeeklyTracker tracker={tracker} account={account} dayStarts={dayStarts} period="7d" onReconnect={onReconnect} />);
  return mounted.container;
}

const text = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent ?? null;

describe("WeeklyTracker", () => {
  it("names the account, its plan and when the week resets", () => {
    const account = makeAccount({ id: "a1", label: "Work Claude", plan: "max" });
    const root = render(account, makeTracker({ accountId: "a1", resetsAt: "2026-10-27T15:00:00Z" }));
    expect(text(root, ".activity-card-title")).toBe("Work Claude");
    expect(text(root, ".activity-card-details")).toBe(`${displayPlan(account)} · resets ${formatResetAtShort("2026-10-27T15:00:00Z")}`);
    expect(root.querySelector("article")!.getAttribute("aria-labelledby")).toBe(root.querySelector(".activity-card-title")!.id);
  });

  it("leaves out what it does not know", () => {
    const root = render(makeAccount({ id: "a1", label: "Plain" }), makeTracker({ accountId: "a1", resetsAt: null }));
    expect(root.querySelector(".activity-card-details")).toBeNull();
  });

  it("shows this week's percent, toned by how little is left", () => {
    const tone = (used: number | null) => {
      const root = render(makeAccount({ id: "a1" }), makeTracker({ accountId: "a1", currentUsedPercent: used }));
      const total = root.querySelector(".activity-card-total")!;
      const result = [total.querySelector("strong")!.textContent, [...total.classList].find((name) => name.startsWith("tone-"))];
      mounted!.unmount();
      mounted = null;
      return result;
    };
    // The same tones as the account cards: amber at 30% left, red at 15% left.
    expect(tone(42)).toEqual(["42%", "tone-healthy"]);
    expect(tone(69)).toEqual(["69%", "tone-healthy"]);
    expect(tone(70)).toEqual(["70%", "tone-warning"]);
    expect(tone(84)).toEqual(["84%", "tone-warning"]);
    expect(tone(85)).toEqual(["85%", "tone-critical"]);
    expect(tone(0.4)).toEqual(["<1%", "tone-healthy"]);
    expect(tone(null)).toEqual(["—", "tone-neutral"]);
    const root = render(makeAccount({ id: "a1" }), makeTracker({ accountId: "a1", currentUsedPercent: 42 }));
    expect(text(root, ".activity-card-total span")).toBe("this week");
    expect(root.querySelector(".activity-card-total strong")!.getAttribute("aria-label")).toBe("42% of the weekly limit used");
  });

  it("says which limit it is on an Antigravity card, and not on others", () => {
    const tracker = makeTracker({ accountId: "a1", windowId: "gemini", windowLabel: "Gemini 4 Argon · Weekly" });
    const antigravity = render(makeAccount({ id: "a1", provider: "antigravity", label: "Antigravity" }), tracker);
    expect(text(antigravity, ".activity-card-limit")).toBe("Gemini 4 Argon · Weekly");
    expect(antigravity.querySelector('.activity-bars[role="img"]')!.getAttribute("aria-label")).toContain("Antigravity Gemini 4 Argon · Weekly, last 7 days");
    mounted!.unmount();
    mounted = null;

    const claude = render(makeAccount({ id: "a1", label: "Work Claude" }), tracker);
    expect(claude.querySelector(".activity-card-limit")).toBeNull();
  });

  it("draws the daily bars for its days and resets", () => {
    const root = render(makeAccount({ id: "a1", label: "Work Claude" }), makeTracker({ accountId: "a1", days: Array.from({ length: 7 }, () => measured(9)) }));
    expect(root.querySelectorAll(".activity-bar")).toHaveLength(7);
    expect(root.querySelector('.activity-bars[role="img"]')!.getAttribute("aria-label")).toContain("Work Claude, last 7 days");
  });

  it("is not dimmed and has no notice while the account is signed in", () => {
    const root = render(makeAccount({ id: "a1" }), undefined, vi.fn());
    expect(root.querySelector(".activity-card")!.classList.contains("is-dimmed")).toBe(false);
    expect(root.querySelector(".activity-card-notice")).toBeNull();
  });

  it("dims an account that needs to sign in, keeps its data, and offers to reconnect", () => {
    const onReconnect = vi.fn();
    const account = makeAccount({ id: "a1", authRequired: true, lastError: "Sign-in expired." });
    const root = render(account, undefined, onReconnect);
    expect(root.querySelector(".activity-card")!.classList.contains("is-dimmed")).toBe(true);
    expect(text(root, ".activity-card-notice span")).toBe("Sign-in expired.");
    expect(root.querySelectorAll(".activity-bar")).toHaveLength(7);
    click(root.querySelector<HTMLButtonElement>(".activity-card-notice button")!);
    expect(onReconnect).toHaveBeenCalledWith(account);
  });

  it("treats an auth_required snapshot like a sign-in notice, with a fallback text and the Cloud wording", () => {
    const account = makeAccount({ id: "a1", provider: "google_ai_studio" });
    account.lastUsage!.freshness = "auth_required";
    const root = render(account, undefined, vi.fn());
    expect(text(root, ".activity-card-notice span")).toBe("Sign in again to keep tracking this account.");
    expect(text(root, ".activity-card-notice button")).toBe("Reconnect Cloud Usage");
  });

  it("shows no reconnect button when it cannot reconnect", () => {
    const root = render(makeAccount({ id: "a1", authRequired: true }));
    expect(root.querySelector(".activity-card-notice button")).toBeNull();
  });
});

describe("NoWeeklyLimitCard", () => {
  it("names the account, badges it, and explains why there is no chart", () => {
    mounted = mount(<NoWeeklyLimitCard account={makeAccount({ id: "s1", label: "Studio key", provider: "google_ai_studio" })} otherLimits={["daily", "per_minute"]} />);
    const root = mounted.container;
    expect(text(root, ".activity-card-title")).toBe("Studio key");
    expect(text(root, ".activity-badge")).toBe("No weekly limit");
    expect(text(root, ".activity-card-details")).toBe(
      "This account only has daily and per-minute limits, so there's no weekly usage to chart. Its current limits are on the Accounts tab.",
    );
    expect(root.querySelector(".activity-card")!.classList.contains("is-no-weekly")).toBe(true);
    expect(root.querySelector(".activity-bars")).toBeNull();
  });

  it("words a monthly-only account differently", () => {
    mounted = mount(<NoWeeklyLimitCard account={makeAccount({ id: "f1", label: "Free ChatGPT", provider: "openai" })} otherLimits={["monthly"]} />);
    expect(text(mounted.container, ".activity-card-details")).toBe(
      "This account has a monthly limit only, so there's no weekly usage to chart. Its current limit is on the Accounts tab.",
    );
  });
});
