import { useRef } from "react";
import { useUsageDisplayMode } from "../../shared/hooks/useUsageDisplayMode";
import type { UsageDisplayMode } from "../../shared/lib/usage-display";
import { useSegmentIndicator } from "../../shared/ui/segment-indicator";

const OPTIONS: ReadonlyArray<{ mode: UsageDisplayMode; letter: string; word: string; tooltip: string }> = [
  { mode: "used", letter: "U", word: "% Used", tooltip: "Show the percentage already used" },
  { mode: "left", letter: "L", word: "% Left", tooltip: "Show the percentage of usage left" },
];

/**
 * Switches every usage percentage between the quota used (U) and the quota left (L). Used is the
 * left option. The desktop top bar spells the options out (`labels` "words") and styles it with
 * its own `className`.
 */
export function UsageDisplayToggle({
  labels = "letters",
  className = "provider-window-toggle usage-display-toggle",
}: {
  labels?: "letters" | "words";
  className?: string;
} = {}) {
  const [mode, setMode] = useUsageDisplayMode();
  const groupRef = useRef<HTMLDivElement>(null);
  useSegmentIndicator(groupRef);
  return (
    <div ref={groupRef} className={`${className} segmented`} role="group" aria-label="Usage display">
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
          {labels === "words" ? option.word : option.letter}
        </button>
      ))}
    </div>
  );
}
