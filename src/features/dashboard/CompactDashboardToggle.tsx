import { useCompactDashboard } from "../../shared/hooks/useCompactDashboard";
import { CompactRowsIcon } from "../../shared/ui/icons";

/**
 * Toggles Dashboard and Usage cards between full detail and slim compact layouts.
 * Lives beside Group in the desktop top bar and beside % Used | % Left in the mobile sidebar footer.
 */
export function CompactDashboardToggle({
  className = "compact-dashboard-toggle",
}: {
  className?: string;
} = {}) {
  const [compact, setCompact] = useCompactDashboard();
  const tooltip = compact ? "Switch back to detailed cards" : "Show compact cards on Dashboard and Usage";

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
