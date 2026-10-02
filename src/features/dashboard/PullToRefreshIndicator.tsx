import { RefreshIcon } from "../../shared/ui/icons";
import type { PullToRefreshData } from "./usePullToRefresh";

interface PullToRefreshIndicatorProps {
  data: PullToRefreshData;
}

export function PullToRefreshIndicator({ data }: PullToRefreshIndicatorProps) {
  const { state, distance, progress, isPrimed } = data;

  if (state === "idle") return null;

  const isPulling = state === "pulling";
  const isRefreshing = state === "refreshing";
  const isSettling = state === "settling";

  // During pulling, track finger directly; during refresh or settle, use CSS transitions
  const transform = isPulling
    ? `translate(-50%, ${distance}px) scale(${0.75 + progress * 0.25})`
    : isRefreshing
      ? "translate(-50%, 52px) scale(1)"
      : "translate(-50%, -60px) scale(0.6)";

  const opacity = isPulling
    ? Math.min(1, Math.max(0.1, progress * 1.3))
    : isRefreshing
      ? 1
      : 0;

  const iconRotation = isPulling ? progress * 360 : 0;

  return (
    <div
      className={`pull-to-refresh-indicator ${isPrimed ? "is-primed" : ""} ${isRefreshing ? "is-refreshing" : ""} ${isSettling ? "is-settling" : ""}`}
      style={{
        transform,
        opacity,
        transition: isPulling ? "none" : undefined,
      }}
      aria-hidden="true"
    >
      <div
        className="pull-to-refresh-icon"
        style={{
          transform: isPulling ? `rotate(${iconRotation}deg)` : undefined,
          transition: isPulling ? "none" : undefined,
        }}
      >
        <RefreshIcon />
      </div>
    </div>
  );
}
