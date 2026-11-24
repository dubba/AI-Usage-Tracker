import { PAIRING_CODE_LENGTH } from "../lib/view-model";

import { ChevronIcon, NearbyShareIcon } from "../../../shared/ui/icons";
import { isMobileDevice } from "../../../shared/lib/platform";
import { FileAccessNote, OtherWaysLink, SearchingRow } from "./HostCodeView";

/** Shows the code as two groups of three ("123 456"), like the placeholder and the sending device. */
const CODE_GROUP = 3;
function groupCode(digits: string): string {
  return digits.length > CODE_GROUP ? `${digits.slice(0, CODE_GROUP)} ${digits.slice(CODE_GROUP)}` : digits;
}

/**
 * Typing in the six-digit link code shown on the other device. The sixth digit connects by itself;
 * the search runs on Wi-Fi first and, where there is AirDrop or Quick Share, switches to it when
 * the other device isn't found.
 */
export function CodeEntryView({
  value,
  busy,
  onChange,
  onSubmit,
  onBack,
  onOtherWays,
  nearbyName,
  onUseNearby,
  fallback,
  fileAccess,
  setKeyboardOpen,
}: {
  value: string;
  busy: boolean;
  /** Receives the digits only, at most six. */
  onChange: (digits: string) => void;
  /** Connect with `code` (six digits). */
  onSubmit: (code: string) => void;
  onBack: () => void;
  /** Lists the other ways to connect (older versions, QR code). */
  onOtherWays: () => void;
  /** "AirDrop" or "Quick Share" where the request can go that way; absent where it can't. */
  nearbyName?: string;
  /** Sends the request for the typed code by AirDrop or Quick Share now. */
  onUseNearby?: () => void;
  /** While the Wi-Fi search runs: the seconds left before AirDrop or Quick Share takes over. */
  fallback?: { secsLeft: number; totalSecs: number };
  /** Android, until the app may read Downloads: the way to allow it. */
  fileAccess?: { needed: boolean; onAllow: () => void };
  /** Lets the field flag the on-screen keyboard before the viewport has resized. */
  setKeyboardOpen: (open: boolean) => void;
}) {
  const complete = value.length === PAIRING_CODE_LENGTH;
  const searching = busy && fallback != null;
  const tiles = Array.from({ length: PAIRING_CODE_LENGTH }, (_, index) => value[index] ?? "");
  const activeIndex = Math.min(value.length, PAIRING_CODE_LENGTH - 1);

  return (
    <div className="pairing-code-entry-view">
      <label className={`pairing-code-tiles${busy ? " is-busy" : ""}`}>
        <input
          id="pairing-join-code-input"
          aria-label="Link code"
          className="pairing-code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={PAIRING_CODE_LENGTH + 1}
          placeholder="000 000"
          value={groupCode(value)}
          autoFocus
          disabled={busy}
          onFocus={() => {
            if (isMobileDevice()) setKeyboardOpen(true);
          }}
          onBlur={() => {
            setTimeout(() => {
              const activeEl = document.activeElement;
              if (activeEl?.id !== "pairing-join-code-input") {
                const vv = window.visualViewport;
                if (!vv || window.innerHeight - vv.height <= 100) {
                  setKeyboardOpen(false);
                }
              }
            }, 120);
          }}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "").slice(0, PAIRING_CODE_LENGTH);
            onChange(digits);
            // The last digit connects: there is nothing else to decide.
            if (digits.length === PAIRING_CODE_LENGTH && value.length < PAIRING_CODE_LENGTH) onSubmit(digits);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && complete) onSubmit(value);
          }}
          aria-describedby="pairing-code-help"
        />
        {tiles.map((digit, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={`pairing-code-tile${digit ? " is-filled" : ""}${
              !busy && index === activeIndex && !complete ? " is-active" : ""
            }${index === CODE_GROUP ? " group-start" : ""}`}
          >
            {digit}
          </span>
        ))}
      </label>

      <div id="pairing-code-help" className="pairing-code-status">
        {searching ? (
          fallback.secsLeft > 0 ? (
            <>
              <SearchingRow>Looking for the other device on Wi-Fi…</SearchingRow>
              <div className="pairing-fallback-track" aria-hidden="true">
                <div
                  className="pairing-fallback-fill"
                  style={{ transform: `scaleX(${1 - fallback.secsLeft / fallback.totalSecs})` }}
                />
              </div>
              <p className="pairing-code-help">
                Not found within <strong>{fallback.secsLeft} {fallback.secsLeft === 1 ? "second" : "seconds"}</strong>?{" "}
                {nearbyName} takes over by itself.
              </p>
            </>
          ) : (
            <SearchingRow>Not on this network. Opening {nearbyName}…</SearchingRow>
          )
        ) : busy ? (
          <SearchingRow>Looking for the other device on Wi-Fi…</SearchingRow>
        ) : (
          <p className="pairing-code-help">
            {nearbyName
              ? `Connects over Wi-Fi or a hotspot. If the other device isn't on the same network, ${nearbyName} takes over by itself.`
              : "Both devices must be connected to the same Wi-Fi network."}
          </p>
        )}
      </div>

      {nearbyName && onUseNearby ? (
        <button
          type="button"
          className="button pairing-nearby-btn"
          disabled={!complete || (busy && !searching)}
          onClick={onUseNearby}
        >
          <NearbyShareIcon />
          <span>{searching ? `Use ${nearbyName} now` : `Use ${nearbyName}`}</span>
        </button>
      ) : null}

      {fileAccess?.needed ? <FileAccessNote name={nearbyName} onAllow={fileAccess.onAllow} /> : null}

      <OtherWaysLink disabled={busy && !searching} onClick={onOtherWays} />

      <div className="pairing-scanner-controls pairing-code-actions">
        <button type="button" className="button ghost pairing-back-btn" onClick={onBack}>
          <ChevronIcon style={{ transform: "rotate(180deg)" }} />
          <span>Back</span>
        </button>
        <button type="button" className="button primary" disabled={busy || !complete} onClick={() => onSubmit(value)}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </div>
  );
}
