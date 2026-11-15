import type { ReactNode } from "react";
import { ToggleSwitch } from "../../shared/ui/ToggleSwitch";

/**
 * A settings row paired with a `ToggleSwitch` where clicking anywhere on the row (its title,
 * description, or blank space) toggles the switch, while direct clicks on the switch button or
 * any nested interactive element still fire only once.
 */
export function SettingsToggleRow({
  className = "settings-row",
  checked,
  labelledBy,
  disabled,
  onChange,
  children,
}: {
  className?: string;
  checked: boolean;
  labelledBy: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`${className} settings-toggle-row`}
      onClick={(event) => {
        if (disabled) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button, a, input, select, textarea, [role='switch']")) return;
        if (window.getSelection()?.toString()) return;
        onChange(!checked);
      }}
    >
      {children}
      <ToggleSwitch checked={checked} labelledBy={labelledBy} disabled={disabled} onChange={onChange} />
    </div>
  );
}
