import { describe, expect, it } from "vitest";
import { hideInline, isHiddenInline, readInlineDisplay, restoreInlineDisplay } from "./reorder-source";

/**
 * Stands in for an element under the packaged app's Content-Security-Policy:
 * `element.style` works, but writing the `style` attribute does not change the
 * live styles. Any attribute access fails the test.
 */
function fakeElement(initial: Record<string, [string, string]> = {}) {
  const declarations = new Map(Object.entries(initial));
  return {
    style: {
      getPropertyValue: (name: string) => declarations.get(name)?.[0] ?? "",
      getPropertyPriority: (name: string) => declarations.get(name)?.[1] ?? "",
      setProperty: (name: string, value: string | null, priority = "") => {
        declarations.set(name, [value ?? "", priority ?? ""]);
      },
      removeProperty: (name: string) => {
        const previous = declarations.get(name)?.[0] ?? "";
        declarations.delete(name);
        return previous;
      },
    },
    getAttribute: () => {
      throw new Error("the style attribute must not be read");
    },
    setAttribute: () => {
      throw new Error("the style attribute must not be written");
    },
    removeAttribute: () => {
      throw new Error("the style attribute must not be removed");
    },
    declarations,
  };
}

describe("dragged card visibility", () => {
  it("hides and restores a card with no inline styles", () => {
    const card = fakeElement();
    const saved = readInlineDisplay(card);
    hideInline(card);
    expect(isHiddenInline(card)).toBe(true);
    restoreInlineDisplay(card, saved);
    expect(isHiddenInline(card)).toBe(false);
    expect(card.declarations.has("display")).toBe(false);
  });

  it("restores the same card correctly on a second and third drag", () => {
    const card = fakeElement();
    for (let drag = 0; drag < 3; drag += 1) {
      const saved = readInlineDisplay(card);
      hideInline(card);
      restoreInlineDisplay(card, saved);
      expect(isHiddenInline(card)).toBe(false);
    }
  });

  it("keeps an inline display the card already had, with its priority", () => {
    const card = fakeElement({ display: ["grid", "important"] });
    const saved = readInlineDisplay(card);
    hideInline(card);
    restoreInlineDisplay(card, saved);
    expect(card.declarations.get("display")).toEqual(["grid", "important"]);
  });

  it("leaves other inline styles alone", () => {
    const card = fakeElement({ height: ["40px", ""] });
    const saved = readInlineDisplay(card);
    hideInline(card);
    restoreInlineDisplay(card, saved);
    expect(card.declarations.get("height")).toEqual(["40px", ""]);
  });

  it("un-hides a card that an earlier drag left hidden", () => {
    const card = fakeElement({ display: ["none", "important"] });
    const saved = readInlineDisplay(card);
    hideInline(card);
    restoreInlineDisplay(card, saved);
    expect(isHiddenInline(card)).toBe(false);
  });
});
