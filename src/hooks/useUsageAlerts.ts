import { useCallback, useEffect, useRef, useState } from "react";
import { appendAlert, type UsageAlertToast } from "../usage-alerts";
import { useTauriEvent } from "./useTauriEvent";

const ALERT_AUTO_DISMISS_MS = 15_000;

type UsageAlertPayload = {
  accountId: string;
  accountLabel: string;
  provider: string;
  windowLabel: string;
  remainingPercent: number;
  thresholdPercent: number;
  title: string;
  body: string;
};

/** In-app usage-limit toasts: capped in number, auto-dismissed, and timer-safe on unmount. */
export function useUsageAlerts() {
  const [alerts, setAlerts] = useState<UsageAlertToast[]>([]);
  const timers = useRef(new Map<string, number>());

  const forget = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback((id: string) => {
    forget(id);
    setAlerts((current) => current.filter((alert) => alert.id !== id));
  }, [forget]);

  useTauriEvent<UsageAlertPayload>("usage-alert", (payload) => {
    if (!payload) return;
    const now = Date.now();
    const alert: UsageAlertToast = {
      id: `${payload.accountId}-${payload.windowLabel}-${now}`,
      title: payload.title,
      body: payload.body,
      timestamp: now,
    };
    // A toast pushed out by the cap keeps its timer; dismissing it later is a harmless no-op.
    setAlerts((current) => appendAlert(current, alert));
    timers.current.set(alert.id, window.setTimeout(() => dismiss(alert.id), ALERT_AUTO_DISMISS_MS));
  });

  useEffect(() => {
    const active = timers.current;
    return () => {
      active.forEach((timer) => window.clearTimeout(timer));
      active.clear();
    };
  }, []);

  return { alerts, dismiss };
}
