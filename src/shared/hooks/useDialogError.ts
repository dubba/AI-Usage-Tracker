import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/**
 * Error text for a dialog: stays visible until the user dismisses it (its X
 * button or Escape), `resetKey` changes (a different step or a closed dialog),
 * or the caller clears it.
 */
export function useDialogError(resetKey?: unknown): {
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  clearError: () => void;
} {
  const [error, setErrorState] = useState<string | null>(null);
  const errorRef = useRef<string | null>(null);

  const apply = useCallback((message: string | null) => {
    if (message === errorRef.current) return;
    errorRef.current = message;
    setErrorState(message);
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
  }, [resetKey, apply]);

  return { error, setError, clearError };
}
