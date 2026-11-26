import { useId } from "react";
import { SettingsToggleRow } from "../../settings/SettingsToggleRow";
import { ShieldIcon } from "../../../shared/ui/icons";
import type { IntendedRole } from "../lib/view-model";
import { RoleCards } from "./RoleCards";

/**
 * Step 1: send or receive, and whether to bring settings and layout along. The two choices are
 * the main actions; the settings option is a quiet switch under them, read before either is tapped.
 */
export function RoleSelectView({
  includeSettings,
  onIncludeSettingsChange,
  onChoose,
}: {
  includeSettings: boolean;
  onIncludeSettingsChange: (include: boolean) => void;
  onChoose: (role: IntendedRole) => void;
}) {
  const labelId = useId();
  return (
    <div className="pairing-role-selection-view">
      <RoleCards onChoose={onChoose} />

      <SettingsToggleRow
        className="pairing-settings-toggle"
        checked={includeSettings}
        labelledBy={labelId}
        onChange={onIncludeSettingsChange}
      >
        <div className="pairing-settings-toggle-text">
          <strong id={labelId}>Also sync settings and layout</strong>
          <small>Includes appearance, alerts, refresh intervals, and card order.</small>
        </div>
      </SettingsToggleRow>
    </div>
  );
}

/** The reassurance in step 1's footer, beside Cancel: muted text, not a control. */
export function SecurityNote() {
  return (
    <div className="pairing-security-note">
      <ShieldIcon />
      <span>End-to-end encrypted device sync</span>
    </div>
  );
}
