/** Source name for the banner about sign-ins that could not be encrypted. */
export const CREDENTIAL_PROTECTION_ERROR_SOURCE = "credential-protection";

/**
 * Shown on the account whose saved sign-in is still a plain file. The app does
 * not use such a sign-in, so the account is paused until it is encrypted or
 * replaced.
 */
export const CREDENTIAL_PROTECTION_ACCOUNT_NOTE =
  "This sign-in isn't encrypted, so the app has paused this account. Retry, or remove it and sign in again.";

/**
 * The warning shown while saved sign-ins are still stored unencrypted, or null
 * when there is nothing to warn about. The app does not use them, and says what
 * to do about it.
 */

export function credentialProtectionMessage(unprotected: number): string | null {
  if (!Number.isFinite(unprotected) || unprotected <= 0) return null;
  const one = unprotected === 1;
  const subject = one ? "1 saved sign-in isn't encrypted" : `${unprotected} saved sign-ins aren't encrypted`;
  return `${subject}, so the app isn't using ${one ? "it" : "them"}. Retry, or remove the account and sign in again.`;
}

/**
 * Names a set of accounts with unencrypted sign-ins, or null when there are
 * none. The prompt about them opens again only when this changes, so "Not now"
 * is respected until another account is affected.
 */
export function unprotectedPromptKey(accountIds: readonly string[] | undefined): string | null {
  if (!accountIds || accountIds.length === 0) return null;
  return [...accountIds].sort().join(",");
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
