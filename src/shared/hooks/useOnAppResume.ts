import { useEffect, useEffectEvent } from "react";

/**
 * Calls `handler` when the window regains focus and when the page becomes visible again, e.g.
 * on returning to the app from another window or app. The latest `handler` is always the one
 * called, without re-subscribing when its identity changes.
 */
export function useOnAppResume(handler: () => void): void {
  const onResume = useEffectEvent(handler);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onResume();
    };
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
