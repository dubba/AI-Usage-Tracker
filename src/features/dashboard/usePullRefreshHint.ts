import { useCallback, useEffect, useState } from "react";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";
import { isMobileUserAgent } from "../../shared/lib/platform";
import { STORAGE_KEYS, storageGet, storageSet } from "../../shared/lib/storage";
import { MOBILE_OVERLAY_QUERY } from "../sidebar/sidebar-width";

/** The pull-to-refresh hint shows in at most this many app sessions (opens in a new session). */
export const MAX_PULL_REFRESH_HINT_OPENS = 2;

export type PullRefreshHintPage = "accounts" | "activity";

interface HintKeys {
  seen: string;
  openCount: string;
  sessionCounted: string;
  sessionDismissed: string;
}

function keysForPage(page: PullRefreshHintPage): HintKeys {
  if (page === "activity") {
    return {
      seen: STORAGE_KEYS.activityPullRefreshHintSeen,
      openCount: STORAGE_KEYS.activityPullRefreshHintOpenCount,
      sessionCounted: STORAGE_KEYS.activityPullRefreshHintSessionCounted,
      sessionDismissed: STORAGE_KEYS.activityPullRefreshHintSessionDismissed,
    };
  }
  return {
    seen: STORAGE_KEYS.pullRefreshHintSeen,
    openCount: STORAGE_KEYS.pullRefreshHintOpenCount,
    sessionCounted: STORAGE_KEYS.pullRefreshHintSessionCounted,
    sessionDismissed: STORAGE_KEYS.pullRefreshHintSessionDismissed,
  };
}

function openCount(keys: HintKeys): number {
  return parseInt(storageGet(keys.openCount) ?? "0", 10) || 0;
}

const sessionFlag = (key: string) => storageGet(key, "session") === "1";

/** True when the current viewport or device supports touch / pull-to-refresh (mirrors `usePullToRefresh`). */
export function useCanPullRefreshEnvironment(): boolean {
  const phone = useMediaQuery(MOBILE_OVERLAY_QUERY);
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const touchOrMobile =
    typeof window !== "undefined" &&
    (window.innerWidth <= 860 || "ontouchstart" in window || navigator.maxTouchPoints > 0 || isMobileUserAgent());
  return phone || coarsePointer || touchOrMobile;
}

/**
 * Whether the pull-to-refresh hint should be offered: pull-to-refresh is usable, the user has not
 * pulled to refresh on this page yet, it was not dismissed in this session, and this session is
 * within the first `MAX_PULL_REFRESH_HINT_OPENS`. A pure read of storage.
 */
export function isPullRefreshHintEligible(
  canPullRefresh: boolean,
  pullRefreshCompleted: boolean,
  page: PullRefreshHintPage = "accounts",
): boolean {
  if (!canPullRefresh || pullRefreshCompleted) return false;
  const keys = keysForPage(page);
  if (sessionFlag(keys.sessionDismissed)) return false;
  // A session not counted yet will count as one more when it is.
  return (sessionFlag(keys.sessionCounted) ? openCount(keys) : openCount(keys) + 1) <= MAX_PULL_REFRESH_HINT_OPENS;
}

/** Counts this session towards the total, once, if the hint was offered in it. */
export function countPullRefreshHintSession(page: PullRefreshHintPage = "accounts"): void {
  const keys = keysForPage(page);
  if (sessionFlag(keys.sessionCounted) || sessionFlag(keys.sessionDismissed)) return;
  storageSet(keys.openCount, String(openCount(keys) + 1));
  storageSet(keys.sessionCounted, "1", "session");
}

/**
 * The "pull down on the screen to refresh data" hint of the dashboard or usage page: shown for up
 * to two sessions, until dismissed, and never again once the user performs a pull-to-refresh here.
 */
export function usePullRefreshHint(canPullRefresh: boolean, page: PullRefreshHintPage = "accounts") {
  const keys = keysForPage(page);
  const [completed, setCompleted] = useState(() => storageGet(keys.seen) === "1");
  const [sessionDismissed, setSessionDismissed] = useState(() => sessionFlag(keys.sessionDismissed));

  const eligible = isPullRefreshHintEligible(canPullRefresh, completed, page);
  const showPullRefreshHint = eligible && !sessionDismissed;

  // The count is written here, not while rendering: a render must not change storage.
  useEffect(() => {
    if (canPullRefresh && !completed) countPullRefreshHintSession(page);
  }, [canPullRefresh, completed, page]);

  const dismissPullRefreshHint = useCallback(() => {
    storageSet(keys.sessionDismissed, "1", "session");
    setSessionDismissed(true);
  }, [keys.sessionDismissed]);

  const completePullRefreshHint = useCallback(() => {
    storageSet(keys.seen, "1");
    setCompleted(true);
  }, [keys.seen]);

  return { showPullRefreshHint, dismissPullRefreshHint, completePullRefreshHint };
}
