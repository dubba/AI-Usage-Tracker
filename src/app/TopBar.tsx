import { useRef } from "react";
import { PlusIcon, StackPlusIcon } from "../shared/ui/icons";
import { useSegmentIndicator } from "../shared/ui/segment-indicator";
import { MAIN_PAGES } from "./BottomNav";
import type { Section } from "./useSidebarNavigation";
import "./top-bar.css";

const PAGE_TOOLTIPS: Record<Section, string> = {
  accounts: "Lists all your AI accounts, their limits, and reset times",
  activity: "Shows daily usage across your AI accounts",
  settings: "Customize app preferences and sync devices",
};

/**
 * The bar across the top of a wide window: the Dashboard, Usage and Settings pages, then the Group and
 * Account buttons (Compact is in the Dashboard header). The sync status and Refresh all are at the foot of the sidebar, as on a
 * phone. A phone has no top bar: the sidebar overlay and the bottom bar hold all of this.
 */
export function TopBar({
  section,
  inert,
  onSelect,
  onAddAccount,
  onAddGroup,
}: {
  section: Section;
  inert?: boolean;
  onSelect: (section: Section) => void;
  onAddAccount: () => void;
  onAddGroup: () => void;
}) {
  const pagesRef = useRef<HTMLElement>(null);
  useSegmentIndicator(pagesRef);
  return (
    <header className="top-bar" inert={inert}>
      <nav className="top-bar-nav segmented" aria-label="Main" ref={pagesRef}>
        {MAIN_PAGES.map(({ section: target, label: pageLabel, Icon }) => {
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
              <Icon />
              {pageLabel}
            </button>
          );
        })}
      </nav>

      <div className="top-bar-actions">
        <button
          type="button"
          className="top-bar-icon-button top-bar-add-group has-label"
          onClick={onAddGroup}
          aria-label="Add new group"
          data-tooltip={"Group AI accounts to track their usage\ntogether, such as Work or Personal"}
        >
          <StackPlusIcon />
          <span>Group</span>
        </button>
        <button
          type="button"
          className="top-bar-add-account"
          onClick={onAddAccount}
          aria-label="Add new account"
          data-tooltip="Connect an AI account to track usage"
        >
          <PlusIcon />Account
        </button>
      </div>
    </header>
  );
}
