import { useEffect, useMemo, useRef, useState } from "react";
import { type BusyKeys } from "../../shared/lib/busy";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  CloseIcon,
  EditIcon,
  MenuIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
} from "../../shared/ui/icons";
import {
  accountNeedsAttention,
  displayAccountLabel,
  nextResetSummary,
} from "../../shared/lib/usage-logic";
import type { SidebarGroup } from "../dashboard/sidebar-groups";
import type {
  Account,
  AccountBucket,
} from "../../types";
import { persistVisibleAccountOrder } from "../reorder";
import { moveAnnouncement, moveById } from "../reorder/reorder-utils";
import { AccountDashboardCard, REORDER_HINT_ID } from "./AccountDashboardCard";
import { ACCOUNT_FORMS, formatCount } from "../../shared/lib/format";
import { useClock } from "../../shared/hooks/useClock";
import { usePullToRefresh } from "../dashboard/usePullToRefresh";
import { PullToRefreshIndicator } from "../dashboard/PullToRefreshIndicator";

const ATTENTION_HINT_ID = "attention-filter-hint";

/** Time until the soonest reset. Updates itself with the shared clock, so the dashboard does not re-render for it. */
function NextResetCard({ accounts }: { accounts: Account[] }) {
  const account = useClock((now) => nextResetSummary(accounts, now).account ?? "No upcoming reset");
  const value = useClock((now) => nextResetSummary(accounts, now).value);
  return (
    <div className="mockup-summary-card next-reset-card">
      <div>
        <span className="summary-label">Next reset</span>
        <strong className="next-reset-account">{account}</strong>
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
  needsAttention: number;
  refreshMinutes: number;
  onToggleSidebar?: () => void;
  onAdd: () => void;
  onRefreshAll?: () => void;
  onEditBucket?: (bucket: AccountBucket) => void;
  onDeleteBucket?: (bucket: AccountBucket) => void;
  onRefresh: (account: Account) => void;
  onReconnect: (account: Account) => void;
  onConnectGoogleUsage: (account: Account) => void;
  onRename: (account: Account, label: string) => Promise<void>;
  onRemove: (account: Account) => void;
  onNotifications: (account: Account) => void;
  busy: BusyKeys;
}) {
  const [showAttentionOnly, setShowAttentionOnly] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    setShowAttentionOnly(false);
  }, [props.selectedGroup.id]);

  useEffect(() => {
    if (showAttentionOnly && props.needsAttention === 0) {
      setShowAttentionOnly(false);
    }
  }, [showAttentionOnly, props.needsAttention]);

  const displayedAccounts = useMemo(() => {
    if (!showAttentionOnly) return props.accounts;
    return props.accounts.filter(accountNeedsAttention);
  }, [showAttentionOnly, props.accounts]);

  // Moving within a filtered subset would reorder against a partial list, so it is only offered on the full page.
  const canReorder = !showAttentionOnly && displayedAccounts.length > 1;
  const moveAccount = (account: Account, delta: -1 | 1) => {
    const move = moveById(displayedAccounts.map((candidate) => candidate.id), account.id, delta);
    if (!move) return;
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
            {props.onToggleSidebar ? (
              <button
                type="button"
                className="mobile-sidebar-toggle-btn"
                onClick={props.onToggleSidebar}
                aria-label="Toggle navigation menu"
                data-tooltip="Toggle navigation menu"
              >
                <MenuIcon />
              </button>
            ) : null}
            <h1 className="eyebrow">
              {props.selectedGroup.type === "all"
                ? props.allAccounts.length === 0 ? "Dashboard" : "All accounts"
                : `${props.selectedGroup.title} Accounts`}
            </h1>
            {props.selectedGroup.type === "bucket" ? (
              <span className="dashboard-bucket-pill">Group</span>
            ) : null}
            {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
              <button
                type="button"
                className="button ghost edit-bucket-title-btn"
                onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}
                aria-label="Edit Group"
                data-tooltip="Edit Group"
              >
                <EditIcon />
              </button>
            ) : null}
          </div>
          <p className="dashboard-description">This is a dashboard of all your AI subscriptions by usage.</p>
        </div>
        {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
          <div className="header-actions">
            <button
              type="button"
              className="button ghost edit-bucket-header-btn"
              onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}
              aria-label="Edit Group"
              data-tooltip="Edit Group"
            >
              <EditIcon /><span className="edit-bucket-label">Edit Group</span>
            </button>
          </div>
        ) : null}
      </header>

      <div ref={scrollRef} className="dashboard-scroll">
        <section className="summary-grid mockup-summary-grid">
          <div className="mockup-summary-card total-card">
            <div><span className="summary-label">Accounts</span><strong className="summary-helper">Active</strong></div>
            <div className="summary-value-cluster"><strong>{props.accounts.length}</strong><UsersIcon /></div>
          </div>
          <div
            className={`mockup-summary-card attention-card ${props.needsAttention ? "has-attention is-clickable" : ""} ${showAttentionOnly ? "is-filtering" : ""}`}
            role={props.needsAttention ? "button" : undefined}
            tabIndex={props.needsAttention ? 0 : undefined}
            aria-pressed={props.needsAttention ? showAttentionOnly : undefined}
            aria-describedby={props.needsAttention > 0 ? ATTENTION_HINT_ID : undefined}
            data-tooltip={
              props.needsAttention > 0
                ? showAttentionOnly
                  ? "Show all accounts"
                  : "Show only accounts needing attention"
                : undefined
            }
            onClick={() => {
              if (props.needsAttention > 0) {
                setShowAttentionOnly((prev) => !prev);
              }
            }}
            onKeyDown={(event) => {
              if (props.needsAttention > 0 && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                setShowAttentionOnly((prev) => !prev);
              }
            }}
          >
            <div>
              <span className="summary-label">Action Needed</span>
              <strong className="summary-helper"><CheckCircleIcon />{props.needsAttention ? formatCount(props.needsAttention, ACCOUNT_FORMS) : "All good"}</strong>
            </div>
            <div className="summary-value-cluster"><strong>{props.needsAttention}</strong><AlertCircleIcon /></div>
            {props.needsAttention > 0 ? (
              <span id={ATTENTION_HINT_ID} className="sr-only">
                {showAttentionOnly
                  ? "Currently showing only accounts needing attention. Activate to show all accounts."
                  : "Activate to show only accounts needing attention."}
              </span>
            ) : null}
          </div>
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
              Show All <CloseIcon />
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
            canMoveUp={canReorder && index > 0}
            canMoveDown={canReorder && index < displayedAccounts.length - 1}
            onMove={canReorder ? (delta) => moveAccount(account, delta) : undefined}
          />
        )) : (
          <section className="welcome-panel mockup-empty-panel">
            <UsersIcon />
            <h2>
              {showAttentionOnly
                ? "No accounts need attention"
                : props.selectedGroup.type === "bucket"
                  ? `No accounts in ${props.selectedGroup.title}`
                  : props.selectedGroup.type === "all"
                    ? "Connect a provider account"
                    : `No accounts in ${props.selectedGroup.title}`}
            </h2>
            <p>
              {showAttentionOnly
                ? "All accounts in this view are healthy and reporting live quota."
                : props.selectedGroup.type === "bucket"
                  ? "This group is still saved. Add accounts to it, or delete the group."
                  : "Add an account to begin monitoring its limits."}
            </p>
            <div className="empty-group-actions">
              {showAttentionOnly ? (
                <button type="button" className="button primary" onClick={() => setShowAttentionOnly(false)}>
                  Show All Accounts
                </button>
              ) : (
                <>
                  {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
                    <>
                      <button type="button" className="button ghost edit-bucket-empty-btn" onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}>
                        <EditIcon /><span className="edit-bucket-label">Edit Group</span>
                      </button>
                      <button type="button" className="button ghost bucket-delete-button" onClick={() => props.onDeleteBucket?.(props.selectedGroup.bucket!)}>
                        <TrashIcon />Delete Group
                      </button>
                    </>
                  ) : null}
                  <button type="button" className="button primary" onClick={props.onAdd}><PlusIcon />Account</button>
                </>
              )}
            </div>
          </section>
        )}
      </section>
      </div>
      <p id={REORDER_HINT_ID} className="sr-only">Press Alt with the up or down arrow key to move this account.</p>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    </div>
  );
}
