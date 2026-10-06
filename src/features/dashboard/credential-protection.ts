/** Source name for the banner about sign-ins that could not be encrypted. */
export const CREDENTIAL_PROTECTION_ERROR_SOURCE = "credential-protection";

/**
 * The warning shown while saved sign-ins are still stored unencrypted, or null
 * when there is nothing to warn about. The backend keeps retrying on its own;
 * the message says so and what to do if it does not clear.
 */
/**
 * Shown on the account whose saved sign-in is still a plain file. The sign-in
 * keeps working, and the app retries the lock on its own.
 */
export const CREDENTIAL_PROTECTION_ACCOUNT_NOTE =
  "This sign-in isn't encrypted yet. It still works, and the app keeps trying to lock it. If this stays, restart the app or your device.";

export function credentialProtectionMessage(unprotected: number): string | null {
  if (!Number.isFinite(unprotected) || unprotected <= 0) return null;
  const subject =
    unprotected === 1
      ? "1 saved sign-in isn't encrypted yet"
      : `${unprotected} saved sign-ins aren't encrypted yet`;
  return `${subject}. The app keeps trying. If this stays, restart the app or your device.`;
}

/**
 * Decides whether to raise or clear the banner for a new count. The banner is
 * raised once per change, so dismissing it is respected until the count
 * changes, and it is cleared as soon as everything is protected.
 */
export function credentialProtectionAction(
  previous: number,
  next: number,
): "report" | "clear" | "none" {
  const normalized = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
  if (normalized === previous) return "none";
  return normalized === 0 ? "clear" : "report";
}
