// @vitest-environment happy-dom
/// <reference types="node" />
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, settle, type Mounted } from "../../test-utils/react";
import {
  estimated,
  makeAccount,
  makeActivity,
  makeTracker,
  measured,
  noData,
} from "../../test-utils/activity-fixtures";
import type { Account, WeeklyActivity } from "../../types";
import { getActivityPeriod, refreshActivityPeriod, setActivityPeriod } from "./activity-period";
import { ActivityView } from "./ActivityView";

const api = vi.hoisted(() => ({ getWeeklyActivity: vi.fn() }));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

const originalZone = process.env.TZ;
let mounted: Mounted | null = null;

beforeEach(() => {
  process.env.TZ = "UTC";
  localStorage.clear();
  refreshActivityPeriod();
  api.getWeeklyActivity.mockReset().mockResolvedValue(makeActivity());
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

const work = makeAccount({ id: "work", label: "Work Claude" });
const personal = makeAccount({ id: "personal", label: "Personal ChatGPT", provider: "openai" });
const studio = makeAccount({ id: "studio", label: "Studio key", provider: "google_ai_studio" });

function renderView(accounts: Account[], props: Partial<Parameters<typeof ActivityView>[0]> = {}) {
  const onAddAccount = vi.fn();
  mounted = mount(<ActivityView accounts={accounts} onAddAccount={onAddAccount} {...props} />);
  return { onAddAccount, root: mounted.container };
}

const select = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
const titles = (root: ParentNode) => select(root, ".activity-card-title").map((title) => title.textContent);
const button = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const requested = (call: number): string[] => api.getWeeklyActivity.mock.calls[call][0];

function answer(trackerCount = 1, dayCount = 7): WeeklyActivity {
  return makeActivity(
    Array.from({ length: trackerCount }, (_, index) => makeTracker({ accountId: index === 0 ? "work" : "personal" }, dayCount)),
  );
}

describe("ActivityView", () => {
  it("shows placeholders while loading and the charts when the answer arrives", async () => {
    let resolve!: (value: WeeklyActivity) => void;
    api.getWeeklyActivity.mockReturnValue(new Promise<WeeklyActivity>((done) => (resolve = done)));
    const { root } = renderView([work]);

    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(root.textContent).toContain("Loading usage…");
    expect(select(root, ".activity-skeleton")).toHaveLength(3);
    expect(select(root, ".activity-bar")).toHaveLength(0);

    resolve(answer());
    await settle();
    expect(root.querySelector('[aria-busy="true"]')).toBeNull();
    expect(titles(root)).toEqual(["Work Claude"]);
    expect(select(root, ".activity-bar")).toHaveLength(7);
  });

  it("invites the user to add an account when there are none, and asks the backend for nothing", async () => {
    const { root, onAddAccount } = renderView([]);
    await settle();
    expect(root.textContent).toContain("No accounts yet");
    click(select(root, "button").find((candidate) => candidate.textContent === "Add account")!);
    expect(onAddAccount).toHaveBeenCalledTimes(1);
    expect(api.getWeeklyActivity).not.toHaveBeenCalled();
  });

  it("shows why loading failed, and tries again on Retry", async () => {
    api.getWeeklyActivity.mockRejectedValueOnce(new Error("The history could not be read."));
    const { root } = renderView([work]);
    await settle();
    const alert = root.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("The history could not be read.");
    expect(select(root, ".activity-skeleton")).toHaveLength(0);

    api.getWeeklyActivity.mockResolvedValueOnce(answer());
    click([...alert.querySelectorAll("button")].find((candidate) => candidate.textContent === "Retry")!);
    await settle();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(titles(root)).toEqual(["Work Claude"]);
    expect(api.getWeeklyActivity).toHaveBeenCalledTimes(2);
  });

  it("keeps the charts on screen when a later refresh fails, and says so", async () => {
    api.getWeeklyActivity.mockResolvedValueOnce(answer());
    const { root } = renderView([work]);
    await settle();

    api.getWeeklyActivity.mockRejectedValueOnce("offline");
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(titles(root)).toEqual(["Work Claude"]);
    expect(root.querySelector('[role="alert"]')!.textContent).toContain("Couldn’t refresh usage: offline");
  });

  it("says tracking starts at the next refresh when nothing has been recorded yet", async () => {
    api.getWeeklyActivity.mockResolvedValue(
      makeActivity([makeTracker({ accountId: "work" }, 7, noData)], [{ accountId: "studio", otherLimits: ["daily"] }]),
    );
    const { root } = renderView([work, studio]);
    await settle();
    expect(root.querySelector('[role="status"]')!.textContent).toBe("Tracking starts at the next refresh.");
    // No empty charts; accounts without a weekly limit still say so.
    expect(select(root, ".activity-bar")).toHaveLength(0);
    expect(titles(root)).toEqual(["Studio key"]);
  });

  it("says the same when the backend knows no limits yet at all", async () => {
    const { root } = renderView([work]);
    await settle();
    expect(root.querySelector('[role="status"]')!.textContent).toBe("Tracking starts at the next refresh.");
  });

  it("lists the trackers in the order of the accounts, then the accounts without a weekly limit", async () => {
    api.getWeeklyActivity.mockResolvedValue(
      makeActivity(
        [
          makeTracker({ accountId: "work" }),
          makeTracker({ accountId: "personal" }),
          makeTracker({ accountId: "work", windowId: "second", windowLabel: "Second · Weekly" }),
        ],
        [
          { accountId: "studio", otherLimits: ["daily"] },
        ],
      ),
    );
    // The page's account order puts Personal first, whatever order the backend answered in.
    const { root } = renderView([personal, studio, work]);
    await settle();
    expect(titles(root)).toEqual(["Personal ChatGPT", "Work Claude", "Work Claude", "Studio key"]);
  });

  it("leaves out trackers of accounts that are no longer there", async () => {
    api.getWeeklyActivity.mockResolvedValue(
      makeActivity([makeTracker({ accountId: "gone" }), makeTracker({ accountId: "work" })], [{ accountId: "gone-too", otherLimits: [] }]),
    );
    const { root } = renderView([work]);
    await settle();
    expect(titles(root)).toEqual(["Work Claude"]);
  });

  it("starts on 7 days, asks for 8 boundaries, and has 7D selected", async () => {
    api.getWeeklyActivity.mockResolvedValue(answer());
    const { root } = renderView([work]);
    await settle();
    expect(requested(0)).toHaveLength(8);
    expect(button(root, "Last 7 days").getAttribute("aria-pressed")).toBe("true");
    expect(button(root, "Last 30 days").getAttribute("aria-pressed")).toBe("false");
    // The switch is named by a visible label beside it.
    const group = root.querySelector('[role="group"]')!;
    expect(root.querySelector(`#${CSS.escape(group.getAttribute("aria-labelledby")!)}`)!.textContent).toBe("Period:");
  });

  it("switches to 30 days, loads again with 31 boundaries, and remembers the choice", async () => {
    api.getWeeklyActivity.mockImplementation(async (starts: string[]) => answer(1, starts.length - 1));
    const { root } = renderView([work]);
    await settle();
    expect(select(root, ".activity-bar")).toHaveLength(7);

    click(button(root, "Last 30 days"));
    await settle();
    expect(api.getWeeklyActivity).toHaveBeenCalledTimes(2);
    expect(requested(1)).toHaveLength(31);
    expect(select(root, ".activity-bar")).toHaveLength(30);
    expect(button(root, "Last 30 days").getAttribute("aria-pressed")).toBe("true");
    expect(getActivityPeriod()).toBe("30d");
    expect(localStorage.getItem("ai-usage-tracker:activity-period")).toBe("30d");

    // A new visit starts on 30 days.
    mounted!.unmount();
    api.getWeeklyActivity.mockClear();
    const again = renderView([work]);
    await settle();
    expect(requested(0)).toHaveLength(31);
    expect(select(again.root, ".activity-bar")).toHaveLength(30);

    click(button(again.root, "Last 7 days"));
    await settle();
    expect(requested(1)).toHaveLength(8);
    expect(getActivityPeriod()).toBe("7d");
  });

  it("shows the weekly reset markers on 30 days only", async () => {
    api.getWeeklyActivity.mockImplementation(async (starts: string[]) => {
      // The reset is inside whichever range the page asked for.
      const first = Date.parse(starts[0]);
      const at = new Date(first + 3.5 * 86_400_000).toISOString();
      return makeActivity([makeTracker({ accountId: "work", resets: [at] }, starts.length - 1)]);
    });
    const { root } = renderView([work]);
    await settle();
    expect(select(root, ".activity-reset")).toHaveLength(0);
    click(button(root, "Last 30 days"));
    await settle();
    expect(select(root, ".activity-reset")).toHaveLength(1);
    expect(select(root, ".activity-reset [data-tooltip]")[0].dataset.tooltip).toMatch(/^Weekly reset · /);
    click(button(root, "Last 7 days"));
    await settle();
    expect(select(root, ".activity-reset")).toHaveLength(0);
  });

  describe("an account with only a monthly limit", () => {
    const free = makeAccount({ id: "free", label: "ChatGPT", provider: "openai" });
    const monthlyAnswer = (dayCount: number, days = measured(2)) =>
      makeActivity(
        [makeTracker({ accountId: "free", windowId: "monthly", windowLabel: "Monthly", windowKind: "monthly", currentUsedPercent: 40 }, dayCount, days)],
        [{ accountId: "free", otherLimits: ["monthly"] }],
      );

    it("keeps its No weekly limit card on 7 days, with a hint to choose 30D", async () => {
      api.getWeeklyActivity.mockImplementation(async (starts: string[]) => monthlyAnswer(starts.length - 1));
      const { root } = renderView([free]);
      await settle();
      expect(titles(root)).toEqual(["ChatGPT"]);
      expect(select(root, ".activity-bar")).toHaveLength(0);
      expect(select(root, ".activity-card.is-no-weekly")).toHaveLength(1);
      expect(root.querySelector(".activity-card-details")!.textContent).toContain("Choose 30D to see its monthly usage.");
      // Monthly usage is not what "Tracking starts" is about here.
      expect(root.querySelector('[role="status"]')).toBeNull();
    });

    it("charts its monthly usage on 30 days instead of the No weekly limit card", async () => {
      api.getWeeklyActivity.mockImplementation(async (starts: string[]) => monthlyAnswer(starts.length - 1));
      const { root } = renderView([free]);
      await settle();
      click(button(root, "Last 30 days"));
      await settle();
      expect(select(root, ".activity-card.is-no-weekly")).toHaveLength(0);
      expect(select(root, ".activity-bar")).toHaveLength(30);
      expect(root.querySelector(".activity-card-total span")!.textContent).toBe("this month");
      expect(root.querySelector(".activity-bars")!.getAttribute("aria-label")).toContain("ChatGPT, last 30 days");

      click(button(root, "Last 7 days"));
      await settle();
      expect(select(root, ".activity-bar")).toHaveLength(0);
      expect(select(root, ".activity-card.is-no-weekly")).toHaveLength(1);
    });

    it("lists the monthly chart after the weekly ones, in account order", async () => {
      api.getWeeklyActivity.mockImplementation(async (starts: string[]) => {
        const days = starts.length - 1;
        return makeActivity(
          [
            makeTracker({ accountId: "free", windowId: "monthly", windowKind: "monthly" }, days),
            makeTracker({ accountId: "work" }, days),
          ],
          [{ accountId: "free", otherLimits: ["monthly"] }],
        );
      });
      const { root } = renderView([work, free]);
      await settle();
      expect(titles(root)).toEqual(["Work Claude", "ChatGPT"]);
      click(button(root, "Last 30 days"));
      await settle();
      expect(titles(root)).toEqual(["Work Claude", "ChatGPT"]);
      expect(select(root, ".activity-card.is-no-weekly")).toHaveLength(0);
    });

    it("says tracking starts at the next refresh on 30 days until something is recorded, and keeps its card", async () => {
      api.getWeeklyActivity.mockImplementation(async (starts: string[]) => monthlyAnswer(starts.length - 1, noData));
      const { root } = renderView([free]);
      await settle();
      click(button(root, "Last 30 days"));
      await settle();
      expect(root.querySelector('[role="status"]')!.textContent).toBe("Tracking starts at the next refresh.");
      expect(select(root, ".activity-bar")).toHaveLength(0);
      expect(titles(root)).toEqual(["ChatGPT"]);
      expect(root.querySelector(".activity-card-details")!.textContent).not.toContain("Choose 30D");
    });
  });

  it("shows a day with nothing observed as striped, and an estimated day as estimated", async () => {
    api.getWeeklyActivity.mockResolvedValue(
      makeActivity([makeTracker({ accountId: "work", days: [measured(5), noData, estimated(2), measured(0), measured(1), measured(1), measured(1)] })]),
    );
    const { root } = renderView([work]);
    await settle();
    expect(select(root, ".activity-day-value")).toHaveLength(0);
    expect(select(root, ".activity-bar").slice(0, 4).map((bar) => bar.dataset.tooltip?.split("\n")[0].split(": ")[1])).toEqual(["5%", "no data", "2%", "0%"]);
    expect(select(root, ".activity-bar.is-empty")).toHaveLength(1);
    expect(select(root, ".activity-bar.is-approximate")).toHaveLength(1);
  });

  it("loads again when a refresh brings new usage, not when nothing changed", async () => {
    api.getWeeklyActivity.mockResolvedValue(answer());
    const { root } = renderView([work]);
    await settle();
    expect(api.getWeeklyActivity).toHaveBeenCalledTimes(1);

    // The same data in new objects (a poll with nothing new): no request.
    mounted!.rerender(<ActivityView accounts={[{ ...work }]} onAddAccount={vi.fn()} />);
    await settle();
    expect(api.getWeeklyActivity).toHaveBeenCalledTimes(1);

    // A refresh finished: new fetch time.
    const refreshed = { ...work, lastUsage: { ...work.lastUsage!, fetchedAt: "2026-10-24T12:15:00Z" } };
    mounted!.rerender(<ActivityView accounts={[refreshed]} onAddAccount={vi.fn()} />);
    await settle();
    expect(api.getWeeklyActivity).toHaveBeenCalledTimes(2);

    // An account was added.
    mounted!.rerender(<ActivityView accounts={[refreshed, personal]} onAddAccount={vi.fn()} />);
    await settle();
    expect(api.getWeeklyActivity).toHaveBeenCalledTimes(3);
    expect(root.isConnected).toBe(true);
  });

  it("loads again when the app comes back to the front", async () => {
    api.getWeeklyActivity.mockResolvedValue(answer());
    renderView([work]);
    await settle();
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(api.getWeeklyActivity).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(api.getWeeklyActivity).toHaveBeenCalledTimes(3);
  });

  it("ignores a slow answer for a period the user has already left", async () => {
    setActivityPeriod("7d");
    const pending: Array<(value: WeeklyActivity) => void> = [];
    api.getWeeklyActivity.mockImplementation(() => new Promise<WeeklyActivity>((done) => pending.push(done)));
    const { root } = renderView([work]);
    click(button(root, "Last 30 days"));
    await settle();
    expect(pending).toHaveLength(2);

    // The 30 day answer arrives first, then the old 7 day one.
    pending[1](answer(1, 30));
    await settle();
    expect(select(root, ".activity-bar")).toHaveLength(30);
    pending[0](answer(1, 7));
    await settle();
    expect(select(root, ".activity-bar")).toHaveLength(30);
    expect(select(root, ".activity-axis")).toHaveLength(1);
  });

  it("does not show the old period's charts, or its error, while the new one loads", async () => {
    api.getWeeklyActivity.mockResolvedValueOnce(answer());
    const { root } = renderView([work]);
    await settle();
    api.getWeeklyActivity.mockReturnValueOnce(new Promise(() => {}));
    click(button(root, "Last 30 days"));
    await settle();
    expect(select(root, ".activity-bar")).toHaveLength(0);
    expect(select(root, ".activity-skeleton")).toHaveLength(3);
  });

  it("keeps the 7D / 30D switch in the title row, after the title, so a phone shows them on one line", async () => {
    const { root } = renderView([work], { onToggleSidebar: vi.fn() });
    await settle();
    const row = root.querySelector(".dashboard-title-row")!;
    const children = [...row.children];
    expect(children.map((child) => child.tagName + (child.classList.contains("activity-period") ? ".period" : ""))).toEqual([
      "BUTTON",
      "H1",
      "DIV.period",
    ]);
    // The label comes first, so the switch reads "Period 7D 30D".
    expect([...row.querySelector(".activity-period")!.children].map((child) => child.className)).toEqual([
      "activity-period-label",
      "activity-period-switch",
    ]);
    expect(root.querySelectorAll(".activity-period-switch")).toHaveLength(1);
  });

  it("has the title as a focusable heading, and the sidebar button when it is given one", async () => {
    const onToggleSidebar = vi.fn();
    const { root } = renderView([work], { onToggleSidebar, sidebarOpen: false });
    await settle();
    expect(root.querySelector("h1")!.textContent).toBe("Usage");
    expect(root.querySelector("h1")!.getAttribute("tabindex")).toBe("-1");
    click(root.querySelector<HTMLButtonElement>('button[aria-label="Toggle navigation menu"]')!);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("passes Reconnect for an account that needs it", async () => {
    const stale = makeAccount({ id: "work", label: "Work Claude", authRequired: true, lastError: "Sign in again." });
    api.getWeeklyActivity.mockResolvedValue(makeActivity([makeTracker({ accountId: "work" })]));
    const onReconnect = vi.fn();
    const { root } = renderView([stale], { onReconnect });
    await settle();
    click(select(root, ".activity-card-notice button")[0]);
    expect(onReconnect).toHaveBeenCalledWith(stale);
  });

  describe("pull to refresh", () => {
    function createTouchEvent(type: string, target: Element, clientX: number, clientY: number) {
      const touch = { clientX, clientY, identifier: 0, target };
      return new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" || type === "touchcancel" ? [] : [touch as unknown as Touch],
        targetTouches: type === "touchend" || type === "touchcancel" ? [] : [touch as unknown as Touch],
        changedTouches: [touch as unknown as Touch],
      });
    }

    it("triggers onRefresh when pulled down on mobile and reloads activity", async () => {
      Object.defineProperty(window, "innerWidth", { value: 400, writable: true, configurable: true });
      Object.defineProperty(window, "ontouchstart", { value: {}, writable: true, configurable: true });

      const onRefresh = vi.fn().mockResolvedValue(undefined);
      const { root } = renderView([work], { onRefresh });
      await settle();

      const container = root.querySelector(".content-scroll")!;
      act(() => {
        container.dispatchEvent(createTouchEvent("touchstart", container, 100, 100));
        window.dispatchEvent(createTouchEvent("touchmove", container, 100, 260));
      });

      const indicator = root.querySelector(".pull-to-refresh-indicator");
      expect(indicator).not.toBeNull();
      expect(indicator?.classList.contains("is-primed")).toBe(true);

      await act(async () => {
        window.dispatchEvent(createTouchEvent("touchend", container, 100, 260));
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it("does not enable pull-to-refresh when there are no accounts", async () => {
      Object.defineProperty(window, "innerWidth", { value: 400, writable: true, configurable: true });
      Object.defineProperty(window, "ontouchstart", { value: {}, writable: true, configurable: true });

      const onRefresh = vi.fn().mockResolvedValue(undefined);
      const { root } = renderView([], { onRefresh });
      await settle();

      const container = root.querySelector(".content-scroll")!;
      act(() => {
        container.dispatchEvent(createTouchEvent("touchstart", container, 100, 100));
        window.dispatchEvent(createTouchEvent("touchmove", container, 100, 260));
      });

      expect(root.querySelector(".pull-to-refresh-indicator")).toBeNull();
      expect(onRefresh).not.toHaveBeenCalled();
    });
  });
});
