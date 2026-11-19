import type {
  Account,
  ActivityDay,
  ActivityTracker,
  UntrackedAccount,
  UsageWindow,
  WeeklyActivity,
} from "../types";

/** An account with live usage, for tests of the Usage page. */
export function makeAccount(overrides: Partial<Account> & { id: string }): Account {
  return {
    label: overrides.id,
    provider: "anthropic",
    email: null,
    providerAccountId: null,
    chatgptAccountId: null,
    plan: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastUsage: {
      plan: null,
      email: null,
      windows: [],
      creditsUsd: null,
      unlimitedCredits: false,
      fetchedAt: "2026-10-24T12:00:00Z",
      freshness: "live",
      source: "test",
      limitResets: [],
    },
    lastError: null,
    authRequired: false,
    health: "live",
    googleSetup: null,
    autoRefresh: true,
    headline: { fiveHour: [], long: [], longWindow: null },
    planDisplay: null,
    ...overrides,
  };
}

export function makeWindow(overrides: Partial<UsageWindow> & { id: string }): UsageWindow {
  return {
    label: "Weekly",
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    windowSeconds: 604_800,
    kind: "weekly",
    ...overrides,
  };
}

export const measured = (usedPercent: number): ActivityDay => ({ usedPercent, quality: "measured" });
export const estimated = (usedPercent: number): ActivityDay => ({ usedPercent, quality: "approximate" });
export const noData: ActivityDay = { usedPercent: null, quality: "none" };

/** A tracker with `dayCount` days, all of them `fill` unless `days` says otherwise. */
export function makeTracker(
  overrides: Partial<ActivityTracker> & { accountId: string },
  dayCount = 7,
  fill: ActivityDay = measured(5),
): ActivityTracker {
  return {
    windowId: "weekly",
    windowLabel: "Weekly",
    windowKind: "weekly",
    currentUsedPercent: 40,
    resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    days: Array.from({ length: dayCount }, () => fill),
    resets: [],
    resetUsedPercent: [],
    ...overrides,
  };
}

export function makeActivity(trackers: ActivityTracker[] = [], untracked: UntrackedAccount[] = []): WeeklyActivity {
  return { trackers, untracked };
}
