import { useState } from "react";
import { CustomDropdown } from "../../shared/ui/CustomDropdown";
import { SettingsToggleRow } from "./SettingsToggleRow";
import { useAccentColor, useBottomNavLabels, useThemePreference } from "../../shared/hooks/usePreferences";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";
import { MODAL_ACCENT_PRESETS } from "../../shared/lib/accent-color";
import { isAndroid, isIOS } from "../../shared/lib/platform";
import type { ThemePreference } from "../../shared/lib/theme";
import { MOBILE_OVERLAY_QUERY } from "../sidebar/sidebar-width";
import { AccentColorModal } from "./AccentColorModal";
import { useAppSettingsState } from "./settings-context";

/**
 * The intervals the dropdown offers. They must match `OFFERED_REFRESH_MINUTES` in
 * `src-tauri/src/store/settings.rs`, which snaps any stored value to the nearest one; a test in
 * `src-tauri` (`frontend_contract.rs`) checks the two lists agree.
 */
const ACCOUNT_REFRESH_OPTIONS = [5, 10, 15, 30, 45, 60] as const;
const DEFAULT_REFRESH_OPTION = 15;
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "oled", label: "Black" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

/** Launch at startup, the bottom bar's labels, appearance, and how often accounts refresh. */
export function GeneralSection() {
  const { appSettings, autostart, toggleAutostart, refreshIntervalBusy, saveAccountRefreshMinutes } = useAppSettingsState();
  const [themePreference, setThemePreference] = useThemePreference();
  const [accentColor] = useAccentColor();
  const [accentPickerOpen, setAccentPickerOpen] = useState(false);
  const [navLabels, setNavLabels] = useBottomNavLabels();
  // The bottom bar only exists while the sidebar is an overlay: a phone, or a narrow window.
  const hasBottomNav = useMediaQuery(MOBILE_OVERLAY_QUERY);
  const minutes = appSettings?.accountRefreshMinutes;
  const activeAccentLabel =
    MODAL_ACCENT_PRESETS.find((preset) => preset.hex === accentColor)?.label ?? accentColor.toUpperCase();

  return (
    <section className="settings-card">
      <h2 id="settings-section-general" className="settings-card-heading">General</h2>
      {/* Neither Android nor iOS lets an app open its screen when the phone starts, so the switch would do nothing. */}
        {!isAndroid() && !isIOS() ? (
          <SettingsToggleRow
            checked={autostart}
            labelledBy="setting-autostart-label"
            onChange={() => void toggleAutostart()}
          >
            <div>
              <strong id="setting-autostart-label">Launch at Startup</strong>
              <small>Start the app when your device starts.</small>
            </div>
          </SettingsToggleRow>
        ) : null}
        {hasBottomNav ? (
          <SettingsToggleRow
            checked={navLabels}
            labelledBy="setting-nav-labels-label"
            onChange={setNavLabels}
          >
            <div>
              <strong id="setting-nav-labels-label">Menu Bar Labels</strong>
              <small>Show labels below icons in bottom bar.</small>
            </div>
          </SettingsToggleRow>
        ) : null}
        <div className="settings-row">
          <div>
            <strong>Appearance</strong>
            <small>Choose your preferred app theme.</small>
          </div>
          <div className="settings-account-refresh settings-appearance-dropdown">
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
            <strong id="setting-accent-color-label">Theme Accent Color</strong>
            <small>Customize the app's accent color.</small>
          </div>
          <div className="settings-account-refresh settings-appearance-dropdown">
            <button
              id="setting-accent-color"
              type="button"
              className="custom-dropdown-trigger settings-accent-trigger"
              aria-labelledby="setting-accent-color-label"
              aria-haspopup="dialog"
              aria-expanded={accentPickerOpen}
              onClick={() => setAccentPickerOpen(true)}
            >
              <span className="settings-accent-trigger-value">
                <span className="settings-accent-trigger-dot" style={{ backgroundColor: accentColor }} aria-hidden="true" />
                <span>{activeAccentLabel}</span>
              </span>
            </button>
          </div>
        </div>
        <AccentColorModal open={accentPickerOpen} onClose={() => setAccentPickerOpen(false)} />
        <div className="settings-row">
          <div>
            <strong>Account Refresh</strong>
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
  );
}
