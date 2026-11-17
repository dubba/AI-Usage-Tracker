import { useCompactDashboard } from "../../shared/hooks/useCompactDashboard";
import { CompactRowsIcon } from "../../shared/ui/icons";

/**
 * Toggles Dashboard account cards between full detail and slim single-row summaries.
 * Paired beside UsageDisplayToggle (% Used | % Left) in the desktop Dashboard header and
 * mobile sidebar footer.
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
