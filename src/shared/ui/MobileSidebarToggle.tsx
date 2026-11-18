import { SIDEBAR_ID } from "../lib/constants";
import { ChevronDownIcon, FilterIcon } from "./icons";

/**
 * The button that opens the sidebar on a narrow screen; Dashboard and Usage render it with the
 * active filter label so it reads as a filter picker rather than page navigation. Settings hides
 * it because Settings is global.
 */
export function MobileSidebarToggle({
  onToggle,
  open,
  filterLabel,
  isFiltered = false,
}: {
  onToggle: () => void;
  open?: boolean;
  filterLabel?: string;
  isFiltered?: boolean;
}) {
  const label = filterLabel?.trim() || undefined;
  const classes = [
    "mobile-sidebar-toggle-btn",
    label ? "has-filter-label" : "",
    isFiltered ? "is-filtered" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
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
}
