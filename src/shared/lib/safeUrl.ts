import { openUrl } from "@tauri-apps/plugin-opener";

export const ALLOWED_EXTERNAL_HOSTS = [
  "github.com",
  "openai.com",
  "auth.openai.com",
  "claude.ai",
  "anthropic.com",
  "accounts.google.com",
  "aistudio.google.com",
  "google.com",
  "accounts.x.ai",
  "grok.com",
  "x.ai",
  "opencode.ai",
] as const;

export function isAllowedExternalUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_EXTERNAL_HOSTS.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
    );
  } catch {
    return false;
  }
}

export async function openSafeUrl(rawUrl: string): Promise<void> {
  if (!isAllowedExternalUrl(rawUrl)) {
    throw new Error(`Refusing to open disallowed or non-HTTPS URL: ${rawUrl}`);
  }
  return openUrl(rawUrl);
}
