import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/** Dialog error banners hide on their own after this many milliseconds (or sooner from their X). */
export const ERROR_AUTO_DISMISS_MS = 10_000;

/**
 * Error text for a dialog: it disappears after {@link ERROR_AUTO_DISMISS_MS},
 * when `resetKey` changes (a different step or a closed dialog), and when the
 * caller clears it. Setting the same message again does not restart the timer,
 * so a poll that re-publishes a failure cannot pin the banner open.
 *
 * While `keepOpen` is true the error stays until it is cleared (its X, or the caller), for a
 * screen whose only content is that error; when it turns false a shown error gets a fresh timer.
 */
export function useAutoDismissedError(resetKey?: unknown, keepOpen = false): {
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  clearError: () => void;
} {
  const [error, setErrorState] = useState<string | null>(null);
  const errorRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepOpenRef = useRef(keepOpen);
  keepOpenRef.current = keepOpen;

  const clearTimer = () => {
    if (timeoutRef.current == null) return;
    clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  };

  const startTimer = useCallback(() => {
    clearTimer();
    const generation = generationRef.current;
    timeoutRef.current = setTimeout(() => {
      if (generationRef.current !== generation) return;
      errorRef.current = null;
      timeoutRef.current = null;
      setErrorState(null);
    }, ERROR_AUTO_DISMISS_MS);
  }, []);

  const apply = useCallback(
    (message: string | null) => {
      if (message === errorRef.current) return;
      generationRef.current += 1;
      errorRef.current = message;
      setErrorState(message);
      clearTimer();
      if (message != null && !keepOpenRef.current) startTimer();
    },
    [startTimer],
  );

  const setError = useCallback<Dispatch<SetStateAction<string | null>>>(
    (update) => {
      apply(typeof update === "function" ? update(errorRef.current) : update);
    },
    [apply],
  );

  const clearError = useCallback(() => apply(null), [apply]);

  useEffect(() => {
    apply(null);
    return clearTimer;
  }, [resetKey, apply]);

  useEffect(() => {
    if (keepOpen) clearTimer();
    else if (errorRef.current != null && timeoutRef.current == null) startTimer();
  }, [keepOpen, startTimer]);

  return { error, setError, clearError };
}
