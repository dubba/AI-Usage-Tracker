import { ExternalLinkIcon } from "../../shared/ui/icons";
import { ToggleSwitch } from "../../shared/ui/ToggleSwitch";
import { isMobileDevice } from "../../shared/lib/platform";
import type { BridgeStatus } from "../../types";

/** The Paseo Bridge (local HTTP API) switch and its window. Not shown on a phone or tablet. */
export function LocalApiSection({
  bridge,
  bridgeBusy,
  integrationWindowBusy,
  onToggleBridge,
  onViewBridgeWindow,
}: {
  bridge: BridgeStatus | null;
  bridgeBusy: boolean;
  integrationWindowBusy: boolean;
  onToggleBridge: (enabled: boolean) => void;
  onViewBridgeWindow: () => void;
}) {
  if (isMobileDevice()) return null;
  return (
    <>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong id="setting-bridge-label">Paseo Bridge</strong>
            <small>Allows local HTTP tools to access quota usage & notification status.</small>
          </div>
          <ToggleSwitch
            checked={Boolean(bridge?.enabled)}
            labelledBy="setting-bridge-label"
            disabled={bridgeBusy}
            onChange={onToggleBridge}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>Integration Window</strong>
            <small>View local bridge status, auth tokens and connection URL.</small>
          </div>
          <button
            type="button"
            className="button ghost settings-changelog-button"
            aria-label="View integration window (opens in a new window)"
            data-tooltip="Opens in a new window"
            disabled={integrationWindowBusy}
            onClick={onViewBridgeWindow}
          >
            <span>View</span>
            <ExternalLinkIcon />
          </button>
        </div>
      </section>
      {bridge?.error ? <div className="error-panel api-integration-error" role="alert">{bridge.error}</div> : null}
    </>
  );
}
