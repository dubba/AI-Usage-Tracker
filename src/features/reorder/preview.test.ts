// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reorderElements, updatePlaceholderFromPointer } from "./preview";
import type { ActiveDrag } from "./types";

// The sidebar lists provider rows under "Accounts" and custom groups under "Groups".
function buildList() {
  const container = document.createElement("div");
  container.className = "provider-list";
  const row = (id: string, bucket: boolean) => {
    const el = document.createElement("button");
    el.className = `provider-summary-row${bucket ? " is-bucket-row" : ""}`;
    el.dataset.groupId = id;
    el.dataset.reorderEnabled = "true";
    return el;
  };
  const header = (text: string) => {
    const el = document.createElement("div");
    el.className = "sidebar-section-header";
    el.textContent = text;
    return el;
  };
  const rows = {
    p1: row("provider:a", false),
    p2: row("provider:b", false),
    p3: row("provider:c", false),
    b1: row("bucket:1", true),
    b2: row("bucket:2", true),
  };
  container.append(header("Accounts"), rows.p1, rows.p2, rows.p3, header("Groups"), rows.b1, rows.b2);
  document.body.append(container);
  // happy-dom lays nothing out: give each row a 60px slot in document order, as the list would.
  Array.from(container.children).forEach((child, index) => {
    vi.spyOn(child, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 60, 300, 60));
  });
  return { container, rows };
}

function startDrag(container: HTMLElement, source: HTMLElement, pointerY: number): ActiveDrag {
  const placeholder = document.createElement("div");
  placeholder.className = "dashboard-reorder-placeholder";
  source.after(placeholder);
  return {
    descriptor: { kind: "group", groupId: source.dataset.groupId!, provider: "openai", source },
    container,
    source,
    placeholder,
    lastClientY: pointerY,
    floatGrabY: 0,
    floatHeight: 0,
  } as unknown as ActiveDrag;
}

const order = (container: HTMLElement) =>
  Array.from(container.children).map((child) => (child as HTMLElement).dataset.groupId ?? child.className);

beforeEach(() => {
  // Skip the move animation, which needs layout.
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
  window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sidebar row drags stay inside their section", () => {
  it("only offers rows of the same kind to swap with", () => {
    const { container, rows } = buildList();
    expect(reorderElements(startDrag(container, rows.p2, 0)).map((el) => el.dataset.groupId)).toEqual(["provider:a", "provider:c"]);
    expect(reorderElements(startDrag(container, rows.b1, 0)).map((el) => el.dataset.groupId)).toEqual(["bucket:2"]);
  });

  it("keeps a provider row's placeholder above the Groups header when dragged far below", () => {
    const { container, rows } = buildList();
    const drag = startDrag(container, rows.p1, 400);
    updatePlaceholderFromPointer(drag);
    // Directly after the last provider row, not among the groups.
    expect(order(container)).toEqual([
      "sidebar-section-header",
      "provider:a",
      "provider:b",
      "provider:c",
      "dashboard-reorder-placeholder",
      "sidebar-section-header",
      "bucket:1",
      "bucket:2",
    ]);
  });

  it("keeps a group row's placeholder below the Groups header when dragged far above", () => {
    const { container, rows } = buildList();
    const drag = startDrag(container, rows.b2, -100);
    updatePlaceholderFromPointer(drag);
    expect(order(container)).toEqual([
      "sidebar-section-header",
      "provider:a",
      "provider:b",
      "provider:c",
      "sidebar-section-header",
      "dashboard-reorder-placeholder",
      "bucket:1",
      "bucket:2",
    ]);
  });

  it("still reorders within a section", () => {
    const { container, rows } = buildList();
    // Slots are 60px (header 0-60, then one per row): the pointer is past the first provider row's
    // middle and above the second's, so the placeholder goes between them.
    const drag = startDrag(container, rows.p3, 121);
    updatePlaceholderFromPointer(drag);
    expect(order(container).slice(0, 5)).toEqual(["sidebar-section-header", "provider:a", "dashboard-reorder-placeholder", "provider:b", "provider:c"]);
  });
});

describe("2-column dashboard grid drag placement (L7)", () => {
  function buildGrid() {
    const container = document.createElement("section");
    container.className = "provider-account-cards is-compact";
    const card = (id: string) => {
      const el = document.createElement("article");
      el.className = "provider-account-card is-compact";
      el.dataset.accountId = id;
      el.dataset.reorderProvider = "anthropic";
      el.dataset.reorderEnabled = "true";
      return el;
    };
    const cards = {
      c1: card("a1"),
      c2: card("a2"),
      c3: card("a3"),
      c4: card("a4"),
    };
    container.append(cards.c1, cards.c2, cards.c3, cards.c4);
    document.body.append(container);
    // 2 columns (x=0..300 and x=320..620), 2 rows (y=0..80 and y=90..170)
    const rects: Record<string, DOMRect> = {
      a1: new DOMRect(0, 0, 300, 80),
      a2: new DOMRect(320, 0, 300, 80),
      a3: new DOMRect(0, 90, 300, 80),
      a4: new DOMRect(320, 90, 300, 80),
    };
    Object.values(cards).forEach((el) => {
      vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => rects[el.dataset.accountId!]);
    });
    return { container, cards };
  }

  function startCardDrag(container: HTMLElement, source: HTMLElement, pointerX: number, pointerY: number): ActiveDrag {
    const placeholder = document.createElement("div");
    placeholder.className = "dashboard-reorder-placeholder";
    source.after(placeholder);
    return {
      descriptor: { kind: "account", accountId: source.dataset.accountId!, provider: "anthropic", source },
      container,
      source,
      placeholder,
      lastClientX: pointerX,
      lastClientY: pointerY,
      floatGrabY: 0,
      floatHeight: 80,
    } as unknown as ActiveDrag;
  }

  const cardOrder = (container: HTMLElement) =>
    Array.from(container.children).map((el) => (el as HTMLElement).dataset.accountId ?? el.className);

  it("moves placeholder across columns in the same row using horizontal pointer coordinates", () => {
    const { container, cards } = buildGrid();
    // Dragging a1 into the left half of a2 (col 2, row 1) places placeholder before a2
    const drag = startCardDrag(container, cards.c1, 360, 40);
    updatePlaceholderFromPointer(drag);
    expect(cardOrder(container)).toEqual(["a1", "dashboard-reorder-placeholder", "a2", "a3", "a4"]);

    // Dragging into the right half of a2 (x > midX=470) places placeholder after a2
    drag.lastClientX = 560;
    drag.lastClientY = 40;
    updatePlaceholderFromPointer(drag);
    expect(cardOrder(container)).toEqual(["a1", "a2", "dashboard-reorder-placeholder", "a3", "a4"]);
  });

  it("moves placeholder into row 2 column 2 when dragged to the bottom-right card", () => {
    const { container, cards } = buildGrid();
    const drag = startCardDrag(container, cards.c1, 560, 130);
    updatePlaceholderFromPointer(drag);
    expect(cardOrder(container)).toEqual(["a1", "a2", "a3", "a4", "dashboard-reorder-placeholder"]);
  });
});
