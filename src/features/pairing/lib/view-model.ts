import type { PairingStatus } from "../../../types";
import { isAndroid, isIOS, isMac, isWindows } from "../../../shared/lib/platform";

/** What this device calls sending a file to a nearby device: AirDrop on Apple devices. */
export function nearbyShareName(): "AirDrop" | "Quick Share" {
  return isIOS() || isMac() ? "AirDrop" : "Quick Share";
}

/**
 * Whether this device sends transfer files through AirDrop or Quick Share by itself when the other
 * device isn't on the network. Elsewhere (Linux) a file is saved by hand, so the code screens keep
 * to Wi-Fi unless asked.
 */
export function hasNearbyShare(): boolean {
  return isAndroid() || isIOS() || isMac() || isWindows();
}

/**
 * What the receiving device's user is asked to change so a device on another account can send it
 * the file: who may share with it by AirDrop or Quick Share, which apps cannot change themselves.
 * `openLabel` is the button that opens the setting (`pairingApi.openReceiveSettings`); absent where
 * no app can open it (iPhone), so the popup gives the steps only. Null where it isn't asked: Linux
 * has no such setting, and on Android no app can reach Quick Share's (the button only got as far
 * as Settings on a Pixel and a Galaxy).
 */
export type ReceiveVisibilityHelp = {
  paragraphs: string[];
  /** Lines shown together in the box under the paragraphs. */
  note: string[];
  openLabel?: string;
};

export function receiveVisibilityHelp(): ReceiveVisibilityHelp | null {
  if (isIOS()) {
    return {
      paragraphs: ["Unless both devices use the same Apple Account, set AirDrop to Everyone for 10 Minutes."],
      note: ["Go to Settings → General → AirDrop, then return here.", "If Settings opens instead, search for AirDrop."],
    };
  }
  if (isMac()) {
    return {
      paragraphs: [
        "Unless both devices use the same Apple Account, AirDrop must allow everyone to share with this Mac.",
        "Click Open AirDrop, set Allow me to be discovered by to Everyone, then return here.",
      ],
      note: ["If System Settings opens instead, go to General → AirDrop & Handoff."],
      openLabel: "Open AirDrop",
    };
  }
  if (isWindows()) {
    return {
      paragraphs: [
        "Unless both devices use the same Google account, Quick Share must allow everyone nearby to share with this PC.",
        "In the Quick Share app, set Receiving to Everyone, then return here.",
      ],
      note: [
        "If Windows' own Nearby sharing receives files on this PC, click Open Nearby Sharing Settings and select Everyone nearby.",
      ],
      openLabel: "Open Nearby Sharing Settings",
    };
  }
  return null;
}

export type ViewMode =
  | "select-role"
  | "select-mode"
  | "host"
  | "scanner"
  | "code"
  | "airgap-sender"
  /** The sender making and sending the file of accounts. */
  | "file-send"
  /** The receiver adding the accounts of the file that arrived. */
  | "file-receive";
export type IntendedRole = "send" | "receive";
export type ActiveFlow = "wifi" | "airgap" | null;

/** True before the devices are connected: the user is still choosing, showing a code, or scanning. */
export function isWaitingStatus(status: PairingStatus["status"]): boolean {
  return status === "idle" || status === "hostWaiting";
}

export function pairingStep(status: PairingStatus["status"], viewMode: ViewMode): 1 | 2 | 3 {
  if (status === "confirmTransfer" || status === "transferring" || status === "completed") {
    return 3;
  }
  if (viewMode === "select-role" && isWaitingStatus(status)) {
    return 1;
  }
  return 2;
}

export type PairingHeader = {
  title: string;
  subtitle: string;
  step: 1 | 2 | 3;
  showStepDots: boolean;
};

