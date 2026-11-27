import { createSharedPreference, isOnOff } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

/**
 * Whether Legacy Features are shown ("on") or hidden ("off", the default): enables the Paseo Bridge
 * integration card in Settings and "Other ways to connect" (six-digit code and QR codes) in Sync
 * Devices. Kept on this device only.
 */
const store = createSharedPreference(STORAGE_KEYS.syncOtherWays, "off", isOnOff);

export const getSyncOtherWays = store.get;
export const subscribeSyncOtherWays = store.subscribe;
export const setSyncOtherWays = store.set;
