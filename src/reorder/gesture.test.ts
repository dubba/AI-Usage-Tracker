// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const persisted = vi.hoisted(() => ({
  persistGroupOrder: vi.fn(async () => {}),
  persistVisibleAccountOrder: vi.fn(async () => {}),
}));
vi.mock("./persist", () => persisted);

import { DROP_COOLDOWN_MS, isReordering, resetReorderingForTests } from "./active";
import { installDashboardReorder } from "./gesture";

const CARD_HEIGHT = 100;

function setRect(element: Element, top: number, height = CARD_HEIGHT) {
  element.getBoundingClientRect = () =>
    ({ left: 0, top, width: 300, height, right: 300, bottom: top + height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** Cards a, b, c stacked 100px apart inside a scroll container; layout is static because happy-dom has none. */
function mountAccounts(): { cards: HTMLElement[]; list: HTMLElement } {
  document.body.innerHTML = `
    <div class="dashboard-scroll"><div class="list" data-group-id="all">
      ${["a", "b", "c"]
        .map((id) => `<div class="provider-account-card" data-account-id="${id}" data-reorder-provider="openai" data-reorder-enabled="true"><p>${id}</p></div>`)
        .join("")}
    </div></div>`;
  const list = document.querySelector<HTMLElement>(".list")!;
  const cards = Array.from(list.children) as HTMLElement[];
  cards.forEach((card, index) => setRect(card, index * CARD_HEIGHT));
  setRect(document.querySelector(".dashboard-scroll")!, 0, 1000);
  return { cards, list };
}

function mountGroups(): HTMLElement[] {
  document.body.innerHTML = `<div class="sidebar-list">
    ${["provider:openai", "provider:grok", "bucket:1"]
      .map((id) => `<div class="provider-summary-row" data-group-id="${id}" data-reorder-provider="openai" data-reorder-enabled="true"><span>${id}</span></div>`)
      .join("")}</div>`;
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".provider-summary-row"));
  rows.forEach((row, index) => setRect(row, index * 40, 40));
  setRect(document.querySelector(".sidebar-list")!, 0, 400);
  return rows;
}

function pointer(type: string, target: EventTarget, init: { x?: number; y?: number; pointerType?: string; buttons?: number } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    button: 0,
    buttons: init.buttons ?? (type === "pointerup" ? 0 : 1),
    isPrimary: true,
    pointerId: 1,
    pointerType: init.pointerType ?? "mouse",
    clientX: init.x ?? 10,
    clientY: init.y ?? 10,
  });
  target.dispatchEvent(event);
  return event;
}

function touch(type: string, target: EventTarget, points: Array<{ x: number; y: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { touches: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
  target.dispatchEvent(event);
}

const order = (list: HTMLElement) => Array.from(list.querySelectorAll<HTMLElement>(".provider-account-card")).map((c) => c.dataset.accountId);

let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetReorderingForTests();
  // happy-dom has no layout, animation or media-query engine.
  Element.prototype.getAnimations = () => [];
  window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  uninstall = installDashboardReorder();
});

afterEach(() => {
  // Let pending long-press timers fire, then end any drag a test left running, so module state
  // does not leak into the next test.
  vi.advanceTimersByTime(DROP_COOLDOWN_MS + 10);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  uninstall();
  vi.advanceTimersByTime(DROP_COOLDOWN_MS + 10);
  resetReorderingForTests();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});

describe("mouse drag of an account card", () => {
  it("drops the card where the pointer left it and reports the new order", () => {
    const { cards, list } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 10, y: 60 });
    expect(document.documentElement.classList.contains("dashboard-reordering")).toBe(true);
    expect(isReordering()).toBe(true);
    // Far below every card: the placeholder goes to the end of the list.
    pointer("pointermove", cards[0], { x: 10, y: 450 });
    pointer("pointerup", cards[0], { x: 10, y: 450 });

    expect(order(list)).toEqual(["b", "c", "a"]);
    expect(persisted.persistVisibleAccountOrder).toHaveBeenCalledWith(["b", "c", "a"], "all");
  });

  it("leaves no float, placeholder, or hidden card behind after a drop", () => {
    const { cards } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 10, y: 450 });
    pointer("pointerup", cards[0], { x: 10, y: 450 });

    expect(document.querySelector(".dashboard-reorder-float")).toBeNull();
    expect(document.querySelector(".dashboard-reorder-placeholder")).toBeNull();
    expect(document.documentElement.classList.contains("dashboard-reordering")).toBe(false);
    for (const card of cards) {
      expect(card.style.display).not.toBe("none");
      expect(card.classList.contains("is-reorder-origin")).toBe(false);
    }
  });

  it("does not start a drag for a movement below the threshold", () => {
    const { cards, list } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 12, y: 12 });
    pointer("pointerup", cards[0], { x: 12, y: 12 });
    expect(isReordering()).toBe(false);
    expect(order(list)).toEqual(["a", "b", "c"]);
    expect(persisted.persistVisibleAccountOrder).not.toHaveBeenCalled();
  });

  it("saves nothing when the card is dropped back where it started", () => {
    const { cards, list } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 10, y: 30 });
    pointer("pointerup", cards[0], { x: 10, y: 30 });
    expect(order(list)).toEqual(["a", "b", "c"]);
    expect(persisted.persistVisibleAccountOrder).not.toHaveBeenCalled();
  });

  it("puts the card back when Escape cancels the drag", () => {
    const { cards, list } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 10, y: 450 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(order(list)).toEqual(["a", "b", "c"]);
    expect(persisted.persistVisibleAccountOrder).not.toHaveBeenCalled();
    expect(cards[0].style.display).not.toBe("none");
    expect(document.querySelector(".dashboard-reorder-placeholder")).toBeNull();
  });

  it("drops the card where it is when the button was released outside the window", () => {
    const { cards, list } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 10, y: 450 });
    // Next move arrives with no button held: pointerup was never delivered.
    pointer("pointermove", cards[0], { x: 10, y: 460, buttons: 0 });
    expect(order(list)).toEqual(["b", "c", "a"]);
    expect(persisted.persistVisibleAccountOrder).toHaveBeenCalledWith(["b", "c", "a"], "all");
  });

  it("ignores presses on buttons inside a card until they move past the threshold", () => {
    const { cards } = mountAccounts();
    const button = document.createElement("button");
    cards[0].appendChild(button);
    pointer("pointerdown", button, { x: 10, y: 10 });
    pointer("pointermove", button, { x: 11, y: 11 });
    expect(isReordering()).toBe(false);
  });
});