/** The dialog's title, subtitle and step indicator for the current state of the flow. */
export function pairingHeader(input: {
  status: PairingStatus["status"];
  viewMode: ViewMode;
  activeFlow: ActiveFlow;
  intendedRole: IntendedRole | null;
  airgapVerifyPrompt: boolean;
  /** In the confirm step, whether this device is the one that sends. */
  isSender?: boolean;
}): PairingHeader {
  const { status, viewMode, activeFlow, intendedRole, airgapVerifyPrompt } = input;
  const waiting = isWaitingStatus(status);

  let title = "Link Devices";
  let subtitle = "Sync accounts & credentials between devices.";
  if (activeFlow === "airgap" || viewMode === "airgap-sender") {
    subtitle = "On the other device, open Link Devices, choose Receive, then Scan QR Code (under Other Ways to Connect), and scan this QR code.";
  }
  if (status === "clientConnecting") {
    title = "Connecting";
    subtitle = "Finding the other device on your Wi-Fi.";
  } else if (waiting && viewMode === "airgap-sender") {
    title = "Show QR Code";
  } else if (waiting && viewMode === "host") {
    title = "Your Link Code";
    subtitle = "Open this app on the other device, go to Settings → Sync Devices, select Send, and enter this code.";
  } else if (waiting && viewMode === "scanner") {
    title = "Scan QR Code";
    subtitle =
      activeFlow === "airgap"
        ? "Point the camera at the animated QR code on the other device."
        : "Point the camera at the QR code on the other device.";
  } else if (waiting && viewMode === "file-send") {
    title = `Sending by ${nearbyShareName()}`;
    subtitle = "The accounts go as a small file, encrypted with the code.";
  } else if (waiting && viewMode === "file-receive") {
    title = `Receiving by ${nearbyShareName()}`;
    subtitle = "The accounts arrived as a small file, encrypted with the code.";
  } else if (waiting && viewMode === "code") {
    title = "Enter Link Code";
    subtitle = "Type the 12-letter link code shown on the receiving device.";
  } else if (status === "roleSelection") {
    title = intendedRole ? "Connecting" : "Send or Receive Accounts";
    subtitle = intendedRole ? "Applying send or receive on this device." : "Choose what this device should do.";
  } else if (status === "peerConnected") {
    title = "Connected";
    subtitle = "Waiting for the other device to finish connecting.";
  } else if (status === "confirmTransfer") {
    title = input.isSender ? "Sending" : "Receiving";
    subtitle = input.isSender
      ? "Connected. Sending the accounts to the other device."
      : "Connected. The other device is sending the accounts.";
  } else if (status === "transferring") {
    title = "Transferring";
    subtitle = "Encrypted accounts and groups are moving between devices.";
  } else if (status === "failed") {
    title = "Pairing Failed";
    subtitle = "The devices didn't finish linking. The reason is below.";
  } else if (status === "completed") {
    title = "Devices linked";
    subtitle = "Accounts and credentials are synchronized.";
  } else if (waiting && viewMode === "select-mode") {
    title = "Other Ways to Connect";
    subtitle = "For a device with an older version of the app, or one that is not on the same Wi-Fi.";
  } else if (waiting && viewMode === "select-role") {
    title = "Send or Receive Accounts";
    subtitle = "Step 1: Choose a role for this device.";
  }

  // The air-gap receiver has every frame: it asks to add the accounts.
  if (waiting && viewMode === "scanner" && airgapVerifyPrompt) {
    title = "Add the accounts";
    subtitle = "Step 3: Add the accounts from the other device.";
  }

  return {
    title,
    subtitle,
    step: airgapVerifyPrompt ? 3 : pairingStep(status, viewMode),
    showStepDots: status !== "failed",
  };
}

/** Whether the active view draws its own action buttons, so the dialog footer is left out. */
export function hasOwnActionButtons(status: PairingStatus["status"], viewMode: ViewMode): boolean {
  return (
    status === "completed" ||
    status === "confirmTransfer" ||
    (isWaitingStatus(status) && viewMode !== "host" && viewMode !== "select-mode" && viewMode !== "select-role")
  );
}

type WaitingStatus = Extract<PairingStatus, { status: "hostWaiting" }>;

function readField(data: Record<string, unknown>, camel: string, snake: string): string {
  const value = data[camel] ?? data[snake];
  return typeof value === "string" ? value : "";
}

