import { formatRemainingDuration } from "../../shared/lib/format";
import { GROK_BOT_WINDOW_ID } from "../../shared/lib/usage-sources";
import type { LimitReset, UsageWindow } from "../../types";

type ResetTarget = "five_hour" | "weekly" | "fable_weekly";

/**
 * What each reset clears, read from the detail the backend writes (the `DETAIL_*` constants in
 * `src-tauri/src/providers/limit_resets.rs`; a test keeps the two in step). Longer prefixes come
 * first, so "Clears 7-day Fable usage and refills…" is not read as the Fable-only reset. A detail
 * that matches none of these (a rate limit, the generic fallback) gets no advice.
 */
export const RESET_CLEARS: ReadonlyArray<readonly [string, readonly ResetTarget[]]> = [
  ["Clears 7-day Fable usage and refills the 5-hour limit", ["fable_weekly", "five_hour"]],
  ["Clears 7-day Fable usage", ["fable_weekly"]],
  ["Clears the 5-hour and 7-day limits", ["five_hour", "weekly"]],
  ["Clears the 5-hour limit", ["five_hour"]],
  ["Clears the 7-day limit", ["weekly"]],
];

const TARGET_NAME: Record<ResetTarget, string> = {
  five_hour: "5-hour",
  weekly: "7-day",
  fable_weekly: "7-day Fable",
};

/** Only a reset this close to its own reset time is worth pointing out. */
const RESETS_SOON_MS = 24 * 60 * 60 * 1000;
/** Only an expiry this close is worth pointing out. */
const EXPIRES_SOON_MS = 3 * 24 * 60 * 60 * 1000;

const isFable = (window: UsageWindow) => /\bfable\b/i.test(`${window.id} ${window.label}`);

/**
 * The account's main window of a kind: an ungrouped one ("Weekly") before a grouped one ("Codex · Weekly").
 * Grok Bot's 7-day window is its own allowance, which a Grok reset does not clear.
 */
function windowFor(target: ResetTarget, windows: UsageWindow[]): UsageWindow | undefined {
  const matches = (window: UsageWindow) =>
    window.id !== GROK_BOT_WINDOW_ID &&
    (target === "fable_weekly"
      ? window.kind === "weekly" && isFable(window)
      : window.kind === target && !isFable(window));
  return windows.find((window) => matches(window) && !window.label.includes(" · ")) ?? windows.find(matches);
}

/** "5-hour limit", "5-hour and 7-day limits". */
function limitsPhrase(names: string[]): string {
  const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `${joined} ${names.length > 1 ? "limits" : "limit"}`;
}

function untilLabel(value: string | null | undefined, now: number, within: number): string | null {
  if (!value) return null;
  const left = new Date(value).getTime() - now;
  if (!Number.isFinite(left) || left <= 0 || left > within) return null;
  return formatRemainingDuration(left);
}

/**
 * One or two sentences on what using this reset would get back right now, from the account's
 * current usage. `null` when the reset clears something the app cannot match to a window, or the
 * usage is missing, so the dialog never guesses.
 */
export function limitResetAdvice(grant: LimitReset, windows: UsageWindow[], now: number): string | null {
  const targets = RESET_CLEARS.find(([prefix]) => grant.detail.startsWith(prefix))?.[1];
  if (!targets) return null;

  const items = [];
  for (const target of targets) {
    const window = windowFor(target, windows);
    if (window?.remainingPercent == null) return null;
    const gain = Math.round(100 - Math.min(100, Math.max(0, window.remainingPercent)));
    items.push({ name: TARGET_NAME[target], gain, window });
  }

  const full = items.filter((item) => item.gain < 1);
  const gaining = items.filter((item) => item.gain >= 1);
  const gains = gaining.map((item) => `${item.gain}% of your ${item.name} limit`).join(" and ");

  let text: string;
  if (gaining.length === 0) {
    const verb = full.length > 1 ? "are" : "is";
    text = `Your ${limitsPhrase(full.map((item) => item.name))} ${verb} already full, so this would restore nothing right now`;
  } else if (full.length > 0) {
    const verb = full.length > 1 ? "are" : "is";
    text = `Your ${limitsPhrase(full.map((item) => item.name))} ${verb} already full, so you'd only get back ${gains}`;
  } else {
    text = `You'd get back ${gains}`;
  }

  if (gaining.length === 1) {
    const soon = untilLabel(gaining[0].window.resetsAt, now, RESETS_SOON_MS);
    if (soon) text += `, which resets on its own in ${soon}`;
  }
  text += ".";

  const expires = untilLabel(grant.expiresAt, now, EXPIRES_SOON_MS);
  if (expires) text += ` This reset expires in ${expires}.`;

  return text;
}
