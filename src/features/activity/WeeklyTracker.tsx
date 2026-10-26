import { useId } from "react";
import { formatResetAtShort } from "../../shared/lib/format";
import { displayPlan } from "../../shared/lib/display";
import { displayAccountLabel, usageTone } from "../../shared/lib/usage-logic";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import type { Account, ActivityTracker } from "../../types";
import { accountEmail, ActivityAccountTitle } from "./account-title";
import { formatDayPercent } from "./activity-format";
import type { ActivityPeriod } from "./activity-period";
import { DailyBars } from "./DailyBars";

/** Usage-card names. Account chips keep their own shorter labels. */
const ANTIGRAVITY_FAMILY_NAMES: Record<string, string> = {
  "claude and gpt models": "Claude & GPT Models",
  "claude & gpt models": "Claude & GPT Models",
  "gemini 4 argon": "Argon Models",
};

/** "Gemini Models · Weekly Limit Remaining" -> "Gemini Models". A name with no family stays whole. */
function antigravityFamilyLabel(windowLabel: string): string {
  const splitAt = windowLabel.indexOf(" · ");
  const family = (splitAt <= 0 ? windowLabel : windowLabel.slice(0, splitAt)).trim();
  return ANTIGRAVITY_FAMILY_NAMES[family.toLowerCase()] ?? family;
}

/** One weekly limit of one account: who and when it resets, how much is used, and the daily bars. */
export function WeeklyTracker({
  tracker,
  account,
  dayStarts,
  period,
  onReconnect,
}: {
  tracker: ActivityTracker;
  account: Account;
  /** The local midnights the tracker's days were counted between. */
  dayStarts: readonly Date[];
  period: ActivityPeriod;
  onReconnect?: (account: Account) => void;
}) {
  const titleId = useId();
  const label = displayAccountLabel(account);
  const used = tracker.currentUsedPercent;
  const tone = usageTone(used == null ? null : 100 - used);
  const needsSignIn = account.authRequired || account.lastUsage?.freshness === "auth_required";
  const limitName = account.provider === "antigravity" ? antigravityFamilyLabel(tracker.windowLabel) : null;
  const email = accountEmail(account);
  const reset = formatResetAtShort(tracker.resetsAt);
  const details = [displayPlan(account), reset ? `resets ${reset}` : null].filter(Boolean).join(" · ");
  const chartName = limitName ? `${label} ${limitName}` : label;
  const monthly = tracker.windowKind === "monthly";

  return (
    <article className={`activity-card${needsSignIn ? " is-dimmed" : ""}`} aria-labelledby={titleId}>
      <header className="activity-card-head">
        <span className="activity-card-icon">
          <ProviderIcon provider={account.provider} />
        </span>
        <div className="activity-card-identity">
          <h2 className="activity-card-title" id={titleId}>
            <ActivityAccountTitle label={label} email={email} />
            {limitName ? <span className="activity-card-limit">{limitName}</span> : null}
          </h2>
          {details ? <p className="activity-card-details">{details}</p> : null}
        </div>
        <div className={`activity-card-total tone-${tone}`}>
          <strong aria-label={used == null ? "Usage unknown" : `${formatDayPercent(used)} of the ${monthly ? "monthly" : "weekly"} limit used`}>
            {formatDayPercent(used)}
          </strong>
          <span aria-hidden="true">{monthly ? "this month" : "this week"}</span>
        </div>
      </header>
      {needsSignIn ? (
        <div className="activity-card-notice">
          <span>{account.lastError ?? "Sign in again to keep tracking this account."}</span>
          {onReconnect ? (
            <button type="button" className="button ghost compact-button" onClick={() => onReconnect(account)}>
              {account.provider === "google_ai_studio" ? "Reconnect Cloud Usage" : "Reconnect"}
            </button>
          ) : null}
        </div>
      ) : null}
      <DailyBars
        name={chartName}
        days={tracker.days}
        dayStarts={dayStarts}
        resets={tracker.resets}
        period={period}
        limit={tracker.windowKind}
      />
    </article>
  );
}