/** The link code a host shows, tolerating the backend's camelCase or snake_case keys. */
export function hostWaitingFields(status: PairingStatus): { joinCode: string } | null {
  if (status.status !== "hostWaiting") return null;
  const data = (status as WaitingStatus).data as unknown as Record<string, unknown>;
  return { joinCode: readField(data, "joinCode", "join_code") };
}

/** When the code being shown expires, in Unix seconds, or null when it is not a waiting state or has none. */
export function waitingExpiresAt(status: PairingStatus): number | null {
  if (status.status !== "hostWaiting") return null;
  const raw = status.data as unknown as Record<string, unknown>;
  if (typeof status.data.expiresAt === "number") return status.data.expiresAt;
  return typeof raw?.expires_at === "number" ? raw.expires_at : null;
}

/** What the transfer-confirmation screen shows, tolerating camelCase or snake_case keys. */
export function confirmFields(status: PairingStatus): {
  sessionId: string;
  role: string;
  accountCount: number | undefined;
  isSender: boolean;
} | null {
  if (status.status !== "confirmTransfer") return null;
  const raw = status.data as unknown as Record<string, unknown>;
  const role = status.data.role || (raw.role as string) || "";
  return {
    sessionId: status.data.sessionId || (raw.session_id as string) || "",
    role,
    accountCount: status.data.accountCount ?? (raw.account_count as number | undefined),
    isSender: role === "sender",
  };
}

/**
 * A link code: twelve capital letters without I, L and O, which read as 1 and 0
 * (`discovery::LINK_CODE_ALPHABET` on the backend). It also keys the file sent by AirDrop or
 * Quick Share, so it is long.
 */
export const LINK_CODE_LENGTH = 12;
export const LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
/** The six digits a device with an older version shows and types: Wi-Fi only. */
export const LEGACY_CODE_LENGTH = 6;

/** Whether `code` is an older version's six digits rather than a link code: it starts with a digit. */
export function isLegacyCode(code: string): boolean {
  return /^\d/.test(code);
}

/**
 * What was typed, as a code: a link code's letters (capitalized; anything else dropped) or, when it
 * starts with a digit and `allowLegacy`, an older version's digits. Never longer than the code.
 * Without `allowLegacy` (Other ways to connect hidden) digits are dropped like any other character.
 */
export function cleanCode(typed: string, allowLegacy = true): string {
  const compact = typed.toUpperCase().replace(/[\s-]/g, "");
  if (allowLegacy && isLegacyCode(compact)) return compact.replace(/\D/g, "").slice(0, LEGACY_CODE_LENGTH);
  return Array.from(compact)
    .filter((char) => LINK_CODE_ALPHABET.includes(char))
    .join("")
    .slice(0, LINK_CODE_LENGTH);
}

/** How many characters the code being typed has when complete. */
export function codeLength(code: string): number {
  return isLegacyCode(code) ? LEGACY_CODE_LENGTH : LINK_CODE_LENGTH;
}

/** Characters per group as a code is shown, for either kind: "KTQ MPR XDH WAB", "123 456". */
export const CODE_GROUP_SIZE = 3;
/** Groups per row of tiles: a link code fills two rows, six digits one. */
const GROUPS_PER_ROW = 2;

/** Whether the tile at `index` starts a group partway along its row, so a small gap goes before it. */
export function startsGroupInRow(index: number): boolean {
  return index % CODE_GROUP_SIZE === 0 && index % (CODE_GROUP_SIZE * GROUPS_PER_ROW) !== 0;
}

export function isCompleteCode(code: string): boolean {
  return code.length === codeLength(code);
}

/** A complete link code (not six digits): the kind that can also go by file. */
export function isLinkCode(code: string): boolean {
  return !isLegacyCode(code) && code.length === LINK_CODE_LENGTH;
}

/** "KTQMPRXDHWAB" -> "KTQ MPR XDH WAB", "123456" -> "123 456", after `cleanCode`. */
export function formatJoinCode(code: string): string {
  return cleanCode(code).match(new RegExp(`.{1,${CODE_GROUP_SIZE}}`, "g"))?.join(" ") ?? "";
}

/** 125 -> "2:05". */
export function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
