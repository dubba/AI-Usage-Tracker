import { computeSyncStatus, splitSyncLabel } from "../features/dashboard/sync-status";
import { useClock } from "../shared/hooks/useClock";
import { isRefreshKey, type BusyKeys } from "../shared/lib/busy";
import { PlusIcon, RefreshIcon, UserPlusIcon } from "../shared/ui/icons";
import type { Account } from "../types";
import { MAIN_PAGES } from "./BottomNav";
import type { Section } from "./useSidebarNavigation";
import "./top-bar.css";

/** "Accounts synced 4m ago" as the top bar says it: "All accounts synced 4m ago". */
function topBarSyncLabel(label: string): string {
  const { title, elapsed } = splitSyncLabel(label);
  return elapsed ? `All accounts synced ${elapsed}` : title;
}

const PAGE_TOOLTIPS: Record<Section, string> = {
  accounts: "Dashboard of all your AI accounts",
  activity: "Shows daily usage across your AI accounts",
  settings: "Customize app preferences and sync devices",
};

/**
 * The bar across the top of a wide window: the Accounts, Usage and Settings pages,
 * then the sync status, Refresh all, and the New group and Add account buttons. A phone has none of this here: the sidebar overlay and the bottom bar hold it.
 */
export function TopBar({
  section,
  accounts,
  refreshMinutes,
  busy,
  inert,
  onSelect,
  onRefreshAll,
  onAddAccount,
  onAddGroup,
}: {
  section: Section;
  accounts: Account[];
  refreshMinutes: number;
  busy: BusyKeys;
  inert?: boolean;
  onSelect: (section: Section) => void;
  onRefreshAll: () => void;
  onAddAccount: () => void;
  onAddGroup: () => void;
}) {
  const syncing = [...busy].some(isRefreshKey);
  const tone = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).tone);
  const label = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).label);
  const detail = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).detail);

  return (
    <header className="top-bar" inert={inert}>
      <nav className="top-bar-nav" aria-label="Main">
        {MAIN_PAGES.map(({ section: target, label: pageLabel }) => {
          const active = section === target;
          return (
            <button
              key={target}
              type="button"
              className={`top-bar-nav-item${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              data-tooltip={PAGE_TOOLTIPS[target]}
              onClick={() => onSelect(target)}
            >
              {pageLabel}
            </button>
          );
        })}
      </nav>

      <div className="top-bar-actions">
        <span className={`top-bar-sync is-${syncing ? "syncing" : tone}`} role="status">
          <span className="top-bar-sync-dot" aria-hidden="true" />
          <span>{syncing ? "Syncing…" : topBarSyncLabel(label)}</span>
          {!syncing && detail ? <span className="top-bar-sync-detail">· {detail}</span> : null}
        </span>
        <button
          type="button"
          className={`top-bar-icon-button top-bar-refresh${syncing ? " spinning" : ""}`}
          onClick={onRefreshAll}
          disabled={syncing}
          aria-label="Refresh all accounts"
          data-tooltip="Refresh all accounts"
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="top-bar-icon-button top-bar-add-group"
          onClick={onAddGroup}
          aria-label="New group"
          data-tooltip={"Group accounts to track usage in\none place, like “Work” or “Personal”"}
        >
          <UserPlusIcon />
        </button>
        <button
          type="button"
          className="top-bar-add-account"
          onClick={onAddAccount}
          data-tooltip="Add new account"
        >
          <PlusIcon />Add account
        </button>
      </div>
    </header>
  );
}
