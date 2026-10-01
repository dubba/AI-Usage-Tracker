/** Switches between a provider's automatic sign-in and pasting session details by hand. */
export function AdvancedToggle({ manual, onToggle }: { manual: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="advanced-connection-toggle" onClick={onToggle}>
      {manual ? "Use automatic sign-in instead" : "Advanced manual connection"}
    </button>
  );
}
