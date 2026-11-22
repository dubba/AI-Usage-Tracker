import { useCompactDashboard } from "../../shared/hooks/usePreferences";
import { CompactRowsIcon } from "../../shared/ui/icons";
import { clearCollapsedCards } from "../layout/dashboard-page-state";

/**
 * Toggles Dashboard account cards between full detail and slim single-row summaries.
 * Lives beside Group in the desktop top bar.
 */
export function CompactDashboardToggle({
  className = "compact-dashboard-toggle",
}: {
  className?: string;
} = {}) {
  const [compact, setCompact] = useCompactDashboard();
  const tooltip = compact ? "Switch back to detailed account cards" : "Shrink account cards to a compact single row";

  return (
    <button
      type="button"
      className={`${className}${compact ? " active" : ""}`}
      aria-pressed={compact}
      aria-label="Compact view"
      data-tooltip={tooltip}
      onClick={() => {
        // Clicking the global Compact View button puts every card back in step with the layout it picks.
        clearCollapsedCards();
        setCompact(!compact);
      }}
    >
      <CompactRowsIcon />
      <span>Compact View</span>
    </button>
  );
}
