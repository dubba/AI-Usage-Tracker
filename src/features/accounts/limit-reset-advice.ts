import { formatRemainingDuration } from "../../shared/lib/format";
import { GROK_BOT_WINDOW_ID } from "../../shared/lib/usage-sources";
import type { LimitReset, ResetTarget, UsageWindow } from "../../types";

/** The limits the app can match to a window; "other" (from a newer version) matches none. */
type KnownTarget = Exclude<ResetTarget, "other">;

const TARGET_NAME: Record<KnownTarget, string> = {
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
function windowFor(target: KnownTarget, windows: UsageWindow[]): UsageWindow | undefined {
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
 * One or two sentences on what using this reset would get back right now, from the limits the
 * backend says it clears (`clears`) and the account's current usage. `null` when it does not say,
 * clears something the app cannot match to a window, or the usage is missing, so the dialog never
 * guesses.
 */
export function limitResetAdvice(grant: LimitReset, windows: UsageWindow[], now: number): string | null {
  if (!grant.clears.length) return null;

  const items = [];
  for (const target of grant.clears) {
    if (target === "other") return null;
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
