import { useCallback, useState } from "react";
import { logIgnored } from "../../../shared/lib/log";
import { applyUiState } from "../../layout/ui-state";
import { useTauriEvent } from "../../../shared/hooks/useTauriEvent";

/** Pairing modal state, and UI state (order, collapsed cards, sidebar width, theme, menu bar labels) sent by a paired device. */
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

  const closePairing = useCallback(() => setPairingOpen(false), []);

  return { pairingOpen, setPairingOpen, closePairing };
}
