import { createSharedPreference, isOnOff } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

/**
 * Whether Sync Devices shows its "Other ways to connect" link ("on"), which leads to an older
 * version's six-digit code and the QR codes, or hides it ("off", the default). Settings > Device
 * Sync. Kept on this device only.
 */
const store = createSharedPreference(STORAGE_KEYS.syncOtherWays, "off", isOnOff);

export const getSyncOtherWays = store.get;
export const subscribeSyncOtherWays = store.subscribe;
export const setSyncOtherWays = store.set;
