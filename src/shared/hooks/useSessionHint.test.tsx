// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { hintStorageKeys, storageGet, storageSet, type HintKind, type HintPage } from "../lib/storage";
import { countHintSession, isHintEligible, MAX_HINT_SESSIONS, useSessionHint } from "./useSessionHint";

let mounted: Mounted | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe.each<HintKind>(["reorder", "pull-refresh"])("the %s hint", (kind) => {
  const keys = hintStorageKeys(kind, "accounts");
  const activityKeys = hintStorageKeys(kind, "activity");
  const opens = () => storageGet(keys.openCount);

  let latest: ReturnType<typeof useSessionHint>;
  let latestActivity: ReturnType<typeof useSessionHint>;
  function capture(page: HintPage, hint: ReturnType<typeof useSessionHint>) {
    if (page === "activity") latestActivity = hint;
    else latest = hint;
  }
  function Probe({ available, page = "accounts" }: { available: boolean; page?: HintPage }) {
    capture(page, useSessionHint(kind, page, available));
    return null;
  }

  describe("isHintEligible", () => {
    it("is a pure read: asking never changes storage", () => {
      for (let i = 0; i < 3; i += 1) expect(isHintEligible(kind, "accounts", true, false)).toBe(true);
      expect(opens()).toBeNull();
      expect(storageGet(keys.sessionCounted, "session")).toBeNull();
    });

    it("needs the gesture to be possible and not done yet", () => {
      expect(isHintEligible(kind, "accounts", false, false)).toBe(false);
      expect(isHintEligible(kind, "accounts", true, true)).toBe(false);
    });

    it("stops after the first two sessions, counting the current one", () => {
      expect(MAX_HINT_SESSIONS).toBe(2);
      storageSet(keys.openCount, String(MAX_HINT_SESSIONS - 1));
      expect(isHintEligible(kind, "accounts", true, false)).toBe(true); // this session would be the last allowed
      storageSet(keys.openCount, String(MAX_HINT_SESSIONS));
      expect(isHintEligible(kind, "accounts", true, false)).toBe(false);
      // Once this session is counted, it stays eligible for the rest of the session.
      storageSet(keys.sessionCounted, "1", "session");
      expect(isHintEligible(kind, "accounts", true, false)).toBe(true);
    });

    it("is off for the rest of the session once dismissed", () => {
      storageSet(keys.sessionDismissed, "1", "session");
      expect(isHintEligible(kind, "accounts", true, false)).toBe(false);
    });
  });

  describe("countHintSession", () => {
    it("counts a session once", () => {
      countHintSession(kind, "accounts");
      countHintSession(kind, "accounts");
      expect(opens()).toBe("1");
    });

    it("does not count a session in which the hint was dismissed", () => {
      storageSet(keys.sessionDismissed, "1", "session");
      countHintSession(kind, "accounts");
      expect(opens()).toBeNull();
    });
  });

  describe("useSessionHint", () => {
    it("shows the hint when available, and counts the session after rendering", () => {
      mounted = mount(<Probe available />);
      expect(latest.show).toBe(true);
      expect(opens()).toBe("1");
      mounted.rerender(<Probe available />);
      expect(opens()).toBe("1");
    });

    it("does not show, or count, while unavailable", () => {
      mounted = mount(<Probe available={false} />);
      expect(latest.show).toBe(false);
      expect(opens()).toBeNull();
      mounted.rerender(<Probe available />);
      expect(latest.show).toBe(true);
      expect(opens()).toBe("1");
    });

    it("stays hidden once it has been shown in enough earlier sessions", () => {
      storageSet(keys.openCount, String(MAX_HINT_SESSIONS));
      mounted = mount(<Probe available />);
      expect(latest.show).toBe(false);
      expect(opens()).toBe(String(MAX_HINT_SESSIONS + 1));
    });

    it("can be dismissed for the session, which survives a remount", () => {
      mounted = mount(<Probe available />);
      act(() => latest.dismiss());
      expect(latest.show).toBe(false);
      mounted.unmount();
      mounted = mount(<Probe available />);
      expect(latest.show).toBe(false);
    });

    it("is done for good once completed", () => {
      mounted = mount(<Probe available />);
      act(() => latest.complete());
      expect(latest.show).toBe(false);
      expect(storageGet(keys.seen)).toBe("1");
      sessionStorage.clear();
      mounted.unmount();
      mounted = mount(<Probe available />);
      expect(latest.show).toBe(false);
    });

    it("counts and dismisses each page on its own", () => {
      storageSet(keys.openCount, String(MAX_HINT_SESSIONS));
      mounted = mount(<><Probe available page="accounts" /><Probe available page="activity" /></>);
      expect(latest.show).toBe(false);
      expect(latestActivity.show).toBe(true);
      expect(storageGet(activityKeys.openCount)).toBe("1");
      expect(opens()).toBe(String(MAX_HINT_SESSIONS + 1));

      act(() => latestActivity.dismiss());
      expect(latestActivity.show).toBe(false);
      expect(storageGet(activityKeys.sessionDismissed, "session")).toBe("1");
      expect(storageGet(keys.sessionDismissed, "session")).toBeNull();
    });
  });
});
