import { bridgeApi } from "./api";
import type { Account, Provider } from "./types";

const PROVIDER_ORDER_KEY = "ai-subscription-tracker:provider-order";
const EDGE_SCROLL_ZONE_PX = 52;
const EDGE_SCROLL_STEP_PX = 14;

type DragState =
  | { kind: "provider"; provider: Provider }
  | { kind: "account"; accountId: string; provider: Provider };

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
  if (classList.contains("provider-opencode_go")) return "opencode_go";
  return null;
}

function providerFromRow(row: HTMLElement): Provider | null {
  const icon = row.querySelector<HTMLElement>(".provider-summary-icon");
  return icon ? providerFromClassList(icon.classList) : null;
}

function providerFromCard(card: HTMLElement): Provider | null {
  const icon = card.querySelector<HTMLElement>(".account-card-provider-icon");
  return icon ? providerFromClassList(icon.classList) : null;
}

function readProviderOrder(): Provider[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROVIDER_ORDER_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is Provider =>
      value === "openai"
      || value === "anthropic"
      || value === "antigravity"
      || value === "opencode_go",
    );
  } catch {
    return [];
  }
}

function storeProviderOrder(order: Provider[]): void {
  try {
    window.localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Drag ordering remains usable for this session when WebView storage is unavailable.
  }
}

function normalizeProviderOrder(available: Provider[]): Provider[] {
  const saved = readProviderOrder();
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

function markDropTarget(element: HTMLElement, clientY: number): boolean {
  clearDropMarkers();
  const after = clientY >= element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2;
  element.classList.add(after ? "drag-after" : "drag-before");
  return after;
}

function finishDrag(): void {
  document.querySelectorAll<HTMLElement>(".is-dragging").forEach((element) => element.classList.remove("is-dragging"));
  clearDropMarkers();
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
    row.draggable = true;
    row.dataset.reorderProvider = provider;
  }

  if (container.dataset.reorderReady === "true") return;
  container.dataset.reorderReady = "true";

  container.addEventListener("dragstart", (event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(".provider-summary-row");
    const provider = row ? providerFromRow(row) : null;
    if (!row || !provider) return;
    dragState = { kind: "provider", provider };
    row.classList.add("is-dragging");
    event.dataTransfer?.setData("text/plain", `provider:${provider}`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });

  container.addEventListener("dragover", (event) => {
    if (dragState?.kind !== "provider") return;
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(".provider-summary-row");
    if (!row) return;
    event.preventDefault();
    autoScroll(container, event.clientY);
    markDropTarget(row, event.clientY);
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });

  container.addEventListener("drop", (event) => {
    if (dragState?.kind !== "provider") return;
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(".provider-summary-row");
    const target = row ? providerFromRow(row) : null;
    if (!row || !target || target === dragState.provider) {
      finishDrag();
      return;
    }
    event.preventDefault();
    const after = row.classList.contains("drag-after");
    const current = providerRows(container)
      .map(providerFromRow)
      .filter((provider): provider is Provider => provider != null);
    const next = moveItem(current, dragState.provider, target, after);
    storeProviderOrder(next);
    applyProviderOrder(container);
    lastDropAt = Date.now();
    void persistProviderOrder(next);
    finishDrag();
  });

  container.addEventListener("dragend", finishDrag);
}

function validExistingAccountMapping(cards: HTMLElement[], accounts: Account[]): boolean {
  const validIds = new Set(accounts.map((account) => account.id));
  const assigned = cards.map((card) => card.dataset.accountId).filter((id): id is string => Boolean(id));
  return assigned.length === cards.length
    && new Set(assigned).size === assigned.length
    && assigned.every((id) => validIds.has(id));
}

function mapAccountCards(cards: HTMLElement[], accounts: Account[]): void {
  if (validExistingAccountMapping(cards, accounts)) return;
  cards.forEach((card, index) => {
    const account = accounts[index];
    if (account) card.dataset.accountId = account.id;
    else delete card.dataset.accountId;
  });
}

function enhanceAccountList(): void {
  const container = document.querySelector<HTMLElement>(".provider-account-cards");
  if (!container) return;
  const cards = accountCards(container);
  const provider = cards.length ? providerFromCard(cards[0]) : null;
  if (provider && latestAccounts.length) {
    mapAccountCards(cards, latestAccounts.filter((account) => account.provider === provider));
  }

  for (const card of cards) {
    card.draggable = true;
  }

  if (container.dataset.reorderReady === "true") return;
  container.dataset.reorderReady = "true";

  container.addEventListener("dragstart", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, select, textarea, a")) {
      event.preventDefault();
      return;
    }
    const card = target?.closest<HTMLElement>(".provider-account-card");
    const accountId = card?.dataset.accountId;
    const provider = card ? providerFromCard(card) : null;
    if (!card || !accountId || !provider) {
      event.preventDefault();
      return;
    }
    dragState = { kind: "account", accountId, provider };
    card.classList.add("is-dragging");
    event.dataTransfer?.setData("text/plain", `account:${accountId}`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });

  container.addEventListener("dragover", (event) => {
    if (dragState?.kind !== "account") return;
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>(".provider-account-card");
    if (!card) return;
    event.preventDefault();
    autoScroll(container, event.clientY);
    markDropTarget(card, event.clientY);
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });

  container.addEventListener("drop", (event) => {
    if (dragState?.kind !== "account") return;
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>(".provider-account-card");
    const targetId = card?.dataset.accountId;
    if (!card || !targetId || targetId === dragState.accountId) {
      finishDrag();
      return;
    }
    event.preventDefault();
    const after = card.classList.contains("drag-after");
    const currentCards = accountCards(container);
    const currentIds = currentCards.map((candidate) => candidate.dataset.accountId).filter((id): id is string => Boolean(id));
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
    finishDrag();
  });

  container.addEventListener("dragend", finishDrag);
}

async function persistProviderOrder(order: Provider[]): Promise<void> {
  try {
    const accounts = latestAccounts.length ? latestAccounts : (await bridgeApi.snapshot()).accounts;
    const orderedIds = order.flatMap((provider) => accounts.filter((account) => account.provider === provider).map((account) => account.id));
    const remainingIds = accounts.filter((account) => !order.includes(account.provider)).map((account) => account.id);
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
    // Existing drag state remains available while the local snapshot is temporarily unavailable.
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

  document.addEventListener("click", (event) => {
    if (Date.now() - lastDropAt > 250) return;
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
