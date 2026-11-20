import { useEffect, useMemo, useRef, useState } from "react";
import { type BusyKeys } from "../../shared/lib/busy";
import { useReorderHint } from "./useReorderHint";
import { MobileSidebarToggle } from "../../shared/ui/MobileSidebarToggle";
import { UsageDisplayToggle } from "../dashboard/UsageDisplayToggle";
import { useCompactDashboard } from "../../shared/hooks/useCompactDashboard";
import { MOBILE_OVERLAY_QUERY } from "../sidebar/sidebar-width";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";
import "./accounts-layout.css";
import {
  CloseIcon,
  EditIcon,
  GridIcon,
  PlusIcon,
  StackPlusIcon,
  TrashIcon,
  UsersIcon,
} from "../../shared/ui/icons";
import { DASHBOARD_EMPTY_ACCOUNT_DESCRIPTION, EmptyAccountPanel } from "./EmptyAccountPanel";
import { accountNeedsAttention, lowLimitSummary, nextResetSummary } from "../../shared/lib/usage-logic";
import { groupFilterLabel, type SidebarGroup } from "../sidebar/sidebar-groups";
import type {
  Account,
  AccountBucket,
  Provider,
} from "../../types";
import { persistVisibleAccountOrder } from "../reorder";
import { moveAnnouncement, moveById } from "../reorder/reorder-utils";
import { AccountDashboardCard, REORDER_HINT_ID } from "./AccountDashboardCard";
import { ACCOUNT_FORMS, formatCount } from "../../shared/lib/format";
import { useClock } from "../../shared/hooks/useClock";
import { nextResetModelLabel } from "../../shared/lib/display";
import { usePullToRefresh } from "../dashboard/usePullToRefresh";
import { useCanPullRefreshEnvironment, usePullRefreshHint } from "../dashboard/usePullRefreshHint";
import { PullToRefreshIndicator } from "../dashboard/PullToRefreshIndicator";

const ATTENTION_HINT_ID = "attention-filter-hint";
const LOW_LIMIT_FORMS = { one: "low limit", other: "low limits" };

function dashboardDescription(group: SidebarGroup, accountCount: number): string {
  const count = formatCount(accountCount, ACCOUNT_FORMS);
  if (group.type === "bucket") return `Usage across ${count} in this group.`;
  if (group.type === "provider") return `${group.title} usage across ${count}.`;
  return "Monitor 5-hour & 7-day limits and reset times across all your AI subscriptions.";
}

/** Time until the soonest reset. Updates itself with the shared clock, so the dashboard does not re-render for it. */
function NextResetInline({ accounts }: { accounts: Account[] }) {
  const account = useClock((now) => nextResetSummary(accounts, now).account);
  // Which limit resets, not only whose: "7D Grok", "5H Claude", the limit styled like a card's "5-HOUR". Antigravity
  // and the Grok Bot limit add their model after it: "5H Gemini Antigravity", "7D Bot Grok".
  const limit = useClock((now) => nextResetSummary(accounts, now).limit?.replace("-hour", "H").replace("-day", "D") ?? null);
  const model = useClock((now) => {
    const next = nextResetSummary(accounts, now);
    return nextResetModelLabel(next.provider, next.window);
  });
  const value = useClock((now) => nextResetSummary(accounts, now).value);
  const badge = [limit, model].filter(Boolean).join(" ");
  if (!account) {
    return (
      <div className="next-reset-inline">
        <span className="next-reset-prefix">No upcoming reset</span>
      </div>
    );
  }
  return (
    <div className="next-reset-inline">
      <span className="next-reset-prefix">Next reset:</span>
      {badge ? <span className="next-reset-limit">{badge}</span> : null}
      <strong className="next-reset-account">{account}</strong>
      <span className="next-reset-prefix">in</span>
      <span className="next-reset-pill">{value}</span>
    </div>
  );
}

