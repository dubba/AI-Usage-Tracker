import { SIDEBAR_ID } from "../lib/constants";
import { MenuIcon } from "./icons";

/** The menu button that opens the sidebar on a narrow screen; the pages render it only when given `onToggle`. */
export function MobileSidebarToggle({ onToggle, open }: { onToggle: () => void; open?: boolean }) {
  return (
    <button
      type="button"
      className="mobile-sidebar-toggle-btn"
      onClick={onToggle}
      aria-expanded={open ?? false}
      aria-controls={SIDEBAR_ID}
      aria-label="Toggle navigation menu"
      data-tooltip="Toggle navigation menu"
    >
      <MenuIcon />
    </button>
  );
}
