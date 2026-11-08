import { useRef, type ReactNode, type RefObject } from "react";
import { SyncStatusLine } from "../features/dashboard/SyncStatusLine";
import { SidebarGroupRow } from "../features/dashboard/SidebarGroupRow";
import { SidebarResizeHandle } from "../features/dashboard/SidebarResizeHandle";
import { ALL_ACCOUNTS_GROUP_ID, isBucketGroup, type SidebarGroup } from "../features/dashboard/sidebar-groups";
import { SIDEBAR_ID } from "../shared/lib/constants";
import type { BusyKeys } from "../shared/lib/busy";
import { useScrollThumb } from "../shared/hooks/useScrollThumb";
import { CloseIcon, GaugeIcon, PlusIcon, StackPlusIcon } from "../shared/ui/icons";
import type { Account } from "../types";
import type { Section } from "./useSidebarNavigation";

/**
 * The navigation sidebar: the All accounts row and one row per group, with the sync status and
 * Refresh all at its foot on every width. On a wide window the app name and the Accounts, Usage and
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
  onAddAccount,
  onAddGroup,
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
  onAddAccount: () => void;
  onAddGroup: () => void;
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
          aria-label="Close navigation menu"
          data-tooltip="Close navigation menu"
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
        <SidebarSectionHeader
          title="Accounts"
          action={
            <button
              type="button"
              className="sidebar-section-button is-primary"
              onClick={onAddAccount}
              aria-label="Add new account"
              data-tooltip="Add new account"
            >
              <PlusIcon />
              <span className="sidebar-section-button-label">Account</span>
            </button>
          }
        />
        {accountGroups.map((group, index) => renderRow(group, index, accountGroups))}
        <SidebarSectionHeader
          title="Groups"
          action={
            <button
              type="button"
              className="sidebar-section-button"
              onClick={onAddGroup}
              aria-label="Add new group"
              data-tooltip={"Group accounts to track usage in\none place, like “Work” or “Personal”"}
            >
              <StackPlusIcon />
              <span className="sidebar-section-button-label">Group</span>
            </button>
          }
        />
        {bucketGroups.length === 0 ? (
          <p className="sidebar-section-empty">No groups yet</p>
        ) : (
          bucketGroups.map((group, index) => renderRow(group, index, bucketGroups))
        )}
      </div>

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
function SidebarSectionHeader({ title, action }: { title: string; action: ReactNode }) {
  return (
    <div className="sidebar-section-header">
      <span className="sidebar-section-title">{title}</span>
      {action}
    </div>
  );
}
