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
      <span />
    </button>
  );
}
