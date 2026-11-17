import { useId } from "react";
import { displayAccountError, displayPlan } from "../../shared/lib/display";
import { formatResetAtShort } from "../../shared/lib/format";
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
 * email) followed by each model group's own reset info, percentage used, and daily usage chart.
 */
export function AntigravityTrackerCard({
  account,
  trackers,
  dayStarts,
  period,
  compact = false,
  onReconnect,
}: {
  account: Account;
  trackers: readonly ActivityTracker[];
  /** The local midnights the trackers' days were counted between. */
  dayStarts: readonly Date[];
  period: ActivityPeriod;
  compact?: boolean;
  onReconnect?: (account: Account) => void;
}) {
  const titleId = useId();
  const label = displayAccountLabel(account);
  const plan = displayPlan(account);
  const email = accountEmail(account);
  const needsSignIn = account.authRequired || account.lastUsage?.freshness === "auth_required";
  const hasError = needsSignIn
    || Boolean(account.lastError)
    || !account.lastUsage
    || account.lastUsage.freshness !== "live";
  const orderedTrackers = sortAntigravityTrackers(trackers);

  if (compact) {
    return (
      <article
        className={`activity-card activity-card-consolidated is-compact${needsSignIn ? " is-dimmed" : ""}${hasError ? " needs-attention" : ""}`}
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
            </div>
          </div>
          {needsSignIn && onReconnect ? (
            <button type="button" className="button primary compact-button compact-card-action-btn" onClick={() => onReconnect(account)}>
              Sign in
            </button>
          ) : null}
        </div>
        <div className="activity-model-sections is-compact">
          {orderedTrackers.map((tracker) => {
            const modelName = antigravityFamilyLabel(tracker.windowLabel);
            const used = tracker.currentUsedPercent;
            const tone = usageTone(used == null ? null : 100 - used);
            const reset = formatResetAtShort(tracker.resetsAt);
            const monthly = tracker.windowKind === "monthly";
            const chartName = `${label} ${modelName}`;

            return (
              <section className="activity-model-section" key={tracker.windowId} aria-label={modelName}>
                <div className="activity-model-head">
                  <div className="activity-model-identity">
                    <h3 className="activity-model-name" title={reset ? `Resets ${reset}` : undefined}>{modelName}</h3>
                  </div>
                  <div className={`activity-card-total activity-model-total tone-${tone}`}>
                    <strong aria-label={used == null ? "Usage unknown" : `${formatDayPercent(used)} of the ${monthly ? "monthly" : "weekly"} limit used`}>
                      {formatDayPercent(used)}
                    </strong>
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
              </section>
            );
          })}
        </div>
      </article>
    );
  }

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
        <span className="activity-card-icon">
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
          const reset = formatResetAtShort(tracker.resetsAt);
          const monthly = tracker.windowKind === "monthly";
          const chartName = `${label} ${modelName}`;

          return (
            <section className="activity-model-section" key={tracker.windowId} aria-label={modelName}>
              <div className="activity-model-head">
                <div className="activity-model-identity">
                  <h3 className="activity-model-name">{modelName}</h3>
                  {reset ? <p className="activity-model-reset">Resets {reset}</p> : null}
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