export function AccountsView(props: {
  allAccounts: Account[];
  accounts: Account[];
  selectedGroup: SidebarGroup;
  refreshMinutes: number;
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  onAdd: (provider?: Provider) => void;
  /** Opens the new-group dialog (phone header's Group button). */
  onAddGroup?: () => void;
  onOpenPairing?: () => void;
  onRefreshAll?: () => void;
  onEditBucket?: (bucket: AccountBucket) => void;
  onDeleteBucket?: (bucket: AccountBucket) => void;
  onRefresh: (account: Account) => void;
  onReconnect: (account: Account) => void;
  onConnectGoogleUsage: (account: Account) => void;
  onRename: (account: Account, label: string) => Promise<void>;
  onRemove: (account: Account) => void;
  onNotifications: (account: Account) => void;
  onUseLimitReset?: (account: Account, grantId: string) => void;
  busy: BusyKeys;
  /** Accounts whose saved sign-in could not be locked on this phone. */
  unprotectedAccountIds?: string[];
  highlightedAccount?: { accountId: string; seq: number } | null;
}) {
  const [showAttentionOnly, setShowAttentionOnly] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [globalCompact] = useCompactDashboard();
  // The L / U switch sits in the title row on a phone and at the header's top right on a wide window.
  const phone = useMediaQuery(MOBILE_OVERLAY_QUERY);
  // Mobile has no global Compact View toggle; cards on mobile ignore the desktop setting and use per-card collapse only.
  const compact = phone ? false : globalCompact;

  useEffect(() => {
    setShowAttentionOnly(false);
  }, [props.selectedGroup.id]);

  const needsAttention = useMemo(() => props.accounts.filter(accountNeedsAttention).length, [props.accounts]);
  const lowLimitCount = useClock((now) => (needsAttention > 0 ? 0 : lowLimitSummary(props.accounts, now).count));
  const lowLimitLevel = useClock((now) => (needsAttention > 0 ? null : lowLimitSummary(props.accounts, now).level));

  useEffect(() => {
    if (showAttentionOnly && needsAttention === 0) {
      setShowAttentionOnly(false);
    }
  }, [showAttentionOnly, needsAttention]);

  const displayedAccounts = useMemo(() => {
    if (!showAttentionOnly) return props.accounts;
    return props.accounts.filter(accountNeedsAttention);
  }, [showAttentionOnly, props.accounts]);

  // Moving within a filtered subset would reorder against a partial list, so it is only offered on the full page.
  const canReorder = !showAttentionOnly && displayedAccounts.length > 1;
  const { showReorderHint, dismissReorderHint, completeReorderHint } = useReorderHint(canReorder);

  const moveAccount = (account: Account, delta: -1 | 1) => {
    const move = moveById(displayedAccounts.map((candidate) => candidate.id), account.id, delta);
    if (!move) return;
    if (showReorderHint) completeReorderHint();
    void persistVisibleAccountOrder(move.ids, props.selectedGroup.id);
    setAnnouncement(moveAnnouncement(account.label, move.to, move.ids.length));
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = props.highlightedAccount;
    if (!target) return;
    if (showAttentionOnly && !displayedAccounts.some((account) => account.id === target.accountId)) {
      setShowAttentionOnly(false);
      return;
    }
    const timer = window.setTimeout(() => {
      const root = scrollRef.current ?? containerRef.current;
      if (!root) return;
      const cards = root.querySelectorAll<HTMLElement>("[data-account-id]");
      const match = Array.from(cards).find((el) => el.dataset.accountId === target.accountId);
      if (match && typeof match.scrollIntoView === "function") {
        match.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [props.highlightedAccount, showAttentionOnly, displayedAccounts]);

  const canPullRefreshEnv = useCanPullRefreshEnvironment();
  const canPullRefresh = Boolean(props.onRefreshAll) && displayedAccounts.length > 0 && canPullRefreshEnv;
  const { showPullRefreshHint, dismissPullRefreshHint, completePullRefreshHint } = usePullRefreshHint(canPullRefresh, "accounts");

  const pullData = usePullToRefresh({
    containerRef,
    scrollRef,
    onRefresh: props.onRefreshAll,
    onTriggered: completePullRefreshHint,
    disabled: !props.onRefreshAll || props.accounts.length === 0,
  });

  const editBucketBtn = props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
    <button
      type="button"
      className="edit-bucket-title-btn"
      onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}
      aria-label="Edit Group"
      data-tooltip="Edit Group"
    >
      <EditIcon />
    </button>
  ) : null;
  const isFiltered = props.selectedGroup.type !== "all";
  const mobileTitleFilter = phone && props.onToggleSidebar ? (
    <h1 className="eyebrow mobile-title-filter-heading" tabIndex={-1} style={{ outline: "none" }}>
      <MobileSidebarToggle
        onToggle={props.onToggleSidebar}
        open={props.sidebarOpen}
        filterLabel={groupFilterLabel(props.selectedGroup)}
        isFiltered={isFiltered}
        trailing={editBucketBtn}
      />
    </h1>
  ) : null;
  const titleHeading = mobileTitleFilter ?? (
    <h1 className="eyebrow" tabIndex={-1} style={{ outline: "none" }}>
      {props.selectedGroup.type === "all"
        ? phone || props.allAccounts.length === 0
          ? "Dashboard"
          : "All accounts"
        : `${props.selectedGroup.title} Accounts`}
    </h1>
  );
  const bucketPill = !phone && props.selectedGroup.type === "bucket" ? (
    <span className="dashboard-bucket-pill">Group</span>
  ) : null;

  return (
    <div ref={containerRef} className="content-scroll dashboard-content">
      <PullToRefreshIndicator data={pullData} />
      <header className="dashboard-header">
        <div>
          <div className="dashboard-title-row">
            {titleHeading}
            {bucketPill}
            {/* On a phone the pen is inside the filter pill (MobileSidebarToggle's `trailing`). */}
            {mobileTitleFilter ? null : editBucketBtn}
            {/* On a phone the title row ends with L / U, New group, and Add account buttons.
                A wide window has them in the top bar and header top-right instead. */}
            {phone ? (
              <div className="dashboard-header-actions">
                <UsageDisplayToggle
                  labels="letters"
                  className="provider-window-toggle usage-display-toggle is-mobile-header"
                />
                {props.onAddGroup ? (
                  <button
                    type="button"
                    className="sidebar-section-button"
                    onClick={props.onAddGroup}
                    aria-label="Add new group"
                    data-tooltip={"Group AI accounts to track their usage\ntogether, such as Work or Personal"}
                  >
                    <StackPlusIcon />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="sidebar-section-button is-primary"
                  onClick={() => props.onAdd()}
                  aria-label="Add new account"
                  data-tooltip="Connect an AI account to track usage"
                >
                  <PlusIcon />
                </button>
              </div>
            ) : null}
          </div>
          <p className="dashboard-description">{dashboardDescription(props.selectedGroup, props.accounts.length)}</p>
          {/* On a wide window the L / U switch sits at the header's top right, like the Usage page's 7D / 30D. */}
          {phone ? null : (
            <div className="accounts-display-switch">
              {/* Names what the switch chooses, as "Period" does on the Usage page; the group already has its own name. */}
              <span className="accounts-display-label" aria-hidden="true">Show</span>
              <UsageDisplayToggle labels="words" className="top-bar-segmented" />
            </div>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="dashboard-scroll">
        {/* The hints come first, above the status strip, as on the Usage page. */}
        {showReorderHint ? (
          <div className="reorder-hint-banner" role="note">
            <span>Press & drag a card below or in the sidebar to reorder</span>
            <button
              type="button"
              className="reorder-hint-dismiss"
              onClick={dismissReorderHint}
              aria-label="Dismiss reorder hint"
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}

        {showPullRefreshHint ? (
          <div className="pull-refresh-hint-banner" role="note">
            <span>Pull down on the screen to refresh data</span>
            <button
              type="button"
              className="pull-refresh-hint-dismiss"
              onClick={dismissPullRefreshHint}
              aria-label="Dismiss pull-to-refresh hint"
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}

        <section className="summary-status-region" aria-label="Account status overview">
          {needsAttention > 0 ? (
            showAttentionOnly ? (
              <div className="summary-strip has-attention is-filtering">
                <button
                  type="button"
                  className="summary-strip-toggle"
                  aria-pressed={true}
                  aria-describedby={ATTENTION_HINT_ID}
                  data-tooltip={phone ? undefined : "Show all accounts"}
                  onClick={() => setShowAttentionOnly(false)}
                >
                  <span className="summary-status-cluster">
                    <span className="summary-status-dot" aria-hidden="true" />
                    <span className="summary-status-text">Attention needed</span>
                    <span className="summary-attention-count">{needsAttention}</span>
                  </span>
                  <NextResetInline accounts={props.accounts} />
                  <span id={ATTENTION_HINT_ID} className="sr-only">
                    Currently showing only accounts needing attention. Activate to show all accounts.
                  </span>
                </button>
                <div className="summary-filter-subrow">
                  <span>Showing {formatCount(displayedAccounts.length, ACCOUNT_FORMS)} needing attention</span>
                  <button
                    type="button"
                    className="button ghost compact-button filter-active-clear-btn"
                    onClick={() => setShowAttentionOnly(false)}
                    aria-label="Show all accounts"
                  >
                    Show all <CloseIcon />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="summary-strip has-attention is-clickable"
                aria-pressed={false}
                aria-describedby={ATTENTION_HINT_ID}
                data-tooltip="Show only accounts needing attention"
                onClick={() => setShowAttentionOnly(true)}
              >
                <span className="summary-status-cluster">
                  <span className="summary-status-dot" aria-hidden="true" />
                  <span className="summary-status-text">Attention needed</span>
                  <span className="summary-attention-count">{needsAttention}</span>
                </span>
                <NextResetInline accounts={props.accounts} />
                <span id={ATTENTION_HINT_ID} className="sr-only">
                  Activate to show only accounts needing attention.
                </span>
              </button>
            )
          ) : (
            <div
              className={`summary-strip${
                props.accounts.length === 0
                  ? " is-empty"
                  : lowLimitCount > 0 && lowLimitLevel
                    ? ` is-low-${lowLimitLevel}`
                    : ""
              }`}
            >
              <span className="summary-status-cluster">
                {/* With nothing to monitor yet, the same purple icon and wording as the Usage page's box. */}
                {props.accounts.length === 0 ? (
                  <>
                    <GridIcon aria-hidden="true" />
                    <span className="summary-status-text">No accounts yet</span>
                  </>
                ) : (
                  <>
                    <span className="summary-status-dot" aria-hidden="true" />
                    <span className="summary-status-text">
                      {lowLimitCount > 0 ? formatCount(lowLimitCount, LOW_LIMIT_FORMS) : "All accounts good"}
                    </span>
                  </>
                )}
              </span>
              <NextResetInline accounts={props.accounts} />
            </div>
          )}
        </section>

        <section className={`provider-account-cards${compact ? " is-compact" : ""}`} data-group-id={props.selectedGroup?.id || undefined}>
        {displayedAccounts.length ? displayedAccounts.map((account, index) => (
          <AccountDashboardCard
            // The layout is part of the key: switching Compact view remounts the cards, so each one
            // reads its own toggle again after the button reset it.
            key={`${props.selectedGroup.id}:${account.id}:${compact ? "compact" : "full"}`}
            pageId={props.selectedGroup.id}
            account={account}
            compact={compact}
            busy={props.busy}
            onRefresh={() => props.onRefresh(account)}
            onReconnect={() => props.onReconnect(account)}
            onConnectGoogleUsage={() => props.onConnectGoogleUsage(account)}
            onRename={(label) => props.onRename(account, label)}
            onRemove={() => props.onRemove(account)}
            onNotifications={() => props.onNotifications(account)}
            onUseLimitReset={
              props.onUseLimitReset
                ? (grantId) => props.onUseLimitReset?.(account, grantId)
                : undefined
            }
            canMoveUp={canReorder && index > 0}
            canMoveDown={canReorder && index < displayedAccounts.length - 1}
            onMove={canReorder ? (delta) => moveAccount(account, delta) : undefined}
            signInUnprotected={props.unprotectedAccountIds?.includes(account.id) ?? false}
            highlighted={props.highlightedAccount?.accountId === account.id}
          />
        )) : showAttentionOnly || props.selectedGroup.type === "bucket" ? (
          <section className="welcome-panel mockup-empty-panel">
            <UsersIcon />
            <h2>
              {showAttentionOnly
                ? "No accounts need attention"
                : `No accounts in ${props.selectedGroup.title}`}
            </h2>
            <p>
              {showAttentionOnly
                ? "All accounts in this view are healthy and reporting live quota."
                : "This group is still saved. Add accounts to it, or delete the group."}
            </p>
            <div className="empty-group-actions">
              {showAttentionOnly ? (
                <button type="button" className="button primary" onClick={() => setShowAttentionOnly(false)}>
                  Show all accounts
                </button>
              ) : props.selectedGroup.bucket ? (
                <>
                  <button type="button" className="button primary edit-bucket-empty-btn" onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}>
                    <EditIcon /><span className="edit-bucket-label">Edit Group</span>
                  </button>
                  <button type="button" className="button ghost bucket-delete-button" onClick={() => props.onDeleteBucket?.(props.selectedGroup.bucket!)}>
                    <TrashIcon />Delete Group
                  </button>
                </>
              ) : null}
            </div>
          </section>
        ) : (
          <EmptyAccountPanel
            description={DASHBOARD_EMPTY_ACCOUNT_DESCRIPTION}
            onAdd={props.onAdd}
            onOpenPairing={props.onOpenPairing}
          />
        )}
      </section>
      </div>
      <p id={REORDER_HINT_ID} className="sr-only">Press Alt with the up or down arrow key to move this account.</p>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    </div>
  );
}
