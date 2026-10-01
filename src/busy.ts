import { useRef, useState } from "react";

export type BusyKeys = ReadonlySet<string>;

/** "refresh:acct-1" for a per-item operation, or just "refresh-all" for a global one. */
export const busyKey = (op: string, id?: string): string => (id === undefined ? op : `${op}:${id}`);

export const REFRESH_ALL_KEY = busyKey("refresh-all");

/** True for the global refresh and for any single-account refresh. */
export const isRefreshKey = (key: string): boolean => key === REFRESH_ALL_KEY || key.startsWith(busyKey("refresh", ""));

export type BusyTracker = {
  /** Marks `key` busy. Returns false (and changes nothing) if it already is. */
  begin: (key: string) => boolean;
  end: (key: string) => void;
  has: (key: string) => boolean;
};

/**
 * Tracks any number of concurrent operations by key, so one operation
 * finishing never clears another's busy state. `has` reads synchronously, so
 * it is safe as a re-entry guard even before React re-renders.
 */
export function createBusyTracker(onChange: (keys: BusyKeys) => void): BusyTracker {
  const active = new Set<string>();
  const emit = () => onChange(new Set(active));
  return {
    begin(key) {
      if (active.has(key)) return false;
      active.add(key);
      emit();
      return true;
    },
    end(key) {
      if (active.delete(key)) emit();
    },
    has: (key) => active.has(key),
  };
}

export function useBusyKeys(): BusyTracker & { busy: BusyKeys } {
  const [busy, setBusy] = useState<BusyKeys>(() => new Set());
  const trackerRef = useRef<BusyTracker | null>(null);
  trackerRef.current ??= createBusyTracker(setBusy);
  return { busy, ...trackerRef.current };
}
