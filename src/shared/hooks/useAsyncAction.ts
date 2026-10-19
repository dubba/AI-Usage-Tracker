import { useCallback, useState } from "react";
import { describeError } from "../lib/errors";

export type AsyncActionOptions = {
  /** Stay busy after `fn` succeeds, e.g. a sign-in that now waits for the backend to report. */
  keepBusyOnSuccess?: boolean;
  /** Runs when `fn` throws, before the message is shown (e.g. to put the form back). */
  onError?: (cause: unknown) => void;
  /**
   * Asked when `fn` throws. When it answers false the failure no longer matters (the dialog was
   * closed meanwhile): nothing is shown and the busy flag is left as it is.
   */
  isCurrent?: () => boolean;
};

/**
 * The busy flag and error text of one action in a dialog or hook. `run` clears the error, marks
 * busy, awaits `fn`, and on failure shows `describeError(source, context, cause)` (the friendly
 * message, with the raw detail kept for Copy Diagnostics) through `setError`. Which error state
 * that is stays the caller's choice, since dialogs differ in how it is dismissed.
 *
 * `run` resolves to whether `fn` succeeded; it never rejects.
 */
export function useAsyncAction({
  source,
  setError,
}: {
  source: string;
  setError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (fn: () => Promise<unknown>, context: string, options: AsyncActionOptions = {}): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        if (!options.keepBusyOnSuccess) setBusy(false);
        return true;
      } catch (cause) {
        if (options.isCurrent && !options.isCurrent()) return false;
        options.onError?.(cause);
        setBusy(false);
        setError(describeError(source, context, cause));
        return false;
      }
    },
    [source, setError],
  );

  return { busy, setBusy, run };
}
