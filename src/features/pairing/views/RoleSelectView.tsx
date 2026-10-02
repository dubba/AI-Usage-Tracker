import { ShieldIcon } from "../../../shared/ui/icons";
import type { IntendedRole } from "../lib/view-model";
import { RoleCards } from "./RoleCards";

/** Step 1: send or receive, and whether to bring settings and layout along. */
export function RoleSelectView({
  includeSettings,
  onIncludeSettingsChange,
  onChoose,
}: {
  includeSettings: boolean;
  onIncludeSettingsChange: (include: boolean) => void;
  onChoose: (role: IntendedRole) => void;
}) {
  return (
    <div className="pairing-role-selection-view">
      <RoleCards onChoose={onChoose} />

      <label className="pairing-settings-toggle">
        <input type="checkbox" checked={includeSettings} onChange={(e) => onIncludeSettingsChange(e.target.checked)} />
        <span>
          Transfer settings &amp; layout config:
          <small>
            Including launch-at-login, auto app updates, accounts refresh intervals, alerts & card order.
          </small>
        </span>
      </label>

      <div className="pairing-security-note">
        <ShieldIcon />
        <span>End-to-end encrypted · Direct device-to-device transfer</span>
      </div>
    </div>
  );
}
