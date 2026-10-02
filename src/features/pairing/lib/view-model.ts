import type { PairingStatus } from "../../../types";

export type ViewMode = "select-role" | "select-mode" | "host" | "scanner" | "code" | "airgap-sender" | "airgap-confirm";
export type IntendedRole = "send" | "receive";
export type ActiveFlow = "wifi" | "airgap" | null;

/** True before the devices are connected: the user is still choosing, showing a code, or scanning. */
export function isWaitingStatus(status: PairingStatus["status"]): boolean {
  return status === "idle" || status === "hostWaiting" || status === "receiverWaiting";
}

export function pairingStep(status: PairingStatus["status"], viewMode: ViewMode): 1 | 2 | 3 {
  if (status === "sasVerification" || status === "transferring" || status === "completed") {
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
}): PairingHeader {
  const { status, viewMode, activeFlow, intendedRole, airgapVerifyPrompt } = input;
  const waiting = isWaitingStatus(status);
  const CONFIRM_SUBTITLE = "Step 3: Make sure both screens show the same code to begin the transfer.";

  let title = "Link Devices";
  let subtitle = "Transfer accounts & credentials between devices.";
  if (activeFlow === "airgap" || viewMode === "airgap-sender") {
    subtitle = "On the other device, open Link Devices, select Scan QR Code, then scan this QR code below.";
  }
  if (status === "clientConnecting" || status === "senderConnecting") {
    title = "Connecting";
    subtitle = "Finding the other device on your Wi-Fi.";
  } else if (waiting && viewMode === "airgap-sender") {
    title = "Show QR Code";
  } else if (waiting && viewMode === "host") {
    title = "Show Link Code";
    subtitle = "On the other device, open Link Devices, select Enter Link Code, then enter the code below.";
  } else if (waiting && viewMode === "scanner") {
    title = "Scan QR Code";
    subtitle =
      activeFlow === "airgap"
        ? "Point the camera at the animated QR code on the other device."
        : "Point the camera at the QR code on the other device.";
  } else if (waiting && viewMode === "code") {
    title = "Enter Link Code";
    subtitle = "Type the 6-digit link code shown on the other device.";
  } else if (status === "roleSelection") {
    title = intendedRole ? "Connecting" : "Send or receive accounts";
    subtitle = intendedRole ? "Applying send or receive on this device." : "Choose what this device should do.";
  } else if (status === "peerConnected") {
    title = "Connected";
    subtitle = "Waiting for the other device to finish connecting.";
  } else if (status === "sasVerification") {
    title = "Confirm the connection";
    subtitle = CONFIRM_SUBTITLE;
  } else if (status === "transferring") {
    title = "Transferring";
    subtitle = "Encrypted accounts and groups are moving between devices.";
  } else if (status === "completed") {
    title = "Devices linked";
    subtitle = "Accounts and credentials are synchronized.";
  } else if (waiting && viewMode === "select-mode") {
    title = "How to connect devices";
    subtitle = "Step 2: Show a pairing code here, or scan or enter the code from your other device.";
  } else if (waiting && viewMode === "select-role") {
    title = "Send or receive accounts";
    subtitle = "Step 1: Choose a role for this device.";
  }

  // The air-gap receiver finished scanning, or the sender opened the confirm view: show the same
  // header as the Wi-Fi confirmation while the codes are compared.
  if (waiting && ((viewMode === "scanner" && airgapVerifyPrompt) || viewMode === "airgap-confirm")) {
    title = "Confirm the connection";
    subtitle = CONFIRM_SUBTITLE;
  }

  return {
    title,
    subtitle,
    step: airgapVerifyPrompt || viewMode === "airgap-confirm" ? 3 : pairingStep(status, viewMode),
    showStepDots: status !== "failed",
  };
}

/** Whether the active view draws its own action buttons, so the dialog footer is left out. */
export function hasOwnActionButtons(status: PairingStatus["status"], viewMode: ViewMode): boolean {
  return (
    status === "completed" ||
    status === "sasVerification" ||
    (isWaitingStatus(status) && viewMode !== "host" && viewMode !== "select-mode" && viewMode !== "select-role")
  );
}

type WaitingStatus = Extract<PairingStatus, { status: "hostWaiting" | "receiverWaiting" }>;

function readField(data: Record<string, unknown>, camel: string, snake: string): string {
  const value = data[camel] ?? data[snake];
  return typeof value === "string" ? value : "";
}

/** The QR and link code a host shows, tolerating the backend's camelCase or snake_case keys. */
export function hostWaitingFields(status: PairingStatus): {
  qrSvg: string;
  qrUri: string;
  fingerprint: string;
  joinCode: string;
} | null {
  if (status.status !== "hostWaiting" && status.status !== "receiverWaiting") return null;
  const data = (status as WaitingStatus).data as unknown as Record<string, unknown>;
  return {
    qrSvg: readField(data, "qrSvg", "qr_svg"),
    qrUri: readField(data, "qrUri", "qr_uri"),
    fingerprint: readField(data, "fingerprint", "fingerprint"),
    joinCode: readField(data, "joinCode", "join_code"),
  };
}

/** When the code being shown expires, in Unix seconds, or null when it is not a waiting state or has none. */
export function waitingExpiresAt(status: PairingStatus): number | null {
  if (status.status !== "hostWaiting" && status.status !== "receiverWaiting") return null;
  const raw = status.data as unknown as Record<string, unknown>;
  if (typeof status.data.expiresAt === "number") return status.data.expiresAt;
  return typeof raw?.expires_at === "number" ? raw.expires_at : null;
}

/** What the code-confirmation screen shows, tolerating camelCase or snake_case keys. */
export function sasFields(status: PairingStatus): {
  sasCode: string;
  sessionId: string;
  role: string;
  accountCount: number | undefined;
  isSender: boolean;
} | null {
  if (status.status !== "sasVerification") return null;
  const raw = status.data as unknown as Record<string, unknown>;
  const role = status.data.role || (raw.role as string) || "";
  return {
    sasCode: status.data.sasCode || (raw.sas_code as string) || "",
    sessionId: status.data.sessionId || (raw.session_id as string) || "",
    role,
    accountCount: status.data.accountCount ?? (raw.account_count as number | undefined),
    isSender: role === "sender",
  };
}

/** "123456" -> "123 456"; anything that is not a digit is dropped, at most six digits are kept. */
export function formatJoinCode(code: string): string {
  const digits = code.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** 125 -> "2:05". */
export function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
