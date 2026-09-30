import { useCallback, useEffect, useState } from "react";
import { pairingApi } from "../api";
import { applyPageUiState } from "../dashboard-page-state";
import { useTauriEvent } from "./useTauriEvent";

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
      } catch {}
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
      if (Array.isArray(payload.sidebar_group_order)) {
        window.localStorage.setItem(
          "ai-subscription-tracker:sidebar-group-order",
          JSON.stringify(payload.sidebar_group_order),
        );
        window.dispatchEvent(
          new CustomEvent("ai-subscription-tracker:group-order-changed", {
            detail: payload.sidebar_group_order,
          }),
        );
      }
      if (Array.isArray(payload.provider_order)) {
        window.localStorage.setItem(
          "ai-subscription-tracker:provider-order",
          JSON.stringify(payload.provider_order),
        );
        window.dispatchEvent(
          new CustomEvent("ai-subscription-tracker:provider-order-changed", {
            detail: payload.provider_order,
          }),
        );
      }
      applyPageUiState(payload);
      if (typeof payload.sidebar_width === "number" && payload.sidebar_width > 0) {
        window.localStorage.setItem("paseo-usage-bridge:sidebar-width", String(payload.sidebar_width));
        document.documentElement.style.setProperty("--sidebar-width", `${payload.sidebar_width}px`);
      }
    } catch {}
    window.dispatchEvent(new Event("focus"));
  });

  const closePairing = useCallback(() => {
    setPairingOpen(false);
    setPairingInitialUri(null);
  }, []);

  return { pairingOpen, setPairingOpen, pairingInitialUri, closePairing };
}
