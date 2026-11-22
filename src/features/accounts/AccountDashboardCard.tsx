import { useId, useRef, useState } from "react";
import { busyKey, REFRESH_ALL_KEY, type BusyKeys } from "../../shared/lib/busy";
import { isCardCollapsedOnPage, setCardCollapsedOnPage } from "../layout/dashboard-page-state";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  RefreshIcon,
  TrashIcon,
} from "../../shared/ui/icons";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import {
  accountNeedsAttention,
  accountSignedOut,
  accountStatus,
  isWindowExpired,
  usageTone,
  cardWindows,
  nextResetSummary,
  windowLength,
} from "../../shared/lib/usage-logic";
import { formatElapsed, formatUpdatedAt } from "../../shared/lib/format";
import { displayAccountSubtitle, metricWindowParts } from "../../shared/lib/display";
import type {
  Account,
  Provider,
  UsageWindow,
} from "../../types";
import { useClock } from "../../shared/hooks/useClock";
import { useUsageDisplayMode } from "../../shared/hooks/usePreferences";
import { displayPercent, usageDisplaySuffix } from "../../shared/lib/usage-display";
import { reorderKeyDelta } from "../reorder/reorder-utils";
import { AccountUsageMetric } from "./AccountUsageMetric";
import { LimitResetsSection } from "./LimitResetsSection";
import { CREDENTIAL_PROTECTION_ACCOUNT_NOTE } from "../dashboard/credential-protection";
import { AccountCardMenu } from "./AccountCardMenu";
import { useInlineAccountRename } from "./useInlineAccountRename";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";
import { MOBILE_OVERLAY_QUERY } from "../sidebar/sidebar-width";

/** Id of the visually hidden hint that AccountsView renders once for every card. */
export const REORDER_HINT_ID = "account-reorder-hint";

