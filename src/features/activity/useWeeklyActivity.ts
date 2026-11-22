import { useCallback, useEffect, useRef, useState } from "react";
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
 * Each period is remembered, so switching back shows that chart at once. A period that has not
 * arrived yet leaves the other one on screen instead of clearing it. A refresh of the period
 * already on screen also leaves that chart up. An error stays with the period it belongs to.
 */
export function useWeeklyActivity({
  dayCount,
  alsoLoad = [],
  refreshKey,
  enabled,
}: {
  dayCount: number;
  /** Other periods to fetch quietly after the shown one, so switching to them is instant. */
  alsoLoad?: readonly number[];
  refreshKey: string;
  enabled: boolean;
}) {
  const [byCount, setByCount] = useState<Partial<Record<number, ActivityData>>>({});
  const [failures, setFailures] = useState<Partial<Record<number, string>>>({});
  const request = useLatestRequest();
  // The newest request for each period. A slow 30-day report can still be stored after the view
  // has moved on to 7 days; a newer request for those same 30 days replaces it.
  const generation = useRef(new Map<number, number>());

  const load = useCallback(async () => {
    if (!enabled) return;
    const ticket = request.begin();
    generation.current.set(dayCount, ticket);
    const dayStarts = dayStartsFor(dayCount);
    try {
      const activity = await bridgeApi.getWeeklyActivity(dayStartInstants(dayStarts));
      if (generation.current.get(dayCount) !== ticket) return;
      setByCount((current) => ({ ...current, [dayCount]: { dayCount, dayStarts, activity } }));
      // A late answer for the other period must not clear an error the user is looking at.
      setFailures((current) => {
        if (current[dayCount] == null) return current;
        const next = { ...current };
        delete next[dayCount];
        return next;
      });
    } catch (cause) {
      if (generation.current.get(dayCount) !== ticket) return;
      setFailures((current) => ({ ...current, [dayCount]: errorMessage(cause) }));
    }
  }, [dayCount, enabled, request]);

  useEffect(() => {
    void load();
    // `refreshKey` is not read in `load`: a new key is the reason to load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  useOnAppResume(() => void load());

  // Fetches the other periods in the background, one after another and only once the shown one is
  // in, so the switch finds them ready. A failure here is ignored: tapping the period retries it.
  const shownLoaded = byCount[dayCount] != null;
  const alsoLoadKey = alsoLoad.join(",");
  useEffect(() => {
    if (!enabled || !shownLoaded) return;
    let cancelled = false;
    void (async () => {
      for (const count of alsoLoadKey ? alsoLoadKey.split(",").map(Number) : []) {
        if (count === dayCount) continue;
        try {
          const dayStarts = dayStartsFor(count);
          const activity = await bridgeApi.getWeeklyActivity(dayStartInstants(dayStarts));
          if (cancelled) return;
          setByCount((current) => ({ ...current, [count]: { dayCount: count, dayStarts, activity } }));
        } catch {
          if (cancelled) return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // A new `refreshKey` means fresh usage, so the other periods are fetched again too.
  }, [enabled, shownLoaded, dayCount, alsoLoadKey, refreshKey]);

  // Leaving the page makes an answer still on its way stale.
  useEffect(
    () => () => {
      generation.current.clear();
      request.cancel();
    },
    [request],
  );

  const requested = byCount[dayCount] ?? null;
  const data = requested ?? Object.values(byCount).find((item) => item != null) ?? null;
  const error = failures[dayCount] ?? null;
  return { data, error, reload: load };
}
