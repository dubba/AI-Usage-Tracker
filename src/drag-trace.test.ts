import { beforeEach, describe, expect, it } from "vitest";
import { coord, describeTarget, formatDragTrace, resetDragTrace, trace, traceGestureStart } from "./drag-trace";

beforeEach(() => {
  resetDragTrace();
});

describe("drag trace", () => {
  it("says when nothing was recorded", () => {
    expect(formatDragTrace()).toBe("Drag trace: no drag recorded since the app started.");
  });

  it("groups lines by gesture, oldest first, with a time prefix", () => {
    traceGestureStart("down touch");
    trace("drag begin");
    traceGestureStart("down mouse");
    const text = formatDragTrace();
    expect(text).toContain("--- gesture 1 of 2 ---");
    expect(text).toContain("--- gesture 2 of 2 ---");
    expect(text.indexOf("down touch")).toBeLessThan(text.indexOf("down mouse"));
    expect(text).toMatch(/^\s+\d+ drag begin$/m);
  });

  it("keeps only the last ten gestures", () => {
    for (let index = 1; index <= 11; index += 1) traceGestureStart(`gesture #${index}#`);
    const text = formatDragTrace();
    expect(text).not.toContain("gesture #1#");
    expect(text).toContain("gesture #2#");
    expect(text).toContain("gesture #11#");
    expect(text).toContain("of 10 ---");
  });

  it("caps a long gesture but keeps its start and end", () => {
    traceGestureStart("start line");
    for (let index = 0; index < 400; index += 1) trace(`line ${index}`);
    const text = formatDragTrace();
    expect(text).toContain("start line");
    expect(text).toContain("line 399");
    expect(text).toMatch(/middle lines dropped/);
    expect(text.split("\n").length).toBeLessThan(170);
  });

  it("records lines even before a gesture starts", () => {
    trace("app snapshot loaded");
    expect(formatDragTrace()).toContain("app snapshot loaded");
  });

  it("rounds coordinates and marks missing ones", () => {
    expect(coord(12.6)).toBe("13");
    expect(coord(undefined)).toBe("?");
    expect(coord(Number.NaN)).toBe("?");
  });

  it("describes a missing target without touching the DOM", () => {
    expect(describeTarget(null)).toBe("none");
  });
});
