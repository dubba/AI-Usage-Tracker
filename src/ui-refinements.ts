import { bridgeApi } from "./api";
import {
  getOpenCodeEmailRecord,
  renameOpenCodeEmailRecord,
  resolveOpenCodeEmailRecord,
} from "./opencode-account-email";
import type { UsageWindow } from "./types";

type CardProvider = "openai" | "anthropic" | "antigravity" | "google_ai_studio" | "opencode_go";
type ResetWindow = "five_hour" | "weekly";

const RESET_COUNTDOWN_SYNC_MS = 60_000;

let resetCountdownSyncInFlight = false;
let resetCountdownSyncTimer: number | null = null;

function cardProvider(card: HTMLElement): CardProvider | null {
  const icon = card.querySelector<HTMLElement>(".account-card-provider-icon");
  if (icon?.classList.contains("provider-openai")) return "openai";
  if (icon?.classList.contains("provider-anthropic")) return "anthropic";
  if (icon?.classList.contains("provider-antigravity")) return "antigravity";
  if (icon?.classList.contains("provider-google_ai_studio")) return "google_ai_studio";
  if (icon?.classList.contains("provider-opencode_go")) return "opencode_go";
  return null;
}

function canonicalWindow(window: UsageWindow, target: ResetWindow): boolean {
  const id = window.id.toLowerCase().replaceAll("-", "_");
  const label = window.label.toLowerCase();
  if (target === "five_hour") {
    return id === "five_hour"
      || id === "rolling"
      || window.windowSeconds === 18_000
      || label.includes("5 hour")
      || label.includes("five hour");
  }
  return id === "weekly"
    || window.windowSeconds === 604_800
    || label.includes("weekly")
    || label.includes("7 day")
    || label.includes("seven day");
}

function orderedWindows(windows: UsageWindow[]): UsageWindow[] {
  const weight = (window: UsageWindow) => {
    if (canonicalWindow(window, "five_hour")) return 0;
    if (canonicalWindow(window, "weekly")) return 1;
    if (window.id.toLowerCase().includes("monthly") || window.label.toLowerCase().includes("monthly")) return 2;
    return 3;
  };
  return [...windows].sort((left, right) => weight(left) - weight(right));
}

function resetCountdownLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const resetAt = new Date(value).getTime();
  if (!Number.isFinite(resetAt)) return null;
  const remainingMs = resetAt - Date.now();
  if (remainingMs <= 0) return null;
  const remainingHours = Math.max(1, Math.ceil(remainingMs / 3_600_000));
  return `Resets in: ${remainingHours}h`;
}

function refineHeader(card: HTMLElement): void {
  const nameRow = card.querySelector<HTMLElement>(".account-card-name-row");
  const plan = card.querySelector<HTMLElement>(".account-plan-badge");
  if (nameRow && plan?.textContent?.trim()) {
    nameRow.dataset.plan = plan.textContent.trim();
  } else if (nameRow) {
    delete nameRow.dataset.plan;
  }

  const remove = Array.from(card.querySelectorAll<HTMLButtonElement>(".account-card-header-actions button"))
    .find((button) => button.title === "Remove this account");
  remove?.classList.toggle("showing-spinner", Boolean(remove.querySelector(".mini-spinner")));
}

function refineMetric(metric: HTMLElement, provider: CardProvider): void {
  const label = metric.querySelector<HTMLElement>(".metric-label");
  if (!label) return;

  const labelText = label.textContent?.trim() ?? "";

  // v0.2.29 mistakenly hid the complete OpenAI metric when its label was
  // "Session". Keep the quota value, window badge, bar, and reset time;
  // only hide the redundant heading text.
  metric.classList.remove("ui-hidden-metric");
  label.classList.toggle(
    "ui-hidden-metric-label",
    provider === "openai" && labelText.toLowerCase() === "session",
  );

  if (provider === "antigravity") {
    const cleaned = labelText.replace(/\s*·\s*(?:five hour|5 hour|weekly) limit\s*$/i, "").trim();
    if (cleaned && cleaned !== labelText) label.textContent = cleaned;
  }
}

function refineCredits(card: HTMLElement, provider: CardProvider): void {
  const credits = card.querySelector<HTMLElement>(".account-credit-metric");
  if (!credits) return;

  credits.classList.toggle("ui-hidden-credit", provider === "antigravity" || provider === "opencode_go");

  if (provider === "openai") {
    for (const child of Array.from(credits.children)) {
      child.classList.toggle(
        "ui-hidden-credit-helper",
        child.textContent?.trim() === "Provider-reported remaining credit balance",
      );
    }
  }
}

function refineAccountCard(card: HTMLElement): void {
  const provider = cardProvider(card);
  if (!provider) return;
  card.dataset.provider = provider;
  refineHeader(card);
  for (const metric of Array.from(card.querySelectorAll<HTMLElement>(".account-usage-metric"))) {
    refineMetric(metric, provider);
  }
  refineCredits(card, provider);
}

