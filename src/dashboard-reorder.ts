import { bridgeApi } from "./api";
import type { Account, Provider } from "./types";

const PROVIDER_ORDER_KEY = "ai-subscription-tracker:provider-order";
const EDGE_SCROLL_ZONE_PX = 52;
const EDGE_SCROLL_STEP_PX = 14;
const DRAG_THRESHOLD_PX = 5;

export const DASHBOARD_PROVIDER_ORDER_EVENT = "ai-subscription-tracker:provider-order-changed";

const KNOWN_PROVIDERS: Provider[] = [
  "openai",
  "anthropic",
  "antigravity",
  "google_ai_studio",
  "grok",
  "opencode_go",
];

type DragState =
  | { kind: "provider"; provider: Provider; source: HTMLElement }
  | { kind: "account"; accountId: string; provider: Provider; source: HTMLElement };

type PointerCandidate = {
  pointerId: number;
  startX: number;
  startY: number;
  drag: DragState;
};

let pointerCandidate: PointerCandidate | null = null;
let dragState: DragState | null = null;
let lastDropAt = 0;
let latestAccounts: Account[] = [];
let snapshotSyncInFlight = false;
let snapshotSyncTimer: number | null = null;
let mutationGuard = false;

function providerFromClassList(classList: DOMTokenList): Provider | null {
  if (classList.contains("provider-openai")) return "openai";
  if (classList.contains("provider-anthropic")) return "anthropic";
  if (classList.contains("provider-antigravity")) return "antigravity";
  if (classList.contains("provider-google_ai_studio")) return "google_ai_studio";
  if (classList.contains("provider-grok")) return "grok";
  if (classList.contains("provider-opencode_go")) return "opencode_go";
  return null;
}

function providerFromRow(row: HTMLElement): Provider | null {
  const provider = row.dataset.reorderProvider as Provider | undefined;
  if (provider && KNOWN_PROVIDERS.includes(provider)) return provider;
  const icon = row.querySelector<HTMLElement>(".provider-summary-icon");
  return icon ? providerFromClassList(icon.classList) : null;
}

function providerFromCard(card: HTMLElement): Provider | null {
  const provider = card.dataset.reorderProvider as Provider | undefined;
  if (provider && KNOWN_PROVIDERS.includes(provider)) return provider;
  const icon = card.querySelector<HTMLElement>(".account-card-provider-icon");
  return icon ? providerFromClassList(icon.classList) : null;
}

export function readDashboardProviderOrder(): Provider[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROVIDER_ORDER_KEY) ?? "[]");
    const saved = Array.isArray(parsed)
      ? parsed.filter((value): value is Provider => KNOWN_PROVIDERS.includes(value as Provider))
      : [];
    return [
      ...saved,
      ...KNOWN_PROVIDERS.filter((provider) => !saved.includes(provider)),
    ];
  } catch {
    return [...KNOWN_PROVIDERS];
  }
}

function storeProviderOrder(order: Provider[]): void {
  try {
    window.localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Ordering remains usable for this session when WebView storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<Provider[]>(DASHBOARD_PROVIDER_ORDER_EVENT, { detail: order }));
}

function normalizeProviderOrder(available: Provider[]): Provider[] {
  const saved = readDashboardProviderOrder();
  return [
    ...saved.filter((provider) => available.includes(provider)),
    ...available.filter((provider) => !saved.includes(provider)),
  ];
}

function moveItem<T>(items: T[], source: T, target: T, after: boolean): T[] {
  const next = items.filter((item) => item !== source);
  const targetIndex = next.indexOf(target);
  if (targetIndex < 0) return items;
  next.splice(targetIndex + (after ? 1 : 0), 0, source);
  return next;
}

function autoScroll(container: HTMLElement, clientY: number): void {
  const bounds = container.getBoundingClientRect();
  if (clientY < bounds.top + EDGE_SCROLL_ZONE_PX) {
    container.scrollBy({ top: -EDGE_SCROLL_STEP_PX });
  } else if (clientY > bounds.bottom - EDGE_SCROLL_ZONE_PX) {
    container.scrollBy({ top: EDGE_SCROLL_STEP_PX });
  }
}

function clearDropMarkers(): void {
  document.querySelectorAll<HTMLElement>(".drag-before, .drag-after").forEach((element) => {
    element.classList.remove("drag-before", "drag-after");
  });
}

function markDropTarget(element: HTMLElement, clientY: number): void {
  clearDropMarkers();
  const bounds = element.getBoundingClientRect();
  const after = clientY >= bounds.top + bounds.height / 2;
  element.classList.add(after ? "drag-after" : "drag-before");
}

