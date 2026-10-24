import { useCallback, useEffect, useState } from "react";
import { bridgeApi } from "../../shared/lib/api";
import { errorMessage } from "../../shared/lib/errors";
import { useLatestRequest } from "../../shared/hooks/useLatestRequest";
import { useOnAppResume } from "../../shared/hooks/useOnAppResume";
import type { WeeklyActivity } from "../../types";
import { dayStartInstants, dayStartsFor } from "./day-boundaries";

/** What the backend answered, with the days it was asked about. */
export interface ActivityData {
  /** How many days the request covered. */
  dayCount: number;
  /** The `dayCount + 1` local midnights the request used, which label the answer. */
  dayStarts: Date[];
  activity: WeeklyActivity;
}

/**
 * Loads the weekly activity of the last `dayCount` days. It loads again when `dayCount` changes,
 * when `refreshKey` changes (the dashboard got new usage from a refresh) and when the app comes
 * back to the front, and the newest answer wins however slowly an older request finishes.
 *
 * `data` is the answer for the current `dayCount` only; the previous period's answer is not shown
 * while the new one loads, but an answer for the same period stays on screen while it is refreshed.
 */
export function useWeeklyActivity({
  dayCount,
  refreshKey,
  enabled,
}: {
  dayCount: number;
  refreshKey: string;
  enabled: boolean;
}) {
  const [answer, setAnswer] = useState<ActivityData | null>(null);
  const [failure, setFailure] = useState<{ dayCount: number; message: string } | null>(null);
  const request = useLatestRequest();

  const load = useCallback(async () => {
    if (!enabled) return;
    const ticket = request.begin();
    const dayStarts = dayStartsFor(dayCount);
    try {
      const activity = await bridgeApi.getWeeklyActivity(dayStartInstants(dayStarts));
      if (!request.isLatest(ticket)) return;
      setAnswer({ dayCount, dayStarts, activity });
      setFailure(null);
    } catch (cause) {
      if (!request.isLatest(ticket)) return;
      setFailure({ dayCount, message: errorMessage(cause) });
    }
  }, [dayCount, enabled, request]);

  useEffect(() => {
    void load();
    // `refreshKey` is not read in `load`: a new key is the reason to load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  useOnAppResume(() => void load());

  // Leaving the page makes an answer still on its way stale.
  useEffect(() => () => request.cancel(), [request]);

  const data = answer && answer.dayCount === dayCount ? answer : null;
  const error = failure && failure.dayCount === dayCount ? failure.message : null;
  return { data, error, reload: load };
}
