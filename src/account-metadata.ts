const ACCOUNT_EMAIL_PREFIX = "paseo-usage-bridge:account-email:";
export const ACCOUNT_METADATA_EVENT = "paseo-account-metadata-changed";

function accountEmailKey(accountId: string): string {
  return `${ACCOUNT_EMAIL_PREFIX}${accountId}`;
}

export function getCustomAccountEmail(accountId: string): string | null {
  try {
    const value = window.localStorage.getItem(accountEmailKey(accountId))?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function setCustomAccountEmail(accountId: string, email: string): void {
  try {
    const normalized = email.trim();
    if (normalized) window.localStorage.setItem(accountEmailKey(accountId), normalized);
    else window.localStorage.removeItem(accountEmailKey(accountId));
    window.dispatchEvent(new CustomEvent(ACCOUNT_METADATA_EVENT, { detail: { accountId } }));
  } catch {
    // The account remains usable even when WebView storage is unavailable.
  }
}

export function clearCustomAccountEmail(accountId: string): void {
  setCustomAccountEmail(accountId, "");
}
