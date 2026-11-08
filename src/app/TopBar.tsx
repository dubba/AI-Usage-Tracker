import { PlusIcon, StackPlusIcon } from "../shared/ui/icons";
import { MAIN_PAGES } from "./BottomNav";
import type { Section } from "./useSidebarNavigation";
import "./top-bar.css";

const PAGE_TOOLTIPS: Record<Section, string> = {
  accounts: "Dashboard of all your AI accounts",
  activity: "Shows daily usage across your AI accounts",
  settings: "Customize app preferences and sync devices",
};

/**
 * The bar across the top of a wide window: the Accounts, Usage and Settings pages, then the Group
 * and Account add buttons (named like the phone sidebar's). The sync status and Refresh all are at the foot of the sidebar, as on a
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
        <button
          type="button"
          className="top-bar-icon-button top-bar-add-group has-label"
          onClick={onAddGroup}
          aria-label="Add new group"
          data-tooltip={"Group accounts to track usage in\none place, like “Work” or “Personal”"}
        >
          <StackPlusIcon />
          <span>Group</span>
        </button>
        <button
          type="button"
          className="top-bar-add-account"
          onClick={onAddAccount}
          aria-label="Add new account"
          data-tooltip="Add new account"
        >
          <PlusIcon />Account
        </button>
      </div>
    </header>
  );
}
