import { useId } from "react";
import { displayAccountError, displayPlan } from "../../shared/lib/display";
import { displayAccountLabel, usageTone } from "../../shared/lib/usage-logic";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import type { Account, ActivityTracker } from "../../types";
import { accountEmail } from "./account-title";
import { formatDayPercent } from "./activity-format";
import type { ActivityPeriod } from "./activity-period";
import { antigravityFamilyLabel, sortAntigravityTrackers } from "./antigravity-models";
import { DailyBars } from "./DailyBars";

/**
 * One consolidated card for an Antigravity account: shared provider header (icon, name, plan pill,
 * email) followed by each model group's percentage used and daily usage chart (with its resets marked).
 */
export function AntigravityTrackerCard({
  account,
  trackers,
  dayStarts,
  period,
  onReconnect,
}: {
  account: Account;
  trackers: readonly ActivityTracker[];
  /** The local midnights the trackers' days were counted between. */
  dayStarts: readonly Date[];
  period: ActivityPeriod;
  onReconnect?: (account: Account) => void;
}) {
  const titleId = useId();
  const label = displayAccountLabel(account);
  const plan = displayPlan(account);
  const email = accountEmail(account);
  const needsSignIn = account.health === "signed_out";
  const hasError = needsSignIn
    || Boolean(account.lastError)
    || !account.lastUsage
    || account.lastUsage.freshness !== "live";
  const orderedTrackers = sortAntigravityTrackers(trackers);

  return (
    <article
      className={`activity-card activity-card-consolidated${needsSignIn ? " is-dimmed" : ""}${hasError ? " needs-attention" : ""}`}
      aria-labelledby={titleId}
      data-account-id={account.id}
      data-reorder-provider={account.provider}
      data-reorder-enabled="true"
      draggable={false}
    >
      <span className="reorder-grip" data-tooltip="Drag to reorder" aria-hidden="true" />
      <header className="activity-consolidated-head">
        <span className={`activity-card-icon provider-${account.provider}`}>
          <ProviderIcon provider={account.provider} />
        </span>
        <div className="activity-consolidated-identity">
          <div className="activity-consolidated-title-row">
            <h2 className="activity-card-title" id={titleId}>
              {label}
            </h2>
            {plan ? <span className="activity-plan-pill">{plan}</span> : null}
          </div>
          {email ? <p className="activity-consolidated-email">{email}</p> : null}
        </div>
      </header>
      {needsSignIn ? (
        <div className="activity-card-notice">
          <span>{displayAccountError(account.lastError) ?? "Sign in again to keep tracking this account."}</span>
          {onReconnect ? (
            <button type="button" className="button primary compact-button" onClick={() => onReconnect(account)}>
              Sign in again
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="activity-model-sections">
        {orderedTrackers.map((tracker) => {
          const modelName = antigravityFamilyLabel(tracker.windowLabel);
          const used = tracker.currentUsedPercent;
          const tone = usageTone(used == null ? null : 100 - used);
          const monthly = tracker.windowKind === "monthly";
          const chartName = `${label} ${modelName}`;

          return (
            <section className="activity-model-section" key={tracker.windowId} aria-label={modelName}>
              <div className="activity-model-head">
                <div className="activity-model-identity">
                  <h3 className="activity-model-name">{modelName}</h3>
                </div>
                <div className={`activity-card-total activity-model-total tone-${tone}`}>
                  <strong aria-label={used == null ? "Usage unknown" : `${formatDayPercent(used)} of the ${monthly ? "monthly" : "weekly"} limit used`}>
                    {formatDayPercent(used)}
                  </strong>
                  <span className="activity-card-total-period" aria-hidden="true">
                    {`${used == null ? "" : "used "}${monthly ? "this month" : "this week"}`}
                  </span>
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
              />
            </section>
          );
        })}
      </div>
    </article>
  );
}
