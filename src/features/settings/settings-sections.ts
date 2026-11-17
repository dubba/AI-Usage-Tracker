export type SettingsSectionId = "general" | "updates" | "devices" | "advanced";

export interface SettingsJumpSection {
  id: SettingsSectionId;
  label: string;
  hint: string;
  elementId: string;
}

export const SETTINGS_JUMP_SECTIONS: readonly SettingsJumpSection[] = [
  { id: "general", label: "General", hint: "Startup, theme & refresh", elementId: "settings-section-general" },
  { id: "updates", label: "Updates", hint: "Version & auto-updates", elementId: "settings-section-updates" },
  { id: "devices", label: "Devices", hint: "Sync & link devices", elementId: "settings-section-devices" },
  { id: "advanced", label: "Advanced", hint: "Data, logs & shortcuts", elementId: "settings-section-advanced" },
];
