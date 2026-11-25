import { useEffect, useEffectEvent, useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { logIgnored } from "../../../shared/lib/log";
import type { FilePreview } from "../../../types";

/** How often Downloads is checked for the file while waiting. */
const POLL_MS = 1000;
/** How often Android is asked whether file access was allowed, while it isn't. */
const ACCESS_POLL_MS = 1500;

/**
 * Waits for the transfer file while `active` (the receiver showing its link code), with nothing to
 * tap. Rust watches Downloads, where AirDrop (Mac/iPhone) and Quick Share (Windows/Android) save
 * what they receive, and opens the file that arrives with the code; `onOpened` gets it. On iPhone
 * tapping the file directly in Files also hands it to the app (`useTappedTransferFile`).
 *
 * Android (All files access) and iPhone (one-time Downloads folder bookmark) need user permission
 * first: `needsAccess` is then true until allowed through `requestAccess`, which is re-checked
 * every 1.5 s so returning from Settings or the folder picker starts watching automatically.
 */
export function useIncomingFile({
  active,
  onOpened,
  onError,
}: {
  active: boolean;
  onOpened: (opened: FilePreview) => void;
  onError: (cause: unknown) => void;
}) {
  const [watching, setWatching] = useState(false);
  const [needsAccess, setNeedsAccess] = useState(false);
  /** The first watch answered, so `needsAccess` is known. */
  const [checked, setChecked] = useState(false);
  const handleOpened = useEffectEvent(onOpened);
  const handleError = useEffectEvent(onError);

  useEffect(() => {
    if (!active) {
      setWatching(false);
      setNeedsAccess(false);
      setChecked(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let polling = false;

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const opened = await pairingApi.pollForFile();
        if (!cancelled && opened) handleOpened(opened);
      } catch (cause) {
        if (!cancelled) handleError(cause);
      } finally {
        polling = false;
      }
    };

    const start = async () => {
      try {
        const info = await pairingApi.watchForFile();
        if (cancelled) return;
        setWatching(info.watching);
        setNeedsAccess(info.needsAccess);
        setChecked(true);
        if (info.watching) {
          timer = window.setInterval(() => void poll(), POLL_MS);
        } else if (info.needsAccess) {
          // Try again once the user may have allowed it.
          timer = window.setTimeout(() => void start(), ACCESS_POLL_MS);
        }
      } catch (cause) {
        logIgnored("pairing.watchForFile", cause);
        if (!cancelled) setChecked(true);
      }
    };
    void start();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(timer);
      void pairingApi.stopWatchingForFile().catch((cause) => logIgnored("pairing.stopWatchingForFile", cause));
    };
  }, [active]);

  const requestAccess = () => {
    void pairingApi.requestFileAccess().catch(onError);
  };

  return { watching, needsAccess, checked, requestAccess };
}
