import { useMemo } from "react";
import { MobileSidebarToggle } from "../../shared/ui/MobileSidebarToggle";
import { BarChartIcon } from "../../shared/ui/icons";
import type { Account, ActivityTracker, UntrackedAccount } from "../../types";
import { ACTIVITY_PERIODS, ACTIVITY_PERIOD_DAYS, type ActivityPeriod } from "./activity-period";
import { NoWeeklyLimitCard } from "./NoWeeklyLimitCard";
import { useActivityPeriod } from "./useActivityPeriod";
import { useWeeklyActivity } from "./useWeeklyActivity";
import { WeeklyTracker } from "./WeeklyTracker";
import "./activity.css";

const PERIOD_LABELS: Record<ActivityPeriod, string> = { "7d": "7D", "30d": "30D" };
const PERIOD_NAMES: Record<ActivityPeriod, string> = { "7d": "Last 7 days", "30d": "Last 30 days" };

/**
 * A key that changes when a refresh brings new usage or the accounts change, so the page loads the
 * activity again then, and only then.
 */
function refreshKeyOf(accounts: readonly Account[]): string {
  return accounts.map((account) => `${account.id}@${account.lastUsage?.fetchedAt ?? ""}`).join("|");
}

/** Puts the entries of `items` in the order of `accounts`, leaving out those whose account is gone. */
function inAccountOrder<T extends { accountId: string }>(items: readonly T[], accounts: readonly Account[]): T[] {
  const position = new Map(accounts.map((account, index) => [account.id, index]));
  return items
    .filter((item) => position.has(item.accountId))
    .sort((left, right) => position.get(left.accountId)! - position.get(right.accountId)!);
}

function PeriodSwitch({ period, onChange }: { period: ActivityPeriod; onChange: (next: ActivityPeriod) => void }) {
  return (
    <div className="activity-period-switch" role="group" aria-label="Period">
      {ACTIVITY_PERIODS.map((candidate) => (
        <button
          key={candidate}
          type="button"
          className={candidate === period ? "active" : undefined}
          aria-pressed={candidate === period}
          aria-label={PERIOD_NAMES[candidate]}
          onClick={() => onChange(candidate)}
        >
          {PERIOD_LABELS[candidate]}
        </button>
      ))}
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="activity-grid" aria-busy="true" aria-label="Loading usage">
      {[0, 1, 2].map((index) => (
        <div className="activity-skeleton" aria-hidden="true" key={index}>
          <span className="activity-skeleton-line" />
          <span className="activity-skeleton-line short" />
          <span className="activity-skeleton-bars" />
        </div>
      ))}
      <span className="sr-only">Loading usage…</span>
    </div>
  );
}

/**
 * The Usage page: for each account with a weekly limit, how much of it was used on each of the
 * last 7 or 30 days, with the accounts in the order of the All accounts page.
 */
export function ActivityView({
  accounts,
  onToggleSidebar,
  sidebarOpen,
  onAddAccount,
  onReconnect,
}: {
  /** The accounts in the order the All accounts page shows them. */
  accounts: readonly Account[];
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  onAddAccount: () => void;
  onReconnect?: (account: Account) => void;
}) {
  const [period, setPeriod] = useActivityPeriod();
  const refreshKey = useMemo(() => refreshKeyOf(accounts), [accounts]);
  const { data, error, reload } = useWeeklyActivity({
    dayCount: ACTIVITY_PERIOD_DAYS[period],
    refreshKey,
    enabled: accounts.length > 0,
  });

  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const trackers = useMemo<ActivityTracker[]>(
    () => (data ? inAccountOrder(data.activity.trackers, accounts) : []),
    [data, accounts],
  );
  const untracked = useMemo<UntrackedAccount[]>(
    () => (data ? inAccountOrder(data.activity.untracked, accounts) : []),
    [data, accounts],
  );
  const hasReadings = trackers.some((tracker) => tracker.days.some((day) => day.quality !== "none"));

  const retry = (
    <button type="button" className="button ghost compact-button" onClick={() => void reload()}>
      Retry
    </button>
  );

  const renderBody = () => {
    if (accounts.length === 0) {
      return (
        <section className="activity-message" aria-label="No accounts">
          <BarChartIcon />
          <h2>No accounts yet</h2>
          <p>Add an account to see how much of its weekly limit you use each day.</p>
          <button type="button" className="button primary" onClick={onAddAccount}>
            Add account
          </button>
        </section>
      );
    }
    if (!data) {
      if (error) {
        return (
          <div className="activity-error" role="alert">
            <span>Couldn’t load usage: {error}</span>
            {retry}
          </div>
        );
      }
      return <SkeletonCards />;
    }
    return (
      <>
        {error ? (
          <div className="activity-error" role="alert">
            <span>Couldn’t refresh usage: {error}</span>
            {retry}
          </div>
        ) : null}
        {!hasReadings ? (
          <p className="activity-note" role="status">
            Tracking starts at the next refresh.
          </p>
        ) : null}
        <div className="activity-grid">
          {hasReadings
            ? trackers.map((tracker) => (
                <WeeklyTracker
                  key={`${tracker.accountId}|${tracker.windowId}`}
                  tracker={tracker}
                  account={accountById.get(tracker.accountId)!}
                  dayStarts={data.dayStarts}
                  period={period}
                  onReconnect={onReconnect}
                />
              ))
            : null}
          {untracked.map((entry) => (
            <NoWeeklyLimitCard key={entry.accountId} account={accountById.get(entry.accountId)!} otherLimits={entry.otherLimits} />
          ))}
        </div>
      </>
    );
  };

  return (
    <div className="content-scroll dashboard-content activity-content">
      <header className="dashboard-header">
        <div className="activity-header-main">
          <div className="dashboard-title-row activity-title-row">
            {onToggleSidebar ? <MobileSidebarToggle onToggle={onToggleSidebar} open={sidebarOpen} /> : null}
            <h1 className="eyebrow" tabIndex={-1} style={{ outline: "none" }}>Usage</h1>
            <PeriodSwitch period={period} onChange={setPeriod} />
          </div>
          <p className="dashboard-description">How much of each weekly limit you used on each day.</p>
        </div>
      </header>
      <div className="dashboard-scroll">{renderBody()}</div>
    </div>
  );
}
