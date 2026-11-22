import { useDeferredValue, useId, useMemo, useRef } from "react";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";
import { MobileSidebarToggle } from "../../shared/ui/MobileSidebarToggle";
import { BarChartIcon } from "../../shared/ui/icons";
import { HintBanner } from "../../shared/ui/HintBanner";
import { useSessionHint } from "../../shared/hooks/useSessionHint";
import { useSegmentIndicator } from "../../shared/ui/segment-indicator";
import { MOBILE_OVERLAY_QUERY } from "../sidebar/sidebar-width";
import { PullToRefreshIndicator } from "../dashboard/PullToRefreshIndicator";
import { useCanPullRefreshEnvironment, usePullToRefresh } from "../dashboard/usePullToRefresh";
import { EmptyAccountPanel } from "../accounts/EmptyAccountPanel";
import { useReorderHint } from "../accounts/useReorderHint";
import type { Account, ActivityTracker, Provider, UntrackedAccount } from "../../types";
import { ACTIVITY_PERIODS, ACTIVITY_PERIOD_DAYS, type ActivityPeriod } from "./activity-period";
import { AntigravityTrackerCard } from "./AntigravityTrackerCard";
import { NoWeeklyLimitCard } from "./NoWeeklyLimitCard";
import { useActivityPeriod } from "./useActivityPeriod";
import { useWeeklyActivity } from "./useWeeklyActivity";
import { WeeklyTracker } from "./WeeklyTracker";
import "./activity.css";

const ALL_PERIOD_DAYS = ACTIVITY_PERIODS.map((candidate) => ACTIVITY_PERIOD_DAYS[candidate]);
const PERIOD_LABELS: Record<ActivityPeriod, string> = { "7d": "7D", "30d": "30D", "90d": "90D" };
const PERIOD_NAMES: Record<ActivityPeriod, string> = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days" };
const PERIOD_TOOLTIPS: Record<ActivityPeriod, string> = { "7d": "Show the last 7 days", "30d": "Show the last 30 days", "90d": "Show the last 90 days" };

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

