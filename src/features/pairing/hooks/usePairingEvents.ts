import { useCallback, useEffect, useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { logIgnored } from "../../../shared/lib/log";
import { applyUiState } from "../../dashboard/ui-state";
import { useTauriEvent } from "../../../shared/hooks/useTauriEvent";

function isPairingUri(uri: string | null | undefined): uri is string {
  return Boolean(uri && (uri.startsWith("aiusage-pair:") || uri.startsWith("aiusage:")));
}

/** Pairing modal state, deep-link URIs, and UI state (order, collapsed cards, sidebar width) sent by a paired device. */
export function usePairingEvents() {
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingInitialUri, setPairingInitialUri] = useState<string | null>(null);

  const openWithUri = useCallback((uri: string) => {
    setPairingInitialUri(uri);
    setPairingOpen(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const uri = await pairingApi.getPendingPairingUri();
        if (!cancelled && isPairingUri(uri)) openWithUri(uri);
      } catch (cause) {
        logIgnored("pending pairing uri", cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openWithUri]);

  useTauriEvent<string>("pairing-uri-received", (uri) => {
    if (isPairingUri(uri)) openWithUri(uri);
  });

  // Apply UI state transferred via pairing (sidebar order, collapsed cards, etc.)
  useTauriEvent<Record<string, unknown>>("pairing-ui-state", (payload) => {
    try {
      applyUiState(payload);
    } catch (cause) {
      logIgnored("apply pairing ui state", cause);
    }
  });

  const closePairing = useCallback(() => {
    setPairingOpen(false);
    setPairingInitialUri(null);
  }, []);

  return { pairingOpen, setPairingOpen, pairingInitialUri, closePairing };
}
