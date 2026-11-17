import { useCompactDashboard } from "../../shared/hooks/useCompactDashboard";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";
import { CompactRowsIcon } from "../../shared/ui/icons";
import { clearCollapsedCards } from "../layout/dashboard-page-state";
import { MOBILE_OVERLAY_QUERY } from "../sidebar/sidebar-width";

/**
 * Toggles Dashboard account cards between full detail and slim single-row summaries.
 * Lives beside Group in the desktop top bar and beside % Used | % Left in the mobile sidebar footer.
 */
export function CompactDashboardToggle({
  className = "compact-dashboard-toggle",
}: {
  className?: string;
} = {}) {
  const [compact, setCompact] = useCompactDashboard();
  const desktop = !useMediaQuery(MOBILE_OVERLAY_QUERY);
  const tooltip = compact ? "Switch back to detailed account cards" : "Shrink account cards to a compact single row";

  return (
    <button
      type="button"
      className={`${className}${compact ? " active" : ""}`}
      aria-pressed={compact}
      aria-label="Compact view"
      data-tooltip={tooltip}
      onClick={() => {
        // On desktop a card's own toggle swaps it to the other layout; the button puts every card
        // back in step with the layout it picks. On a phone the toggle collapses a card instead,
        // which this button leaves alone.
        if (desktop) clearCollapsedCards();
        setCompact(!compact);
      }}
    >
      <CompactRowsIcon />
      <span>Compact</span>
    </button>
  );
}
