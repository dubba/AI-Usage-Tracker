import { useEffect, useEffectEvent } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { logIgnored } from "../../../shared/lib/log";
import { isAndroid } from "../../../shared/lib/platform";

/**
 * Android: a Sync Devices transfer file tapped in another app (Quick Share's notification) opens
 * this app, which keeps the file until it is taken. While `active`, this checks for one when it
 * starts and whenever the app comes back to the front, and calls `onTapped` when one is waiting.
 * Does nothing elsewhere.
 */
export function useTappedTransferFile(active: boolean, onTapped: () => void) {
  const handleTapped = useEffectEvent(onTapped);

  useEffect(() => {
    if (!active || !isAndroid()) return;
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        if ((await pairingApi.tappedFilePending()) && !cancelled) handleTapped();
      } catch (cause) {
        logIgnored("pairing.tappedFilePending", cause);
      }
    };
    void check();
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [active]);
}
