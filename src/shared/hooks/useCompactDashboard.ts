import { useSyncExternalStore } from "react";
import {
  getCompactDashboardMode,
  setCompactDashboardMode,
  subscribeCompactDashboardMode,
} from "../lib/compact-dashboard";

export function useCompactDashboard(): [boolean, (next: boolean) => void] {
  const mode = useSyncExternalStore(
    subscribeCompactDashboardMode,
    getCompactDashboardMode,
    getCompactDashboardMode,
  );
  return [mode === "on", (next: boolean) => setCompactDashboardMode(next ? "on" : "off")];
}
