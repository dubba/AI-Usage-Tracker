import { useMemo, useRef } from "react";

/**
 * Tells the newest of several overlapping async requests from the ones it superseded, so a slow
 * old answer cannot overwrite what a newer request (or a change of view) has already settled.
 *
 *   const ticket = request.begin();
 *   const result = await somethingSlow();
 *   if (!request.isLatest(ticket)) return;   // another request began, or `cancel()` was called
 */
export function useLatestRequest() {
  const latest = useRef(0);
  return useMemo(
    () => ({
      /** Starts a request; every earlier one becomes stale. Returns this request's ticket. */
      begin: () => ++latest.current,
      /** Makes every request in flight stale without starting one (leaving the view, closing). */
      cancel: () => {
        latest.current += 1;
      },
      isLatest: (ticket: number) => ticket === latest.current,
    }),
    [],
  );
}
