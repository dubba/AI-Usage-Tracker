import type { ReactNode } from "react";
import { SIDEBAR_ID } from "../lib/constants";
import { ChevronDownIcon, FilterIcon } from "./icons";

/**
 * The button that opens the sidebar on a narrow screen; Dashboard and Usage render it with the
 * active filter label so it reads as a filter picker rather than page navigation. Settings hides
 * it because Settings is global.
 *
 * `trailing` (the Dashboard's Edit Group pen) is drawn inside the pill's right end. It stays a
 * button of its own beside this one, not inside it, so each keeps its own click and label.
 */
export function MobileSidebarToggle({
  onToggle,
  open,
  filterLabel,
  isFiltered = false,
  trailing,
}: {
  onToggle: () => void;
  open?: boolean;
  filterLabel?: string;
  isFiltered?: boolean;
  trailing?: ReactNode;
}) {
  const label = filterLabel?.trim() || undefined;
  const classes = [
    "mobile-sidebar-toggle-btn",
    label ? "has-filter-label" : "",
    isFiltered ? "is-filtered" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const button = (
    <button
      type="button"
      className={classes}
      onClick={onToggle}
      aria-expanded={open ?? false}
      aria-controls={SIDEBAR_ID}
      aria-label={label ? `${label}, filter by account or group` : "Filter by account or group"}
      data-tooltip="Filter by account or group"
    >
      {label ? (
        <>
          <FilterIcon className="mobile-sidebar-toggle-filter" />
          <span className="mobile-sidebar-toggle-label">{label}</span>
          <ChevronDownIcon className="mobile-sidebar-toggle-chevron" />
        </>
      ) : (
        <FilterIcon />
      )}
    </button>
  );
  return trailing ? (
    <span className="mobile-filter-with-edit">
      {button}
      {trailing}
    </span>
  ) : (
    button
  );
}
