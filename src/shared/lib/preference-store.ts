import { storageGet, storageSet } from "./storage";

/**
 * A small external store for one saved preference (a theme, a display mode): the current value
 * for `useSyncExternalStore`, saved to localStorage by `set`, and re-read by `refresh` when it
 * changed elsewhere (first load, or another window of the app writing the same key).
 *
 * The value starts as `fallback`; call `refresh()` to load what is saved.
 */
export function createPreferenceStore<T extends string>(key: string, fallback: T, isValid: (value: unknown) => value is T) {
  let value: T = fallback;
  const listeners = new Set<() => void>();

  const readStored = (): T => {
    const saved = storageGet(key);
    return isValid(saved) ? saved : fallback;
  };

  const update = (next: T) => {
    if (next === value) return;
    value = next;
    for (const notify of [...listeners]) notify();
  };

  return {
    get: (): T => value,
    readStored,
    subscribe(notify: () => void): () => void {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    /** Takes the saved value (or the fallback when nothing valid is saved). */
    refresh: () => update(readStored()),
    /** Saves `next` and makes it the current value. */
    set(next: T) {
      storageSet(key, next);
      update(next);
    },
    /** Follows the same key being changed by another window of the app. */
    followOtherWindows(): () => void {
      const onStorage = (event: StorageEvent) => {
        if (event.key === key) update(readStored());
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
  };
}
