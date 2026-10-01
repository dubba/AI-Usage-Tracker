import { CameraIcon, KeypadIcon, QrIcon } from "../../../shared/ui/icons";
import type { IntendedRole } from "../lib/view-model";

/** Step 2: show a link code, enter one, show an animated QR code, or scan one. */
export function ModeSelectView({
  intendedRole,
  onShowCode,
  onEnterCode,
  onShowQr,
  onScan,
}: {
  intendedRole: IntendedRole | null;
  onShowCode: () => void;
  onEnterCode: () => void;
  onShowQr: () => void;
  onScan: () => void;
}) {
  return (
    <div className="pairing-mode-select-view">
      <div className="pairing-mode-cards">
        <button type="button" className="pairing-mode-card" onClick={onShowCode}>
          <div className="pairing-mode-card-icon wifi">
            <KeypadIcon />
          </div>
          <div className="pairing-mode-card-body">
            <div className="pairing-mode-card-header">
              <span className="pairing-mode-card-title">Show Link code</span>
              <span className="pairing-mode-badge wifi">On same Wi-Fi</span>
            </div>
            <p className="pairing-mode-card-desc">
              Display code to enter on other device. Use if devices are on the same Wi-Fi.
            </p>
          </div>
        </button>

        <button type="button" className="pairing-mode-card" onClick={onEnterCode}>
          <div className="pairing-mode-card-icon enter">
            <KeypadIcon />
          </div>
          <div className="pairing-mode-card-body">
            <div className="pairing-mode-card-header">
              <span className="pairing-mode-card-title">Enter Link code</span>
              <span className="pairing-mode-badge enter">On same Wi-Fi</span>
            </div>
            <p className="pairing-mode-card-desc">
              Type Link code shown on other device.
            </p>
          </div>
        </button>

        {intendedRole !== "receive" ? (
          <button type="button" className="pairing-mode-card" onClick={onShowQr}>
            <div className="pairing-mode-card-icon qr">
              <QrIcon />
            </div>
            <div className="pairing-mode-card-body">
              <div className="pairing-mode-card-header">
                <span className="pairing-mode-card-title">Show QR code</span>
                <span className="pairing-mode-badge qr">No Wi-Fi needed</span>
              </div>
              <p className="pairing-mode-card-desc">
                Displays animated QR code to scan. Use if devices are on different networks.
              </p>
            </div>
          </button>
        ) : null}

        <button type="button" className="pairing-mode-card" onClick={onScan}>
          <div className="pairing-mode-card-icon scan">
            <CameraIcon />
          </div>
          <div className="pairing-mode-card-body">
            <div className="pairing-mode-card-header">
              <span className="pairing-mode-card-title">Scan QR code</span>
              <span className="pairing-mode-badge scan">Uses camera</span>
            </div>
            <p className="pairing-mode-card-desc">
              Scan QR code shown on other device.
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
