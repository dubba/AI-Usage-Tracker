import { useRef, type RefObject } from "react";
import { SyncStatusLine } from "../dashboard/SyncStatusLine";
import { SidebarGroupRow } from "./SidebarGroupRow";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { ALL_ACCOUNTS_GROUP_ID, isBucketGroup, type SidebarGroup } from "./sidebar-groups";
import { SIDEBAR_ID } from "../../shared/lib/constants";
import type { BusyKeys } from "../../shared/lib/busy";
import { useScrollThumb } from "../../shared/hooks/useScrollThumb";
import { ArrowUpCircleIcon, CloseIcon, DatabaseIcon, DevicesIcon, GaugeIcon, KeyboardIcon, PlugIcon, SettingsIcon } from "../../shared/ui/icons";
import { isMobileDevice } from "../../shared/lib/platform";
import type { Account, AccountBucket } from "../../types";
import type { Section } from "../../app/useSidebarNavigation";
import { SETTINGS_JUMP_SECTIONS, type SettingsSectionId } from "../settings/settings-sections";
import "../settings/settings-layout.css";

function settingsJumpIcon(id: SettingsSectionId) {
  switch (id) {
    case "general":
      return <SettingsIcon />;
    case "updates":
      return <ArrowUpCircleIcon />;
    case "devices":
    case "sync-options":
      return <DevicesIcon />;
    case "data":
      return <DatabaseIcon />;
    case "integrations":
      return <PlugIcon />;
    case "shortcuts":
      return <KeyboardIcon />;
  }
}

/**
 * The navigation sidebar: the All accounts row and one row per group, with the sync status and
 * Refresh all at its foot on every width. On a wide window when viewing Settings, it switches to
 * quick section jump links (General, Updates, Devices, Advanced).
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
  activeSettingsSection = "general",
  onJumpToSettingsSection,
  onClose,
  onSelectGroup,
  onMoveGroup,
  onEditBucket,
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
  activeSettingsSection?: SettingsSectionId;
  onJumpToSettingsSection?: (section: SettingsSectionId) => void;
  onClose: () => void;
  onSelectGroup: (groupId: string) => void;
  onMoveGroup: (group: SidebarGroup, delta: -1 | 1) => void;
  onEditBucket?: (bucket: AccountBucket) => void;
  onRefreshAll: () => void;
}) {
  // The list keeps room for its scroll bar only while it overflows, so the cards sit centered otherwise.
  const providerListRef = useRef<HTMLDivElement>(null);
  const showSettingsJump = topBar && section === "settings";
  const jumpSections = isMobileDevice()
    ? SETTINGS_JUMP_SECTIONS.filter((item) => !item.desktopOnly)
    : SETTINGS_JUMP_SECTIONS;
  const providerListOverflows = useScrollThumb(providerListRef, true, showSettingsJump ? jumpSections : groups).overflows;

  // Provider rows and custom groups share one saved order, but the sidebar lists them in two sections.
  const accountGroups = groups.filter((group) => !isBucketGroup(group));
  const bucketGroups = groups.filter(isBucketGroup);
  const showsSelectedGroup = section === "accounts" || (!topBar && section === "activity");
  const renderRow = (group: SidebarGroup, index: number, list: SidebarGroup[]) => (
    <SidebarGroupRow
      key={group.id}
      group={group}
      onMove={(delta) => {
        const target = index + delta;
        if (target >= 0 && target < list.length) onMoveGroup(group, delta);
      }}
      selected={showsSelectedGroup && selectedGroupId === group.id}
      onSelect={() => onSelectGroup(group.id)}
      onEditBucket={group.type === "bucket" ? onEditBucket : undefined}
    />
  );

  const allAccountsRow = (
    <SidebarGroupRow
      group={allAccountsGroup}
      selected={showsSelectedGroup && selectedGroupId === ALL_ACCOUNTS_GROUP_ID}
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

      {showSettingsJump ? (
        <div ref={providerListRef} className={`provider-list settings-jump-list${providerListOverflows ? " has-overflow" : ""}`}>
          <nav className="settings-jump-nav" aria-label="Settings sections">
            <div className="settings-jump-heading">Settings Section</div>
            {jumpSections
              .filter((item) => item.group === "settings")
              .map((item) => {
                const active = activeSettingsSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`settings-jump-item${active ? " is-active" : ""}`}
                    aria-current={active ? "location" : undefined}
                    onClick={() => onJumpToSettingsSection?.(item.id)}
                  >
                    <span className="settings-jump-icon" aria-hidden="true">{settingsJumpIcon(item.id)}</span>
                    <span className="settings-jump-text">
                      <span className="settings-jump-label">{item.label}</span>
                      <span className="settings-jump-hint">{item.hint}</span>
                    </span>
                  </button>
                );
              })}
            {jumpSections.some((item) => item.group === "advanced") ? (
              <>
                <div className="settings-jump-heading">Advanced Section</div>
                {jumpSections
                  .filter((item) => item.group === "advanced")
                  .map((item) => {
                    const active = activeSettingsSection === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`settings-jump-item${active ? " is-active" : ""}`}
                        aria-current={active ? "location" : undefined}
                        onClick={() => onJumpToSettingsSection?.(item.id)}
                      >
                        <span className="settings-jump-icon" aria-hidden="true">{settingsJumpIcon(item.id)}</span>
                        <span className="settings-jump-text">
                          <span className="settings-jump-label">{item.label}</span>
                          <span className="settings-jump-hint">{item.hint}</span>
                        </span>
                      </button>
                    );
                  })}
              </>
            ) : null}
          </nav>
        </div>
      ) : (
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
