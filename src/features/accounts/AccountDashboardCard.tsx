import { useRef, useState } from "react";
import { busyKey, REFRESH_ALL_KEY, type BusyKeys } from "../../shared/lib/busy";
import { isCardCollapsedOnPage, setCardCollapsedOnPage } from "../dashboard/dashboard-page-state";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  EditIcon,
  RefreshIcon,
  TrashIcon,
} from "../../shared/ui/icons";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import {
  displayAccountLabel,
  accountNeedsAttention,
  accountStatus,
  usageTone,
  formatUpdatedAt,
  cardWindows,
} from "../../shared/lib/usage-logic";
import {
  displayAccountSubtitle,
  displayPlan,
} from "../../shared/lib/display";
import type {
  Account,
} from "../../types";
import { useClock } from "../../shared/hooks/useClock";
import { useUsageDisplayMode } from "../../shared/hooks/useUsageDisplayMode";
import { displayPercent, usageDisplaySuffix } from "../../shared/lib/usage-display";
import { isGoogleKeyOnly, isGoogleSetupPending } from "../../shared/lib/usage-sources";
import { reorderKeyDelta } from "../reorder/reorder-utils";
import { AccountUsageMetric } from "./AccountUsageMetric";
import { CREDENTIAL_PROTECTION_ACCOUNT_NOTE } from "../dashboard/credential-protection";
import { AccountCardMenu } from "./AccountCardMenu";
import { useInlineAccountRename } from "./useInlineAccountRename";

/** Id of the visually hidden hint that AccountsView renders once for every card. */
export const REORDER_HINT_ID = "account-reorder-hint";


