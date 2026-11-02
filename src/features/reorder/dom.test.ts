// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountCards,
  arraysEqual,
  committedOrder,
  dragFromPointerTarget,
  groupRows,
  isInteractivePointerTarget,
  originalOrder,
  visibleAccountIds,
} from "./dom";
import type { ActiveDrag } from "./types";

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.body.firstElementChild as HTMLElement;
}

const card = (id: string, extra = "") =>
  `<div class="provider-account-card" data-account-id="${id}" data-reorder-provider="openai" data-reorder-enabled="true">${extra}</div>`;
const activityCard = (id: string, extra = "") =>
  `<article class="activity-card" data-account-id="${id}" data-reorder-provider="antigravity" data-reorder-enabled="true">${extra}</article>`;
const row = (id: string, extra = "") =>
  `<div class="provider-summary-row" data-group-id="${id}" data-reorder-provider="anthropic" data-reorder-enabled="true">${extra}</div>`;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("list queries", () => {
  it("reads account cards and their ids in document order, ignoring duplicates", () => {
    const list = html(`<div>${card("a")}${card("b")}${card("a")}</div>`);
    expect(accountCards(list)).toHaveLength(3);
    expect(visibleAccountIds(list)).toEqual(["a", "b"]);
  });

  it("reads activity cards in document order, ignoring duplicates", () => {
    const list = html(`<div>${activityCard("ag1")}${activityCard("ag1")}${activityCard("oa1")}</div>`);
    expect(accountCards(list)).toHaveLength(3);
    expect(visibleAccountIds(list)).toEqual(["ag1", "oa1"]);
  });

  it("only counts direct children, so nested cards are not reorderable", () => {
    const list = html(`<div>${card("a")}<div>${card("nested")}</div></div>`);
    expect(visibleAccountIds(list)).toEqual(["a"]);
  });

  it("leaves the all row out of the sidebar groups", () => {
    const list = html(`<div>${row("all")}${row("provider:openai")}<div class="provider-summary-row is-all-row" data-group-id="x"></div>${row("bucket:1")}</div>`);
    expect(groupRows(list).map((r) => r.dataset.groupId)).toEqual(["provider:openai", "bucket:1"]);
  });
});

describe("dragFromPointerTarget", () => {
  it("finds a sidebar group from anywhere inside its row", () => {
    html(`<div>${row("provider:openai", `<span id="inner">x</span>`)}</div>`);
    const drag = dragFromPointerTarget(document.getElementById("inner")!);
    expect(drag).toMatchObject({ kind: "group", groupId: "provider:openai" });
  });

  it("finds an account card and its provider", () => {
    html(`<div>${card("a1", `<p id="inner">x</p>`)}</div>`);
    expect(dragFromPointerTarget(document.getElementById("inner")!)).toMatchObject({
      kind: "account",
      accountId: "a1",
      provider: "openai",
    });
  });

  it("finds an activity card and its provider", () => {
    html(`<div>${activityCard("ag1", `<p id="inner">x</p>`)}</div>`);
    expect(dragFromPointerTarget(document.getElementById("inner")!)).toMatchObject({
      kind: "account",
      accountId: "ag1",
      provider: "antigravity",
    });
  });

  it("ignores cards that have reordering switched off", () => {
    html(`<div><div class="provider-account-card" data-account-id="a" data-reorder-provider="openai"><p id="inner"></p></div></div>`);
    expect(dragFromPointerTarget(document.getElementById("inner")!)).toBeNull();
  });

  it("does not start a drag from a text field inside a card", () => {
    html(`<div>${card("a", `<input id="field" />`)}</div>`);
    expect(dragFromPointerTarget(document.getElementById("field")!)).toBeNull();
  });

  it("does not drag a card whose provider is unknown", () => {
    html(`<div><div class="provider-account-card" data-account-id="a" data-reorder-provider="nope" data-reorder-enabled="true"><i id="i"></i></div></div>`);
    expect(dragFromPointerTarget(document.getElementById("i")!)).toBeNull();
  });
});

describe("isInteractivePointerTarget", () => {
  it("treats controls as interactive and plain text as not", () => {
    html(`<div><button id="b"><span id="s"></span></button><p id="p"></p><a id="a" href="#"></a></div>`);
    expect(isInteractivePointerTarget(document.getElementById("s")!)).toBe(true);
    expect(isInteractivePointerTarget(document.getElementById("a")!)).toBe(true);
    expect(isInteractivePointerTarget(document.getElementById("p")!)).toBe(false);
  });
});

describe("order helpers", () => {
  it("compares ordered lists", () => {
    expect(arraysEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(arraysEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(arraysEqual(["a"], ["a", "b"])).toBe(false);
  });

  it("reads the original and committed order for accounts and groups", () => {
    const list = html(`<div>${card("a")}${card("b")}${card("c")}</div>`);
    const accountDescriptor = { kind: "account", accountId: "a", provider: "openai", source: list.children[0] as HTMLElement } as const;
    expect(originalOrder(accountDescriptor, list)).toEqual(["a", "b", "c"]);
    list.appendChild(list.children[0]);
    expect(committedOrder({ descriptor: accountDescriptor, container: list } as unknown as ActiveDrag)).toEqual(["b", "c", "a"]);

    const groups = html(`<div>${row("provider:openai")}${row("provider:grok")}</div>`);
    const groupDescriptor = { kind: "group", groupId: "provider:openai", provider: "openai", source: groups.children[0] as HTMLElement } as const;
    expect(originalOrder(groupDescriptor, groups)).toEqual(["provider:openai", "provider:grok"]);
  });

  it("handles multi-tracker accounts in committed order", () => {
    // Accounts: ag1 (2 cards), oa1 (1 card), cl1 (1 card).
    // Initial order: ag1-tracker1, ag1-tracker2, oa1, cl1.
    // User drags ag1-tracker1 after oa1:
    // DOM becomes: ag1-tracker2, oa1, ag1-tracker1 (source), cl1.
    const list = html(`<div>${activityCard("ag1")}${card("oa1")}${activityCard("ag1")}${card("cl1")}</div>`);
    const draggedSource = list.children[2] as HTMLElement;
    const drag = {
      descriptor: { kind: "account", accountId: "ag1", provider: "antigravity", source: draggedSource },
      source: draggedSource,
      container: list,
    } as unknown as ActiveDrag;
    expect(committedOrder(drag)).toEqual(["oa1", "ag1", "cl1"]);
  });
});
