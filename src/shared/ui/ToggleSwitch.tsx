/** An on/off switch (`role="switch"`). Name it with `labelledBy`, the id of its visible label. */
export function ToggleSwitch({
  checked,
  onChange,
  labelledBy,
  disabled,
}: {
  checked: boolean;
  /** Called with the new state when clicked. */
  onChange: (next: boolean) => void;
  labelledBy: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      className={`toggle ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>
        <ToggleMark />
      </span>
    </button>
  );
}

/**
 * The mark inside the knob: two strokes that morph smoothly between an X (off) and a checkmark
 * (on). Each arm is anchored at its off-state origin so CSS transforms translate/rotate/trim it
 * into the checkmark in lockstep with the knob slide.
 */
function ToggleMark() {
  return (
    <svg className="toggle-mark" viewBox="0 0 24 24" aria-hidden="true">
      <g transform="translate(7.3 7.6)">
        <line className="toggle-mark-arm toggle-mark-primary" x1="0" y1="0" x2="9.6" y2="9.6" />
      </g>
      <g transform="translate(7.3 17.2)">
        <line className="toggle-mark-arm toggle-mark-secondary" x1="0" y1="0" x2="9.6" y2="-9.6" />
      </g>
    </svg>
  );
}
