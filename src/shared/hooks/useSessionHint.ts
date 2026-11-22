import { useCallback, useEffect, useState } from "react";
import { hintStorageKeys, storageGet, storageSet, type HintKind, type HintPage } from "../lib/storage";

/** A hint shows in at most this many app sessions (opens of its page in a new session). */
export const MAX_HINT_SESSIONS = 2;

const sessionFlag = (key: string) => storageGet(key, "session") === "1";

function openCount(kind: HintKind, page: HintPage): number {
  return parseInt(storageGet(hintStorageKeys(kind, page).openCount) ?? "0", 10) || 0;
}

/**
 * Whether the hint should be offered: what it teaches is possible (`available`), the user has not
 * done it on this page yet, it was not dismissed in this session, and this session is within the
 * first `MAX_HINT_SESSIONS`. A pure read of storage; `countHintSession` records the session.
 */
export function isHintEligible(kind: HintKind, page: HintPage, available: boolean, completed: boolean): boolean {
  if (!available || completed) return false;
  const keys = hintStorageKeys(kind, page);
  if (sessionFlag(keys.sessionDismissed)) return false;
  // A session not counted yet will count as one more when it is.
  const count = openCount(kind, page);
  return (sessionFlag(keys.sessionCounted) ? count : count + 1) <= MAX_HINT_SESSIONS;
}

/** Counts this session towards the total, once, if the hint was offered in it. */
export function countHintSession(kind: HintKind, page: HintPage): void {
  const keys = hintStorageKeys(kind, page);
  if (sessionFlag(keys.sessionCounted) || sessionFlag(keys.sessionDismissed)) return;
  storageSet(keys.openCount, String(openCount(kind, page) + 1));
  storageSet(keys.sessionCounted, "1", "session");
}

/**
 * An onboarding hint of one page: shown in the first couple of sessions while `available`, hidden
 * for the session once dismissed, and never again once `complete` is called (the user did what it
 * teaches).
 */
export function useSessionHint(kind: HintKind, page: HintPage, available: boolean) {
  const keys = hintStorageKeys(kind, page);
  const [completed, setCompleted] = useState(() => storageGet(keys.seen) === "1");
  const [sessionDismissed, setSessionDismissed] = useState(() => sessionFlag(keys.sessionDismissed));

  const show = isHintEligible(kind, page, available, completed) && !sessionDismissed;

  // The count is written here, not while rendering: a render must not change storage.
  useEffect(() => {
    if (available && !completed) countHintSession(kind, page);
  }, [available, completed, kind, page]);

  const dismiss = useCallback(() => {
    storageSet(keys.sessionDismissed, "1", "session");
    setSessionDismissed(true);
  }, [keys.sessionDismissed]);

  const complete = useCallback(() => {
    storageSet(keys.seen, "1");
    setCompleted(true);
  }, [keys.seen]);

  return { show, dismiss, complete };
}
