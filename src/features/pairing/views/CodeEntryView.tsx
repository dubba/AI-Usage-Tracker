import { PAIRING_CODE_LENGTH } from "../lib/view-model";

import { ChevronIcon } from "../../../shared/ui/icons";
import { isMobileDevice } from "../../../shared/lib/platform";
import { OtherWaysLink } from "./HostCodeView";

/** Typing in the six-digit link code shown on the other device. */
export function CodeEntryView({
  value,
  busy,
  onChange,
  onSubmit,
  onBack,
  onOtherWays,
  onUseFile,
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
  /** Lets the field flag the on-screen keyboard before the viewport has resized. */
  setKeyboardOpen: (open: boolean) => void;
}) {
  return (
    <div className="pairing-code-entry-view">
      <input
        id="pairing-join-code-input"
        aria-label="Link code"
        className="pairing-code-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={PAIRING_CODE_LENGTH}
        placeholder="000 000"
        value={value}
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
        Both devices must be connected to the same Wi-Fi network.
      </p>

      {onUseFile ? (
        <button
          type="button"
          className="pairing-other-ways"
          disabled={busy || value.length !== PAIRING_CODE_LENGTH}
          onClick={onUseFile}
        >
          Not on the same network? Use a file instead
        </button>
      ) : null}
      <OtherWaysLink disabled={busy} onClick={onOtherWays} />

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
