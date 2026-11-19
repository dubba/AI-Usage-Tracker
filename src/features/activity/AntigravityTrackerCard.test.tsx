// @vitest-environment happy-dom
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { estimated, makeAccount, makeTracker, measured, noData } from "../../test-utils/activity-fixtures";
import type { Account, ActivityTracker } from "../../types";
import { AntigravityTrackerCard } from "./AntigravityTrackerCard";

const originalZone = process.env.TZ;
let mounted: Mounted | null = null;

beforeEach(() => {
  process.env.TZ = "UTC";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

const dayStarts = Array.from({ length: 8 }, (_, index) => new Date(Date.UTC(2026, 10, 11 + index)));

function renderCard(
  account: Account,
  trackers: ActivityTracker[],
  period: "7d" | "30d" = "7d",
  starts: readonly Date[] = dayStarts,
  onReconnect?: (account: Account) => void,
) {
  mounted = mount(
    <AntigravityTrackerCard
      account={account}
      trackers={trackers}
      dayStarts={starts}
      period={period}
      onReconnect={onReconnect}
    />,
  );
  return mounted.container;
}

describe("AntigravityTrackerCard", () => {
  const antigravityAccount = makeAccount({
    id: "anti-1",
    provider: "antigravity",
    label: "Google Antigravity",
    plan: "pro",
    planDisplay: "Pro/$20",
    email: "m.bahabib@yahoo.com",
  });

  const geminiTracker = makeTracker({
    accountId: "anti-1",
    windowId: "gemini_weekly",
    windowLabel: "Gemini Models · Weekly Limit Remaining",
    currentUsedPercent: 36,
    resetsAt: "2026-11-21T15:28:00Z",
    days: [noData, measured(8), measured(12), measured(5), estimated(15), measured(10), measured(7)],
    resets: ["2026-11-14T15:28:00Z"],
    resetUsedPercent: [62],
  });

  const claudeTracker = makeTracker({
    accountId: "anti-1",
    windowId: "claude_weekly",
    windowLabel: "Claude and GPT models · Weekly Limit Remaining",
    currentUsedPercent: 72,
    resetsAt: "2026-11-23T23:25:00Z",
    days: [noData, measured(0), measured(0), measured(0), measured(0), measured(23), measured(0)],
  });

  const argonTracker = makeTracker({
    accountId: "anti-1",
    windowId: "argon_weekly",
    windowLabel: "Gemini 4 Argon · Weekly Limit",
    currentUsedPercent: 88,
    resetsAt: "2026-11-23T23:15:00Z",
    days: [noData, measured(0), measured(17), measured(0), measured(0), measured(45), measured(1)],
  });

  it("renders a single consolidated card with one shared header, plan pill, and email", () => {
    const root = renderCard(antigravityAccount, [geminiTracker, claudeTracker, argonTracker]);

    expect(root.querySelectorAll(".activity-card")).toHaveLength(1);
    expect(root.querySelectorAll(".activity-card-icon")).toHaveLength(1);
    expect(root.querySelector(".activity-card-title")!.textContent).toBe("Antigravity");
    expect(root.querySelectorAll(".activity-plan-pill")).toHaveLength(1);
    expect(root.querySelector(".activity-plan-pill")!.textContent).toBe("Pro/$20");
    expect(root.querySelectorAll(".activity-consolidated-email")).toHaveLength(1);
    expect(root.querySelector(".activity-consolidated-email")!.textContent).toBe("m.bahabib@yahoo.com");
    expect(root.querySelector("article")!.getAttribute("aria-labelledby")).toBe(root.querySelector(".activity-card-title")!.id);
  });

  it("displays model groups in canonical order regardless of input order", () => {
    const root = renderCard(antigravityAccount, [argonTracker, claudeTracker, geminiTracker]);

    const sections = [...root.querySelectorAll(".activity-model-section")];
    expect(sections).toHaveLength(3);
    expect(sections.map((section) => section.querySelector(".activity-model-name")!.textContent)).toEqual([
      "Gemini Models",
      "Other Models",
      "Argon Models",
    ]);
  });

  it("keeps each model group's percentage, tone, and chart independent, with no reset line", () => {
    const root = renderCard(antigravityAccount, [geminiTracker, claudeTracker, argonTracker]);
    const sections = [...root.querySelectorAll(".activity-model-section")];
    expect(root.querySelector(".activity-model-reset")).toBeNull();

    expect(sections[0].querySelector(".activity-model-total strong")!.textContent).toBe("36%");
    expect(sections[0].querySelector(".activity-model-total")!.classList.contains("tone-healthy")).toBe(true);
    expect(sections[0].querySelector(".activity-bars")!.getAttribute("aria-label")).toContain("Antigravity Gemini Models, last 7 days");
    expect(sections[0].querySelectorAll(".activity-reset")).toHaveLength(1);
    expect(sections[0].querySelectorAll(".activity-bar.is-empty")).toHaveLength(1);
    expect(sections[0].querySelectorAll(".activity-bar.is-approximate")).toHaveLength(1);

    expect(sections[1].querySelector(".activity-model-total strong")!.textContent).toBe("72%");
    expect(sections[1].querySelector(".activity-model-total")!.classList.contains("tone-warning")).toBe(true);
    expect(sections[1].querySelector(".activity-bars")!.getAttribute("aria-label")).toContain("Antigravity Other Models, last 7 days");
    expect(sections[1].querySelectorAll(".activity-reset")).toHaveLength(0);

    expect(sections[2].querySelector(".activity-model-total strong")!.textContent).toBe("88%");
    expect(sections[2].querySelector(".activity-model-total")!.classList.contains("tone-critical")).toBe(true);
    expect(sections[2].querySelector(".activity-bars")!.getAttribute("aria-label")).toContain("Antigravity Argon Models, last 7 days");
  });

  it("omits missing plan pill and email cleanly", () => {
    const plain = makeAccount({ id: "anti-plain", provider: "antigravity", label: "Antigravity" });
    const bareTracker = makeTracker({
      accountId: "anti-plain",
      windowId: "gemini_weekly",
      windowLabel: "Gemini Models · Weekly Limit Remaining",
      resetsAt: null,
      currentUsedPercent: null,
    });
    const root = renderCard(plain, [bareTracker]);

    expect(root.querySelector(".activity-plan-pill")).toBeNull();
    expect(root.querySelector(".activity-consolidated-email")).toBeNull();
    expect(root.querySelector(".activity-model-total strong")!.textContent).toBe("—");
    expect(root.querySelector(".activity-model-total-period")).toBeNull();
    expect(root.querySelector(".activity-card-total-period")!.textContent).toBe("this week");
  });

  it("shows one sign-in notice and dims the card when reconnection is required", () => {
    const onReconnect = vi.fn();
    const stale = makeAccount({
      ...antigravityAccount,
      authRequired: true,
      lastError: "Sign-in expired.",
      health: "signed_out",
    });
    const root = renderCard(stale, [geminiTracker, claudeTracker, argonTracker], "7d", dayStarts, onReconnect);

    const card = root.querySelector(".activity-card")!;
    expect(card.classList.contains("is-dimmed")).toBe(true);
    expect(card.classList.contains("needs-attention")).toBe(true);
    expect(root.querySelectorAll(".activity-card-notice")).toHaveLength(1);
    expect(root.querySelector(".activity-card-notice span")!.textContent).toBe("Sign-in expired.");
    click(root.querySelector<HTMLButtonElement>(".activity-card-notice button")!);
    expect(onReconnect).toHaveBeenCalledWith(stale);
  });

  it("renders 30d period charts independently inside each model section", () => {
    const starts30 = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 9, 19 + i)));
    const t1 = makeTracker({ accountId: "anti-1", windowId: "gemini", windowLabel: "Gemini Models · Weekly" }, 30);
    const t2 = makeTracker({ accountId: "anti-1", windowId: "claude", windowLabel: "Claude and GPT models · Weekly" }, 30);
    const t3 = makeTracker({ accountId: "anti-1", windowId: "argon", windowLabel: "Gemini 4 Argon · Weekly" }, 30);
    const root = renderCard(antigravityAccount, [t1, t2, t3], "30d", starts30);

    expect(root.querySelectorAll(".activity-model-section")).toHaveLength(3);
    expect(root.querySelectorAll(".activity-bar")).toHaveLength(90);
    expect(root.querySelectorAll(".activity-axis")).toHaveLength(3);
  });
});
