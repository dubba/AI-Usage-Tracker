/** Locale-aware formatting helpers. `locale` defaults to the user's locale; tests pass one explicitly. */

/** Plural forms for `formatCount` when counting accounts. */
export const ACCOUNT_FORMS = { one: "account", other: "accounts" };

/** "1 account" / "2 accounts", choosing the form with the locale's plural rules. */
export function formatCount(
  count: number,
  forms: { one: string; other: string },
  locale?: string,
): string {
  const category = new Intl.PluralRules(locale).select(count);
  return `${count} ${category === "one" ? forms.one : forms.other}`;
}

export function formatMonthDay(date: Date, locale?: string): string {
  return date.toLocaleString(locale, { month: "short", day: "numeric" });
}

/**
 * Clock time in the user's own convention. English 12-hour locales keep the
 * app's compact style ("2:34a", "12:07p"); everything else uses the locale's
 * standard time format, which also honors 24-hour locales ("14:34").
 */
export function formatClockTime(date: Date, locale?: string): string {
  const resolved = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
  const hourCycle = resolved.hourCycle;
  const isEnglish = new Intl.Locale(resolved.locale).language === "en";
  if (isEnglish && (hourCycle === "h12" || hourCycle === "h11")) {
    const hour12 = date.getHours() % 12 || 12;
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hour12}:${minutes}${date.getHours() < 12 ? "a" : "p"}`;
  }
  const is24Hour = hourCycle === "h23" || hourCycle === "h24";
  return date.toLocaleTimeString(locale, { hour: is24Hour ? "2-digit" : "numeric", minute: "2-digit" });
}

export function formatResetAtShort(value: string | null | undefined, locale?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatMonthDay(date, locale)} @ ${formatClockTime(date, locale)}`;
}

export function formatRemainingDuration(remainingMs: number): string | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes === 0) {
    const totalSeconds = Math.max(1, Math.floor(remainingMs / 1000));
    if (totalSeconds >= 45) return "45s";
    if (totalSeconds >= 30) return "30s";
    if (totalSeconds >= 15) return "15s";
    return "5s";
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/** "just now", "5m ago", "3h ago", "2d ago" for a duration that has passed. */
export function formatElapsed(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatUpdatedAt(value: string | null | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return null;
  return `Updated ${formatElapsed(now - then)}`;
}

export function resetCountdownLabel(
  value: string | null | undefined,
  now: number = Date.now(),
  windowSeconds?: number | null,
): string | null {
  if (!value) return null;
  const resetAt = new Date(value).getTime();
  if (!Number.isFinite(resetAt)) return null;
  const currentNow = Math.max(now, Date.now());
  let remainingMs = resetAt - currentNow;
  if (windowSeconds && remainingMs >= windowSeconds * 1000) {
    remainingMs = windowSeconds * 1000 - 1;
  }
  const remaining = formatRemainingDuration(remainingMs);
  return remaining ? `Reset: ${remaining}` : null;
}

export function formatAlertTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
