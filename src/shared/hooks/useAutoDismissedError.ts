import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/** Dialog error banners hide on their own after this many milliseconds. */
export const ERROR_AUTO_DISMISS_MS = 6000;

/**
 * Error text for a dialog: it disappears after {@link ERROR_AUTO_DISMISS_MS},
 * when `resetKey` changes (a different step or a closed dialog), and when the
 * caller clears it. Setting the same message again does not restart the timer,
 * so a poll that re-publishes a failure cannot pin the banner open.
 */
export function useAutoDismissedError(resetKey?: unknown): {
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  clearError: () => void;
} {
  const [error, setErrorState] = useState<string | null>(null);
  const errorRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timeoutRef.current == null) return;
    clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  };

  const apply = useCallback((message: string | null) => {
    if (message === errorRef.current) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    errorRef.current = message;
    setErrorState(message);
    clearTimer();
    if (message == null) return;
    timeoutRef.current = setTimeout(() => {
      if (generationRef.current !== generation) return;
      errorRef.current = null;
      timeoutRef.current = null;
      setErrorState(null);
    }, ERROR_AUTO_DISMISS_MS);
  }, []);

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

  return { error, setError, clearError };
}
