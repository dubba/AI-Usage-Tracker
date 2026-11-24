import {
  cleanCode,
  codeGroupSize,
  codeLength,
  formatJoinCode,
  isCompleteCode,
  isLegacyCode,
  isLinkCode,
} from "../lib/view-model";

import { ChevronIcon, NearbyShareIcon } from "../../../shared/ui/icons";
import { isMobileDevice } from "../../../shared/lib/platform";
import { OtherWaysLink, SearchingRow } from "./HostCodeView";

/**
 * Typing in the link code shown on the other device: ten letters, or six digits from a device with
 * an older version. The last character connects by itself over Wi-Fi. For a ten-letter code where
 * there is AirDrop or Quick Share, a button sends the accounts that way instead, offered above all
 * when the search finds no one.
 */
export function CodeEntryView({
  value,
  busy,
  onChange,
  onSubmit,
  onBack,
  onOtherWays,
  nearbyName,
  notFound,
  onUseNearby,
  fallback,
  setKeyboardOpen,
}: {
  value: string;
  busy: boolean;
  /** Receives the code as `cleanCode` leaves it. */
  onChange: (code: string) => void;
  /** Connect with `code`, complete. */
  onSubmit: (code: string) => void;
  onBack: () => void;
  /** Lists the other ways to connect (older versions, QR code). Absent while Settings > Device Sync hides them. */
  onOtherWays?: () => void;
  /** "AirDrop" or "Quick Share" where the request can go that way; absent where it can't. */
  nearbyName?: string;
  /** The Wi-Fi search for this code ended without finding the other device. */
  notFound?: boolean;
  /** Sends the accounts for the typed code by AirDrop or Quick Share now. */
  onUseNearby?: () => void;
  /** While the Wi-Fi search runs: the seconds left in it. */
  fallback?: { secsLeft: number; totalSecs: number };
  /** Lets the field flag the on-screen keyboard before the viewport has resized. */
  setKeyboardOpen: (open: boolean) => void;
}) {
  const complete = isCompleteCode(value);
  const legacy = isLegacyCode(value);
  const length = codeLength(value);
  const group = codeGroupSize(value);
  const searching = busy && fallback != null;
  const tiles = Array.from({ length }, (_, index) => value[index] ?? "");
  const activeIndex = Math.min(value.length, length - 1);
  // Only a ten-letter code can go by file.
  const nearby = legacy ? undefined : nearbyName;

  return (
    <div className="pairing-code-entry-view">
      <label className={`pairing-code-tiles${busy ? " is-busy" : ""}${legacy ? "" : " is-long"}`}>
        <input
          id="pairing-join-code-input"
          aria-label="Link code"
          className="pairing-code-input"
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          maxLength={length + 2}
          value={formatJoinCode(value)}
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
            const code = cleanCode(event.target.value);
            onChange(code);
            // The last character connects: there is nothing else to decide.
            if (isCompleteCode(code) && !isCompleteCode(value)) onSubmit(code);
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
            }${index === group ? " group-start" : ""}`}
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
                Not found within <strong>{fallback.secsLeft} {fallback.secsLeft === 1 ? "second" : "seconds"}</strong>?
                You can send by {nearby} instead.
              </p>
            </>
          ) : (
            <SearchingRow>Finishing the search on Wi-Fi…</SearchingRow>
          )
        ) : busy ? (
          <SearchingRow>Looking for the other device on Wi-Fi…</SearchingRow>
        ) : notFound && nearby ? (
          <p className="pairing-code-help pairing-code-not-found" role="status">
            <strong>Couldn't find the other device on the same Wi-Fi network.</strong> Tap <strong>Use {nearby}</strong> to
            sync accounts instead, or connect both devices to the same Wi-Fi and tap Connect. If a VPN is on, turn it off
            on both devices.
          </p>
        ) : (
          <p className="pairing-code-help">
            {legacy
              ? "A 6-digit code from an older version connects over Wi-Fi only."
              : nearby
                ? `Connects over Wi-Fi or a hotspot. If the other device isn't on the same network, you can send by ${nearby} instead.`
                : "Both devices must be connected to the same Wi-Fi network."}
          </p>
        )}
      </div>

      {nearby && onUseNearby ? (
        <button
          type="button"
          className={`button pairing-nearby-btn${notFound ? " is-suggested" : ""}`}
          disabled={!isLinkCode(value) || (busy && !searching)}
          onClick={onUseNearby}
        >
          <NearbyShareIcon />
          <span>{searching ? `Use ${nearby} now` : `Use ${nearby}`}</span>
        </button>
      ) : null}

      {onOtherWays ? <OtherWaysLink disabled={busy && !searching} onClick={onOtherWays} /> : null}

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
