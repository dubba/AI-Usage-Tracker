import { useEffect, useEffectEvent } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { logIgnored } from "../../../shared/lib/log";
import { isAndroid, isIOS, isMac } from "../../../shared/lib/platform";

/**
 * The window event Android, iOS and macOS dispatch when a transfer file is opened while the app is
 * running (`MainActivity.TRANSFER_FILE_TAPPED_EVENT` on Android, `RunEvent::Opened` on Apple). The
 * WebView sends no visibilitychange or focus event when the app comes back to the front, so this is
 * what notices a file then.
 */
export const TRANSFER_FILE_TAPPED_EVENT = "aiut-transfer-file-tapped";

/** How often iOS checks its app inbox while the receiver is showing a link code. */
const IOS_INBOX_POLL_MS = 1000;

/**
 * Android, iOS and macOS: a Sync Devices transfer file opened from another app (Quick Share's
 * notification, AirDrop, Files, Finder) opens this app, which keeps the file until it is taken.
 * While `active`, this checks for one when it starts (a cold start from the file), when the native
 * layer says a file was opened, when the page becomes visible or focused, and (on iOS when `poll`
 * is set) every second while waiting for AirDrop, calling `onTapped` when one is waiting. Does
 * nothing on Windows or Linux.
 */
export function useTappedTransferFile(
  active: boolean,
  onTapped: () => void,
  options?: { poll?: boolean },
) {
  const handleTapped = useEffectEvent(onTapped);
  const shouldPoll = Boolean(options?.poll);

  useEffect(() => {
    if (!active || !(isAndroid() || isIOS() || isMac())) return;
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
    // The native layer says so itself; the page may not count as visible yet at that moment.
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

  useEffect(() => {
    if (!active || !shouldPoll || !isIOS()) return;
    let cancelled = false;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void pairingApi
        .tappedFilePending()
        .then((pending) => {
          if (pending && !cancelled) handleTapped();
        })
        .catch((cause) => logIgnored("pairing.tappedFilePending", cause))
        .finally(() => {
          polling = false;
        });
    }, IOS_INBOX_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, shouldPoll]);
}
