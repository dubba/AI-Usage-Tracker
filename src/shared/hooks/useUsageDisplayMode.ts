import { useSyncExternalStore } from "react";
import {
  getUsageDisplayMode,
  setUsageDisplayMode,
  subscribeUsageDisplayMode,
  type UsageDisplayMode,
} from "../lib/usage-display";

export function useUsageDisplayMode(): [UsageDisplayMode, (next: UsageDisplayMode) => void] {
  const mode = useSyncExternalStore(subscribeUsageDisplayMode, getUsageDisplayMode, getUsageDisplayMode);
  return [mode, setUsageDisplayMode];
}
