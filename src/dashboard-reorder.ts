import { bridgeApi } from "./api";
import type { Account, Provider } from "./types";

const PROVIDER_ORDER_KEY = "ai-subscription-tracker:provider-order";
const EDGE_SCROLL_ZONE_PX = 52;
const EDGE_SCROLL_MAX_STEP_PX = 18;
const DRAG_THRESHOLD_PX = 5;
const REORDER_ANIMATION_MS = 150;

export const DASHBOARD_PROVIDER_ORDER_EVENT = "ai-subscription-tracker:provider-order-changed";

const KNOWN_PROVIDERS: Provider[] = [
  "openai",
  "anthropic",
  "antigravity",
  "google_ai_studio",
  "grok",
  "opencode_go",
];

type DragDescriptor =
  | { kind: "provider"; provider: Provider; source: HTMLElement }
  | { kind: "account"; accountId: string; provider: Provider; source: HTMLElement };

type PointerCandidate = {
  pointerId: number;
  startX: number;
  startY: number;
  drag: DragDescriptor;
};

type ActiveDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  lastClientX: number;
  lastClientY: number;
  grabOffsetY: number;
  sourceHeight: number;
  descriptor: DragDescriptor;
  container: HTMLElement;
  scrollContainer: HTMLElement;
  source: HTMLElement;
  placeholder: HTMLElement;
  originalNextSibling: ChildNode | null;
  originalStyle: string | null;
  originalOrder: string[];
  autoScrollFrame: number | null;
};

let pointerCandidate: PointerCandidate | null = null;
let dragState: ActiveDrag | null = null;
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

function uniqueProviders(list: Provider[]): Provider[] {
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

export function readDashboardProviderOrder(): Provider[] {
  try {
    const raw = window.localStorage.getItem(PROVIDER_ORDER_KEY);
    const parsed = JSON.parse(raw ?? "[]");
    const saved = Array.isArray(parsed)
      ? uniqueProviders(parsed.filter((value): value is Provider => KNOWN_PROVIDERS.includes(value as Provider)))
      : [];
    // Persist deduped correction and missing-provider backfill immediately.
    const canonical = [
      ...saved,
      ...KNOWN_PROVIDERS.filter((provider) => !saved.includes(provider)),
    ];
    if (raw != null) {
      try {
        const dedupedRaw = JSON.stringify(canonical.slice(0, saved.length + KNOWN_PROVIDERS.filter((p) => !saved.includes(p)).length));
        // Only rewrite if original was duplicated or missing providers
        if (raw !== JSON.stringify(saved) && raw !== JSON.stringify(canonical)) {
          // Rewrite to remove duplicates; keep full canonical order for consistency
          window.localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(uniqueProviders(canonical)));
        } else if (raw !== JSON.stringify(uniqueProviders(JSON.parse(raw)))) {
          window.localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(uniqueProviders(JSON.parse(raw) as Provider[]).filter((p): p is Provider => KNOWN_PROVIDERS.includes(p))));
        }
      } catch {
        // Ignore storage write failures
      }
    }
    return canonical;
  } catch {
    return [...KNOWN_PROVIDERS];
  }
}

function storeProviderOrder(order: Provider[]): void {
  const deduped = uniqueProviders(order.filter((p): p is Provider => KNOWN_PROVIDERS.includes(p)));
  try {
    window.localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(deduped));
  } catch {
    // Ordering remains usable for this session when WebView storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<Provider[]>(DASHBOARD_PROVIDER_ORDER_EVENT, { detail: deduped }));
}

function normalizeProviderOrder(available: Provider[]): Provider[] {
  const saved = readDashboardProviderOrder();
  const dedupedAvailable = uniqueProviders(available);
  return [
    ...saved.filter((provider) => dedupedAvailable.includes(provider)),
    ...dedupedAvailable.filter((provider) => !saved.includes(provider)),
  ];
}

