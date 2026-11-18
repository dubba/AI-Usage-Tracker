// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { STORAGE_KEYS, storageGet, storageSet } from "../../shared/lib/storage";
import {
  countPullRefreshHintSession,
  isPullRefreshHintEligible,
  MAX_PULL_REFRESH_HINT_OPENS,
  usePullRefreshHint,
} from "./usePullRefreshHint";

let latest: ReturnType<typeof usePullRefreshHint>;
let latestActivity: ReturnType<typeof usePullRefreshHint>;

function capture(value: ReturnType<typeof usePullRefreshHint>) {
  latest = value;
}

function captureActivity(value: ReturnType<typeof usePullRefreshHint>) {
  latestActivity = value;
}

function Probe({ canPullRefresh, page }: { canPullRefresh: boolean; page?: "accounts" | "activity" }) {
  capture(usePullRefreshHint(canPullRefresh, page));
  return null;
}

function ActivityProbe({ canPullRefresh }: { canPullRefresh: boolean }) {
  captureActivity(usePullRefreshHint(canPullRefresh, "activity"));
  return null;
}

let mounted: Mounted | null = null;
const opens = () => storageGet(STORAGE_KEYS.pullRefreshHintOpenCount);
const activityOpens = () => storageGet(STORAGE_KEYS.activityPullRefreshHintOpenCount);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("isPullRefreshHintEligible", () => {
  it("is a pure read: asking never changes storage", () => {
    for (let i = 0; i < 3; i += 1) expect(isPullRefreshHintEligible(true, false)).toBe(true);
    expect(opens()).toBeNull();
    expect(storageGet(STORAGE_KEYS.pullRefreshHintSessionCounted, "session")).toBeNull();
  });

  it("requires pull-to-refresh to be usable and not completed yet", () => {
    expect(isPullRefreshHintEligible(false, false)).toBe(false);
    expect(isPullRefreshHintEligible(true, true)).toBe(false);
  });

  it("stops after MAX_PULL_REFRESH_HINT_OPENS sessions, counting the current one", () => {
    expect(MAX_PULL_REFRESH_HINT_OPENS).toBe(2);
    storageSet(STORAGE_KEYS.pullRefreshHintOpenCount, String(MAX_PULL_REFRESH_HINT_OPENS - 1));
    expect(isPullRefreshHintEligible(true, false)).toBe(true);
    storageSet(STORAGE_KEYS.pullRefreshHintOpenCount, String(MAX_PULL_REFRESH_HINT_OPENS));
    expect(isPullRefreshHintEligible(true, false)).toBe(false);
    storageSet(STORAGE_KEYS.pullRefreshHintSessionCounted, "1", "session");
    expect(isPullRefreshHintEligible(true, false)).toBe(true);
  });

  it("is off for the rest of the session once dismissed", () => {
    storageSet(STORAGE_KEYS.pullRefreshHintSessionDismissed, "1", "session");
    expect(isPullRefreshHintEligible(true, false)).toBe(false);
  });
});

describe("countPullRefreshHintSession", () => {
  it("counts a session once", () => {
    countPullRefreshHintSession();
    countPullRefreshHintSession();
    expect(opens()).toBe("1");
  });

  it("does not count a session in which the hint was dismissed", () => {
    storageSet(STORAGE_KEYS.pullRefreshHintSessionDismissed, "1", "session");
    countPullRefreshHintSession();
    expect(opens()).toBeNull();
  });
});

describe("usePullRefreshHint", () => {
  it("shows the hint when pull-to-refresh is usable, and counts the session after rendering", () => {
    mounted = mount(<Probe canPullRefresh />);
    expect(latest.showPullRefreshHint).toBe(true);
    expect(opens()).toBe("1");
    mounted.rerender(<Probe canPullRefresh />);
    expect(opens()).toBe("1");
  });

  it("does not show or count when pull-to-refresh is disabled or unavailable", () => {
    mounted = mount(<Probe canPullRefresh={false} />);
    expect(latest.showPullRefreshHint).toBe(false);
    expect(opens()).toBeNull();
    mounted.rerender(<Probe canPullRefresh />);
    expect(latest.showPullRefreshHint).toBe(true);
    expect(opens()).toBe("1");
  });

  it("stays hidden once it has been shown in 2 earlier sessions", () => {
    storageSet(STORAGE_KEYS.pullRefreshHintOpenCount, String(MAX_PULL_REFRESH_HINT_OPENS));
    mounted = mount(<Probe canPullRefresh />);
    expect(latest.showPullRefreshHint).toBe(false);
    expect(opens()).toBe(String(MAX_PULL_REFRESH_HINT_OPENS + 1));
  });

  it("can be dismissed for the session, which survives a remount", () => {
    mounted = mount(<Probe canPullRefresh />);
    act(() => latest.dismissPullRefreshHint());
    expect(latest.showPullRefreshHint).toBe(false);
    mounted.unmount();
    mounted = mount(<Probe canPullRefresh />);
    expect(latest.showPullRefreshHint).toBe(false);
  });

  it("permanently completes when pull-to-refresh is triggered", () => {
    mounted = mount(<Probe canPullRefresh />);
    act(() => latest.completePullRefreshHint());
    expect(latest.showPullRefreshHint).toBe(false);
    expect(storageGet(STORAGE_KEYS.pullRefreshHintSeen)).toBe("1");
    sessionStorage.clear();
    mounted.unmount();
    mounted = mount(<Probe canPullRefresh />);
    expect(latest.showPullRefreshHint).toBe(false);
  });

  it("operates independently on dashboard and usage pages", () => {
    storageSet(STORAGE_KEYS.pullRefreshHintOpenCount, String(MAX_PULL_REFRESH_HINT_OPENS));
    mounted = mount(<><Probe canPullRefresh page="accounts" /><ActivityProbe canPullRefresh /></>);
    expect(latest.showPullRefreshHint).toBe(false);
    expect(latestActivity.showPullRefreshHint).toBe(true);
    expect(activityOpens()).toBe("1");

    act(() => latestActivity.dismissPullRefreshHint());
    expect(latestActivity.showPullRefreshHint).toBe(false);
    expect(storageGet(STORAGE_KEYS.activityPullRefreshHintSessionDismissed, "session")).toBe("1");
    expect(storageGet(STORAGE_KEYS.pullRefreshHintSessionDismissed, "session")).toBeNull();
  });
});
