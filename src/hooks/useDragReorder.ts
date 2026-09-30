import { useEffect } from "react";
import { installDashboardReorder } from "../dashboard-reorder";

/** Turns on drag-to-reorder for account cards and sidebar groups while the app is mounted. */
export function useDragReorder(): void {
  useEffect(() => installDashboardReorder(), []);
}