function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function providerRows(container: HTMLElement): HTMLElement[] {
  const all = Array.from(container.querySelectorAll<HTMLElement>(":scope > .provider-summary-row"));
  // Remove DOM-level duplicates that can appear when React and manual reordering race.
  // Bucket and provider groups can share the same provider value but have distinct groupIds,
  // so deduplicate by groupId (e.g. "bucket:xxx" vs "provider:antigravity").
  const seen = new Set<string>();
  for (const row of [...all]) {
    const groupId = row.dataset.groupId as string | undefined;
    const provider = providerFromRow(row);
    const key = groupId ?? provider ?? row.outerHTML;
    if (seen.has(key)) {
      row.remove();
    } else {
      seen.add(key);
    }
  }
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

function validExistingAccountMapping(cards: HTMLElement[], accounts: Account[]): boolean {
  const validIds = new Set(accounts.map((account) => account.id));
  const assigned = cards
    .map((card) => card.dataset.accountId)
    .filter((accountId): accountId is string => Boolean(accountId));
  return assigned.length === cards.length
    && new Set(assigned).size === assigned.length
    && assigned.every((accountId) => validIds.has(accountId));
}

function mapAccountCards(cards: HTMLElement[], accounts: Account[]): void {
  if (validExistingAccountMapping(cards, accounts)) return;
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

function dragFromPointerTarget(target: HTMLElement): DragDescriptor | null {
  const providerRow = target.closest<HTMLElement>(".provider-summary-row[data-reorder-enabled='true']");
  if (providerRow) {
    const provider = providerFromRow(providerRow);
    return provider ? { kind: "provider", provider, source: providerRow } : null;
  }

  if (target.closest("button, input, select, textarea, a, [contenteditable='true'], .account-card-name-actions, .account-card-header-actions, .remove-account-confirmation")) return null;
  const card = target.closest<HTMLElement>(".provider-account-card[data-reorder-enabled='true']");
  if (!card) return null;
  const accountId = card.dataset.accountId;
  const provider = providerFromCard(card);
  return accountId && provider ? { kind: "account", accountId, provider, source: card } : null;
}

function originalOrder(descriptor: DragDescriptor, container: HTMLElement): string[] {
  if (descriptor.kind === "provider") {
    return providerRows(container)
      .map(providerFromRow)
      .filter((provider): provider is Provider => provider != null);
  }
  return accountCards(container)
    .filter((card) => providerFromCard(card) === descriptor.provider)
    .map((card) => card.dataset.accountId)
    .filter((accountId): accountId is string => Boolean(accountId));
}

function reorderElements(drag: ActiveDrag): HTMLElement[] {
  if (drag.descriptor.kind === "provider") {
    return providerRows(drag.container).filter((row) => row !== drag.source);
  }
  return accountCards(drag.container).filter(
    (card) => card !== drag.source && providerFromCard(card) === drag.descriptor.provider,
  );
}

function capturePositions(elements: HTMLElement[]): Map<HTMLElement, { left: number; top: number }> {
  return new Map(elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return [element, { left: bounds.left, top: bounds.top }];
  }));
}

function animateReorder(elements: HTMLElement[], before: Map<HTMLElement, { left: number; top: number }>): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.requestAnimationFrame(() => {
    for (const element of elements) {
      const previous = before.get(element);
      if (!previous) continue;
      const bounds = element.getBoundingClientRect();
      const deltaX = previous.left - bounds.left;
      const deltaY = previous.top - bounds.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
      for (const animation of element.getAnimations()) animation.cancel();
      element.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: REORDER_ANIMATION_MS, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  });
}

function placeholderIndex(drag: ActiveDrag, elements: HTMLElement[]): number {
  const sequence = Array.from(drag.container.children).filter(
    (child) => child === drag.placeholder || elements.includes(child as HTMLElement),
  );
  return sequence.indexOf(drag.placeholder);
}

function floatingCenterY(drag: ActiveDrag): number {
  return drag.lastClientY - drag.grabOffsetY + drag.sourceHeight / 2;
}

function updatePlaceholderFromPointer(drag: ActiveDrag): void {
  const clientY = floatingCenterY(drag);
  const elements = reorderElements(drag);
  let reference: HTMLElement | null = null;
  for (const element of elements) {
    const bounds = element.getBoundingClientRect();
    if (clientY < bounds.top + bounds.height / 2) {
      reference = element;
      break;
    }
  }

  const desiredIndex = reference ? elements.indexOf(reference) : elements.length;
  if (placeholderIndex(drag, elements) === desiredIndex) return;

  const before = capturePositions(elements);
  mutationGuard = true;
  try {
    if (reference) drag.container.insertBefore(drag.placeholder, reference);
    else drag.container.appendChild(drag.placeholder);
  } finally {
    mutationGuard = false;
  }
  animateReorder(elements, before);
}

