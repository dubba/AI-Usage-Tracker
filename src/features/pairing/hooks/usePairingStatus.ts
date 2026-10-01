import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pairingApi } from "../../../shared/lib/api";
import { logIgnored } from "../../../shared/lib/log";
import type { PairingStatus } from "../../../types";
import { waitingExpiresAt } from "../lib/view-model";

/**
 * The backend's pairing status while the dialog is open: pushed by the `pairing-status` event
 * with an 800ms poll as a fallback, plus the seconds left on a code being shown. Once completed
 * it stays completed, so a late poll cannot undo it.
 */
export function usePairingStatus(open: boolean) {
  const [status, setStatus] = useState<PairingStatus>({ status: "idle" });
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);
  const hasCompletedRef = useRef(false);

  useEffect(() => {
    if (!open) return;

    let unlisten: (() => void) | undefined;
    let pollInterval: ReturnType<typeof setInterval> | undefined;
    const keepCompleted = (next: PairingStatus) => (prev: PairingStatus) =>
      hasCompletedRef.current && prev.status === "completed" ? prev : next;

    const setupListener = async () => {
      try {
        unlisten = await listen<PairingStatus>("pairing-status", (event) => {
          setStatus(keepCompleted(event.payload));
        });
      } catch (cause) {
        // Event listener unavailable, polling will handle it
        logIgnored("pairing-status listener", cause);
      }
    };

    void setupListener();

    pollInterval = setInterval(() => {
      void pairingApi.status().then((current) => {
        setStatus(keepCompleted(current));
      }).catch(() => {
        // Polled every 800ms; a transient failure just retries on the next tick.
      });
    }, 800);

    return () => {
      if (unlisten) unlisten();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [open]);

  useEffect(() => {
    const expiresAt = waitingExpiresAt(status);
    if (!expiresAt) {
      setRemainingSecs(null);
      return;
    }

    const updateCountdown = () => {
      const nowSecs = Math.floor(Date.now() / 1000);
      setRemainingSecs(Math.max(0, expiresAt - nowSecs));
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [status]);

  return { status, setStatus, remainingSecs, hasCompletedRef };
}
