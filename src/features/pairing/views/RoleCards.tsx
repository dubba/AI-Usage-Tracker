import { DownloadIcon, UploadIcon } from "../../../shared/ui/icons";
import type { IntendedRole } from "../lib/view-model";

/** The send and receive choices, used in step 1 and when devices joined through a link. */
export function RoleCards({ disabled, onChoose }: { disabled?: boolean; onChoose: (role: IntendedRole) => void }) {
  return (
    <div className="pairing-role-cards">
      <button type="button" className="pairing-role-card" disabled={disabled} onClick={() => onChoose("send")}>
        <div className="pairing-role-card-icon send">
          <UploadIcon />
        </div>
        <div className="pairing-role-card-content">
          <h4>Send Accounts from This Device</h4>
          <p>Export accounts, tokens, and groups to another device.</p>
        </div>
      </button>

      <button type="button" className="pairing-role-card" disabled={disabled} onClick={() => onChoose("receive")}>
        <div className="pairing-role-card-icon receive">
          <DownloadIcon />
        </div>
        <div className="pairing-role-card-content">
          <h4 className="pairing-role-title-receive">Receive Accounts on This Device</h4>
          <p>Import accounts, tokens, and groups from another device.</p>
        </div>
      </button>
    </div>
  );
}
