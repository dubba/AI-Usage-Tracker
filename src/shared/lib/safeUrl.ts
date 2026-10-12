import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * The URLs the app may open in the user's browser. This mirrors the
 * `opener:allow-open-url` allowlist in `src-tauri/capabilities/default.json`
 * (`https://host/path/*` there, `https://host/path/` here), which is what the
 * opener actually enforces; the Rust sync test in `lib.rs` fails if the two
 * lists differ. Anything outside it would be refused by the opener anyway, so
 * links to it are shown as plain text instead of as links that do nothing.
 */
export const ALLOWED_EXTERNAL_URL_PREFIXES = [
  "https://auth.openai.com/",
  "https://claude.ai/",
  "https://accounts.google.com/",
  "https://accounts.x.ai/",
  "https://grok.com/",
  "https://x.ai/",
  "https://opencode.ai/",
  "https://github.com/dubba/AI-Usage-Tracker/",
] as const;

export function isAllowedExternalUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl);
    // Compare the parsed, normalized URL so `..` segments, `user@` prefixes,
    // ports, or letter case cannot make another URL look like an allowed one.
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
      return false;
    }
    return ALLOWED_EXTERNAL_URL_PREFIXES.some((prefix) => parsed.href.startsWith(prefix));
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
