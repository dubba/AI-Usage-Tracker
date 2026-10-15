import { classifyError } from "../../../shared/lib/errors";

/**
 * Internal pairing-protocol vocabulary that reads as plain text to the generic
 * error classifier but means nothing to users (e.g. "Expected
 * MSG_SAS_CONFIRM from peer"). Anything matching it — or anything the generic
 * classifier already flags as backend/network/technical — means the two
 * devices lost track of each other mid-transfer.
 */
const PAIRING_PROTOCOL_PATTERN =
  /\bMSG_[A-Z_]+\b|\bSAS\b|handshake|ECDH|X25519|mDNS|\bnonce\b|confirmation tag|decrypt|\bpayload\b|\bframe\b|\bchunk\b/i;

/**
 * Plain-English text for a backend pairing failure. Messages the backend
 * already wrote as sentences (e.g. "The transfer was cancelled.") pass
 * through; everything else becomes pairing-specific guidance, since the
 * generic network/backend sentences point at the internet or the app service
 * while the real problem is the device-to-device link.
 */
export function pairingFailedMessage(raw: string): string {
  if (!PAIRING_PROTOCOL_PATTERN.test(raw) && classifyError(raw) === "plain") return raw;
  return (
    "The link to the other device broke. " +
    "Keep both devices on this screen and connected to the same Wi-Fi, then try again."
  );
}
