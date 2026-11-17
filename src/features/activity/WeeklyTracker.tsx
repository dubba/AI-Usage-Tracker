import { useId } from "react";
import { useClock } from "../../shared/hooks/useClock";
import { displayAccountError, displayPlan } from "../../shared/lib/display";
import { displayAccountLabel, isWindowExpired, usageTone } from "../../shared/lib/usage-logic";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import type { Account, ActivityTracker } from "../../types";
import { accountEmail } from "./account-title";
import { formatDayPercent } from "./activity-format";
import type { ActivityPeriod } from "./activity-period";
import { antigravityFamilyLabel } from "./antigravity-models";
import { DailyBars } from "./DailyBars";

/** One weekly limit of one account: who it is, how much is used, and the daily bars (with the resets marked). */
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
  const plan = displayPlan(account);
  const expired = useClock((now) => isWindowExpired(tracker.resetsAt, Math.max(now, Date.now())));
  const used = expired ? null : tracker.currentUsedPercent;
  // Toned by what is left, like the account cards. The number itself is always what was used:
  // this page is about consumption, and the daily bars below count usage too.
  const tone = usageTone(used == null ? null : 100 - used);
  const needsSignIn = account.authRequired || account.lastUsage?.freshness === "auth_required";
  const hasError = needsSignIn
    || Boolean(account.lastError)
    || !account.lastUsage
    || account.lastUsage.freshness !== "live";
  const limitName = account.provider === "antigravity" ? antigravityFamilyLabel(tracker.windowLabel) : null;
  const email = accountEmail(account);
  const chartName = limitName ? `${label} ${limitName}` : label;
  const monthly = tracker.windowKind === "monthly";

  return (
    <article
      className={`activity-card${needsSignIn ? " is-dimmed" : ""}${hasError ? " needs-attention" : ""}`}
      aria-labelledby={titleId}
      data-account-id={account.id}
      data-reorder-provider={account.provider}
      data-reorder-enabled="true"
      draggable={false}
    >
      <span className="reorder-grip" data-tooltip="Drag to reorder" aria-hidden="true" />
      <header className="activity-card-head">
        <span className={`activity-card-icon provider-${account.provider}`}>
          <ProviderIcon provider={account.provider} />
        </span>
        <div className="activity-card-identity">
          <div className="activity-consolidated-title-row">
            <h2 className="activity-card-title" id={titleId}>
              {label}
            </h2>
            {plan ? <span className="activity-plan-pill">{plan}</span> : null}
          </div>
          {email ? <p className="activity-consolidated-email">{email}</p> : null}
          {limitName ? <span className="activity-card-limit">{limitName}</span> : null}
        </div>
        <div className={`activity-card-total tone-${tone}`}>
          <strong
            aria-label={
              expired
                ? "Usage unknown since reset"
                : used == null
                  ? "Usage unknown"
                  : `${formatDayPercent(used)} of the ${monthly ? "monthly" : "weekly"} limit used`
            }
          >
            {formatDayPercent(used)}
          </strong>
          <span className="activity-card-total-period" aria-hidden="true">
            {expired
              ? (monthly ? "month ended" : "week ended")
              : `${used == null ? "" : "used "}${monthly ? "this month" : "this week"}`}
          </span>
        </div>
      </header>
      {needsSignIn ? (
        <div className="activity-card-notice">
          <span>{displayAccountError(account.lastError) ?? "Sign in again to keep tracking this account."}</span>
          {onReconnect ? (
            <button type="button" className="button primary compact-button" onClick={() => onReconnect(account)}>
              {account.provider === "google_ai_studio" ? "Reconnect Cloud Usage" : "Sign in again"}
            </button>
          ) : null}
        </div>
      ) : null}
      <DailyBars
        name={chartName}
        days={tracker.days}
        dayStarts={dayStarts}
        resets={tracker.resets}
        resetUsedPercent={tracker.resetUsedPercent}
        period={period}
        limit={tracker.windowKind}
      />
    </article>
  );
}
