import { useSyncExternalStore } from "react";
import {
  getActivityPeriod,
  setActivityPeriod,
  subscribeActivityPeriod,
  type ActivityPeriod,
} from "./activity-period";

/** The period the Activity page shows, remembered on this device. */
export function useActivityPeriod(): [ActivityPeriod, (next: ActivityPeriod) => void] {
  const period = useSyncExternalStore(subscribeActivityPeriod, getActivityPeriod, getActivityPeriod);
  return [period, setActivityPeriod];
}