describe("touch drag", () => {
  it("starts after a long press, follows the finger, and drops on release", () => {
    const { cards, list } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10, pointerType: "touch" });
    expect(isReordering()).toBe(false);
    vi.advanceTimersByTime(400);
    expect(isReordering()).toBe(true);

    touch("touchmove", cards[0], [{ x: 10, y: 450 }]);
    touch("touchend", cards[0], []);

    expect(order(list)).toEqual(["b", "c", "a"]);
    expect(persisted.persistVisibleAccountOrder).toHaveBeenCalledWith(["b", "c", "a"], "all");
  });

  it("cancels the long press when the finger moves first, so scrolling still works", () => {
    const { cards } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10, pointerType: "touch" });
    pointer("pointermove", cards[0], { x: 10, y: 60, pointerType: "touch" });
    vi.advanceTimersByTime(500);
    expect(isReordering()).toBe(false);
  });

  it("finishes a drag whose touch was cancelled and never moved again", () => {
    const { cards, list } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10, pointerType: "touch" });
    vi.advanceTimersByTime(400);
    touch("touchmove", cards[0], [{ x: 10, y: 450 }]);
    touch("touchcancel", cards[0], []);
    vi.advanceTimersByTime(2000);
    expect(order(list)).toEqual(["b", "c", "a"]);
    expect(persisted.persistVisibleAccountOrder).toHaveBeenCalledTimes(1);
  });
});

describe("recovering from a lost drag end", () => {
  it("finishes the previous drag when a new press arrives long after it started", () => {
    const { cards, list } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 10, y: 450 });
    vi.advanceTimersByTime(1000);
    // No pointerup ever came; the user presses again.
    pointer("pointerdown", cards[1], { x: 10, y: 110 });
    expect(order(list)).toEqual(["b", "c", "a"]);
    expect(persisted.persistVisibleAccountOrder).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".dashboard-reorder-float")).toBeNull();
  });
});

describe("after a drop", () => {
  it("swallows the click on the dropped card for a moment, then lets clicks through", () => {
    const { cards } = mountAccounts();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 10, y: 450 });
    pointer("pointerup", cards[0], { x: 10, y: 450 });

    const early = new MouseEvent("click", { bubbles: true, cancelable: true });
    cards[0].dispatchEvent(early);
    expect(early.defaultPrevented).toBe(true);

    vi.advanceTimersByTime(DROP_COOLDOWN_MS + 10);
    const late = new MouseEvent("click", { bubbles: true, cancelable: true });
    cards[0].dispatchEvent(late);
    expect(late.defaultPrevented).toBe(false);
    expect(isReordering()).toBe(false);
  });
});

describe("sidebar group drag", () => {
  it("reports the new group order", () => {
    const rows = mountGroups();
    pointer("pointerdown", rows[0], { x: 10, y: 10 });
    pointer("pointermove", rows[0], { x: 10, y: 60 });
    pointer("pointermove", rows[0], { x: 10, y: 500 });
    pointer("pointerup", rows[0], { x: 10, y: 500 });

    expect(persisted.persistGroupOrder).toHaveBeenCalledWith(["provider:grok", "bucket:1", "provider:openai"]);
    expect(persisted.persistVisibleAccountOrder).not.toHaveBeenCalled();
  });
});

describe("uninstalling", () => {
  it("stops reacting to pointer events", () => {
    const { cards } = mountAccounts();
    uninstall();
    pointer("pointerdown", cards[0], { x: 10, y: 10 });
    pointer("pointermove", cards[0], { x: 10, y: 450 });
    expect(isReordering()).toBe(false);
    uninstall = installDashboardReorder();
  });
});
