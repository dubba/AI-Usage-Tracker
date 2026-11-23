import { useCallback, useState } from "react";
import { logIgnored } from "../../../shared/lib/log";
import { applyUiState } from "../../layout/ui-state";
import { useTauriEvent } from "../../../shared/hooks/useTauriEvent";
import { useTappedTransferFile } from "./useTappedTransferFile";

/** Pairing modal state (also opened by a transfer file tapped in Quick Share), and UI state (order, collapsed cards, sidebar width, theme, menu bar labels) sent by a paired device. */
export function usePairingEvents() {
  const [pairingOpen, setPairingOpen] = useState(false);

  // Apply UI state transferred via pairing (sidebar order, collapsed cards, theme, etc.)
  useTauriEvent<Record<string, unknown>>("pairing-ui-state", (payload) => {
    try {
      applyUiState(payload);
    } catch (cause) {
      logIgnored("apply pairing ui state", cause);
    }
  });

  // A transfer file tapped in Quick Share while Sync Devices is closed opens it, and the dialog
  // then opens the file (or says which step this device must reach first).
  useTappedTransferFile(!pairingOpen, () => setPairingOpen(true));

  const closePairing = useCallback(() => setPairingOpen(false), []);

  return { pairingOpen, setPairingOpen, closePairing };
}
