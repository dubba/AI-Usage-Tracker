import { useSyncOtherWays } from "../../shared/hooks/usePreferences";
import { SettingsToggleRow } from "./SettingsToggleRow";

/**
 * Advanced Sync Devices options. "Other ways to connect" (an older version's six-digit code, and
 * the animated QR codes) is hidden in Sync Devices unless shown here; the choice stays on this
 * device.
 */
export function SyncOptionsSection() {
  const [otherWays, setOtherWays] = useSyncOtherWays();
  return (
    <section className="settings-card">
      <h2 id="settings-section-sync-options" className="settings-card-heading">Sync Options</h2>
      <SettingsToggleRow checked={otherWays} labelledBy="setting-sync-other-ways-label" onChange={setOtherWays}>
        <div>
          <strong id="setting-sync-other-ways-label">Other Ways to Connect</strong>
          <small>Show a 6-digit code for older app versions and QR codes in Sync Devices.</small>
        </div>
      </SettingsToggleRow>
    </section>
  );
}
