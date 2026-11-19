import { useCallback, useEffect, useRef, useState } from "react";
import { appendAlert, type UsageAlertToast } from "./usage-alerts";
import { useTauriEvent } from "../../shared/hooks/useTauriEvent";

export const ALERT_AUTO_DISMISS_MS = 15_000;

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

const NO_ALERTS: UsageAlertToast[] = [];

/**
 * In-app usage-limit toasts: capped in number, auto-dismissed after
 * ALERT_AUTO_DISMISS_MS when a single alert is active and not hovered/touched,
 * and kept open while paused or when multiple alerts are queued.
 */
export function useUsageAlerts(enabled = true) {
  const [alerts, setAlerts] = useState<UsageAlertToast[]>([]);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(ALERT_AUTO_DISMISS_MS);
  const seqRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setAlerts((current) => {
      const next = current.filter((alert) => alert.id !== id);
      if (next.length === 0) {
        setPaused(false);
        remainingRef.current = ALERT_AUTO_DISMISS_MS;
      }
      return next;
    });
  }, []);

  const dismissAll = useCallback(() => {
    setPaused(false);
    remainingRef.current = ALERT_AUTO_DISMISS_MS;
    setAlerts([]);
  }, []);

  useTauriEvent<UsageAlertPayload>("usage-alert", (payload) => {
    if (!enabled || !payload) return;
    const now = Date.now();
    seqRef.current += 1;
    const alert: UsageAlertToast = {
      id: `${payload.accountId}-${payload.windowLabel}-${now}-${seqRef.current}`,
      accountId: payload.accountId,
      accountLabel: payload.accountLabel,
      provider: payload.provider,
      windowLabel: payload.windowLabel,
      title: payload.title,
      body: payload.body,
      timestamp: now,
    };
    remainingRef.current = ALERT_AUTO_DISMISS_MS;
    setAlerts((current) => appendAlert(current, alert));
  }, enabled);

  useEffect(() => {
    if (!enabled) {
      setPaused(false);
      remainingRef.current = ALERT_AUTO_DISMISS_MS;
      return;
    }
    if (alerts.length === 0) {
      setPaused(false);
      remainingRef.current = ALERT_AUTO_DISMISS_MS;
      return;
    }
    if (alerts.length > 1) {
      // Keep stacked alerts open until dismissed; reset timer if narrowed back to 1.
      remainingRef.current = ALERT_AUTO_DISMISS_MS;
      return;
    }
    if (paused) return;

    const targetId = alerts[0].id;
    const startedAt = Date.now();
    const delay = Math.max(0, remainingRef.current);
    const timer = window.setTimeout(() => {
      remainingRef.current = ALERT_AUTO_DISMISS_MS;
      dismiss(targetId);
    }, delay);

    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, delay - (Date.now() - startedAt));
    };
  }, [enabled, alerts, paused, dismiss]);

  return {
    alerts: enabled ? alerts : NO_ALERTS,
    dismiss,
    dismissAll,
    paused: enabled && paused,
    setPaused,
  };
}

