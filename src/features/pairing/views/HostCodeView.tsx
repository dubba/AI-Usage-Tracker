import type { ReactNode } from "react";
import type { PairingStatus } from "../../../types";
import { FolderIcon } from "../../../shared/ui/icons";
import { isAndroid, isIOS } from "../../../shared/lib/platform";
import { formatCountdown, formatJoinCode, hostWaitingFields, isLegacyCode, startsGroupInRow } from "../lib/view-model";

/** How long a link code lasts (`transport::SESSION_TIMEOUT_SECS`), for the bar under it. */
const CODE_LIFETIME_SECS = 300;

/** The link code this device shows for the other one to type in. */
export function HostCodeView({
  status,
  remainingSecs,
  busy = false,
  onRegenerate,
  onOpenFile,
  autoPickup = false,
  onOtherWays,
  nearbyName,
}: {
  status: PairingStatus;
  remainingSecs: number | null;
  busy?: boolean;
  /** The countdown hit zero; start a fresh session and code. */
  onRegenerate: () => void;
  /** iPhone: open a received transfer file from the Files app when AirDrop saved it there. */
  onOpenFile?: () => void;
  /** Whether Downloads is being watched automatically for incoming transfer files. */
  autoPickup?: boolean;
  /**
   * Ends this session and lists the other ways to connect (older versions, QR code). Absent while
   * Settings > Device Sync hides them.
   */
  onOtherWays?: () => void;
  /** "AirDrop" or "Quick Share" where the accounts can come that way; absent where files aren't offered. */
  nearbyName?: string;
}) {
  const host = hostWaitingFields(status);
  const joinCode = host?.joinCode ?? "";
  if (!joinCode) {
    return (
      <div className="pairing-panel-status">
        <span className="spinner" />
        <h3>Starting pairing session…</h3>
        <p>Preparing a link code for the other device.</p>
      </div>
    );
  }

  if (remainingSecs === 0) {
    return (
      <div className="pairing-panel-status">
        <h3>This link code expired</h3>
        <p>The other device didn't connect in time. Generate a new code to try the connection again.</p>
        <button type="button" className="button primary" onClick={onRegenerate}>
          Generate New Code
        </button>
      </div>
    );
  }

  const formatted = formatJoinCode(joinCode);
  // Six digits for an older version go over Wi-Fi only.
  const nearby = isLegacyCode(joinCode) ? undefined : nearbyName;
  const left = remainingSecs == null ? 1 : Math.max(0, Math.min(1, remainingSecs / CODE_LIFETIME_SECS));

  return (
    <div className="pairing-host-content">
      <div className="pairing-code-hero" aria-label={`Link code ${formatted}`}>
        <span className="pairing-code-hero-tag">Link code</span>
        <CodeDigits code={joinCode} />
        {remainingSecs !== null && (
          <div className="pairing-code-expiry">
            <div className="pairing-code-expiry-track" aria-hidden="true">
              <div className="pairing-code-expiry-fill" style={{ transform: `scaleX(${left})` }} />
            </div>
            <span>
              Expires in <strong>{formatCountdown(remainingSecs)}</strong>
            </span>
          </div>
        )}
      </div>

      <SearchingRow>Waiting for the other device to connect…</SearchingRow>

      {nearby && (isAndroid() || isIOS()) ? <DiscoverableNote autoPickup={autoPickup} /> : null}

      {nearby && onOpenFile ? (
        <button type="button" className="button ghost pairing-open-file-btn" disabled={busy} onClick={onOpenFile}>
          <FolderIcon />
          <span>Open File from Files</span>
        </button>
      ) : null}

      {onOtherWays ? <OtherWaysLink onClick={onOtherWays} /> : null}
    </div>
  );
}

/**
 * The code as tiles in groups of three, two groups to a row: twelve letters fill two rows, an
 * older version's six digits one.
 */
function CodeDigits({ code }: { code: string }) {
  const characters = formatJoinCode(code).replace(/ /g, "").split("");
  return (
    <div className={`pairing-code-digits${isLegacyCode(code) ? "" : " is-long"}`} aria-hidden="true">
      {characters.map((character, index) => (
        <span key={index} className={`pairing-code-digit${startsGroupInRow(index) ? " group-start" : ""}`}>
          {character}
        </span>
      ))}
    </div>
  );
}

/**
 * Phones: a device on another account can send here only if Quick Share (Android) or AirDrop
 * (iPhone) lets everyone share with this one, and no app can open or change that setting, so this
 * says where it is.
 */
function DiscoverableNote({ autoPickup = false }: { autoPickup?: boolean }) {
  const ios = isIOS();
  return (
    <div className="pairing-discover-note">
      {ios ? (
        // AirDrop's own setting: Settings → General → AirDrop → Everyone for 10 Minutes.
        <p>
          To use <strong>AirDrop</strong>, set it to <strong>Everyone for 10 Minutes</strong> to allow devices to sync.
        </p>
      ) : (
        <p>
          To use <strong>Quick Share</strong>, set <strong>Who can share with you</strong> to{" "}
          <strong>Everyone for 10 minutes</strong> to allow devices to sync.
        </p>
      )}
      <p>
        {ios
          ? "To change this, search for AirDrop in your device Settings, then return here."
          : "To change this, search for Quick Share in your device Settings, then return here."}
      </p>
      {ios ? (
        <p>
          {autoPickup
            ? "AirDrop files saved to Downloads are picked up automatically when you return here. You can also tap Open File from Files below."
            : "If AirDrop saves the file to Files, tap Open File from Files below and choose it from Downloads."}
        </p>
      ) : null}
    </div>
  );
}

/** A pulsing dot and what this device is waiting for. */
export function SearchingRow({ children }: { children: ReactNode }) {
  return (
    <div className="pairing-searching-row">
      <span className="pairing-pulse" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/** Opens the other ways to connect from a code screen. */
export function OtherWaysLink({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="pairing-other-ways pairing-other-ways-quiet" disabled={disabled} onClick={onClick}>
      Other ways to connect
    </button>
  );
}
