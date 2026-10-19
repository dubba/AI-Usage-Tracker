import { STORAGE_KEYS, storageGet, storageRemove, storageSet } from "../../shared/lib/storage";

export function readSettingsAdvancedOpen(): boolean {
  return storageGet(STORAGE_KEYS.settingsAdvancedOpen) === "true";
}

export function writeSettingsAdvancedOpen(open: boolean): void {
  if (open) {
    storageSet(STORAGE_KEYS.settingsAdvancedOpen, "true");
  } else {
    storageRemove(STORAGE_KEYS.settingsAdvancedOpen);
  }
}
