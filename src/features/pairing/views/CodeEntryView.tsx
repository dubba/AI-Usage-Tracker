import { ChevronIcon, ShieldIcon } from "../../../shared/ui/icons";
import { isMobileDevice } from "../../../shared/lib/platform";

/** Typing in the six-digit link code shown on the other device. */
export function CodeEntryView({
  value,
  busy,
  onChange,
  onSubmit,
  onBack,
  setKeyboardOpen,
}: {
  value: string;
  busy: boolean;
  /** Receives the digits only, at most six. */
  onChange: (digits: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  /** Lets the field flag the on-screen keyboard before the viewport has resized. */
  setKeyboardOpen: (open: boolean) => void;
}) {
  return (
    <div className="pairing-code-entry-view">
      <input
        id="pairing-join-code-input"
        className="pairing-code-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
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
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.length === 6) onSubmit();
        }}
        aria-describedby="pairing-code-help"
      />
      <p id="pairing-code-help" className="pairing-code-help">
        Both devices must be connected to the same Wi-Fi network.
      </p>

      <div className="pairing-security-note">
        <ShieldIcon />
        <span>End-to-end encrypted · Direct peer-to-peer transfer</span>
      </div>

      <div className="pairing-scanner-controls pairing-code-actions">
        <button type="button" className="button pairing-back-btn" onClick={onBack}>
          <ChevronIcon style={{ transform: "rotate(180deg)" }} />
          <span>Back</span>
        </button>
        <button type="button" className="button primary" disabled={busy || value.length !== 6} onClick={onSubmit}>
          {busy ? "Connecting…" : "Connect to Device"}
        </button>
      </div>
    </div>
  );
}
