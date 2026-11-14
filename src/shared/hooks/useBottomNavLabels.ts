import { useSyncExternalStore } from "react";
import { getBottomNavLabels, setBottomNavLabels, subscribeBottomNavLabels } from "../lib/bottom-nav-labels";

/** Whether the bottom navigation bar shows its page names, and a setter that saves the choice. */
export function useBottomNavLabels(): [boolean, (show: boolean) => void] {
  const labels = useSyncExternalStore(subscribeBottomNavLabels, getBottomNavLabels, getBottomNavLabels);
  return [labels === "on", (show) => setBottomNavLabels(show ? "on" : "off")];
}
