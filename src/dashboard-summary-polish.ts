import { bridgeApi } from "./api";
import type { Account } from "./types";

const ACCOUNT_ATTENTION_SYNC_MS = 30_000;
const RESET_SEPARATOR = " · ";

let attentionAccountIds = new Set<string>();
let attentionRefreshInFlight = false;
let attentionRefreshTimer: number | null = null;
let polishFrame: number | null = null;

function accountNeedsAttention(account: Account): boolean {
  return Boolean(
    account.authRequired
    || account.lastError
    || !account.lastUsage
    || account.lastUsage.freshness !== "live",
  );
}

function applyAccountAttentionState(): void {
  for (const shell of document.querySelectorAll<HTMLElement>(".account-row-shell[data-account-id]")) {
    const accountId = shell.dataset.accountId;
    shell.classList.toggle("needs-attention", Boolean(accountId && attentionAccountIds.has(accountId)));
  }
}

async function refreshAccountAttentionState(): Promise<void> {
  if (attentionRefreshInFlight) return;
  attentionRefreshInFlight = true;
  try {
    const snapshot = await bridgeApi.snapshot();
    attentionAccountIds = new Set(
      snapshot.accounts
        .filter(accountNeedsAttention)
        .map((account) => account.id),
    );
    applyAccountAttentionState();
  } catch {
    // Keep the last known attention state when the local snapshot is temporarily unavailable.
  } finally {
    attentionRefreshInFlight = false;
  }
}

function scheduleAttentionRefresh(): void {
  if (attentionRefreshTimer != null) window.clearTimeout(attentionRefreshTimer);
  attentionRefreshTimer = window.setTimeout(() => {
    attentionRefreshTimer = null;
    void refreshAccountAttentionState();
  }, 200);
}

function summaryLabel(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>(":scope > div > small");
}

function summaryHelper(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>(":scope > div > span");
}

function polishSummaryCards(): void {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".summary-grid.summary-grid-three > .summary-card"));

  for (const card of cards) {
    const label = summaryLabel(card);
    if (!label) continue;

    const normalized = label.textContent?.trim().toLowerCase();
    card.classList.add("summary-card-inline");

    if (normalized === "connected accounts") {
      card.classList.add("summary-connected");
      if (label.textContent !== "Connected Accounts") label.textContent = "Connected Accounts";
      continue;
    }

    if (normalized === "needs attention") {
      card.classList.add("summary-attention");
      if (label.textContent !== "Needs Attention") label.textContent = "Needs Attention";
      continue;
    }

    if (normalized === "next reset") {
      card.classList.add("summary-next-reset");
      if (label.textContent !== "Next Reset") label.textContent = "Next Reset";

      const helper = summaryHelper(card);
      if (!helper) continue;
      const current = helper.textContent?.trim() ?? "";
      const accountName = current.includes(RESET_SEPARATOR)
        ? current.split(RESET_SEPARATOR, 1)[0]?.trim()
        : current === "No upcoming reset reported"
          ? "Not reported"
          : current;
      if (accountName && helper.textContent !== accountName) helper.textContent = accountName;
    }
  }
}

function schedulePolish(): void {
  if (polishFrame != null) return;
  polishFrame = window.requestAnimationFrame(() => {
    polishFrame = null;
    polishSummaryCards();
    applyAccountAttentionState();
  });
}

export function installDashboardSummaryPolish(): void {
  schedulePolish();
  void refreshAccountAttentionState();

  const observer = new MutationObserver(() => {
    schedulePolish();
    scheduleAttentionRefresh();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  window.addEventListener("focus", () => void refreshAccountAttentionState());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshAccountAttentionState();
  });
  window.setInterval(() => void refreshAccountAttentionState(), ACCOUNT_ATTENTION_SYNC_MS);
}
