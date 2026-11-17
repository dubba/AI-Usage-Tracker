import { useCompactDashboard } from "../../shared/hooks/useCompactDashboard";
import { CompactRowsIcon } from "../../shared/ui/icons";

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
  const tooltip = compact ? "Switch back to detailed account cards" : "Shrink account cards to a compact single row";

  return (
    <button
      type="button"
      className={`${className}${compact ? " active" : ""}`}
      aria-pressed={compact}
      aria-label="Compact view"
      data-tooltip={tooltip}
      onClick={() => setCompact(!compact)}
    >
      <CompactRowsIcon />
      <span>Compact</span>
    </button>
  );
}
