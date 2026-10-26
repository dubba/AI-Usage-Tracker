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
        <ToggleMark kind="off" />
        <ToggleMark kind="on" />
      </span>
    </button>
  );
}

/** The mark inside the knob: an X while off, a check while on. Both stay mounted so the swap can fade. */
function ToggleMark({ kind }: { kind: "on" | "off" }) {
  return (
    <svg className={`toggle-mark toggle-mark-${kind}`} viewBox="0 0 24 24" aria-hidden="true">
      {kind === "on" ? <path d="M6.2 12.4 10.4 16.6 18 8.2" /> : <path d="M8 8l8 8M16 8l-8 8" />}
    </svg>
  );
}