function nearestElement(elements: HTMLElement[], clientY: number): HTMLElement | null {
  let nearest: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    const bounds = element.getBoundingClientRect();
    if (clientY >= bounds.top && clientY <= bounds.bottom) return element;
    const distance = Math.abs(clientY - (bounds.top + bounds.height / 2));
    if (distance < nearestDistance) {
      nearest = element;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function finishDrag(): void {
  document.querySelectorAll<HTMLElement>(".is-dragging").forEach((element) => {
    element.classList.remove("is-dragging");
  });
  clearDropMarkers();
  document.documentElement.classList.remove("dashboard-reordering");
  pointerCandidate = null;
  dragState = null;
}

function providerRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .provider-summary-row"));
}

function accountCards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .provider-account-card"));
}

function applyProviderOrder(container: HTMLElement): void {
  const rows = providerRows(container);
  const available = rows.flatMap((row) => {
    const provider = providerFromRow(row);
    return provider ? [provider] : [];
  });
  const order = normalizeProviderOrder(available);
  const current = rows.map(providerFromRow).filter((provider): provider is Provider => provider != null);
  if (order.length !== current.length || order.every((provider, index) => current[index] === provider)) return;

  mutationGuard = true;
  try {
    for (const provider of order) {
      const row = rows.find((candidate) => providerFromRow(candidate) === provider);
      if (row) container.appendChild(row);
    }
  } finally {
    mutationGuard = false;
  }
}

function enhanceProviderList(): void {
  const container = document.querySelector<HTMLElement>(".provider-list");
  if (!container) return;
  applyProviderOrder(container);
  for (const row of providerRows(container)) {
    const provider = providerFromRow(row);
    if (!provider) continue;
    row.draggable = false;
    row.dataset.reorderEnabled = "true";
    row.dataset.reorderProvider = provider;
  }
}

function mapAccountCards(cards: HTMLElement[], accounts: Account[]): void {
  cards.forEach((card, index) => {
    const account = accounts[index];
    if (account) {
      card.dataset.accountId = account.id;
      card.dataset.reorderProvider = account.provider;
      card.dataset.reorderEnabled = "true";
      card.draggable = false;
    } else {
      delete card.dataset.accountId;
      delete card.dataset.reorderProvider;
      delete card.dataset.reorderEnabled;
    }
  });
}

function enhanceAccountList(): void {
  const container = document.querySelector<HTMLElement>(".provider-account-cards");
  if (!container) return;
  const cards = accountCards(container);
  const provider = cards.length ? providerFromCard(cards[0]) : null;
  if (provider && latestAccounts.length) {
    mapAccountCards(cards, latestAccounts.filter((account) => account.provider === provider));
  } else {
    for (const card of cards) {
      card.draggable = false;
      card.dataset.reorderEnabled = "true";
    }
  }
}

function dragFromPointerTarget(target: HTMLElement): DragState | null {
  const providerRow = target.closest<HTMLElement>(".provider-summary-row[data-reorder-enabled='true']");
  if (providerRow) {
    const provider = providerFromRow(providerRow);
    return provider ? { kind: "provider", provider, source: providerRow } : null;
  }

  if (target.closest("button, input, select, textarea, a")) return null;
  const card = target.closest<HTMLElement>(".provider-account-card[data-reorder-enabled='true']");
  if (!card) return null;
  const accountId = card.dataset.accountId;
  const provider = providerFromCard(card);
  return accountId && provider ? { kind: "account", accountId, provider, source: card } : null;
}

function beginPointerCandidate(event: PointerEvent): void {
  if (event.button !== 0 || event.isPrimary === false || dragState) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return;
  const drag = dragFromPointerTarget(target);
  if (!drag) return;
  pointerCandidate = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    drag,
  };
}

function movePointerCandidate(event: PointerEvent): void {
  if (!pointerCandidate || pointerCandidate.pointerId !== event.pointerId) return;
  if (!dragState) {
    const distance = Math.hypot(
      event.clientX - pointerCandidate.startX,
      event.clientY - pointerCandidate.startY,
    );
    if (distance < DRAG_THRESHOLD_PX) return;
    dragState = pointerCandidate.drag;
    dragState.source.classList.add("is-dragging");
    document.documentElement.classList.add("dashboard-reordering");
  }

  event.preventDefault();
  if (dragState.kind === "provider") {
    const container = document.querySelector<HTMLElement>(".provider-list");
    if (!container) return;
    autoScroll(container, event.clientY);
    const target = nearestElement(providerRows(container), event.clientY);
    if (target) markDropTarget(target, event.clientY);
  } else {
    const container = document.querySelector<HTMLElement>(".provider-account-cards");
    if (!container) return;
    autoScroll(container, event.clientY);
    const targets = accountCards(container).filter(
      (card) => providerFromCard(card) === dragState?.provider,
    );
    const target = nearestElement(targets, event.clientY);
    if (target) markDropTarget(target, event.clientY);
  }
}