export function AccountDashboardCard({
  pageId,
  account,
  busy,
  onRefresh,
  onReconnect,
  onConnectGoogleUsage,
  onRename,
  onRemove,
  onNotifications,
  canMoveUp = false,
  canMoveDown = false,
  onMove,
  signInUnprotected = false,
}: {
  pageId: string;
  account: Account;
  busy: BusyKeys;
  onRefresh: () => void;
  onReconnect: () => void;
  onConnectGoogleUsage: () => void;
  onRename: (label: string) => Promise<void>;
  onRemove: () => void;
  onNotifications: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMove?: (delta: -1 | 1) => void;
  /** This account's saved sign-in is still a plain file because locking it failed. */
  signInUnprotected?: boolean;
}) {
  const status = accountStatus(account);
  const plan = displayPlan(account);
  const needsAttention = accountNeedsAttention(account);
  const [isCollapsed, setIsCollapsed] = useState(() => isCardCollapsedOnPage(pageId, account.id));
  const rename = useInlineAccountRename(account, onRename);
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const toggleCollapse = () => {
    // Persist outside the state updater: updaters must be pure (StrictMode runs them twice).
    const next = !isCollapsed;
    setIsCollapsed(next);
    setCardCollapsedOnPage(pageId, account.id, next);
  };
  const isRefreshing = busy.has(busyKey("refresh", account.id));
  const isRenaming = busy.has(busyKey("rename", account.id));
  const isRemoving = busy.has(busyKey("remove", account.id));
  // Gate actions per account: refreshing or renaming one card must not freeze
  // the controls of every other card. A global "Refresh All" still locks
  // per-account refresh to avoid redundant provider calls, but leaves
  // remove/notify usable.
  const isGlobalRefresh = busy.has(REFRESH_ALL_KEY);
  const cardBusy = isRefreshing || isRenaming || isRemoving;
  const windows = cardWindows(account.lastUsage?.windows ?? [], account.provider);
  const remainingValues = windows.flatMap((window) => (window.remainingPercent == null ? [] : [window.remainingPercent]));
  const lowestRemaining = remainingValues.length ? Math.min(...remainingValues) : null;
  const [displayMode] = useUsageDisplayMode();
  const modelsOnly = isGoogleKeyOnly(account);
  const waitingForMetrics = isGoogleSetupPending(account);
  const googleUnavailableLabel = modelsOnly ? "Key only" : waitingForMetrics ? "Setup in progress" : "Unavailable";
  const updatedAtLabel = useClock((now) => formatUpdatedAt(account.lastUsage?.fetchedAt, now) ?? "Not updated yet");
  const creditLabel = account.provider !== "openai"
    ? null
    : account.lastUsage?.unlimitedCredits
      ? "Credits: Unlimited"
      : account.lastUsage?.creditsUsd != null
        ? `Credits: $${account.lastUsage.creditsUsd.toFixed(2)}`
        : null;

  const requestMove = (delta: -1 | 1) => {
    if (!onMove || (delta < 0 ? !canMoveUp : !canMoveDown)) return;
    onMove(delta);
    // React moves the card's DOM node, which drops focus; put it back once the move has rendered.
    window.setTimeout(() => iconButtonRef.current?.focus(), 0);
  };

  return (
    <article
      className={`provider-account-card ${needsAttention ? "needs-attention" : ""} ${isCollapsed ? "is-collapsed" : ""} ${mobileMenuOpen ? "has-open-menu" : ""}`}
      data-account-id={account.id}
      data-reorder-provider={account.provider}
      data-reorder-enabled="true"
      draggable={false}
    >
      <header className="provider-account-card-header">
        <span className="reorder-grip" data-tooltip="Drag to reorder" aria-hidden="true" />
        <button
          ref={iconButtonRef}
          type="button"
          className={`account-card-provider-icon provider-${account.provider}${isCollapsed ? " is-collapsed" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            toggleCollapse();
          }}
          onKeyDown={(event) => {
            const delta = onMove ? reorderKeyDelta(event) : null;
            if (delta == null) return;
            event.preventDefault();
            requestMove(delta);
          }}
          aria-keyshortcuts={onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          aria-describedby={onMove ? REORDER_HINT_ID : undefined}
          data-tooltip={isCollapsed ? "Expand card" : "Collapse card"}
          aria-label={isCollapsed ? `Expand ${displayAccountLabel(account)}` : `Collapse ${displayAccountLabel(account)}`}
          aria-expanded={!isCollapsed}
        >
          <ProviderIcon provider={account.provider} />
          <span className="collapse-chevron" aria-hidden="true"><ChevronIcon /></span>
        </button>
        <div className="account-card-identity">
          <div className="account-card-name-row">
            {rename.editing ? (
              <div className="account-card-name-edit-wrap">
                <input
                  className="account-card-name-input"
                  value={rename.label}
                  maxLength={80}
                  disabled={isRenaming}
                  autoFocus
                  aria-label={`Rename ${account.label}`}
                  onChange={(event) => rename.setLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void rename.commit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      rename.cancel();
                    }
                  }}
                />
                <div className="account-card-name-edit-actions">
                  <button
                    type="button"
                    className="account-name-cancel"
                    data-tooltip="Cancel"
                    aria-label={`Cancel renaming ${account.label}`}
                    disabled={isRenaming}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={rename.cancel}
                  >
                    <CloseIcon />
                  </button>
                  <button
                    type="button"
                    className="account-name-confirm"
                    data-tooltip="Save name"
                    aria-label={`Save name for ${account.label}`}
                    disabled={isRenaming}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void rename.commit()}
                  >
                    {isRenaming ? <span className="mini-spinner" /> : <CheckIcon />}
                  </button>
                </div>
              </div>
            ) : <h2>{displayAccountLabel(account)}</h2>}
            {!rename.editing ? (
              <button type="button" className="account-name-edit" data-tooltip="Edit account name" aria-label={`Edit ${account.label}`} onClick={rename.startEditing}>
                <EditIcon />
              </button>
            ) : null}
          </div>
          <p className="account-card-email">{displayAccountSubtitle(account)}</p>
          {rename.renameError ? <small className="account-card-inline-error">{rename.renameError}</small> : null}
        </div>
        <div className={`account-card-header-actions ${account.provider === "google_ai_studio" ? "has-google-action" : ""}`}>
          <div className="account-card-header-meta">
            {status.label !== "LIVE" ? <span className={`account-status-badge ${status.className}`}>{status.label}</span> : null}
            <span className="plan-with-dot">
              {isCollapsed && lowestRemaining != null ? (
                <span className={`collapsed-summary tone-${usageTone(lowestRemaining)}`}>{Math.round(displayPercent(lowestRemaining, displayMode))}% {usageDisplaySuffix(displayMode)}</span>
              ) : null}
              <span
                className={`live-dot ${needsAttention || status.label !== "LIVE" ? "attention" : ""}`}
                aria-hidden="true"
              />
              {plan ? <span className="account-plan-badge">{plan}</span> : null}
            </span>
            {account.provider === "google_ai_studio" ? (
              <button type="button" className="button ghost compact-button google-cloud-connect-action" disabled={cardBusy} onClick={onConnectGoogleUsage}>
                {modelsOnly || waitingForMetrics ? "Connect Cloud Usage" : "Change Cloud Project"}
              </button>
            ) : null}
          </div>
          <div className="account-card-action-stack">
            <p className="account-card-updated">{updatedAtLabel}</p>
            <div className="account-card-action-row">
            <div className="account-card-name-actions desktop-only">
            {onMove ? (
              <>
                <button
                  type="button"
                  className="account-card-action move-action"
                  data-tooltip="Move up"
                  aria-label={`Move ${account.label} up`}
                  disabled={cardBusy || !canMoveUp}
                  onClick={() => requestMove(-1)}
                ><ArrowUpIcon /></button>
                <button
                  type="button"
                  className="account-card-action move-action"
                  data-tooltip="Move down"
                  aria-label={`Move ${account.label} down`}
                  disabled={cardBusy || !canMoveDown}
                  onClick={() => requestMove(1)}
                ><ArrowDownIcon /></button>
              </>
            ) : null}
            <button
              type="button"
              className={`account-card-action refresh-action ${isRefreshing ? "spinning" : ""}`}
              data-tooltip="Refresh this account"
              aria-label={`Refresh ${account.label}`}
              disabled={cardBusy || isGlobalRefresh}
              onClick={onRefresh}
            ><RefreshIcon /></button>
            <button
              type="button"
              className="account-card-action notify-action"
              data-tooltip="Update account alerts"
              aria-label={`Configure usage notifications for ${account.label}`}
              disabled={cardBusy}
              onClick={onNotifications}
            ><BellIcon /></button>
            <button
              type="button"
              className="account-card-action remove-action"
              data-tooltip="Remove this account"
              aria-label={`Remove ${account.label}`}
              disabled={cardBusy}
              onClick={onRemove}
            >{isRemoving ? <span className="mini-spinner" /> : <TrashIcon />}</button>
           </div>
            <AccountCardMenu
              account={account}
              open={mobileMenuOpen}
              onOpenChange={setMobileMenuOpen}
              hasMove={Boolean(onMove)}
              canMoveUp={canMoveUp}
              canMoveDown={canMoveDown}
              cardBusy={cardBusy}
              refreshDisabled={isGlobalRefresh}
              onMove={requestMove}
              onRefresh={onRefresh}
              onNotifications={onNotifications}
              onRemove={onRemove}
            />
            </div>
          </div>
        </div>
      </header>

      {signInUnprotected ? (
        <p className="account-card-protection-note" role="status">
          {CREDENTIAL_PROTECTION_ACCOUNT_NOTE}
        </p>
      ) : null}

      {!isCollapsed ? (
        <>
          {account.lastError ? (
            <div className="account-card-error">
              <span>{account.lastError}</span>
              {account.authRequired ? <button type="button" className="button ghost compact-button" onClick={onReconnect}>{account.provider === "google_ai_studio" ? "Reconnect Cloud Usage" : "Reconnect"}</button> : null}
            </div>
          ) : null}

          <div className={`account-card-metrics${windows.length > 1 ? " two-column-metrics" : ""}${windows.length > 2 ? " multi-row-metrics" : ""}`}>
            {windows.length ? windows.map((window, index) => (
              <AccountUsageMetric
                key={window.id}
                window={window}
                provider={account.provider}
                unavailableLabel={googleUnavailableLabel}
                creditLabel={index === 0 ? creditLabel : null}
              />
            )) : (
              <AccountUsageMetric unavailable creditLabel={creditLabel} />
            )}
          </div>
        </>
      ) : null}
    </article>
  );
}