/** "LIVE" / "AUTH NEEDED" as the desktop status chip says them: "Live" / "Auth needed". */
function statusChipLabel(label: string): string {
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Concise label for a compact single-row metric: e.g. "5h · Claude", "7d · Bot", "5h · Argon". */
function compactWindowLabel(window: UsageWindow, provider: Provider | string): string {
  const { span, name } = metricWindowParts(window, provider);
  const shortSpan = span
    ? span.replace(/-hour$/i, "h").replace(/-day$/i, "d")
    : null;
  return [shortSpan, name].filter(Boolean).join(" · ") || windowLength(window) || window.label;
}

export function AccountDashboardCard({
  pageId,
  account,
  compact = false,
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
  onUseLimitReset,
  signInUnprotected = false,
  highlighted = false,
}: {
  pageId: string;
  account: Account;
  compact?: boolean;
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
  /** Spends one saved limit reset. Absent in tests that never render the section. */
  onUseLimitReset?: (grantId: string) => void;
  /** This account's saved sign-in is still a plain file because locking it failed. */
  signInUnprotected?: boolean;
  highlighted?: boolean;
}) {
  const status = accountStatus(account);
  // Signed out, the card asks for one thing only: sign in again. Its notice holds the button.
  const signedOut = accountSignedOut(account);
  const accountErrorMessage = account.lastError;
  // Older usage is still on screen: point at Refresh.
  const outOfDate = !signedOut && account.lastUsage?.freshness === "stale";
  // A bar that still has a percent, but the reading is signed out, out of date, or unavailable, is striped.
  const usageStale = signedOut || account.lastUsage?.freshness === "stale" || account.lastUsage?.freshness === "unavailable";
  const plan = account.planDisplay;
  const needsAttention = accountNeedsAttention(account);
  const [isCollapsed, setIsCollapsed] = useState(() => isCardCollapsedOnPage(pageId, account.id));
  const rename = useInlineAccountRename(account, onRename);
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // A wide window gets the desktop header: a status chip (unless the account is live), the plan chip,
  // then Refresh, Alerts and a menu behind a chevron.
  const desktop = !useMediaQuery(MOBILE_OVERLAY_QUERY);
  // Collapsing a card switches it to the other layout on every width: a full card shrinks to the
  // compact row (with its bars), and while Compact view is on, a compact card opens to full. The
  // Compact button resets every card to its layout.
  const cardCompact = compact !== isCollapsed;
  // What the icon, its tooltip and the menu offer next: "Expand card" when the card is the smaller one.
  const shownCollapsed = cardCompact;

  const toggleCollapse = () => {
    // Persist outside the state updater: updaters must be pure (StrictMode runs them twice).
    const next = !isCollapsed;
    setIsCollapsed(next);
    setCardCollapsedOnPage(pageId, account.id, next);
  };
  const isRefreshing = busy.has(busyKey("refresh", account.id));
  const isRenaming = busy.has(busyKey("rename", account.id));
  const isRemoving = busy.has(busyKey("remove", account.id));
  const isUsingReset = busy.has(busyKey("reset", account.id));
  // Gate actions per account: refreshing or renaming one card must not freeze
  // the controls of every other card. A global "Refresh All" still locks
  // per-account refresh to avoid redundant provider calls, but leaves
  // remove/notify usable.
  const isGlobalRefresh = busy.has(REFRESH_ALL_KEY);
  const cardBusy = isRefreshing || isRenaming || isRemoving || isUsingReset;
  const limitResets = account.lastUsage?.limitResets ?? [];
  const windows = cardWindows(account.lastUsage?.windows ?? [], account.provider);
  const [displayMode] = useUsageDisplayMode();
  const modelsOnly = account.googleSetup === "key_only";
  const waitingForMetrics = account.googleSetup === "waiting";
  const googleUnavailableLabel = modelsOnly ? "Key only" : waitingForMetrics ? "Setup in progress" : "Unavailable";
  const updatedAtLabel = useClock((now) => formatUpdatedAt(account.lastUsage?.fetchedAt, now) ?? "Not updated yet");
  // The desktop Refresh button carries the time itself: "⟳ 8m ago".
  const updatedAgo = useClock((now) => {
    const fetchedAt = account.lastUsage?.fetchedAt ? new Date(account.lastUsage.fetchedAt).getTime() : Number.NaN;
    return Number.isFinite(fetchedAt) ? formatElapsed(now - fetchedAt) : "Not updated yet";
  });
  const updatedAgoId = useId();
  // Ids of the windows whose reset time has passed; their old percentages are no longer current.
  const expiredWindowIds = useClock((now) => {
    const currentNow = Math.max(now, Date.now());
    return windows.filter((window) => isWindowExpired(window.resetsAt, currentNow)).map((window) => window.id).join("\n");
  });
  const expiredWindows = new Set(expiredWindowIds ? expiredWindowIds.split("\n") : []);
  const soonestReset = useClock((now) => {
    const next = nextResetSummary([account], now);
    return next.account ? next.value : null;
  });
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

  // Both layouts share the card element, the provider button and these controls.
  const articleProps = {
    className: `provider-account-card${desktop ? " desktop-card" : ""}${cardCompact ? " is-compact" : ""} ${needsAttention ? "needs-attention" : ""} ${mobileMenuOpen ? "has-open-menu" : ""}${highlighted ? " is-alert-highlighted" : ""}`,
    "data-account-id": account.id,
    "data-reorder-provider": account.provider,
    "data-reorder-enabled": "true",
    draggable: false,
  };
  const providerButton = (
    <button
      ref={iconButtonRef}
      type="button"
      className={`account-card-provider-icon provider-${account.provider}${shownCollapsed ? " is-collapsed" : ""}`}
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
      data-tooltip={shownCollapsed ? "Expand card" : "Collapse card"}
      aria-label={shownCollapsed ? `Expand ${account.label}` : `Collapse ${account.label}`}
      aria-expanded={!shownCollapsed}
    >
      <ProviderIcon provider={account.provider} />
    </button>
  );
  const statusChip = status.label !== "LIVE" ? (
    <span className={`account-status-chip ${status.className}`}>
      <span className="account-status-chip-dot" aria-hidden="true" />
      {statusChipLabel(status.label)}
    </span>
  ) : null;
  const refreshButton = (
    <button
      type="button"
      className={`account-card-action refresh-action ${isRefreshing ? "spinning" : ""}${outOfDate ? " is-suggested" : ""}`}
      data-tooltip="Refresh this account"
      aria-label={`Refresh ${account.label}`}
      disabled={cardBusy || isGlobalRefresh}
      onClick={onRefresh}
    >
      <RefreshIcon />
    </button>
  );
  const alertsButton = (
    <button
      type="button"
      className="account-card-action notify-action"
      data-tooltip="Update account alerts"
      aria-label={`Configure usage notifications for ${account.label}`}
      disabled={cardBusy}
      onClick={onNotifications}
    >
      <BellIcon />
    </button>
  );
  const googleConnectButton = account.provider === "google_ai_studio" && !signedOut ? (
    <button type="button" className="button ghost compact-button google-cloud-connect-action" disabled={cardBusy} onClick={onConnectGoogleUsage}>
      {modelsOnly || waitingForMetrics ? "Connect Cloud Usage" : "Change Cloud Project"}
    </button>
  ) : null;
  const cardMenu = (
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
      variant={desktop ? "desktop" : undefined}
      collapsed={shownCollapsed}
      onToggleCollapse={toggleCollapse}
      onRename={rename.startEditing}
    />
  );
  const protectionNote = signInUnprotected ? (
    <p className="account-card-protection-note" role="status">
      {CREDENTIAL_PROTECTION_ACCOUNT_NOTE}
    </p>
  ) : null;

  if (cardCompact && !rename.editing) {
    return (
      <article {...articleProps}>
        <div className="compact-card-row">
          <span className="reorder-grip" data-tooltip="Drag to reorder" aria-hidden="true" />
          {providerButton}

          <div className="compact-card-identity">
            <h2 title={displayAccountSubtitle(account)}>{account.label}</h2>
            {statusChip}
            {plan ? <span className="account-plan-badge">{plan}</span> : null}
          </div>

          <div className={`compact-card-metrics${windows.length > 4 ? " is-two-col" : ""}`}>
            {windows.length ? windows.map((window) => {
              const expired = expiredWindows.has(window.id);
              const remaining = expired ? null : window.remainingPercent;
              const shown = remaining == null ? null : displayPercent(remaining, displayMode);
              const suffix = usageDisplaySuffix(displayMode);
              const width = shown == null ? 0 : Math.min(100, Math.max(0, shown));
              const tone = usageTone(remaining);
              const hatchTrack = shown == null;
              const missingText = expired ? "—" : googleUnavailableLabel;
              const missingAria = expired ? "Reset, usage unknown until the next refresh" : googleUnavailableLabel;
              const staleFill = usageStale && !hatchTrack;
              const { span, name } = metricWindowParts(window, account.provider);
              const label = compactWindowLabel(window, account.provider);
              const ariaLabel = `${[span, name].filter(Boolean).join(" ") || windowLength(window) || window.label} ${displayMode === "used" ? "used" : "remaining"}`;

              return (
                <div key={window.id} className={`compact-metric-item${staleFill ? " is-stale" : ""}`}>
                  <div className="compact-metric-head">
                    <span className="compact-metric-label" title={window.label}>{label}</span>
                    <span className={`compact-metric-value tone-${tone}`}>
                      {shown == null ? missingText : `${Math.round(shown)}%`}
                    </span>
                  </div>
                  <span
                    className={`account-metric-track${hatchTrack ? " is-hatched" : ""}`}
                    role="progressbar"
                    aria-label={ariaLabel}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={shown == null ? undefined : Math.round(shown)}
                    aria-valuetext={shown == null ? missingAria : `${Math.round(shown)}% ${suffix}`}
                  >
                    <span className={`tone-${tone}`} style={{ width: `${width}%` }} />
                  </span>
                </div>
              );
            }) : (
              <span className="compact-card-empty-status">
                {signedOut ? "Sign in required" : "Refresh to load limits"}
              </span>
            )}
          </div>

          <div className="compact-card-trailing">
            {signedOut ? (
              <button
                type="button"
                className="button primary compact-button compact-card-action-btn"
                disabled={cardBusy}
                onClick={onReconnect}
              >
                {account.provider === "google_ai_studio" ? "Reconnect" : "Sign in"}
              </button>
            ) : account.lastError ? (
              <button
                type="button"
                className="button ghost compact-button compact-card-action-btn"
                aria-label={`Retry refreshing ${account.label}`}
                disabled={cardBusy || isGlobalRefresh}
                onClick={onRefresh}
              >
                Retry
              </button>
            ) : soonestReset ? (
              <span className="compact-card-reset" title="Soonest quota reset">Resets {soonestReset}</span>
            ) : null}

            <div className={desktop ? "account-card-desktop-actions compact-card-actions" : "compact-card-actions"}>
              {desktop ? (
                <>
                  {refreshButton}
                  {alertsButton}
                </>
              ) : null}
              {cardMenu}
            </div>
          </div>
        </div>
        {protectionNote}
      </article>
    );
  }

  return (
    <article {...articleProps}>
      <header className="provider-account-card-header">
        <span className="reorder-grip" data-tooltip="Drag to reorder" aria-hidden="true" />
        {providerButton}
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
            ) : desktop ? (
              // On a wide window the name and the pencil are one click target, from the first letter
              // to the pencil. The pencil stays the keyboard control; its click bubbles up to here.
              <span className="account-card-name-hit" onClick={rename.startEditing}>
                <h2>{account.label}</h2>
                <button type="button" className="account-name-edit" data-tooltip="Edit account name" aria-label={`Edit ${account.label}`}>
                  <EditIcon />
                </button>
              </span>
            ) : <h2>{account.label}</h2>}
            {!rename.editing && !desktop ? (
              <button type="button" className="account-name-edit" data-tooltip="Edit account name" aria-label={`Edit ${account.label}`} onClick={rename.startEditing}>
                <EditIcon />
              </button>
            ) : null}
          </div>
          <p className="account-card-email">{displayAccountSubtitle(account)}</p>
          {rename.renameError ? <small className="account-card-inline-error">{rename.renameError}</small> : null}
        </div>
        {desktop ? (
          <div className="account-card-desktop-actions">
            {googleConnectButton}
            {statusChip}
            {plan ? <span className="account-plan-badge">{plan}</span> : null}
            <button
              type="button"
              className={`account-card-refresh-time refresh-action${isRefreshing ? " spinning" : ""}${outOfDate ? " is-suggested" : ""}`}
              data-tooltip="Refresh this account"
              aria-label={`Refresh ${account.label}`}
              aria-describedby={updatedAgoId}
              disabled={cardBusy || isGlobalRefresh}
              onClick={onRefresh}
            >
              <RefreshIcon />
              <span id={updatedAgoId} className="account-card-refresh-time-label">{updatedAgo}</span>
            </button>
            {alertsButton}
            {isRemoving ? <span className="account-card-action remove-action" aria-label={`Removing ${account.label}`} role="status"><span className="mini-spinner" /></span> : null}
            {cardMenu}
          </div>
        ) : (
          <div className={`account-card-header-actions ${account.provider === "google_ai_studio" && !signedOut ? "has-google-action" : ""}`}>
            <div className="account-card-header-meta">
              {statusChip}
              {plan ? (
                <span className="plan-with-dot">
                  <span className="account-plan-badge">{plan}</span>
                </span>
              ) : null}
              {googleConnectButton}
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
              {refreshButton}
              {alertsButton}
              <button
                type="button"
                className="account-card-action remove-action"
                data-tooltip="Remove this account"
                aria-label={`Remove ${account.label}`}
                disabled={cardBusy}
                onClick={onRemove}
              >{isRemoving ? <span className="mini-spinner" /> : <TrashIcon />}</button>
             </div>
              {cardMenu}
              </div>
            </div>
          </div>
        )}
      </header>

      {protectionNote}

      {signedOut ? (
        <div className="account-card-error is-signed-out">
          <span>{accountErrorMessage ?? "This account is signed out."}</span>
          <button type="button" className="button primary compact-button" disabled={cardBusy} onClick={onReconnect}>
            {account.provider === "google_ai_studio" ? "Reconnect Cloud Usage" : "Sign in again"}
          </button>
        </div>
      ) : account.lastError ? (
        <div className="account-card-error">
          <span>{accountErrorMessage ?? account.lastError}</span>
          <button
            type="button"
            className="button ghost compact-button"
            aria-label={`Retry refreshing ${account.label}`}
            disabled={cardBusy || isGlobalRefresh}
            onClick={onRefresh}
          >Retry</button>
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
            stale={usageStale}
          />
        )) : (
          <AccountUsageMetric unavailable signedOut={signedOut} creditLabel={creditLabel} />
        )}
      </div>
      {limitResets.length > 0 ? (
        <LimitResetsSection
          grants={limitResets}
          windows={account.lastUsage?.windows ?? []}
          accountLabel={account.label}
          busy={cardBusy}
          onUse={onUseLimitReset}
        />
      ) : null}
    </article>
  );
}
