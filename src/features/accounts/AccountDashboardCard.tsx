import { useEffect, useRef, useState } from "react";
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
  formatUpdatedAt,
  orderedWindows,
} from "../../shared/lib/usage-logic";
import {
  displayAccountSubtitle,
  displayPlan,
} from "../../shared/lib/display";
import type {
  Account,
} from "../../types";
import { useClock } from "../../shared/hooks/useClock";
import { reorderKeyDelta } from "../reorder/reorder-utils";
import { AccountUsageMetric } from "./AccountUsageMetric";

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
}) {
  const status = accountStatus(account);
  const plan = displayPlan(account);
  const needsAttention = accountNeedsAttention(account);
  const [isCollapsed, setIsCollapsed] = useState(() => isCardCollapsedOnPage(pageId, account.id));
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [renameError, setRenameError] = useState<string | null>(null);
  const committingRenameRef = useRef(false);
  const iconButtonRef = useRef<HTMLButtonElement>(null);

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
  const windows = orderedWindows(account.lastUsage?.windows ?? []);
  const modelsOnly = account.provider === "google_ai_studio" && account.lastUsage?.source === "google_ai_studio_model_access";
  const waitingForMetrics = account.provider === "google_ai_studio" && account.lastUsage?.source === "google_ai_studio_monitoring_waiting";
  const googleUnavailableLabel = modelsOnly ? "Key only" : waitingForMetrics ? "Setup in progress" : "Unavailable";
  const updatedAtLabel = useClock((now) => formatUpdatedAt(account.lastUsage?.fetchedAt, now) ?? "Not updated yet");
  const creditLabel = account.provider !== "openai"
    ? null
    : account.lastUsage?.unlimitedCredits
      ? "Credits: Unlimited"
      : account.lastUsage?.creditsUsd != null
        ? `Credits: $${account.lastUsage.creditsUsd.toFixed(2)}`
        : null;

  useEffect(() => {
    if (!editing) setLabel(account.label);
  }, [account.label, editing]);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setMobileMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileMenuOpen]);

  const requestMove = (delta: -1 | 1) => {
    if (!onMove || (delta < 0 ? !canMoveUp : !canMoveDown)) return;
    onMove(delta);
    // React moves the card's DOM node, which drops focus; put it back once the move has rendered.
    window.setTimeout(() => iconButtonRef.current?.focus(), 0);
  };

  const commitRename = async () => {
    const next = label.trim();
    if (!next) {
      setRenameError("Account name is required.");
      return;
    }
    if (next === account.label) {
      setEditing(false);
      setRenameError(null);
      return;
    }
    if (committingRenameRef.current) return;
    committingRenameRef.current = true;
    try {
      await onRename(next);
      setEditing(false);
      setRenameError(null);
    } catch {
      setRenameError("Unable to rename this account.");
    } finally {
      committingRenameRef.current = false;
    }
  };

  const cancelRename = () => {
    setLabel(account.label);
    setRenameError(null);
    setEditing(false);
  };

  return (
    <article
      className={`provider-account-card ${needsAttention ? "needs-attention" : ""} ${isCollapsed ? "is-collapsed" : ""}`}
      data-account-id={account.id}
      data-reorder-provider={account.provider}
      data-reorder-enabled="true"
      draggable={false}
    >
      <header className="provider-account-card-header">
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
          data-tooltip={isCollapsed ? "Expand card" : "Shrink card"}
          aria-label={isCollapsed ? `Expand ${displayAccountLabel(account)}` : `Shrink ${displayAccountLabel(account)} to divider`}
          aria-expanded={!isCollapsed}
        >
          <ProviderIcon provider={account.provider} />
        </button>
        <div className="account-card-identity">
          <div className="account-card-name-row">
            {editing ? (
              <div className="account-card-name-edit-wrap">
                <input
                  className="account-card-name-input"
                  value={label}
                  maxLength={80}
                  disabled={isRenaming}
                  autoFocus
                  aria-label={`Rename ${account.label}`}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setRenameError(null);
                  }}
                  onBlur={cancelRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
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
                    onClick={cancelRename}
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
                    onClick={() => void commitRename()}
                  >
                    {isRenaming ? <span className="mini-spinner" /> : <CheckIcon />}
                  </button>
                </div>
              </div>
            ) : <h2>{displayAccountLabel(account)}</h2>}
            {!editing ? (
              <button type="button" className="account-name-edit" data-tooltip="Edit account name" aria-label={`Edit ${account.label}`} onClick={() => setEditing(true)}>
                <EditIcon />
              </button>
            ) : null}
          </div>
          <p className="account-card-email">{displayAccountSubtitle(account)}</p>
          {renameError ? <small className="account-card-inline-error">{renameError}</small> : null}
        </div>
        <div className={`account-card-header-actions ${account.provider === "google_ai_studio" ? "has-google-action" : ""}`}>
          <div className="account-card-header-meta">
            {status.label !== "LIVE" ? <span className={`account-status-badge ${status.className}`}>{status.label}</span> : null}
            <span className="plan-with-dot">
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
              className="account-card-action remove-action"
              data-tooltip="Remove this account"
              aria-label={`Remove ${account.label}`}
              disabled={cardBusy}
              onClick={onRemove}
            >{isRemoving ? <span className="mini-spinner" /> : <TrashIcon />}</button>
            <button
              type="button"
              className="account-card-action notify-action"
              data-tooltip="Usage notifications"
              aria-label={`Configure usage notifications for ${account.label}`}
              disabled={cardBusy}
              onClick={onNotifications}
            ><BellIcon /></button>
            <button
              type="button"
              className={`account-card-action refresh-action ${isRefreshing ? "spinning" : ""}`}
              data-tooltip="Refresh this account"
              aria-label={`Refresh ${account.label}`}
              disabled={cardBusy || isGlobalRefresh}
              onClick={onRefresh}
            ><RefreshIcon /></button>
           </div>
            <div className="mobile-actions-dropdown" ref={mobileMenuRef}>
              <button
                type="button"
                className="mobile-dropdown-toggle"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-expanded={mobileMenuOpen}
                aria-label="More actions"
              >
                <ChevronIcon className={mobileMenuOpen ? "open" : ""} />
              </button>
              {mobileMenuOpen ? (
                <div className="mobile-dropdown-menu">
                  {onMove ? (
                    <>
                      <button type="button" className="mobile-dropdown-item move-action" disabled={cardBusy || !canMoveUp} onClick={() => { setMobileMenuOpen(false); requestMove(-1); }}>
                        <ArrowUpIcon /> Move up
                      </button>
                      <button type="button" className="mobile-dropdown-item move-action" disabled={cardBusy || !canMoveDown} onClick={() => { setMobileMenuOpen(false); requestMove(1); }}>
                        <ArrowDownIcon /> Move down
                      </button>
                    </>
                  ) : null}
                  <button type="button" className="mobile-dropdown-item refresh-action" disabled={cardBusy || isGlobalRefresh} onClick={() => { setMobileMenuOpen(false); onRefresh(); }}>
                    <RefreshIcon /> Refresh
                  </button>
                  <button type="button" className="mobile-dropdown-item notify-action" disabled={cardBusy} onClick={() => { setMobileMenuOpen(false); onNotifications(); }}>
                    <BellIcon /> Notifications
                  </button>
                  <button type="button" className="mobile-dropdown-item remove-action" disabled={cardBusy} onClick={() => { setMobileMenuOpen(false); onRemove(); }}>
                    <TrashIcon /> Delete
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {!isCollapsed ? (
        <>
          {account.lastError ? (
            <div className="account-card-error">
              <span>{account.lastError}</span>
              {account.authRequired ? <button className="button ghost compact-button" onClick={onReconnect}>{account.provider === "google_ai_studio" ? "Reconnect Cloud Usage" : "Reconnect"}</button> : null}
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
              <div className="account-usage-metric unavailable-metric">
                <div className="metric-divider-row">
                  <span className="metric-divider-line" aria-hidden="true" />
                </div>
                <div className="metric-value-row">
                  <span className="account-metric-track"><span className="tone-neutral" style={{ width: "0%" }} /></span>
                  {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
                </div>
                <div className="metric-detail-row">
                  <span className="metric-percent-line">
                    <strong className="metric-full-value">Unavailable</strong>
                  </span>
                  <span className="metric-reset">Refresh this account to retrieve its limits.</span>
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}
    </article>
  );
}
