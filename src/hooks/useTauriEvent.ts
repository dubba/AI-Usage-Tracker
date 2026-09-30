import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

// Unsubscribing can fail if the listener is already gone (e.g. during teardown); that is never actionable.
function safeUnlisten(unlisten: (() => void) | undefined): void {
  if (!unlisten) return;
  try {
    void Promise.resolve(unlisten()).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Subscribes to a Tauri event for the lifetime of the component. Unlike a bare
 * `listen(...).then(fn => unlisten = fn)`, this still unsubscribes when the
 * component unmounts before `listen` has resolved.
 */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<T>(event, (incoming) => handlerRef.current(incoming.payload))
      .then((fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, [event]);
}
