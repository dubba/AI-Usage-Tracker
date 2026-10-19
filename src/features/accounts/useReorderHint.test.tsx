// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { UI_EVENTS } from "../../shared/lib/events";
import { STORAGE_KEYS, storageGet, storageSet } from "../../shared/lib/storage";
import { countReorderHintSession, isReorderHintEligible, MAX_REORDER_HINT_OPENS, useReorderHint } from "./useReorderHint";

let latest: ReturnType<typeof useReorderHint>;

function capture(value: ReturnType<typeof useReorderHint>) {
  latest = value;
}

function Probe({ canReorder }: { canReorder: boolean }) {
  capture(useReorderHint(canReorder));
  return null;
}

let mounted: Mounted | null = null;
const opens = () => storageGet(STORAGE_KEYS.reorderHintOpenCount);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("isReorderHintEligible", () => {
  it("is a pure read: asking never changes storage", () => {
    for (let i = 0; i < 3; i += 1) expect(isReorderHintEligible(true, false)).toBe(true);
    expect(opens()).toBeNull();
    expect(storageGet(STORAGE_KEYS.reorderHintSessionCounted, "session")).toBeNull();
  });

  it("needs a movable list and a user who has not reordered yet", () => {
    expect(isReorderHintEligible(false, false)).toBe(false);
    expect(isReorderHintEligible(true, true)).toBe(false);
  });

  it("stops after the first few sessions, counting the current one", () => {
    storageSet(STORAGE_KEYS.reorderHintOpenCount, String(MAX_REORDER_HINT_OPENS - 1));
    expect(isReorderHintEligible(true, false)).toBe(true); // this session would be the last allowed
    storageSet(STORAGE_KEYS.reorderHintOpenCount, String(MAX_REORDER_HINT_OPENS));
    expect(isReorderHintEligible(true, false)).toBe(false);
    // Once this session is counted, it stays eligible for the rest of the session.
    storageSet(STORAGE_KEYS.reorderHintSessionCounted, "1", "session");
    expect(isReorderHintEligible(true, false)).toBe(true);
  });

  it("is off for the rest of the session once dismissed", () => {
    storageSet(STORAGE_KEYS.reorderHintSessionDismissed, "1", "session");
    expect(isReorderHintEligible(true, false)).toBe(false);
  });
});

describe("countReorderHintSession", () => {
  it("counts a session once", () => {
    countReorderHintSession();
    countReorderHintSession();
    expect(opens()).toBe("1");
  });

  it("does not count a session in which the hint was dismissed", () => {
    storageSet(STORAGE_KEYS.reorderHintSessionDismissed, "1", "session");
    countReorderHintSession();
    expect(opens()).toBeNull();
  });
});

describe("useReorderHint", () => {
  it("shows the hint when cards can be moved, and counts the session after rendering", () => {
    mounted = mount(<Probe canReorder />);
    expect(latest.showReorderHint).toBe(true);
    expect(opens()).toBe("1");
    mounted.rerender(<Probe canReorder />);
    expect(opens()).toBe("1");
  });

  it("does not show, or count, with a single card", () => {
    mounted = mount(<Probe canReorder={false} />);
    expect(latest.showReorderHint).toBe(false);
    expect(opens()).toBeNull();
    mounted.rerender(<Probe canReorder />);
    expect(latest.showReorderHint).toBe(true);
    expect(opens()).toBe("1");
  });

  it("stays hidden once it has been shown in enough earlier sessions", () => {
    storageSet(STORAGE_KEYS.reorderHintOpenCount, String(MAX_REORDER_HINT_OPENS));
    mounted = mount(<Probe canReorder />);
    expect(latest.showReorderHint).toBe(false);
    expect(opens()).toBe(String(MAX_REORDER_HINT_OPENS + 1));
  });

  it("can be dismissed for the session, which survives a remount", () => {
    mounted = mount(<Probe canReorder />);
    act(() => latest.dismissReorderHint());
    expect(latest.showReorderHint).toBe(false);
    mounted.unmount();
    mounted = mount(<Probe canReorder />);
    expect(latest.showReorderHint).toBe(false);
  });

  it("is done for good after the user moves a card or a group", () => {
    mounted = mount(<Probe canReorder />);
    act(() => {
      window.dispatchEvent(new Event(UI_EVENTS.pageOrderChanged));
    });
    expect(latest.showReorderHint).toBe(false);
    expect(storageGet(STORAGE_KEYS.reorderHintSeen)).toBe("1");
    sessionStorage.clear();
    mounted.unmount();
    mounted = mount(<Probe canReorder />);
    expect(latest.showReorderHint).toBe(false);
  });

  it("also finishes when a sidebar group is moved, and completeReorderHint does the same", () => {
    mounted = mount(<Probe canReorder />);
    act(() => {
      window.dispatchEvent(new Event(UI_EVENTS.groupOrderChanged));
    });
    expect(latest.showReorderHint).toBe(false);
    localStorage.clear();
    sessionStorage.clear();
    mounted.unmount();
    mounted = mount(<Probe canReorder />);
    act(() => latest.completeReorderHint());
    expect(latest.showReorderHint).toBe(false);
  });
});
