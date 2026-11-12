import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS, storageGet, storageSet } from "../../shared/lib/storage";
import { onReorderDone } from "../../shared/lib/events";

/** The reorder hint shows in at most this many app sessions (opens of the dashboard in a new session). */
export const MAX_REORDER_HINT_OPENS = 2;

export type ReorderHintPage = "accounts" | "activity";

interface HintKeys {
  seen: string;
  openCount: string;
  sessionCounted: string;
  sessionDismissed: string;
}

function keysForPage(page: ReorderHintPage): HintKeys {
  if (page === "activity") {
    return {
      seen: STORAGE_KEYS.activityReorderHintSeen,
      openCount: STORAGE_KEYS.activityReorderHintOpenCount,
      sessionCounted: STORAGE_KEYS.activityReorderHintSessionCounted,
      sessionDismissed: STORAGE_KEYS.activityReorderHintSessionDismissed,
    };
  }
  return {
    seen: STORAGE_KEYS.reorderHintSeen,
    openCount: STORAGE_KEYS.reorderHintOpenCount,
    sessionCounted: STORAGE_KEYS.reorderHintSessionCounted,
    sessionDismissed: STORAGE_KEYS.reorderHintSessionDismissed,
  };
}

function openCount(keys: HintKeys): number {
  return parseInt(storageGet(keys.openCount) ?? "0", 10) || 0;
}

const sessionFlag = (key: string) => storageGet(key, "session") === "1";

/**
 * Whether the hint should be offered: more than one card can be moved, the user has not moved
 * one yet, it was not dismissed in this session, and this session is within the first few. A
 * pure read of storage; `countReorderHintSession` records the session.
 */
export function isReorderHintEligible(
  canReorder: boolean,
  reorderCompleted: boolean,
  page: ReorderHintPage = "accounts",
): boolean {
  if (!canReorder || reorderCompleted) return false;
  const keys = keysForPage(page);
  if (sessionFlag(keys.sessionDismissed)) return false;
  // A session not counted yet will count as one more when it is.
  return (sessionFlag(keys.sessionCounted) ? openCount(keys) : openCount(keys) + 1) <= MAX_REORDER_HINT_OPENS;
}

/** Counts this session towards the total, once, if the hint was offered in it. */
export function countReorderHintSession(page: ReorderHintPage = "accounts"): void {
  const keys = keysForPage(page);
  if (sessionFlag(keys.sessionCounted) || sessionFlag(keys.sessionDismissed)) return;
  storageSet(keys.openCount, String(openCount(keys) + 1));
  storageSet(keys.sessionCounted, "1", "session");
}

/**
 * The "you can drag or move cards" hint of the accounts or usage page: shown a couple of times,
 * until dismissed, and never again once the user reorders a card or a sidebar group while on this page.
 */
export function useReorderHint(canReorder: boolean, page: ReorderHintPage = "accounts") {
  const keys = keysForPage(page);
  const [completed, setCompleted] = useState(() => storageGet(keys.seen) === "1");
  const [sessionDismissed, setSessionDismissed] = useState(() => sessionFlag(keys.sessionDismissed));

  const eligible = isReorderHintEligible(canReorder, completed, page);
  const showReorderHint = eligible && !sessionDismissed;

  // The count is written here, not while rendering: a render must not change storage.
  useEffect(() => {
    if (canReorder && !completed) countReorderHintSession(page);
  }, [canReorder, completed, page]);

  const dismissReorderHint = useCallback(() => {
    storageSet(keys.sessionDismissed, "1", "session");
    setSessionDismissed(true);
  }, [keys.sessionDismissed]);

  const completeReorderHint = useCallback(() => {
    storageSet(keys.seen, "1");
    setCompleted(true);
  }, [keys.seen]);

  // Done for good once the user reorders while on this page (a card, or a sidebar group). A reorder
  // on another page, Settings included, leaves this page's hint alone, so each page teaches
  // dragging on its own.
  useEffect(() => {
    if (!showReorderHint) return;
    return onReorderDone((reorderedOn) => {
      if (reorderedOn === page) completeReorderHint();
    });
  }, [showReorderHint, completeReorderHint, page]);

  return { showReorderHint, dismissReorderHint, completeReorderHint };
}
