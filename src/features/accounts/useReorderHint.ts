import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS, storageGet, storageSet } from "../../shared/lib/storage";
import { subscribeLayout } from "../dashboard/layout-store";

/** The reorder hint shows in at most this many app sessions (opens of the dashboard in a new session). */
export const MAX_REORDER_HINT_OPENS = 2;

function openCount(): number {
  return parseInt(storageGet(STORAGE_KEYS.reorderHintOpenCount) ?? "0", 10) || 0;
}

const sessionFlag = (key: (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]) => storageGet(key, "session") === "1";

/**
 * Whether the hint should be offered: more than one card can be moved, the user has not moved
 * one yet, it was not dismissed in this session, and this session is within the first few. A
 * pure read of storage; `countReorderHintSession` records the session.
 */
export function isReorderHintEligible(canReorder: boolean, reorderCompleted: boolean): boolean {
  if (!canReorder || reorderCompleted) return false;
  if (sessionFlag(STORAGE_KEYS.reorderHintSessionDismissed)) return false;
  // A session not counted yet will count as one more when it is.
  return (sessionFlag(STORAGE_KEYS.reorderHintSessionCounted) ? openCount() : openCount() + 1) <= MAX_REORDER_HINT_OPENS;
}

/** Counts this session towards the total, once, if the hint was offered in it. */
export function countReorderHintSession(): void {
  if (sessionFlag(STORAGE_KEYS.reorderHintSessionCounted) || sessionFlag(STORAGE_KEYS.reorderHintSessionDismissed)) return;
  storageSet(STORAGE_KEYS.reorderHintOpenCount, String(openCount() + 1));
  storageSet(STORAGE_KEYS.reorderHintSessionCounted, "1", "session");
}

/**
 * The "you can drag or move cards" hint of the accounts page: shown a couple of times, until
 * dismissed, and never again once the user reorders a card or a sidebar group.
 */
export function useReorderHint(canReorder: boolean) {
  const [completed, setCompleted] = useState(() => storageGet(STORAGE_KEYS.reorderHintSeen) === "1");
  const [sessionDismissed, setSessionDismissed] = useState(() => sessionFlag(STORAGE_KEYS.reorderHintSessionDismissed));

  const eligible = isReorderHintEligible(canReorder, completed);
  const showReorderHint = eligible && !sessionDismissed;

  // The count is written here, not while rendering: a render must not change storage.
  useEffect(() => {
    if (canReorder && !completed) countReorderHintSession();
  }, [canReorder, completed]);

  const dismissReorderHint = useCallback(() => {
    storageSet(STORAGE_KEYS.reorderHintSessionDismissed, "1", "session");
    setSessionDismissed(true);
  }, []);

  const completeReorderHint = useCallback(() => {
    storageSet(STORAGE_KEYS.reorderHintSeen, "1");
    setCompleted(true);
  }, []);

  // Done for good once the user reorders a card or a group (any saved change of the layout).
  useEffect(() => {
    if (!showReorderHint) return;
    return subscribeLayout(completeReorderHint);
  }, [showReorderHint, completeReorderHint]);

  return { showReorderHint, dismissReorderHint, completeReorderHint };
}
