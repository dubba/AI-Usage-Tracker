import { SIDEBAR_ID } from "../lib/constants";
import { FilterIcon } from "./icons";

/**
 * The button that opens the sidebar on a narrow screen; the pages render it only when given
 * `onToggle`. It is a funnel, not a hamburger: the sidebar lists accounts and groups to filter the
 * page by, and the pages themselves are in the bottom bar.
 */
export function MobileSidebarToggle({ onToggle, open }: { onToggle: () => void; open?: boolean }) {
  return (
    <button
      type="button"
      className="mobile-sidebar-toggle-btn"
      onClick={onToggle}
      aria-expanded={open ?? false}
      aria-controls={SIDEBAR_ID}
      aria-label="Filter by account or group"
      data-tooltip="Filter by account or group"
    >
      <FilterIcon />
    </button>
  );
}
