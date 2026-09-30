import { vi } from "vitest";

export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

/** A minimal browser-like `window`/`document` so DOM-touching modules run under Node. */
export function installFakeWindow() {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const win = Object.assign(new EventTarget(), { localStorage, sessionStorage });
  const cssVars = new Map<string, string>();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    documentElement: { style: { setProperty: (name: string, value: string) => cssVars.set(name, value) } },
  });
  return { window: win, localStorage, sessionStorage, cssVars };
}

/** Records the detail of every dispatched event with the given name. */
export function captureEvents(target: EventTarget, name: string) {
  const details: unknown[] = [];
  target.addEventListener(name, (event) => details.push((event as CustomEvent).detail));
  return details;
}
