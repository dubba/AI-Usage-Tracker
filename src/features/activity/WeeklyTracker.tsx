import { useId } from "react";
import { formatResetAtShort } from "../../shared/lib/format";
import { displayAccountError, displayPlan } from "../../shared/lib/display";
import { displayAccountLabel, usageTone } from "../../shared/lib/usage-logic";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import type { Account, ActivityTracker } from "../../types";
import { accountEmail, ActivityAccountTitle } from "./account-title";
import { formatDayPercent } from "./activity-format";
import type { ActivityPeriod } from "./activity-period";
import { antigravityFamilyLabel } from "./antigravity-models";
import { DailyBars } from "./DailyBars";

/** One weekly limit of one account: who and when it resets, how much is used, and the daily bars. */
export function WeeklyTracker({
  tracker,
  account,
  dayStarts,
  period,
  compact = false,
  onReconnect,
}: {
  tracker: ActivityTracker;
  account: Account;
  /** The local midnights the tracker's days were counted between. */
  dayStarts: readonly Date[];
  period: ActivityPeriod;
  compact?: boolean;
  onReconnect?: (account: Account) => void;
}) {
  const titleId = useId();
  const label = displayAccountLabel(account);
  const used = tracker.currentUsedPercent;
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
  const plan = displayPlan(account);
  const reset = formatResetAtShort(tracker.resetsAt);
  const details = [plan, reset ? `resets ${reset}` : null].filter(Boolean).join(" · ");
  const chartName = limitName ? `${label} ${limitName}` : label;
  const monthly = tracker.windowKind === "monthly";

  if (compact) {
    const compactMeta = [limitName, reset ? `Resets ${reset}` : null].filter(Boolean).join(" · ");
    return (
      <article
        className={`activity-card is-compact${needsSignIn ? " is-dimmed" : ""}${hasError ? " needs-attention" : ""}`}
        aria-labelledby={titleId}
        data-account-id={account.id}
        data-reorder-provider={account.provider}
        data-reorder-enabled="true"
        draggable={false}
      >
        <span className="reorder-grip" data-tooltip="Drag to reorder" aria-hidden="true" />
        <div className="activity-compact-head">
          <span className="activity-card-icon">
            <ProviderIcon provider={account.provider} />
          </span>
          <div className="activity-compact-identity">
            <div className="activity-compact-title-row">
              <h2 className="activity-card-title" id={titleId} title={email ?? undefined}>
                {label}
              </h2>
              {plan ? <span className="activity-plan-pill is-compact">{plan}</span> : null}
              {compactMeta ? <span className="activity-compact-meta">{compactMeta}</span> : null}
            </div>
          </div>
          <div className="activity-compact-trailing">
            <div className={`activity-card-total is-compact tone-${tone}`}>
              <strong aria-label={used == null ? "Usage unknown" : `${formatDayPercent(used)} of the ${monthly ? "monthly" : "weekly"} limit used`}>
                {formatDayPercent(used)}
              </strong>
              <span className="activity-card-total-period" aria-hidden="true">
                {`${used == null ? "" : "used "}${monthly ? "this month" : "this week"}`}
              </span>
            </div>
            {needsSignIn && onReconnect ? (
              <button type="button" className="button primary compact-button compact-card-action-btn" onClick={() => onReconnect(account)}>
                {account.provider === "google_ai_studio" ? "Reconnect" : "Sign in"}
              </button>
            ) : null}
          </div>
        </div>
        <DailyBars
          name={chartName}
          days={tracker.days}
          dayStarts={dayStarts}
          resets={tracker.resets}
          resetUsedPercent={tracker.resetUsedPercent}
          period={period}
          limit={tracker.windowKind}
          compact
        />
      </article>
    );
  }

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
        <span className="activity-card-icon">
          <ProviderIcon provider={account.provider} />
        </span>
        <div className="activity-card-identity">
          <h2 className="activity-card-title" id={titleId}>
            <ActivityAccountTitle label={label} email={email} />
          </h2>
          {details ? <p className="activity-card-details">{details}</p> : null}
          {limitName ? <span className="activity-card-limit">{limitName}</span> : null}
        </div>
        <div className={`activity-card-total tone-${tone}`}>
          <strong aria-label={used == null ? "Usage unknown" : `${formatDayPercent(used)} of the ${monthly ? "monthly" : "weekly"} limit used`}>
            {formatDayPercent(used)}
          </strong>
          <span className="activity-card-total-period" aria-hidden="true">
            {`${used == null ? "" : "used "}${monthly ? "this month" : "this week"}`}
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
