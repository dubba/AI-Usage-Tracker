import { UI_EVENTS } from "./events";
import { readJson, storageGet, STORAGE_KEYS, writeJson } from "./storage";
import type { Provider } from "./types";

export const DASHBOARD_PROVIDER_ORDER_EVENT = UI_EVENTS.providerOrderChanged;
export const DASHBOARD_GROUP_ORDER_EVENT = UI_EVENTS.groupOrderChanged;

export const KNOWN_PROVIDERS: Provider[] = [
  "openai",
  "anthropic",
  "grok",
  "antigravity",
  "google_ai_studio",
  "opencode_go",
];

export function uniqueStrings(list: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (item && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function uniqueProviders(list: Provider[]): Provider[] {
  const seen = new Set<Provider>();
  const result: Provider[] = [];
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function readSidebarGroupOrder(): string[] {
  const saved = readJson<unknown[]>(STORAGE_KEYS.sidebarGroupOrder, [], Array.isArray);
  return uniqueStrings(saved.filter((item): item is string => typeof item === "string" && item.length > 0));
}

export function storeSidebarGroupOrder(order: string[]): void {
  const deduped = uniqueStrings(order.filter((id) => id !== "all"));
  writeJson(STORAGE_KEYS.sidebarGroupOrder, deduped);

  // Also derive Provider[] order for backwards compatibility
  const derivedProviders: Provider[] = [];
  for (const id of deduped) {
    if (id.startsWith("provider:")) {
      const p = id.slice(9) as Provider;
      if (KNOWN_PROVIDERS.includes(p) && !derivedProviders.includes(p)) {
        derivedProviders.push(p);
      }
    }
  }
  for (const p of KNOWN_PROVIDERS) {
    if (!derivedProviders.includes(p)) {
      derivedProviders.push(p);
    }
  }
  writeJson(STORAGE_KEYS.providerOrder, derivedProviders);

  window.dispatchEvent(new CustomEvent<string[]>(DASHBOARD_GROUP_ORDER_EVENT, { detail: deduped }));
  window.dispatchEvent(new CustomEvent<Provider[]>(DASHBOARD_PROVIDER_ORDER_EVENT, { detail: derivedProviders }));
}

export function readDashboardProviderOrder(): Provider[] {
  const raw = storageGet(STORAGE_KEYS.providerOrder);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return [...KNOWN_PROVIDERS];
  }
  const saved = Array.isArray(parsed)
    ? uniqueProviders(parsed.filter((value): value is Provider => KNOWN_PROVIDERS.includes(value as Provider)))
    : [];
  const canonical = [
    ...saved,
    ...KNOWN_PROVIDERS.filter((provider) => !saved.includes(provider)),
  ];
  // Heal a stored list that has unknown, duplicated, or missing providers.
  if (raw != null && raw !== JSON.stringify(saved) && raw !== JSON.stringify(canonical)) {
    writeJson(STORAGE_KEYS.providerOrder, canonical);
  }
  return canonical;
}
