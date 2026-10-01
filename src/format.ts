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
 * standard time format, which also honours 24-hour locales ("14:34").
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
