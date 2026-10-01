import { describe, expect, it } from "vitest";
import { moveAnnouncement, moveById, reorderKeyDelta } from "./reorder-utils";

describe("moveById", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves an item up and down by one", () => {
    expect(moveById(ids, "c", -1)).toEqual({ ids: ["a", "c", "b", "d"], from: 2, to: 1 });
    expect(moveById(ids, "b", 1)).toEqual({ ids: ["a", "c", "b", "d"], from: 1, to: 2 });
  });

  it("returns null at the edges of the list", () => {
    expect(moveById(ids, "a", -1)).toBeNull();
    expect(moveById(ids, "d", 1)).toBeNull();
  });

  it("returns null for unknown ids and zero moves", () => {
    expect(moveById(ids, "zzz", 1)).toBeNull();
    expect(moveById(ids, "b", 0)).toBeNull();
  });

  it("does not mutate the input", () => {
    moveById(ids, "b", 1);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });
});

describe("moveAnnouncement", () => {
  it("uses one-based positions", () => {
    expect(moveAnnouncement("Work GPT", 0, 5)).toBe("Work GPT moved to position 1 of 5.");
  });
});

describe("reorderKeyDelta", () => {
  it("maps Alt+Arrow keys only", () => {
    expect(reorderKeyDelta({ key: "ArrowUp", altKey: true })).toBe(-1);
    expect(reorderKeyDelta({ key: "ArrowDown", altKey: true })).toBe(1);
    expect(reorderKeyDelta({ key: "ArrowUp", altKey: false })).toBeNull();
    expect(reorderKeyDelta({ key: "Enter", altKey: true })).toBeNull();
  });

  it("ignores combinations with other modifiers", () => {
    expect(reorderKeyDelta({ key: "ArrowUp", altKey: true, shiftKey: true })).toBeNull();
    expect(reorderKeyDelta({ key: "ArrowDown", altKey: true, metaKey: true })).toBeNull();
  });
});
