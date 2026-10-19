/** The schemes a pairing link uses: the app's own link, and the shorter form some scanners produce. */
const PAIRING_URI_PREFIXES = ["aiusage-pair:", "aiusage:"] as const;

/**
 * Whether `uri` looks like a pairing link. Only a cheap check on the text: the backend still
 * validates the link (`ParsedQrPayload::parse`) before connecting to anything.
 */
export function isPairingUri(uri: string | null | undefined): boolean {
  return Boolean(uri && PAIRING_URI_PREFIXES.some((prefix) => uri.startsWith(prefix)));
}
