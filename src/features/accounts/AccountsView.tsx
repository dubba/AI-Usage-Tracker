import { useEffect, useMemo, useRef, useState } from "react";
import { type BusyKeys } from "../../shared/lib/busy";
import { useReorderHint } from "./useReorderHint";
import { MobileSidebarToggle } from "../../shared/ui/MobileSidebarToggle";
import { UsageDisplayToggle } from "../dashboard/UsageDisplayToggle";
import { MOBILE_OVERLAY_QUERY } from "../dashboard/sidebar-width";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  CloseIcon,
  EditIcon,
  PlusIcon,
  StackPlusIcon,
  TrashIcon,
  UsersIcon,
} from "../../shared/ui/icons";
import { DASHBOARD_EMPTY_ACCOUNT_DESCRIPTION, EmptyAccountPanel } from "./EmptyAccountPanel";
import {
  accountNeedsAttention,
  displayAccountLabel,
  nextResetSummary,
} from "../../shared/lib/usage-logic";
import type { SidebarGroup } from "../dashboard/sidebar-groups";
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
import { PullToRefreshIndicator } from "../dashboard/PullToRefreshIndicator";

const ATTENTION_HINT_ID = "attention-filter-hint";

function dashboardDescription(group: SidebarGroup, accountCount: number): string {
  const count = formatCount(accountCount, ACCOUNT_FORMS);
  if (group.type === "bucket") return `Usage across ${count} in this group.`;
  if (group.type === "provider") return `${group.title} usage across ${count}.`;
  return "Monitor weekly limits, session limits, and reset times across all your AI subscriptions.";
}

/** Time until the soonest reset. Updates itself with the shared clock, so the dashboard does not re-render for it. */
function NextResetCard({ accounts }: { accounts: Account[] }) {
  const account = useClock((now) => nextResetSummary(accounts, now).account ?? "No upcoming reset");
  // Which limit resets, not only whose: "7D Grok", "5H Claude", the limit styled like a card's "5-HOUR". Antigravity
  // and the Grok Bot limit add their model after it: "5H Gemini Antigravity", "7D Bot Grok".
  const limit = useClock((now) => nextResetSummary(accounts, now).limit?.replace("-hour", "H").replace("-day", "D") ?? null);
  const model = useClock((now) => {
    const next = nextResetSummary(accounts, now);
    return nextResetModelLabel(next.provider, next.window);
  });
  const value = useClock((now) => nextResetSummary(accounts, now).value);
  return (
    <div className="summary-card next-reset-card">
      <div>
        <span className="summary-label">Next reset</span>
        <strong className="next-reset-account">
          {limit ? <span className="next-reset-limit">{limit}</span> : null}
          {model ? <span className="next-reset-limit">{model}</span> : null}
          {account}
        </strong>
      </div>
      <div className="next-reset-actions">
        <span className="next-reset-pill">{value}</span>
        <ClockIcon />
      </div>
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
}) {
  const [showAttentionOnly, setShowAttentionOnly] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // The L / U switch sits in the title row on a phone and at the header's top right on a wide window.
  const phone = useMediaQuery(MOBILE_OVERLAY_QUERY);

  useEffect(() => {
    setShowAttentionOnly(false);
  }, [props.selectedGroup.id]);

  const needsAttention = useMemo(() => props.accounts.filter(accountNeedsAttention).length, [props.accounts]);

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
    setAnnouncement(moveAnnouncement(displayAccountLabel(account), move.to, move.ids.length));
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pullData = usePullToRefresh({
    containerRef,
    scrollRef,
    onRefresh: props.onRefreshAll,
    disabled: !props.onRefreshAll,
  });

  return (
    <div ref={containerRef} className="content-scroll dashboard-content">
      <PullToRefreshIndicator data={pullData} />
      <header className="dashboard-header">
        <div>
          <div className="dashboard-title-row">
            {props.onToggleSidebar ? <MobileSidebarToggle onToggle={props.onToggleSidebar} open={props.sidebarOpen} /> : null}
            <h1 className="eyebrow" tabIndex={-1} style={{ outline: "none" }}>
              {props.selectedGroup.type === "all"
                ? props.allAccounts.length === 0 ? "Dashboard" : "All accounts"
                : `${props.selectedGroup.title} Accounts`}
            </h1>
            {props.selectedGroup.type === "bucket" ? (
              <span className="dashboard-bucket-pill">Group</span>
            ) : null}
            {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
              <>
                <button
                  type="button"
                  className="edit-bucket-title-btn"
                  onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}
                  aria-label="Edit Group"
                  data-tooltip="Edit Group"
                >
                  <EditIcon />
                </button>
              </>
            ) : null}
            {/* On a phone the title row ends with icon-only New group and Add account buttons, the same
                actions as the side menu's labeled ones. A wide window has them in the top bar. The
                % Left / % Used switch is at the bottom of the side menu (Sidebar.tsx). */}
            {phone ? (
              <div className="dashboard-header-actions">
                {props.onAddGroup ? (
                  <button
                    type="button"
                    className="sidebar-section-button"
                    onClick={props.onAddGroup}
                    aria-label="Add new group"
                  >
                    <StackPlusIcon />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="sidebar-section-button is-primary"
                  onClick={() => props.onAdd()}
                  aria-label="Add new account"
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
        <section className="summary-strip" aria-label="Account status overview">
          <div className="summary-card total-card">
            <div>
              <span className="summary-label">Accounts</span>
              <strong className="summary-helper">
                {needsAttention > 0
                  ? `${props.accounts.length - needsAttention} healthy`
                  : "Total"}
              </strong>
            </div>
            <div className="summary-value-cluster">
              <strong>{props.accounts.length}</strong>
              <UsersIcon />
            </div>
          </div>
          {needsAttention > 0 ? (
            <button
              type="button"
              className={`summary-card attention-card has-attention is-clickable ${showAttentionOnly ? "is-filtering" : ""}`}
              aria-pressed={showAttentionOnly}
              aria-describedby={ATTENTION_HINT_ID}
              data-tooltip={
                showAttentionOnly
                  ? "Show all accounts"
                  : "Show only accounts needing attention"
              }
              onClick={() => {
                setShowAttentionOnly((prev) => !prev);
              }}
            >
              <div>
                <span className="summary-label">Action Needed</span>
                <strong className="summary-helper">
                  <AlertCircleIcon /> Requires action
                </strong>
              </div>
              <div className="summary-value-cluster">
                <strong>{needsAttention}</strong>
                <AlertCircleIcon />
              </div>
              <span id={ATTENTION_HINT_ID} className="sr-only">
                {showAttentionOnly
                  ? "Currently showing only accounts needing attention. Activate to show all accounts."
                  : "Activate to show only accounts needing attention."}
              </span>
            </button>
          ) : (
            <div className="summary-card attention-card">
              <div>
                <span className="summary-label">Action Needed</span>
                <strong className="summary-helper">
                  <CheckCircleIcon /> All good
                </strong>
              </div>
              <div className="summary-value-cluster">
                <strong>0</strong>
                <AlertCircleIcon />
              </div>
            </div>
          )}
          <NextResetCard accounts={props.accounts} />
        </section>

        {showAttentionOnly ? (
          <div className="filter-active-banner">
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
        ) : null}

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

        <section className="provider-account-cards" data-group-id={props.selectedGroup?.id || undefined}>
        {displayedAccounts.length ? displayedAccounts.map((account, index) => (
          <AccountDashboardCard
            key={`${props.selectedGroup.id}:${account.id}`}
            pageId={props.selectedGroup.id}
            account={account}
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
