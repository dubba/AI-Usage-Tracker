import { useEffect, useEffectEvent, useRef, useState } from "react";
import { bridgeApi } from "../lib/api";
import { logIgnored } from "../lib/log";
import { abandonLoginAttempt, retryLoginAttempt, subscribeLoginStatus, watchLoginAttempt } from "../lib/login-status";
import type { LoginStatus } from "../../types";

/** A status for a sign-in that has started and is waiting on the provider. */
export function waitingStatus(
  attemptId: string,
  message: string | null,
  extra: Partial<Pick<LoginStatus, "projects" | "selectedProjectId">> = {},
): LoginStatus {
  return {
    attemptId,
    status: "waiting",
    message,
    account: null,
    projects: extra.projects ?? null,
    selectedProjectId: extra.selectedProjectId ?? null,
  };
}

/**
 * The part of a sign-in dialog that follows one login attempt at the backend:
 *
 * - which attempt the dialog is tracking, and its latest status (updates for any other attempt,
 *   or after the dialog closed, are ignored);
 * - `adopt` an attempt that has just started (or cancel it, if the dialog was closed while it was
 *   starting), `retry` it after a lost connection, and `abandon` it when the dialog closes.
 *
 * `active` is whether the dialog is open. `onStatus` handles each status of the tracked attempt
 * after it is stored (finish, show a failure, offer project choices); the latest `onStatus` is
 * always the one called.
 */
export function useLoginAttempt({ active, onStatus }: { active: boolean; onStatus: (next: LoginStatus) => void }) {
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const attemptIdRef = useRef<string | null>(null);
  const closeRequestedRef = useRef(false);
  const handleStatus = useEffectEvent(onStatus);

  useEffect(() => {
    closeRequestedRef.current = !active;
    if (!active) {
      attemptIdRef.current = null;
      setStatus(null);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    return subscribeLoginStatus((next) => {
      if (closeRequestedRef.current) return;
      if (attemptIdRef.current !== next.attemptId) return;
      setStatus(next);
      handleStatus(next);
    });
  }, [active]);

  /**
   * Starts following `attemptId`, showing `waiting` until the backend reports. Returns false,
   * after cancelling the attempt, when the dialog was closed while the attempt was starting.
   */
  const adopt = async (attemptId: string, waiting: LoginStatus): Promise<boolean> => {
    if (closeRequestedRef.current) {
      await bridgeApi.cancelLogin(attemptId).catch((cause) => logIgnored("login.cancel", cause));
      return false;
    }
    attemptIdRef.current = attemptId;
    setStatus(waiting);
    watchLoginAttempt(attemptId);
    return true;
  };

  /**
   * Resumes watching the tracked attempt after a lost connection, showing `waiting(attemptId)`.
   * False when there is nothing to resume, so the caller starts a new attempt.
   */
  const retry = (waiting: (attemptId: string) => LoginStatus): boolean => {
    const attemptId = status?.attemptId ?? attemptIdRef.current;
    if (!attemptId || !retryLoginAttempt(attemptId)) return false;
    setStatus(waiting(attemptId));
    return true;
  };

  /** The dialog is closing: stop following the attempt and cancel it at the backend. */
  const abandon = () => {
    closeRequestedRef.current = true;
    const attemptId = status?.attemptId ?? attemptIdRef.current;
    setStatus(null);
    attemptIdRef.current = null;
    if (attemptId) abandonLoginAttempt(attemptId);
  };

  return { status, setStatus, attemptIdRef, closeRequestedRef, adopt, retry, abandon };
}
