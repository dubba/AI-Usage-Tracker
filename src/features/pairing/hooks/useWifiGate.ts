import { useEffect, useEffectEvent, useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { logIgnored } from "../../../shared/lib/log";
import { isMobileDevice } from "../../../shared/lib/platform";

/** How often the "turn on Wi-Fi" prompt checks whether Wi-Fi came on. */
const WIFI_POLL_MS = 800;

export type LinkCodeAction = "host" | "code";

/**
 * Link codes work over Wi-Fi. `requireWifiThen(action)` runs `onReady(action)` at once on a
 * desktop or when Wi-Fi is on; otherwise it raises `prompt` (the dialog asks to turn Wi-Fi on) and
 * keeps checking, also when the app regains focus after the system settings, and runs `onReady`
 * as soon as Wi-Fi is on. The check itself failing counts as "on" rather than blocking the user.
 */
export function useWifiGate({ open, onReady }: { open: boolean; onReady: (action: LinkCodeAction) => void }) {
  const [prompt, setPrompt] = useState<LinkCodeAction | null>(null);
  const handleReady = useEffectEvent(onReady);

  const requireWifiThen = async (action: LinkCodeAction) => {
    if (!isMobileDevice()) {
      onReady(action);
      return;
    }
    let enabled = true;
    try {
      enabled = await pairingApi.wifiEnabled();
    } catch (cause) {
      logIgnored("pairing.wifiEnabled", cause);
    }
    if (enabled) {
      onReady(action);
      return;
    }
    setPrompt(action);
  };

  // While the prompt is up, poll so returning from the system panel (or flipping Wi-Fi in the
  // Android overlay) continues the link-code step.
  useEffect(() => {
    if (!open || !prompt) return;
    let cancelled = false;
    let continued = false;
    const action = prompt;
    const tick = async () => {
      try {
        const enabled = await pairingApi.wifiEnabled();
        if (cancelled || continued || !enabled) return;
        continued = true;
        setPrompt(null);
        handleReady(action);
      } catch (cause) {
        logIgnored("pairing.wifiEnabled", cause);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const id = window.setInterval(() => void tick(), WIFI_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [open, prompt]);

  return { prompt, setPrompt, requireWifiThen };
}
