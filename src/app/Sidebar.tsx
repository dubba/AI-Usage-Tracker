import { useRef, type RefObject } from "react";
import { SyncStatusLine } from "../features/dashboard/SyncStatusLine";
import { SidebarGroupRow } from "../features/dashboard/SidebarGroupRow";
import { SidebarResizeHandle } from "../features/dashboard/SidebarResizeHandle";
import { UsageDisplayToggle } from "../features/dashboard/UsageDisplayToggle";
import { ALL_ACCOUNTS_GROUP_ID, isBucketGroup, type SidebarGroup } from "../features/dashboard/sidebar-groups";
import { SIDEBAR_ID } from "../shared/lib/constants";
import type { BusyKeys } from "../shared/lib/busy";
import { useScrollThumb } from "../shared/hooks/useScrollThumb";
import { CloseIcon, GaugeIcon } from "../shared/ui/icons";
import type { Account } from "../types";
import type { Section } from "./useSidebarNavigation";

/**
 * The navigation sidebar: the All accounts row and one row per group, with the sync status and
 * Refresh all at its foot on every width. On a wide window the app name and the Dashboard, Usage and
 * Settings pages are in the top bar (TopBar.tsx); on a phone the pages are in the bottom bar.
 */
export function Sidebar({
  sidebarRef,
  shellRef,
  open,
  hidden,
  modal,
  section,
  selectedGroupId,
  allAccountsGroup,
  groups,
  accounts,
  refreshMinutes,
  busy,
  topBar,
  onClose,
  onSelectGroup,
  onMoveGroup,
  onRefreshAll,
}: {
  sidebarRef: RefObject<HTMLElement | null>;
  shellRef: RefObject<HTMLDivElement | null>;
  /** The mobile overlay is showing. */
  open: boolean;
  /** An off-canvas overlay that is closed: unreachable for the keyboard and screen readers. */
  hidden: boolean;
  /** An off-canvas overlay that is open: a modal dialog. */
  modal: boolean;
  section: Section;
  selectedGroupId: string;
  allAccountsGroup: SidebarGroup;
  groups: SidebarGroup[];
  accounts: Account[];
  refreshMinutes: number;
  busy: BusyKeys;
  /** The top bar is showing and holds the app name and the page switch. */
  topBar: boolean;
  onClose: () => void;
  onSelectGroup: (groupId: string) => void;
  onMoveGroup: (group: SidebarGroup, delta: -1 | 1) => void;
  onRefreshAll: () => void;
}) {
  // The list keeps room for its scroll bar only while it overflows, so the cards sit centered otherwise.
  const providerListRef = useRef<HTMLDivElement>(null);
  const providerListOverflows = useScrollThumb(providerListRef, true, groups).overflows;

  // Provider rows and custom groups share one saved order, but the sidebar lists them in two sections.
  const accountGroups = groups.filter((group) => !isBucketGroup(group));
  const bucketGroups = groups.filter(isBucketGroup);
  const renderRow = (group: SidebarGroup, index: number, list: SidebarGroup[]) => (
    <SidebarGroupRow
      key={group.id}
      group={group}
      onMove={(delta) => {
        const target = index + delta;
        if (target >= 0 && target < list.length) onMoveGroup(group, delta);
      }}
      selected={section === "accounts" && selectedGroupId === group.id}
      onSelect={() => onSelectGroup(group.id)}
    />
  );

  const allAccountsRow = (
    <SidebarGroupRow
      group={allAccountsGroup}
      selected={section === "accounts" && selectedGroupId === ALL_ACCOUNTS_GROUP_ID}
      onSelect={() => onSelectGroup(ALL_ACCOUNTS_GROUP_ID)}
    />
  );

  return (
    <aside
      ref={sidebarRef}
      id={SIDEBAR_ID}
      className={`sidebar ${open ? "mobile-open" : ""}`}
      inert={hidden}
      role={modal ? "dialog" : undefined}
      aria-modal={modal ? true : undefined}
      aria-label={modal ? "Navigation menu" : undefined}
    >
      <div className="sidebar-mobile-header">
        <button
          type="button"
          className="mobile-sidebar-toggle-btn mobile-sidebar-close-btn"
          onClick={onClose}
          aria-label="Close accounts and groups"
          data-tooltip="Close accounts and groups"
        >
          <CloseIcon />
        </button>
        <span className="eyebrow sidebar-title">AI Usage Tracker</span>
      </div>
      {topBar ? null : (
        <div className="brand">
          <span className="brand-mark"><GaugeIcon /></span>
          <strong>AI Usage Tracker</strong>
        </div>
      )}

      <div ref={providerListRef} className={`provider-list${providerListOverflows ? " has-overflow" : ""}`}>
        {allAccountsRow}
        <SidebarSectionHeader title="Accounts" />
        {accountGroups.length === 0 ? (
          <p className="sidebar-section-empty">No accounts yet</p>
        ) : (
          accountGroups.map((group, index) => renderRow(group, index, accountGroups))
        )}
        <SidebarSectionHeader title="Groups" />
        {bucketGroups.length === 0 ? (
          <p className="sidebar-section-empty">No groups yet</p>
        ) : (
          bucketGroups.map((group, index) => renderRow(group, index, bucketGroups))
        )}
      </div>

      {/* Phone overlay: the % Left / % Used switch, full width and pinned above the sync line, outside
          the scrolling list. It changes these meters and every card, on every page. A wide window
          keeps it at the Dashboard header's top right (AccountsView). */}
      {topBar ? null : (
        <div className="sidebar-display-switch">
          <UsageDisplayToggle labels="words" className="provider-window-toggle usage-display-toggle is-words" />
        </div>
      )}

      <SyncStatusLine
        accounts={accounts}
        refreshMinutes={refreshMinutes}
        busy={busy}
        onRefreshAll={onRefreshAll}
      />
      <SidebarResizeHandle shellRef={shellRef} sidebarRef={sidebarRef} />
    </aside>
  );
}

/** A small label above one list of rows, with an optional small button at its right edge. */
function SidebarSectionHeader({ title, className }: { title: string; className?: string }) {
  return (
    <div className={className ? `sidebar-section-header ${className}` : "sidebar-section-header"}>
      <span className="sidebar-section-title">{title}</span>
    </div>
  );
}