function endPointerCandidate(event: PointerEvent): void {
  if (!pointerCandidate || pointerCandidate.pointerId !== event.pointerId) return;
  if (!dragState) {
    pointerCandidate = null;
    return;
  }

  event.preventDefault();
  if (dragState.kind === "provider") {
    const container = document.querySelector<HTMLElement>(".provider-list");
    const targetRow = container?.querySelector<HTMLElement>(".provider-summary-row.drag-before, .provider-summary-row.drag-after");
    const targetProvider = targetRow ? providerFromRow(targetRow) : null;
    if (container && targetRow && targetProvider && targetProvider !== dragState.provider) {
      const after = targetRow.classList.contains("drag-after");
      const current = providerRows(container)
        .map(providerFromRow)
        .filter((provider): provider is Provider => provider != null);
      const next = moveItem(current, dragState.provider, targetProvider, after);
      storeProviderOrder(next);
      applyProviderOrder(container);
      lastDropAt = Date.now();
      void persistProviderOrder(next);
    }
  } else {
    const container = document.querySelector<HTMLElement>(".provider-account-cards");
    const targetCard = container?.querySelector<HTMLElement>(".provider-account-card.drag-before, .provider-account-card.drag-after");
    const targetId = targetCard?.dataset.accountId;
    if (container && targetCard && targetId && targetId !== dragState.accountId) {
      const after = targetCard.classList.contains("drag-after");
      const currentCards = accountCards(container);
      const currentIds = currentCards
        .filter((card) => providerFromCard(card) === dragState?.provider)
        .map((card) => card.dataset.accountId)
        .filter((id): id is string => Boolean(id));
      const nextIds = moveItem(currentIds, dragState.accountId, targetId, after);

      mutationGuard = true;
      try {
        for (const id of nextIds) {
          const candidate = currentCards.find((item) => item.dataset.accountId === id);
          if (candidate) container.appendChild(candidate);
        }
      } finally {
        mutationGuard = false;
      }
      lastDropAt = Date.now();
      void persistAccountOrder(dragState.provider, nextIds);
    }
  }
  finishDrag();
}

async function persistProviderOrder(order: Provider[]): Promise<void> {
  try {
    const accounts = latestAccounts.length ? latestAccounts : (await bridgeApi.snapshot()).accounts;
    const orderedIds = order.flatMap((provider) =>
      accounts.filter((account) => account.provider === provider).map((account) => account.id),
    );
    const remainingIds = accounts
      .filter((account) => !order.includes(account.provider))
      .map((account) => account.id);
    latestAccounts = await bridgeApi.reorderAccounts([...orderedIds, ...remainingIds]);
    window.dispatchEvent(new Event("focus"));
  } catch {
    scheduleSnapshotSync(0);
  }
}

async function persistAccountOrder(provider: Provider, orderedProviderIds: string[]): Promise<void> {
  try {
    const accounts = latestAccounts.length ? latestAccounts : (await bridgeApi.snapshot()).accounts;
    let providerIndex = 0;
    const fullOrder = accounts.map((account) => {
      if (account.provider !== provider) return account.id;
      const replacement = orderedProviderIds[providerIndex];
      providerIndex += 1;
      return replacement ?? account.id;
    });
    latestAccounts = await bridgeApi.reorderAccounts(fullOrder);
    window.dispatchEvent(new Event("focus"));
  } catch {
    scheduleSnapshotSync(0);
  }
}

async function syncSnapshotAndMappings(): Promise<void> {
  if (snapshotSyncInFlight || dragState) return;
  snapshotSyncInFlight = true;
  try {
    latestAccounts = (await bridgeApi.snapshot()).accounts;
    enhanceProviderList();
    enhanceAccountList();
  } catch {
    // Existing ordering remains usable while the local snapshot is temporarily unavailable.
  } finally {
    snapshotSyncInFlight = false;
  }
}

function scheduleSnapshotSync(delay = 100): void {
  if (snapshotSyncTimer != null) window.clearTimeout(snapshotSyncTimer);
  snapshotSyncTimer = window.setTimeout(() => {
    snapshotSyncTimer = null;
    void syncSnapshotAndMappings();
  }, delay);
}

export function installDashboardReorder(): void {
  enhanceProviderList();
  enhanceAccountList();
  scheduleSnapshotSync(0);

  const observer = new MutationObserver(() => {
    if (mutationGuard || dragState) return;
    enhanceProviderList();
    enhanceAccountList();
    scheduleSnapshotSync();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("pointerdown", beginPointerCandidate, true);
  document.addEventListener("pointermove", movePointerCandidate, { capture: true, passive: false });
  document.addEventListener("pointerup", endPointerCandidate, { capture: true, passive: false });
  document.addEventListener("pointercancel", finishDrag, true);
  window.addEventListener("blur", finishDrag);

  document.addEventListener("click", (event) => {
    if (Date.now() - lastDropAt > 300) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest(".provider-summary-row, .provider-account-card")) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener("focus", () => scheduleSnapshotSync(0));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleSnapshotSync(0);
  });
}
