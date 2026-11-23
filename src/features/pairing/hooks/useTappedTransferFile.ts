import { useEffect, useEffectEvent } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { logIgnored } from "../../../shared/lib/log";
import { isAndroid } from "../../../shared/lib/platform";

/**
 * The window event Android dispatches when a transfer file is tapped while the app is running
 * (`MainActivity.TRANSFER_FILE_TAPPED_EVENT`). The WebView sends no visibilitychange or focus
 * event when the app comes back to the front, so this is what notices a file then.
 */
export const TRANSFER_FILE_TAPPED_EVENT = "aiut-transfer-file-tapped";

/**
 * Android: a Sync Devices transfer file tapped in another app (Quick Share's notification) opens
 * this app, which keeps the file until it is taken. While `active`, this checks for one when it
 * starts (a cold start from the file), when Android says a file was tapped, and when the page
 * becomes visible or focused, and calls `onTapped` when one is waiting. Does nothing elsewhere.
 */
export function useTappedTransferFile(active: boolean, onTapped: () => void) {
  const handleTapped = useEffectEvent(onTapped);

  useEffect(() => {
    if (!active || !isAndroid()) return;
    let cancelled = false;
    const check = async () => {
      try {
        if ((await pairingApi.tappedFilePending()) && !cancelled) handleTapped();
      } catch (cause) {
        logIgnored("pairing.tappedFilePending", cause);
      }
    };
    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    // Android says so itself; the page may not count as visible yet at that moment.
    const onTappedEvent = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(TRANSFER_FILE_TAPPED_EVENT, onTappedEvent);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(TRANSFER_FILE_TAPPED_EVENT, onTappedEvent);
    };
  }, [active]);
}
