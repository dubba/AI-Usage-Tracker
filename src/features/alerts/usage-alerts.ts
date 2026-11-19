export type UsageAlertToast = {
  id: string;
  accountId: string;
  accountLabel?: string;
  provider?: string;
  windowLabel?: string;
  title: string;
  body: string;
  timestamp: number;
};

export const MAX_VISIBLE_ALERTS = 5;

/** Appends a toast, dropping the oldest so at most `max` remain. */
export function appendAlert(
  alerts: UsageAlertToast[],
  alert: UsageAlertToast,
  max: number = MAX_VISIBLE_ALERTS,
): UsageAlertToast[] {
  return [...alerts, alert].slice(-max);
}

