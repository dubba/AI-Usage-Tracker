/**
 * The local midnight `offset` days from `base`'s day. `new Date(year, month, day)` lands on the real
 * local midnight, so a day that gains or loses an hour to daylight saving time is 25 or 23 hours long
 * here, and the backend never needs to know the time zone.
 */
function localMidnight(base: Date, offset: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
}

/**
 * The boundaries of the last `dayCount` local days, today included: `dayCount + 1` midnights, the
 * first being the start of the oldest day and the last tomorrow's midnight (the end of today).
 */
export function dayStartsFor(dayCount: number, now: Date = new Date()): Date[] {
  return Array.from({ length: dayCount + 1 }, (_, index) => localMidnight(now, index - dayCount + 1));
}

/** The boundaries as the RFC 3339 instants `get_weekly_activity` takes. */
export function dayStartInstants(starts: readonly Date[]): string[] {
  return starts.map((start) => start.toISOString());
}