function refineOpenCodeEmails(cards: HTMLElement[]): void {
  const usedAccountIds = new Set<string>();
  const openCodeCards = cards.filter((candidate) => candidate.dataset.provider === "opencode_go");

  for (const card of [...openCodeCards].reverse()) {
    const name = card.querySelector<HTMLElement>(".account-card-name-row h2")?.textContent?.trim();
    const subtitle = card.querySelector<HTMLElement>(".account-card-identity > p");
    if (!name || !subtitle) continue;

    const assignedId = card.dataset.emailAccountId;
    const assignedRecord = assignedId ? getOpenCodeEmailRecord(assignedId) : null;
    const record = assignedRecord && !usedAccountIds.has(assignedRecord.accountId)
      ? assignedRecord
      : resolveOpenCodeEmailRecord(name, usedAccountIds);
    if (!record) continue;

    usedAccountIds.add(record.accountId);
    card.dataset.emailAccountId = record.accountId;
    renameOpenCodeEmailRecord(record.accountId, name);
    if (subtitle.textContent !== record.email) subtitle.textContent = record.email;
  }
}

function modalCancelButton(modal: HTMLElement): HTMLButtonElement | null {
  return Array.from(modal.querySelectorAll<HTMLButtonElement>(".modal-actions button"))
    .find((button) => {
      const label = button.textContent?.trim().toLowerCase();
      return label === "cancel" || label === "close";
    }) ?? null;
}

function refineModalCloseButton(modal: HTMLElement): void {
  let close = modal.querySelector<HTMLButtonElement>(":scope > .ui-modal-close");
  if (!close) {
    close = document.createElement("button");
    close.type = "button";
    close.className = "ui-modal-close";
    close.setAttribute("aria-label", "Close dialog");
    close.title = "Close";
    close.textContent = "×";
    modal.prepend(close);
  }

  const cancel = modalCancelButton(modal);
  close.disabled = !cancel || cancel.disabled;
  close.onclick = () => {
    const currentCancel = modalCancelButton(modal);
    if (currentCancel && !currentCancel.disabled) currentCancel.click();
  };
}

function clearResetCountdowns(cards: HTMLElement[]): void {
  for (const card of cards) {
    for (const reset of Array.from(card.querySelectorAll<HTMLElement>(".metric-reset"))) {
      reset.removeAttribute("data-reset-countdown");
    }
  }
}

async function syncResetCountdowns(): Promise<void> {
  if (resetCountdownSyncInFlight) return;

  const cards = Array.from(document.querySelectorAll<HTMLElement>(".provider-account-card"));
  if (!cards.length) return;

  const provider = cardProvider(cards[0]);
  if (!provider) {
    clearResetCountdowns(cards);
    return;
  }

  resetCountdownSyncInFlight = true;
  try {
    const snapshot = await bridgeApi.snapshot();
    const accounts = snapshot.accounts.filter((account) => account.provider === provider);

    cards.forEach((card, cardIndex) => {
      const account = accounts[cardIndex];
      const windows = orderedWindows(account?.lastUsage?.windows ?? []);
      const metrics = Array.from(card.querySelectorAll<HTMLElement>(".account-usage-metric"));

      metrics.forEach((metric, metricIndex) => {
        const reset = metric.querySelector<HTMLElement>(".metric-reset");
        if (!reset) return;
        const label = resetCountdownLabel(windows[metricIndex]?.resetsAt);
        if (label) reset.dataset.resetCountdown = label;
        else reset.removeAttribute("data-reset-countdown");
      });
    });
  } catch {
    // Keep the last known countdown while a local snapshot is temporarily unavailable.
  } finally {
    resetCountdownSyncInFlight = false;
  }
}

function scheduleResetCountdownSync(delay = 120): void {
  if (resetCountdownSyncTimer != null) window.clearTimeout(resetCountdownSyncTimer);
  resetCountdownSyncTimer = window.setTimeout(() => {
    resetCountdownSyncTimer = null;
    void syncResetCountdowns();
  }, delay);
}

function applyRefinements(): void {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".provider-account-card"));
  for (const card of cards) refineAccountCard(card);
  refineOpenCodeEmails(cards);

  const modals = Array.from(document.querySelectorAll<HTMLElement>(".modal-card[role=\"dialog\"]"));
  for (const modal of modals) refineModalCloseButton(modal);
}

export function installUiRefinements(): void {
  applyRefinements();
  scheduleResetCountdownSync(0);

  const observer = new MutationObserver(() => {
    applyRefinements();
    scheduleResetCountdownSync();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });

  window.addEventListener("focus", () => scheduleResetCountdownSync(0));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleResetCountdownSync(0);
  });
  window.setInterval(() => void syncResetCountdowns(), RESET_COUNTDOWN_SYNC_MS);
}