/** The 7D / 30D / 90D switch with a label saying what it chooses: how many days the charts cover. */
function PeriodSwitch({ period, onChange }: { period: ActivityPeriod; onChange: (next: ActivityPeriod) => void }) {
  const labelId = useId();
  const switchRef = useRef<HTMLDivElement>(null);
  useSegmentIndicator(switchRef);
  return (
    <div className="activity-period">
      <span className="activity-period-label" id={labelId}>Period</span>
      <div ref={switchRef} className="activity-period-switch segmented" role="group" aria-labelledby={labelId}>
        {ACTIVITY_PERIODS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={candidate === period ? "active" : undefined}
            aria-pressed={candidate === period}
            aria-label={PERIOD_NAMES[candidate]}
            data-tooltip={PERIOD_TOOLTIPS[candidate]}
            onClick={() => onChange(candidate)}
          >
            {PERIOD_LABELS[candidate]}
          </button>
        ))}
      </div>
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
  filterLabel,
  isFiltered = false,
  groupId = "all",
  hasAnyAccounts = false,
  onToggleSidebar,
  sidebarOpen,
  onAddAccount,
  onOpenPairing,
  onReconnect,
  onRefresh,
}: {
  /** The accounts in the order the active view shows them. */
  accounts: readonly Account[];
  filterLabel?: string;
  isFiltered?: boolean;
  groupId?: string;
  hasAnyAccounts?: boolean;
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  /** Opens add-account for a provider. With no provider, the chooser starts on its default. */
  onAddAccount: (provider?: Provider) => void;
  onOpenPairing?: () => void;
  onReconnect?: (account: Account) => void;
  onRefresh?: () => void | Promise<void>;
}) {
  const phone = useMediaQuery(MOBILE_OVERLAY_QUERY);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [period, setPeriod] = useActivityPeriod();
  const refreshKey = useMemo(() => refreshKeyOf(accounts), [accounts]);
  const { data: latest, error, reload } = useWeeklyActivity({
    dayCount: ACTIVITY_PERIOD_DAYS[period],
    alsoLoad: ALL_PERIOD_DAYS,
    refreshKey,
    enabled: accounts.length > 0,
  });

  // Drawing 90 bars on every card is heavy. Deferring the answer lets the switch itself move at once
  // and the charts follow a moment later, instead of the whole tap waiting on the redraw.
  const data = useDeferredValue(latest);
  const redrawing = data !== latest;

  const canPullRefreshEnv = useCanPullRefreshEnvironment();
  const canPullRefresh = Boolean(onRefresh) && accounts.length > 0 && Boolean(data) && canPullRefreshEnv;
  const pullRefreshHint = useSessionHint("pull-refresh", "activity", canPullRefresh);

  const pullData = usePullToRefresh({
    containerRef,
    scrollRef,
    onRefresh: onRefresh
      ? async () => {
          await onRefresh();
          await reload();
        }
      : undefined,
    onTriggered: pullRefreshHint.complete,
    disabled: !onRefresh || accounts.length === 0,
  });

  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  // The switch updates immediately. The chart stays on the period it has data for until the other
  // report arrives, so the cards are not replaced by placeholders in between.
  const chartPeriod: ActivityPeriod =
    data == null ? period : (ACTIVITY_PERIODS.find((candidate) => ACTIVITY_PERIOD_DAYS[candidate] === data.dayCount) ?? "7d");
  const trackers = useMemo<ActivityTracker[]>(
    // An account with no weekly limit but a monthly one is charted on the 30 and 90 day views only.
    () => (data ? inAccountOrder(data.activity.trackers.filter((tracker) => chartPeriod !== "7d" || tracker.windowKind === "weekly"), accounts) : []),
    [data, accounts, chartPeriod],
  );
  const hasReadings = trackers.some((tracker) => tracker.days.some((day) => day.quality !== "none"));
  // Accounts whose monthly usage the 30 day view charts, for a hint on their card on the 7 day view.
  const monthlyAccountIds = useMemo(
    () => new Set((data?.activity.trackers ?? []).filter((tracker) => tracker.windowKind === "monthly").map((tracker) => tracker.accountId)),
    [data],
  );
  // The "No weekly limit" cards belong to the 7 day view. The 30 day view charts monthly
  // usage instead, and says tracking has not started yet when nothing is recorded.
  const untracked = useMemo<UntrackedAccount[]>(() => {
    if (!data || chartPeriod !== "7d") return [];
    const charted = new Set(hasReadings ? trackers.map((tracker) => tracker.accountId) : []);
    return inAccountOrder(data.activity.untracked, accounts).filter((entry) => !charted.has(entry.accountId));
  }, [data, accounts, trackers, hasReadings, chartPeriod]);
  // Nothing recorded yet for the charts on screen, or no limits known at all.
  const waitingForReadings = trackers.length > 0 ? !hasReadings : untracked.length === 0;

  const trackerCards = useMemo<
    Array<
      | { kind: "single"; account: Account; tracker: ActivityTracker }
      | { kind: "antigravity"; account: Account; trackers: ActivityTracker[] }
    >
  >(() => {
    const items: Array<
      | { kind: "single"; account: Account; tracker: ActivityTracker }
      | { kind: "antigravity"; account: Account; trackers: ActivityTracker[] }
    > = [];
    const antigravityByAccount = new Map<string, { kind: "antigravity"; account: Account; trackers: ActivityTracker[] }>();
    for (const tracker of trackers) {
      const account = accountById.get(tracker.accountId);
      if (!account) continue;
      if (account.provider === "antigravity") {
        let grouped = antigravityByAccount.get(account.id);
        if (!grouped) {
          grouped = { kind: "antigravity", account, trackers: [] };
          antigravityByAccount.set(account.id, grouped);
          items.push(grouped);
        }
        grouped.trackers.push(tracker);
      } else {
        items.push({ kind: "single", account, tracker });
      }
    }
    return items;
  }, [trackers, accountById]);

  const canReorder = accounts.length > 1 && (trackerCards.length + untracked.length) > 1;
  const reorderHint = useReorderHint(canReorder, "activity");

  const retry = (
    <button type="button" className="button ghost compact-button" onClick={() => void reload()}>
      Retry
    </button>
  );

  const renderBody = () => {
    if (accounts.length === 0) {
      if (hasAnyAccounts && isFiltered) {
        return (
          <section className="activity-message" aria-label="No accounts in filter">
            <BarChartIcon />
            <h2>No accounts in {filterLabel}</h2>
            <p>Add accounts to this group or choose another filter.</p>
          </section>
        );
      }
      return (
        <section className="activity-empty" aria-label="No accounts">
          <div className="activity-empty-strip">
            <BarChartIcon />
            <h2>No accounts yet</h2>
          </div>
          <EmptyAccountPanel onAdd={onAddAccount} onOpenPairing={onOpenPairing} />
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
        {reorderHint.show ? <HintBanner kind="reorder" onDismiss={reorderHint.dismiss} /> : null}
        {pullRefreshHint.show ? <HintBanner kind="pull-refresh" onDismiss={pullRefreshHint.dismiss} /> : null}
        {error ? (
          <div className="activity-error" role="alert">
            <span>
              {data.dayCount === ACTIVITY_PERIOD_DAYS[period]
                ? `Couldn’t refresh usage: ${error}`
                : `Couldn’t load usage: ${error}`}
            </span>
            {retry}
          </div>
        ) : null}
        {waitingForReadings ? (
          <p className="activity-note" role="status">
            Tracking starts at the next refresh.
          </p>
        ) : null}
        {hasReadings ? (
          <ul className="activity-legend" aria-label="Chart legend">
            <li className="activity-legend-label" aria-hidden="true">
              KEY
            </li>
            <li className="activity-legend-item">
              <span className="activity-legend-swatch is-measured" aria-hidden="true" />
              <span>Measured</span>
            </li>
            <li className="activity-legend-item">
              <span className="activity-legend-swatch is-approximate" aria-hidden="true" />
              <span>Estimated</span>
            </li>
            <li className="activity-legend-item">
              <span className="activity-legend-swatch is-empty" aria-hidden="true" />
              <span>No data</span>
            </li>
            <li className="activity-legend-item">
              <span className="activity-legend-swatch is-reset" aria-hidden="true" />
              <span>Reset</span>
            </li>
          </ul>
        ) : null}
        <div className={`activity-grid${redrawing ? " is-redrawing" : ""}`} data-group-id={groupId}>
          {hasReadings
            ? trackerCards.map((entry) =>
                entry.kind === "antigravity" ? (
                  <AntigravityTrackerCard
                    key={entry.account.id}
                    account={entry.account}
                    trackers={entry.trackers}
                    dayStarts={data.dayStarts}
                    period={chartPeriod}
                    onReconnect={onReconnect}
                  />
                ) : (
                  <WeeklyTracker
                    key={`${entry.tracker.accountId}|${entry.tracker.windowId}`}
                    tracker={entry.tracker}
                    account={entry.account}
                    dayStarts={data.dayStarts}
                    period={chartPeriod}
                    onReconnect={onReconnect}
                  />
                ),
              )
            : null}
          {untracked.map((entry) => {
            const account = accountById.get(entry.accountId);
            if (!account) return null;
            return (
              <NoWeeklyLimitCard
                key={entry.accountId}
                account={account}
                otherLimits={entry.otherLimits}
                monthlyOn30d={chartPeriod === "7d" && monthlyAccountIds.has(entry.accountId)}
              />
            );
          })}
        </div>
      </>
    );
  };

  const titleHeading = phone && onToggleSidebar ? (
    <h1 className="eyebrow mobile-title-filter-heading" tabIndex={-1} style={{ outline: "none" }}>
      <MobileSidebarToggle
        onToggle={onToggleSidebar}
        open={sidebarOpen}
        filterLabel={filterLabel ?? "All Accounts"}
        isFiltered={isFiltered}
      />
    </h1>
  ) : (
    <h1 className="eyebrow" tabIndex={-1} style={{ outline: "none" }}>Usage</h1>
  );

  return (
    <div ref={containerRef} className="content-scroll dashboard-content activity-content">
      <PullToRefreshIndicator data={pullData} />
      <header className="dashboard-header">
        <div className="activity-header-main">
          <div className="dashboard-title-row activity-title-row">
            {titleHeading}
            <PeriodSwitch period={period} onChange={setPeriod} />
          </div>
          <p className="dashboard-description">Track daily usage as a percentage of each account's weekly limit.</p>
        </div>
      </header>
      <div ref={scrollRef} className="dashboard-scroll">{renderBody()}</div>
    </div>
  );
}