function autoScrollStep(drag: ActiveDrag): number {
  const bounds = drag.scrollContainer.getBoundingClientRect();
  if (drag.lastClientY < bounds.top + EDGE_SCROLL_ZONE_PX) {
    const strength = 1 - Math.max(0, drag.lastClientY - bounds.top) / EDGE_SCROLL_ZONE_PX;
    return -Math.max(4, Math.round(EDGE_SCROLL_MAX_STEP_PX * strength));
  }
  if (drag.lastClientY > bounds.bottom - EDGE_SCROLL_ZONE_PX) {
    const strength = 1 - Math.max(0, bounds.bottom - drag.lastClientY) / EDGE_SCROLL_ZONE_PX;
    return Math.max(4, Math.round(EDGE_SCROLL_MAX_STEP_PX * strength));
  }
  return 0;
}

function runAutoScroll(): void {
  const drag = dragState;
  if (!drag) return;
  const delta = autoScrollStep(drag);
  if (delta !== 0) {
    const previousScrollTop = drag.scrollContainer.scrollTop;
    drag.scrollContainer.scrollTop += delta;
    if (drag.scrollContainer.scrollTop !== previousScrollTop) {
      updatePlaceholderFromPointer(drag);
    }
  }
  drag.autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
}

function beginVisualDrag(event: PointerEvent, candidate: PointerCandidate): ActiveDrag | null {
  const descriptor = candidate.drag;
  const container = descriptor.source.parentElement;
  if (!container) return null;
  const scrollContainer = descriptor.kind === "provider"
    ? container
    : descriptor.source.closest<HTMLElement>(".dashboard-content") ?? container;
  const bounds = descriptor.source.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = `dashboard-reorder-placeholder ${descriptor.kind}-reorder-placeholder`;
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.style.height = `${bounds.height}px`;

  const active: ActiveDrag = {
    pointerId: event.pointerId,
    startX: candidate.startX,
    startY: candidate.startY,
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    grabOffsetY: candidate.startY - bounds.top,
    sourceHeight: bounds.height,
    descriptor,
    container,
    scrollContainer,
    source: descriptor.source,
    placeholder,
    originalNextSibling: descriptor.source.nextSibling,
    originalStyle: descriptor.source.getAttribute("style"),
    originalOrder: originalOrder(descriptor, container),
    autoScrollFrame: null,
  };

  dragState = active;
  mutationGuard = true;
  try {
    descriptor.source.after(placeholder);
  } finally {
    mutationGuard = false;
  }

  container.classList.add("reorder-previewing");
  descriptor.source.classList.add("is-dragging");
  Object.assign(descriptor.source.style, {
    position: "fixed",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    margin: "0",
    zIndex: "10000",
    pointerEvents: "none",
    boxSizing: "border-box",
    transform: "translate3d(0, 0, 0) rotate(0.8deg) scale(1.01)",
    transformOrigin: "top left",
    willChange: "transform",
  });
  document.documentElement.classList.add("dashboard-reordering");
  try {
    descriptor.source.setPointerCapture(event.pointerId);
  } catch {
    // Document-level pointer handlers continue the drag when capture is unavailable.
  }
  updatePlaceholderFromPointer(active);
  active.autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
  return active;
}

