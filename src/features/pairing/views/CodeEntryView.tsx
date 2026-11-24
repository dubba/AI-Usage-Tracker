import { PAIRING_CODE_LENGTH } from "../lib/view-model";

import { ChevronIcon } from "../../../shared/ui/icons";
import { isMobileDevice } from "../../../shared/lib/platform";
import { OtherWaysLink } from "./HostCodeView";

/** Shows the code as two groups of three ("123 456"), like the placeholder and the sending device. */
const CODE_GROUP = 3;
function groupCode(digits: string): string {
  return digits.length > CODE_GROUP ? `${digits.slice(0, CODE_GROUP)} ${digits.slice(CODE_GROUP)}` : digits;
}

/** Typing in the six-digit link code shown on the other device. */
export function CodeEntryView({
  value,
  busy,
  onChange,
  onSubmit,
  onBack,
  onOtherWays,
  onUseFile,
  fileFallbackSecs,
  setKeyboardOpen,
}: {
  value: string;
  busy: boolean;
  /** Receives the digits only, at most six. */
  onChange: (digits: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  /** Lists the other ways to connect (older versions, QR code). */
  onOtherWays: () => void;
  /** Saves a request file for the typed code; absent where files are not offered yet. */
  onUseFile?: () => void;
  /**
   * Where a request goes out by itself when the Wi-Fi search finds nothing (Android): the seconds
   * left, counting down while the search runs. The file link stays usable then, to skip the wait.
   */
  fileFallbackSecs?: number;
  /** Lets the field flag the on-screen keyboard before the viewport has resized. */
  setKeyboardOpen: (open: boolean) => void;
}) {
  // While the code is being looked for on the network (busy), a file can still be chosen instead.
  const secsLeft = busy ? fileFallbackSecs : undefined;
  const searchingWithFallback = secsLeft != null;
  return (
    <div className="pairing-code-entry-view">
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
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, PAIRING_CODE_LENGTH))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.length === PAIRING_CODE_LENGTH) onSubmit();
        }}
        aria-describedby="pairing-code-help"
      />
      <p id="pairing-code-help" className="pairing-code-help">
        {searchingWithFallback
          ? secsLeft > 0
            ? `Looking for the other device on this network. If it isn't found in ${secsLeft} ${
                secsLeft === 1 ? "second" : "seconds"
              }, the share menu opens to send a request by Quick Share.`
            : "The other device wasn't found on this network. Opening the share menu…"
          : onUseFile
            ? "Works when both devices are on the same Wi-Fi. If they aren't, use a file instead."
            : "Both devices must be connected to the same Wi-Fi network."}
      </p>

      <div className="pairing-code-links">
        {onUseFile ? (
          <button
            type="button"
            className="pairing-other-ways"
            disabled={busy && !searchingWithFallback}
            onClick={() => {
              // The request is made for the typed code, so until it is complete the tap only
              // points at the box (the link stays purple rather than looking unavailable).
              if (value.length === PAIRING_CODE_LENGTH) onUseFile();
              else document.getElementById("pairing-join-code-input")?.focus();
            }}
          >
            {searchingWithFallback ? "Use Quick Share now" : "Not on the same network? Use a file instead"}
          </button>
        ) : null}
        <OtherWaysLink disabled={busy} onClick={onOtherWays} />
      </div>

      <div className="pairing-scanner-controls pairing-code-actions">
        <button type="button" className="button ghost pairing-back-btn" onClick={onBack}>
          <ChevronIcon style={{ transform: "rotate(180deg)" }} />
          <span>Back</span>
        </button>
        <button type="button" className="button primary" disabled={busy || value.length !== PAIRING_CODE_LENGTH} onClick={onSubmit}>
          {busy ? "Connecting…" : "Connect to Device"}
        </button>
      </div>
    </div>
  );
}
