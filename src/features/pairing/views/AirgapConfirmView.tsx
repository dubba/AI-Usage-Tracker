import { ChevronIcon, ShieldIcon } from "../../../shared/ui/icons";

/** The air-gap sender's code to compare with the receiving device. */
export function AirgapConfirmView({
  verifyCode,
  onBack,
  onCancel,
}: {
  verifyCode: string;
  onBack: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="airgap-pin-prompt-card">
      <div className="pairing-sas-icon"><ShieldIcon /></div>
      <h3>Do both devices show this code?</h3>
      <p className="pairing-instruction">
        Compare this code with the receiving device. Import only if both screens match.
      </p>
      <div className="pairing-sas-badge" aria-label={`Verification code ${verifyCode}`}>
        {verifyCode}
      </div>

      <div className="airgap-prompt-actions">
        <button type="button" className="button pairing-back-btn" onClick={onBack}>
          <ChevronIcon style={{ transform: "rotate(180deg)" }} />
          <span>Back</span>
        </button>
        <button type="button" className="button ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
