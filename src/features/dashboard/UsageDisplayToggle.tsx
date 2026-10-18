import { useUsageDisplayMode } from "../../shared/hooks/useUsageDisplayMode";
import type { UsageDisplayMode } from "../../shared/lib/usage-display";

const OPTIONS: ReadonlyArray<{ mode: UsageDisplayMode; letter: string; tooltip: string }> = [
  { mode: "left", letter: "L", tooltip: "Show the percentage of usage left" },
  { mode: "used", letter: "U", tooltip: "Show the percentage already used" },
];

/** Switches every usage percentage between the quota left (L) and the quota used (U). */
export function UsageDisplayToggle() {
  const [mode, setMode] = useUsageDisplayMode();
  return (
    <div className="provider-window-toggle usage-display-toggle" role="group" aria-label="Usage display">
      {OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          className={mode === option.mode ? "active" : undefined}
          aria-pressed={mode === option.mode}
          aria-label={option.tooltip}
          data-tooltip={option.tooltip}
          onClick={() => setMode(option.mode)}
        >
          {option.letter}
        </button>
      ))}
    </div>
  );
}
