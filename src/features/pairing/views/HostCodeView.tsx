import type { ReactNode } from "react";
import type { PairingStatus } from "../../../types";
import { isAndroid } from "../../../shared/lib/platform";
import { formatCountdown, formatJoinCode, hostWaitingFields, isLegacyCode, startsGroupInRow } from "../lib/view-model";

/** How long a link code lasts (`transport::SESSION_TIMEOUT_SECS`), for the bar under it. */
const CODE_LIFETIME_SECS = 300;

/** The link code this device shows for the other one to type in. */
export function HostCodeView({
  status,
  remainingSecs,
  onRegenerate,
  onOtherWays,
  nearbyName,
  onOpenFile,
}: {
  status: PairingStatus;
  remainingSecs: number | null;
  /** The countdown hit zero; start a fresh session and code. */
  onRegenerate: () => void;
  /**
   * Ends this session and lists the other ways to connect (older versions, QR code). Absent while
   * Settings > Device Sync hides them.
   */
  onOtherWays?: () => void;
  /** "AirDrop" or "Quick Share" where the accounts can come that way; absent where files aren't offered. */
  nearbyName?: string;
  /** Opens the file by hand, for one that wasn't picked up by itself. */
  onOpenFile?: () => void;
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

      <SearchingRow>
        {nearby ? `Waiting for the other device on Wi-Fi or ${nearby}…` : "Waiting for the other device to connect…"}
      </SearchingRow>

      {nearby && isAndroid() ? <DiscoverableNote /> : null}

      {nearby && onOpenFile ? (
        <button type="button" className="pairing-other-ways" onClick={onOpenFile}>
          Received a file but nothing happened? Open it
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
 * Android: a phone on another Google account can send here only if Quick Share lets everyone share
 * with this one, and no app can open or change that setting, so this says where it is.
 */
function DiscoverableNote() {
  return (
    <div className="pairing-discover-note">
      <p>
        Unless both devices use the same Google Account, in Quick Share, set <strong>Who can share with you</strong> to{" "}
        <strong>Everyone for 10 Minutes</strong>.
      </p>
      <p>Go to Settings and search for Quick Share to change this setting.</p>
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
