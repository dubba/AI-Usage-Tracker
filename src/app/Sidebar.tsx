import { useRef, type RefObject } from "react";
import { SyncStatusLine } from "../features/dashboard/SyncStatusLine";
import { SidebarGroupRow } from "../features/dashboard/SidebarGroupRow";
import { SidebarResizeHandle } from "../features/dashboard/SidebarResizeHandle";
import { UsageDisplayToggle } from "../features/dashboard/UsageDisplayToggle";
import { ALL_ACCOUNTS_GROUP_ID, type SidebarGroup } from "../features/dashboard/sidebar-groups";
import { SIDEBAR_ID } from "../shared/lib/constants";
import type { BusyKeys } from "../shared/lib/busy";
import { useScrollThumb } from "../shared/hooks/useScrollThumb";
import { BarChartIcon, CloseIcon, GaugeIcon, GridIcon, PlusIcon, SettingsIcon } from "../shared/ui/icons";
import type { Account } from "../types";
import type { Section } from "./useSidebarNavigation";
import "./bottom-nav.css";
import "./sidebar-nav.css";

/** The page links at the bottom of the sidebar on a wide window; a phone has the bottom bar instead. */
const PAGE_LINKS = [
  { section: "activity", label: "Usage", Icon: BarChartIcon },
  { section: "accounts", label: "Accounts", Icon: GridIcon },
  { section: "settings", label: "Settings", Icon: SettingsIcon },
] as const satisfies ReadonlyArray<{ section: Section; label: string; Icon: typeof GridIcon }>;

/**
 * The navigation sidebar: add buttons, the All accounts row and one row per group, then (on wide
 * windows; a phone has the bottom bar) the Usage, Accounts and Settings links, and the sync status.
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
  showMainNav,
  onClose,
  onAddAccount,
  onAddGroup,
  onSelectGroup,
  onMoveGroup,
  onRefreshAll,
  onOpenSettings,
  onOpenActivity,
  onOpenAccounts,
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
  /** Show the Usage, Accounts and Settings links: the bottom bar is not there to offer them. */
  showMainNav: boolean;
  onClose: () => void;
  onAddAccount: () => void;
  onAddGroup: () => void;
  onSelectGroup: (groupId: string) => void;
  onMoveGroup: (group: SidebarGroup, delta: -1 | 1) => void;
  onRefreshAll: () => void;
  onOpenSettings: () => void;
  onOpenActivity: () => void;
  onOpenAccounts: () => void;
}) {
  // The list keeps room for its scroll bar only while it overflows, so the cards sit centered otherwise.
  const providerListRef = useRef<HTMLDivElement>(null);
  const providerListOverflows = useScrollThumb(providerListRef, true, groups).overflows;

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
      <div className="brand">
        <span className="brand-mark"><GaugeIcon /></span>
        <strong>AI Usage Tracker</strong>
      </div>

      <div className="provider-sidebar-heading">
        <div className="provider-sidebar-heading-stack">
          <div className="provider-sidebar-heading-actions">
            <button
              type="button"
              className="button primary add-account-header-button"
              data-tooltip="Add new account"
              aria-label="Add new account"
              onClick={onAddAccount}
            >
              <PlusIcon />Account
            </button>
            <button
              type="button"
              className="button primary add-bucket-header-button"
              data-tooltip={"Group accounts to track usage in\none place, like “Work” or “Personal”"}
              aria-label="Group accounts to track usage in one place, like “Work” or “Personal”"
              onClick={onAddGroup}
            >
              <PlusIcon />Group
            </button>
          </div>
          <UsageDisplayToggle />
        </div>
      </div>

      <div ref={providerListRef} className={`provider-list${providerListOverflows ? " has-overflow" : ""}`}>
        <SidebarGroupRow
          group={allAccountsGroup}
          selected={section === "accounts" && selectedGroupId === ALL_ACCOUNTS_GROUP_ID}
          onSelect={() => onSelectGroup(ALL_ACCOUNTS_GROUP_ID)}
        />
        {groups.map((group, index) => (
          <SidebarGroupRow
            key={group.id}
            group={group}
            onMove={(delta) => {
              const target = index + delta;
              if (target >= 0 && target < groups.length) onMoveGroup(group, delta);
            }}
            selected={section === "accounts" && selectedGroupId === group.id}
            onSelect={() => onSelectGroup(group.id)}
          />
        ))}
      </div>

      {showMainNav ? (
        <nav className="sidebar-main-nav" aria-label="Main">
          {PAGE_LINKS.map(({ section: target, label, Icon }) => {
            const active = section === target;
            return (
              <button
                key={target}
                type="button"
                className={`bottom-nav-item${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={target === "activity" ? onOpenActivity : target === "accounts" ? onOpenAccounts : onOpenSettings}
              >
                <Icon />
                {label}
              </button>
            );
          })}
        </nav>
      ) : null}

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
