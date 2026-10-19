import { CustomDropdown } from "../../shared/ui/CustomDropdown";
import { ToggleSwitch } from "../../shared/ui/ToggleSwitch";
import { useThemePreference } from "../../shared/hooks/useThemePreference";
import type { ThemePreference } from "../../shared/lib/theme";
import { useAppSettingsState } from "./settings-context";

/**
 * The intervals the dropdown offers. They must match `OFFERED_REFRESH_MINUTES` in
 * `src-tauri/src/settings.rs`, which snaps any stored value to the nearest one; a test in
 * `src-tauri` (`frontend_contract.rs`) checks the two lists agree.
 */
const ACCOUNT_REFRESH_OPTIONS = [5, 10, 15, 30, 45, 60] as const;
const DEFAULT_REFRESH_OPTION = 15;
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

/** Appearance, launch at startup, and how often accounts refresh. */
export function GeneralSection() {
  const { appSettings, autostart, toggleAutostart, refreshIntervalBusy, saveAccountRefreshMinutes } = useAppSettingsState();
  const [themePreference, setThemePreference] = useThemePreference();
  const minutes = appSettings?.accountRefreshMinutes;

  return (
    <>
      <h2 className="settings-section-title">General</h2>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Appearance</strong>
            <small>Dark, light, or match your device.</small>
          </div>
          <div className="settings-account-refresh settings-theme-dropdown">
            <CustomDropdown<ThemePreference>
              id="setting-theme"
              aria-label="Theme"
              value={themePreference}
              options={THEME_OPTIONS}
              onChange={setThemePreference}
            />
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong id="setting-autostart-label">Launch at Startup</strong>
            <small>Start the app when your device starts.</small>
          </div>
          <ToggleSwitch checked={autostart} labelledBy="setting-autostart-label" onChange={() => void toggleAutostart()} />
        </div>
        <div className="settings-row">
          <div>
            <strong>Account Updates</strong>
            <small>How often usage is refreshed.</small>
          </div>
          <div className="settings-account-refresh">
            <CustomDropdown<number>
              aria-label="Refresh interval"
              value={minutes != null && (ACCOUNT_REFRESH_OPTIONS as readonly number[]).includes(minutes) ? minutes : DEFAULT_REFRESH_OPTION}
              disabled={!appSettings || refreshIntervalBusy}
              options={ACCOUNT_REFRESH_OPTIONS.map((option) => ({
                value: option,
                label: `${option} minutes`,
              }))}
              onChange={(next) => void saveAccountRefreshMinutes(next)}
            />
          </div>
        </div>
      </section>
    </>
  );
}
