export type SettingsSectionId = "general" | "updates" | "devices" | "data" | "integrations" | "shortcuts";
export type SettingsSectionGroup = "settings" | "advanced";

export interface SettingsJumpSection {
  id: SettingsSectionId;
  group: SettingsSectionGroup;
  label: string;
  hint: string;
  elementId: string;
  desktopOnly?: boolean;
}

export const SETTINGS_JUMP_SECTIONS: readonly SettingsJumpSection[] = [
  { id: "general", group: "settings", label: "General", hint: "Startup, theme & refresh", elementId: "settings-section-general" },
  { id: "updates", group: "settings", label: "Updates", hint: "Version & auto-updates", elementId: "settings-section-updates" },
  { id: "devices", group: "settings", label: "Devices", hint: "Sync & link devices", elementId: "settings-section-devices" },
  { id: "data", group: "advanced", label: "Data & Diagnostics", hint: "Diagnostics, history & reset", elementId: "settings-section-data" },
  { id: "integrations", group: "advanced", label: "Integrations", hint: "Paseo Bridge & local API", elementId: "settings-section-integrations", desktopOnly: true },
  { id: "shortcuts", group: "advanced", label: "Keyboard Shortcuts", hint: "Hotkeys & navigation", elementId: "settings-section-shortcuts", desktopOnly: true },
];