function updateFloatingSource(drag: ActiveDrag): void {
  const deltaX = drag.lastClientX - drag.startX;
  const deltaY = drag.lastClientY - drag.startY;
  drag.source.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) rotate(0.8deg) scale(1.01)`;
}

function restoreSourceStyle(drag: ActiveDrag): void {
  if (drag.originalStyle == null) drag.source.removeAttribute("style");
  else drag.source.setAttribute("style", drag.originalStyle);
}

function settleVisualDrag(drag: ActiveDrag, commit: boolean): void {
  if (drag.autoScrollFrame != null) window.cancelAnimationFrame(drag.autoScrollFrame);
  for (const element of reorderElements(drag)) {
    for (const animation of element.getAnimations()) animation.cancel();
  }

  mutationGuard = true;
  try {
    if (commit) {
      drag.container.insertBefore(drag.source, drag.placeholder);
    } else if (drag.originalNextSibling && drag.originalNextSibling.parentNode === drag.container) {
      drag.container.insertBefore(drag.source, drag.originalNextSibling);
    } else {
      drag.container.appendChild(drag.source);
    }
    drag.placeholder.remove();
  } finally {
    mutationGuard = false;
  }

  drag.source.classList.remove("is-dragging");
  drag.container.classList.remove("reorder-previewing");
  restoreSourceStyle(drag);
  try {
    if (drag.source.hasPointerCapture(drag.pointerId)) {
      drag.source.releasePointerCapture(drag.pointerId);
    }
  } catch {
    // The pointer may already have been released by the WebView.
  }
  document.documentElement.classList.remove("dashboard-reordering");
}

function committedOrder(drag: ActiveDrag): string[] {
  if (drag.descriptor.kind === "provider") {
    return uniqueProviders(
      providerRows(drag.container)
        .map(providerFromRow)
        .filter((provider): provider is Provider => provider != null),
    );
  }
  const ids = accountCards(drag.container)
    .filter((card) => providerFromCard(card) === drag.descriptor.provider)
    .map((card) => card.dataset.accountId)
    .filter((accountId): accountId is string => Boolean(accountId));
  // Deduplicate accountIds while preserving order (guards against DOM duplicate nodes)
  return Array.from(new Set(ids));
}

function finishDrag(commit: boolean): void {
  const drag = dragState;
  pointerCandidate = null;
  if (!drag) return;

  settleVisualDrag(drag, commit);
  const nextOrder = commit ? committedOrder(drag) : drag.originalOrder;
  dragState = null;

  if (!commit || arraysEqual(drag.originalOrder, nextOrder)) {
    scheduleSnapshotSync(0);
    return;
  }

  lastDropAt = Date.now();
  if (drag.descriptor.kind === "provider") {
    const providers = nextOrder.filter((value): value is Provider => KNOWN_PROVIDERS.includes(value as Provider));
    storeProviderOrder(providers);
    void persistProviderOrder(providers);
  } else {
    void persistAccountOrder(drag.descriptor.provider, nextOrder);
  }
}

function beginPointerCandidate(event: PointerEvent): void {
  if (event.button !== 0 || event.isPrimary === false || dragState) return;
  if (event.pointerType === "touch") return;
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
    if (!beginVisualDrag(event, pointerCandidate)) {
      pointerCandidate = null;
      return;
    }
  }

  const drag = dragState;
  if (!drag) return;
  event.preventDefault();
  drag.lastClientX = event.clientX;
  drag.lastClientY = event.clientY;
  updateFloatingSource(drag);
  updatePlaceholderFromPointer(drag);
}

function endPointerCandidate(event: PointerEvent): void {
  if (!pointerCandidate || pointerCandidate.pointerId !== event.pointerId) return;
  if (!dragState) {
    pointerCandidate = null;
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  finishDrag(true);
}

function cancelPointerCandidate(event?: PointerEvent): void {
  if (event && pointerCandidate && pointerCandidate.pointerId !== event.pointerId) return;
  finishDrag(false);
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
    const dedupedOrdered = Array.from(new Set(orderedProviderIds));
    const accounts = latestAccounts.length ? latestAccounts : (await bridgeApi.snapshot()).accounts;
    let providerIndex = 0;
    const fullOrder = accounts.map((account) => {
      if (account.provider !== provider) return account.id;
      const replacement = dedupedOrdered[providerIndex];
      providerIndex += 1;
      return replacement ?? account.id;
    });
    // Final safeguard: ensure fullOrder has no duplicates before sending to backend
    if (new Set(fullOrder).size !== fullOrder.length) {
      scheduleSnapshotSync(0);
      return;
    }
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
  document.addEventListener("pointercancel", cancelPointerCandidate, true);
  window.addEventListener("blur", () => cancelPointerCandidate());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dragState) {
      event.preventDefault();
      cancelPointerCandidate();
    }
  }, true);

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
